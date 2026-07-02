import { getProvider } from '../../providers';
import { webullConfigured } from '../../providers/webull/account';
import { webullMovers } from '../../providers/webull/movers';
import { defaultScreenerConfig, scoreSymbol, ScreenerConfig, SymbolScore } from '../../indicators/screener';
import { listUniverseSymbols } from '../../db/universe';
import { isExcluded } from '../../db/autotradeExclusions';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { mapPool } from '../../util/async';
import { classifySector } from './realEstateClassifier';

// ---------------------------------------------------------------------------
// The Research & Screen stage (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP,
// stage 1). Discovers gapper/momentum/unusual-volume candidates, then applies
// the real-estate exclusion (list + sector/industry classification) before
// anything downstream — Decision, Risk Check — ever sees a candidate. Reuses
// the existing scoring engine (indicators/screener.ts) rather than a parallel
// one; this stage only adds discovery + the exclusion gate on top of it.
//
// Read-only: this scans and journals, it never places an order.
// ---------------------------------------------------------------------------

export type DiscoverySource = 'universe' | 'movers';

export interface ScreenCandidate extends SymbolScore {
  discoverySource: DiscoverySource;
}

export interface ScreenResult {
  generatedAt: number;
  candidates: ScreenCandidate[];
  excluded: { symbol: string; reason: string }[];
  /** Sector/industry couldn't be determined this cycle — skipped, not cleared
   *  and not blacklisted; may be reconsidered next cycle. */
  skipped: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  discovery: { universeCount: number; moversCount: number; scannedCount: number };
}

/** Auto-trade screening leans harder on "unusual volume" than the manual
 *  screener's general-purpose defaults — the strategy specifically targets
 *  volume breakouts (docs/AUTOTRADING_SPEC.md — STRATEGY OBJECTIVE). */
export function defaultAutotradeScreenerConfig(): ScreenerConfig {
  const base = defaultScreenerConfig();
  return { ...base, filters: { ...base.filters, minRelVol: 1.5 } };
}

/** Merge a partial (from an API request) onto the auto-trade defaults — same
 *  merge shape as indicators/screener.ts's resolveScreenerConfig. */
export function resolveAutotradeScreenerConfig(patch?: Partial<ScreenerConfig>): ScreenerConfig {
  const base = defaultAutotradeScreenerConfig();
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    weights: { ...base.weights, ...(patch.weights ?? {}) },
    filters: { ...base.filters, ...(patch.filters ?? {}) },
  };
}

/** Candidate symbols: the whole universe, plus (when Webull is configured) its
 *  pre-market unusual-volume and gainers movers — the only source in this app
 *  that can find gappers outside the ~124-symbol seeded universe. Movers are a
 *  discovery enhancement, not required; a failed/unconfigured fetch just falls
 *  back to universe-only, matching how the manual screener already works. */
async function discoverSymbols(): Promise<{
  symbols: string[];
  universeCount: number;
  moversCount: number;
  fromMovers: Set<string>;
}> {
  const universeSymbols = listUniverseSymbols().map((s) => s.toUpperCase());
  const fromMovers = new Set<string>();

  if (webullConfigured()) {
    try {
      const [unusual, gainers] = await Promise.all([
        webullMovers('unusual', 20, 'premarket'),
        webullMovers('gainers', 20, 'premarket'),
      ]);
      for (const m of [...unusual.movers, ...gainers.movers]) fromMovers.add(m.symbol);
    } catch {
      /* discovery enhancement only — universe alone still works */
    }
  }

  const symbols = Array.from(new Set([...universeSymbols, ...fromMovers]));
  return { symbols, universeCount: universeSymbols.length, moversCount: fromMovers.size, fromMovers };
}

export interface RunScreenOptions {
  config?: Partial<ScreenerConfig>;
  /** Bypass universe/movers discovery and scan exactly these symbols instead
   *  (mirrors the manual screener's `symbols` override in routes/screener.ts). */
  symbols?: string[];
}

export async function runAutotradeScreen(opts: RunScreenOptions = {}): Promise<ScreenResult> {
  const cfg = resolveAutotradeScreenerConfig(opts.config);
  const provider = getProvider();
  const { symbols, universeCount, moversCount, fromMovers } = opts.symbols?.length
    ? {
        symbols: Array.from(new Set(opts.symbols.map((s) => s.toUpperCase()))),
        universeCount: 0,
        moversCount: 0,
        fromMovers: new Set<string>(),
      }
    : await discoverSymbols();

  const candidates: ScreenCandidate[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  const errors: { symbol: string; message: string }[] = [];

  await mapPool(symbols, 6, async (symbol) => {
    // Real-estate exclusion runs FIRST, before any scoring — a listed or
    // classified RE symbol never reaches Decision/Risk Check, per the spec.
    if (isExcluded(symbol)) {
      const reason = 'On the real-estate exclusion list';
      excluded.push({ symbol, reason });
      logAutotradeEvent({ symbol, stage: 'screen', action: 'excluded_re', detail: { reason, source: 'list' } });
      return;
    }

    const classification = await classifySector(symbol);
    if (classification.outcome === 'real_estate') {
      const reason = `Classified as real estate (${classification.sector ?? classification.industry ?? 'sector match'})`;
      excluded.push({ symbol, reason });
      logAutotradeEvent({
        symbol,
        stage: 'screen',
        action: 'excluded_re',
        detail: {
          reason,
          source: classification.source,
          sector: classification.sector,
          industry: classification.industry,
        },
      });
      return;
    }
    if (classification.outcome === 'unknown') {
      skipped.push({ symbol, reason: 'sector/industry could not be determined this cycle' });
      logAutotradeEvent({ symbol, stage: 'screen', action: 'skipped_unknown_sector' });
      return;
    }

    try {
      const [candles, quote] = await Promise.all([
        provider.getCandles(symbol, 'daily', { limit: 120 }),
        provider.getQuote(symbol).catch(() => undefined),
      ]);
      const score = scoreSymbol(symbol, candles, quote, cfg);
      if (score.passedFilters) {
        candidates.push({ ...score, discoverySource: fromMovers.has(symbol) ? 'movers' : 'universe' });
        logAutotradeEvent({
          symbol,
          stage: 'screen',
          action: 'candidate_found',
          detail: {
            total: score.total,
            price: score.price,
            gapPct: score.indicators.gapPct,
            relVolume: score.indicators.relVolume,
          },
        });
      }
      // Symbols that fail the score filters (not RE) are just omitted — logging
      // every routine non-match would flood the journal every cycle.
    } catch (err) {
      errors.push({ symbol, message: (err as Error).message });
    }
  });

  candidates.sort((a, b) => b.total - a.total);
  return {
    generatedAt: Date.now(),
    candidates,
    excluded,
    skipped,
    errors,
    discovery: { universeCount, moversCount, scannedCount: symbols.length },
  };
}

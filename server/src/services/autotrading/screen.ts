import { getProvider } from '../../providers';
import { webullConfigured } from '../../providers/webull/account';
import { webullMovers } from '../../providers/webull/movers';
import { Candle } from '../../providers/types';
import {
  CandleIndicators,
  computeCandleIndicators,
  defaultScreenerConfig,
  scoreSymbol,
  ScreenerConfig,
  SymbolScore,
} from '../../indicators/screener';
import { listUniverseSymbols } from '../../db/universe';
import { isExcluded } from '../../db/autotradeExclusions';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { mapPool } from '../../util/async';
import { classifySector, buildUniverseSectorMap } from './realEstateClassifier';
import { getSymbolEvents } from '../events';

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
  /** Skip a candidate whose next known earnings date falls within this many
   *  CALENDAR days (today counts as day 0) — 0 or omitted disables the
   *  check. Read from AutotradeConfig.earningsBlackoutDays by the caller
   *  (loop.ts / the manual Screen+Decision routes), same convention as
   *  config.filters.minRelVol above. */
  earningsBlackoutDays?: number;
}

/** Whether `earningsDate` (YYYY-MM-DD) falls within `blackoutDays` calendar
 *  days from now, inclusive of today — a pure calendar-date comparison, not
 *  a fractional-hours one, so the window's meaning doesn't shift with what
 *  time of day the loop happens to run. */
function withinEarningsBlackout(earningsDate: string, blackoutDays: number, now: number = Date.now()): boolean {
  const todayMs = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const earningsMs = Date.parse(`${earningsDate}T00:00:00Z`);
  const diffDays = Math.round((earningsMs - todayMs) / (24 * 60 * 60 * 1000));
  return diffDays >= 0 && diffDays <= blackoutDays;
}

// Cached SMA/RSI/ATR per symbol, keyed on the exact config fields that feed
// computeCandleIndicators() plus the latest candle's own timestamp — a daily
// bar only actually changes once a trading day, but this tick runs every 60s,
// so most ticks can skip recomputing the heaviest part of scoring entirely.
// Keying on the config fields (not just symbol) means a caller testing a
// different maShort/maLong/rsiPeriod/atrPeriod (the manual Screen/Decision
// routes accept a custom config override) simply misses the cache rather
// than risking a stale-config hit — never silently serves a value computed
// under different indicator settings.
const candleIndicatorCache = new Map<string, { candleTime: number; indicators: CandleIndicators }>();

function candleIndicatorCacheKey(symbol: string, cfg: ScreenerConfig): string {
  return `${symbol}:${cfg.maShort}:${cfg.maLong}:${cfg.rsiPeriod}:${cfg.atrPeriod}`;
}

/** computeCandleIndicators(), reusing the previous tick's result when this
 *  symbol's latest candle hasn't actually changed since then. */
function cachedCandleIndicatorsFor(
  symbol: string,
  candles: Candle[],
  cfg: ScreenerConfig,
): CandleIndicators | undefined {
  if (candles.length === 0) return undefined;
  const candleTime = candles[candles.length - 1].time;
  const key = candleIndicatorCacheKey(symbol, cfg);
  const cached = candleIndicatorCache.get(key);
  if (cached && cached.candleTime === candleTime) return cached.indicators;
  const fresh = computeCandleIndicators(candles, cfg);
  if (fresh) candleIndicatorCache.set(key, { candleTime, indicators: fresh });
  return fresh ?? undefined;
}

/** Test-only: clears the module-level cache so tests don't leak state into
 *  each other across runs. */
export function resetCandleIndicatorCache(): void {
  candleIndicatorCache.clear();
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

  // One batched lookup for every candidate up front — getSymbolEvents()
  // itself batches into a single Yahoo quote call per cycle of cache misses,
  // so this is no more expensive scanning 120 symbols than 1. Skipped
  // entirely when the check is disabled (the common case for anyone who
  // hasn't opted in) rather than paying for a lookup nothing will use.
  const earningsBlackoutDays = opts.earningsBlackoutDays ?? 0;
  const earningsBySymbol =
    earningsBlackoutDays > 0
      ? new Map((await getSymbolEvents(symbols)).map((e) => [e.symbol, e]))
      : new Map<string, { earningsDate?: string }>();

  // Both hoisted out of the per-symbol loop below: buildUniverseSectorMap()
  // is one query instead of one PER symbol (up to 507 full-table re-scans a
  // tick, otherwise); the quotes warm-up is one batched provider call
  // instead of up to 507 individual ones — same pattern routes/screener.ts
  // already uses. Best-effort: a failure here just means the per-symbol
  // getQuote() call below falls through to its own individual fetch, exactly
  // as it did before this warm-up existed.
  const universeSectorBySymbol = buildUniverseSectorMap();
  if (provider.getQuotes) {
    try {
      await provider.getQuotes(symbols);
    } catch {
      /* best-effort cache warm-up only */
    }
  }

  await mapPool(symbols, 6, async (symbol) => {
    // Real-estate exclusion runs FIRST, before any scoring — a listed or
    // classified RE symbol never reaches Decision/Risk Check, per the spec.
    if (isExcluded(symbol)) {
      const reason = 'On the real-estate exclusion list';
      excluded.push({ symbol, reason });
      logAutotradeEvent({ symbol, stage: 'screen', action: 'excluded_re', detail: { reason, source: 'list' } });
      return;
    }

    const classification = await classifySector(symbol, universeSectorBySymbol);
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

    // Earnings blackout — an unknown earnings date does NOT block (see
    // RunScreenOptions' own doc comment on why this fails OPEN, unlike the
    // real-estate checks above).
    if (earningsBlackoutDays > 0) {
      const earningsDate = earningsBySymbol.get(symbol)?.earningsDate;
      if (earningsDate && withinEarningsBlackout(earningsDate, earningsBlackoutDays)) {
        const reason = `Earnings ${earningsDate} is within the ${earningsBlackoutDays}-day blackout window`;
        excluded.push({ symbol, reason });
        logAutotradeEvent({ symbol, stage: 'screen', action: 'excluded_earnings', detail: { reason, earningsDate } });
        return;
      }
    }

    try {
      const [candles, quote] = await Promise.all([
        provider.getCandles(symbol, 'daily', { limit: 120 }),
        provider.getQuote(symbol).catch(() => undefined),
      ]);
      const score = scoreSymbol(symbol, candles, quote, cfg, cachedCandleIndicatorsFor(symbol, candles, cfg));
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

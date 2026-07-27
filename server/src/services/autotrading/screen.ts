import { getProvider } from '../../providers';
import { webullConfigured } from '../../providers/webull/account';
import { webullMovers } from '../../providers/webull/movers';
import { Candle } from '../../providers/types';
import {
  CandleIndicators,
  computeCandleIndicators,
  defaultScreenerConfig,
  Direction,
  lookbackReturnPct,
  scoreSymbol,
  scoreSymbolBothDirections,
  ScreenerConfig,
  SymbolScore,
} from '../../indicators/screener';
import { listUniverseSymbols } from '../../db/universe';
import { isExcluded } from '../../db/autotradeExclusions';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { mapPool } from '../../util/async';
import { classifySector, buildUniverseSectorMap } from './realEstateClassifier';
import { getSymbolEvents } from '../events';
import { getNews } from '../news';
import { computeHeadlineSentiment } from '../sentiment';

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
  /** Which side this candidate qualified as. In 'long'/'short' directionMode
   *  this always matches that mode; in 'both' mode it's per-symbol — the
   *  direction that actually passed filters (the stronger of the two, if
   *  both did — see pickDirection()). */
  direction: Direction;
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

/** Candidate symbols: the whole universe, plus (when Webull is configured AND
 *  movers discovery is enabled) its pre-market unusual-volume and gainers
 *  movers — the only source in this app that can find gappers outside the
 *  seeded universe. Movers are a discovery enhancement, not required; a
 *  failed/unconfigured fetch just falls back to universe-only, matching how
 *  the manual screener already works. `moversEnabled: false`
 *  (AutotradeConfig.moversDiscoveryEnabled, 2026-07-27) skips the fetch
 *  outright — the switch that lets a curated universe stay curated without
 *  unplugging Webull, which live trading still needs. */
async function discoverSymbols(moversEnabled: boolean): Promise<{
  symbols: string[];
  universeCount: number;
  moversCount: number;
  fromMovers: Set<string>;
}> {
  const universeSymbols = listUniverseSymbols().map((s) => s.toUpperCase());
  const fromMovers = new Set<string>();

  if (moversEnabled && webullConfigured()) {
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
  /** 'long' or 'short': scores every candidate as exactly that one direction
   *  (config?.direction, if given, is ignored in favor of this — kept as a
   *  SEPARATE option so a 'both' caller never has to also pick a meaningless
   *  single config.direction). 'both': scores every candidate BOTH ways
   *  (scoreSymbolBothDirections) and keeps whichever direction actually
   *  passed filters per symbol (the stronger of the two if both did — see
   *  pickDirection()) — this is what lets the loop hold a long on one symbol
   *  and a short on another from the SAME cycle. Defaults to
   *  config?.direction ?? 'long' — identical behavior to every caller that
   *  existed before this option did. */
  directionMode?: 'long' | 'short' | 'both';
  /** Whether discovery unions Webull's premarket movers into the candidate
   *  set (AutotradeConfig.moversDiscoveryEnabled, 2026-07-27). Defaults to
   *  true — identical behavior to every caller that existed before this
   *  option did. Irrelevant when `symbols` is supplied (explicit symbols
   *  bypass discovery entirely). */
  moversEnabled?: boolean;
}

/** Given both directions' scores for one symbol, pick which (if either)
 *  qualifies as an actual candidate. Both passing is rare (the checks are
 *  largely symmetric, so a genuinely two-sided setup is unusual) but not
 *  impossible — deliberately never emits a candidate for BOTH directions on
 *  the same symbol in the same cycle (proposing a stock as both a long and a
 *  short setup at once is a contradiction downstream, not a genuine edge
 *  case to preserve), so the stronger (higher total) side wins; an exact tie
 *  favors long, arbitrarily but deterministically. */
export function pickDirection(both: {
  long: SymbolScore;
  short: SymbolScore;
}): { direction: Direction; score: SymbolScore } | null {
  const { long, short } = both;
  if (long.passedFilters && short.passedFilters) {
    return long.total >= short.total ? { direction: 'long', score: long } : { direction: 'short', score: short };
  }
  if (long.passedFilters) return { direction: 'long', score: long };
  if (short.passedFilters) return { direction: 'short', score: short };
  return null;
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

// The WEEKLY counterpart of candleIndicatorCache above (2026-07-16, multi-
// timeframe confirmation — docs/AUTOTRADING_SPEC.md phase 19). A separate Map
// (not a shared key namespace with the daily cache) so a weekly and daily
// entry for the same symbol+config can never collide/overwrite each other.
// Keyed and invalidated the same way — the latest WEEKLY candle's own
// timestamp only actually changes once a week, so this self-invalidates even
// less often than the daily cache does.
const weeklyIndicatorCache = new Map<string, { candleTime: number; indicators: CandleIndicators }>();

function weeklyIndicatorCacheKey(symbol: string, cfg: ScreenerConfig): string {
  return `${symbol}:${cfg.maShort}`;
}

/** How many weekly bars to fetch — a fixed, generous constant (not sized off
 *  cfg.maShort dynamically), matching the daily fetch's own `limit: 120`
 *  convention below. 40 weeks (~9 months) comfortably covers the default
 *  20-week reading with room to spare even for a raised maShort. */
const WEEKLY_CANDLE_LIMIT = 40;

/** The closed-week counterpart of cachedCandleIndicatorsFor() above — only
 *  called when requireWeeklyTrendAlignment is actually enabled (see the
 *  gate at its call site below), so nobody who hasn't opted in pays for the
 *  extra provider fetch. `weeklyCandles.slice(0, -1)` drops the most recent
 *  (possibly still-in-progress) week before computing anything — the SAME
 *  "only trust a fully closed week" posture backtest.ts's own
 *  closedWeeklyIndexAsOf() enforces for the backtest engines, just via
 *  array-slicing here instead of an index lookup (a live fetch always ends
 *  at "now," so the tail element is exactly the one bar that might not be
 *  closed yet). */
function cachedWeeklyIndicatorsFor(
  symbol: string,
  weeklyCandles: Candle[],
  cfg: ScreenerConfig,
): CandleIndicators | undefined {
  const closed = weeklyCandles.slice(0, -1);
  if (closed.length === 0) return undefined;
  const candleTime = closed[closed.length - 1].time;
  const key = weeklyIndicatorCacheKey(symbol, cfg);
  const cached = weeklyIndicatorCache.get(key);
  if (cached && cached.candleTime === candleTime) return cached.indicators;
  const fresh = computeCandleIndicators(closed, cfg);
  if (fresh) weeklyIndicatorCache.set(key, { candleTime, indicators: fresh });
  return fresh ?? undefined;
}

/** Test-only: clears the module-level weekly cache, mirroring
 *  resetCandleIndicatorCache() above. */
export function resetWeeklyIndicatorCache(): void {
  weeklyIndicatorCache.clear();
}

export async function runAutotradeScreen(opts: RunScreenOptions = {}): Promise<ScreenResult> {
  const cfg = resolveAutotradeScreenerConfig(opts.config);
  // Falls back to cfg.direction (itself defaulted 'long') when omitted —
  // every existing caller that doesn't know about directionMode gets
  // IDENTICAL behavior to before this option existed.
  const directionMode = opts.directionMode ?? cfg.direction;
  const provider = getProvider();
  const { symbols, universeCount, moversCount, fromMovers } = opts.symbols?.length
    ? {
        symbols: Array.from(new Set(opts.symbols.map((s) => s.toUpperCase()))),
        universeCount: 0,
        moversCount: 0,
        fromMovers: new Set<string>(),
      }
    : await discoverSymbols(opts.moversEnabled ?? true);

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

  // Relative-strength-vs-benchmark (2026-07-17): the benchmark's own lookback
  // return is the SAME single number for every candidate this cycle, so it's
  // fetched and computed ONCE here — never per-symbol inside the mapPool
  // loop below — then handed to every scoreSymbol/scoreSymbolBothDirections
  // call as-is. Only fetched when the component is actually weighted in (same
  // don't-do-unrequested-work gate as the weekly-trend fetch above); a failed
  // fetch degrades to "no relative-strength data this cycle" (score 0 for
  // that one component, everything else unaffected) rather than failing the
  // whole screen — same best-effort posture as the sector-map/quotes warm-up
  // just above.
  const benchmarkLookbackReturnPct =
    cfg.weights.relativeStrength > 0
      ? await provider
          .getCandles(cfg.benchmarkSymbol, 'daily', { limit: 120 })
          .then((candles) => lookbackReturnPct(candles, cfg.relativeStrengthLookbackDays))
          .catch(() => null)
      : null;

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
      const cachedIndicators = cachedCandleIndicatorsFor(symbol, candles, cfg);
      // Only fetched when the filter is actually enabled — same
      // don't-do-unrequested-work gate as the earnings blackout lookup
      // above (and optionsExecute.ts's own priceRulesActive gate).
      const weeklyIndicators = cfg.filters.requireWeeklyTrendAlignment
        ? cachedWeeklyIndicatorsFor(
            symbol,
            await provider.getCandles(symbol, 'weekly', { limit: WEEKLY_CANDLE_LIMIT }),
            cfg,
          )
        : undefined;
      // Sentiment (2026-07-18): unlike relativeStrength's ONE shared
      // benchmark fetch above, this is genuinely per-symbol — each candidate
      // has its own headlines — so it's fetched here, inside the per-symbol
      // loop, same don't-do-unrequested-work gate as weeklyIndicators just
      // above. getNews() is already best-effort on its own (empty array on
      // failure, its own 5-min TTL cache) — the extra .catch(() => []) here
      // is belt-and-suspenders, matching benchmarkLookbackReturnPct's own
      // explicit .catch(() => null) above: this candidate's OTHER components
      // (momentum, RSI, ...) shouldn't fail just because sentiment couldn't
      // be read this cycle.
      const sentimentNetScore =
        cfg.weights.sentiment > 0 ? computeHeadlineSentiment(await getNews(symbol).catch(() => [])).netScore : null;
      // 'both': score each candidate as a long AND a short from the SAME
      // indicator computation, then keep whichever direction (if either)
      // actually qualifies — see pickDirection(). 'long'/'short': unchanged
      // single-direction behavior, just reading directionMode instead of
      // cfg.direction directly so a 'both' caller was never required to also
      // pick a meaningless single cfg.direction.
      const picked =
        directionMode === 'both'
          ? pickDirection(
              scoreSymbolBothDirections(
                symbol,
                candles,
                quote,
                cfg,
                cachedIndicators,
                undefined,
                weeklyIndicators,
                benchmarkLookbackReturnPct,
                sentimentNetScore,
              ),
            )
          : (() => {
              const score = scoreSymbol(
                symbol,
                candles,
                quote,
                { ...cfg, direction: directionMode },
                cachedIndicators,
                undefined,
                weeklyIndicators,
                benchmarkLookbackReturnPct,
                sentimentNetScore,
              );
              return score.passedFilters ? { direction: directionMode, score } : null;
            })();
      if (picked) {
        candidates.push({
          ...picked.score,
          direction: picked.direction,
          discoverySource: fromMovers.has(symbol) ? 'movers' : 'universe',
        });
        logAutotradeEvent({
          symbol,
          stage: 'screen',
          action: 'candidate_found',
          detail: {
            direction: picked.direction,
            total: picked.score.total,
            price: picked.score.price,
            gapPct: picked.score.indicators.gapPct,
            relVolume: picked.score.indicators.relVolume,
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

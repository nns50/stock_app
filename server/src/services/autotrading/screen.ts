import { getProvider } from '../../providers';
import { webullConfigured } from '../../providers/webull/account';
import { webullMovers } from '../../providers/webull/movers';
import { Candle } from '../../providers/types';
import {
  CandleIndicators,
  computeCandleIndicators,
  computeIndicators,
  defaultScreenerConfig,
  Direction,
  IndicatorSnapshot,
  lookbackReturnPct,
  scoreFromIndicators,
  ScreenerConfig,
  SymbolScore,
} from '../../indicators/screener';
import { listUniverseSymbols } from '../../db/universe';
import { isExcluded } from '../../db/autotradeExclusions';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { mapPool } from '../../util/async';
import { etToday } from '../../util/marketDate';
import { relVolMedian, relVolPace } from '../../indicators/relVolPace';
import { classifySector, buildUniverseSectorMap } from './realEstateClassifier';
import { claimOncePerDay } from './oncePerDayEvents';
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
  /** This candidate's relative-volume PACE — its relVolume over the universe's
   *  median relVolume this tick, so it means the same thing at 10:00 and 15:30
   *  (indicators/relVolPace.ts). Computed for every candidate since 2026-09-01,
   *  not only when the pace GATE is on: levelPlan reads it to tell a genuine
   *  high-volume breakout through a wall from a drift into one, and a gate
   *  being off is no reason for the number not to exist. Null when the pace is
   *  unmeasurable (too few samples, or no relVolume for this symbol). */
  relVolPace: number | null;
}

export interface ScreenResult {
  generatedAt: number;
  candidates: ScreenCandidate[];
  excluded: { symbol: string; reason: string }[];
  /** Sector/industry couldn't be determined this cycle — skipped, not cleared
   *  and not blacklisted; may be reconsidered next cycle. */
  skipped: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  /** Symbols that were fully SCORED and then failed the screener's own filters
   *  (minChangePct, minScore, weekly-trend alignment, minPrice, minAvgVolume).
   *
   *  These reasons used to be computed and dropped on the floor: `scoreSymbol`
   *  has always returned `filterReasons`, and the call sites discarded them for
   *  anything that did not pass. So the journal could say why a symbol was
   *  excluded for real estate, pace, volatility, earnings or an unknown sector,
   *  and could say NOTHING about a name that simply never appeared — which is
   *  the more common case and the more useful question. SPY and QQQ were added
   *  to the universe on an explicit operator decision (2026-08-27), had their
   *  unknown-sector skip fixed on 2026-09-03, and then produced zero candidates
   *  and zero signals on 2026-09-04 with no record anywhere of what stopped
   *  them.
   *
   *  Kept IN MEMORY and never journaled: a per-symbol reason for all 528 names
   *  every tick would dwarf even `excluded_re`, which was itself 31% of a
   *  507k-row table that nothing prunes until it was cut to one row per symbol
   *  per day (task #43). The explain route reads this from a live screen
   *  instead — a question you ask, not a query you had to anticipate. */
  rejected: { symbol: string; direction: Direction; total: number; reasons: string[] }[];
  /** The universe's median relVolume this tick — the market's current pace, and
   *  the denominator every relVolPace was measured against. Computed every tick
   *  since 2026-09-01 (it used to be skipped when the pace GATE was off), because
   *  the pace itself is now read downstream by levelPlan's breakout test. Null
   *  only when there were too few samples to estimate it. Surfaced so a pace
   *  figure in the journal can always be checked against what it was divided
   *  by. */
  relVolMedian: number | null;
  /** `moversError` is the message from a FAILED movers fetch, null when the
   *  fetch succeeded or was never attempted. Movers discovery used to swallow
   *  every error with a bare catch, so a provider outage and "the provider
   *  returned nothing" were the same observation: moversCount 0, no log, no
   *  event. They mean different things — one is broken, the other is a quiet
   *  premarket — so they are now distinguishable. */
  discovery: { universeCount: number; moversCount: number; scannedCount: number; moversError: string | null };
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
  moversError: string | null;
}> {
  const universeSymbols = listUniverseSymbols().map((s) => s.toUpperCase());
  const fromMovers = new Set<string>();
  let moversError: string | null = null;

  if (moversEnabled && webullConfigured()) {
    try {
      const [unusual, gainers] = await Promise.all([
        webullMovers('unusual', 20, 'premarket'),
        webullMovers('gainers', 20, 'premarket'),
      ]);
      for (const m of [...unusual.movers, ...gainers.movers]) fromMovers.add(m.symbol);
    } catch (e) {
      // Still a discovery enhancement — universe alone works, so this is NOT
      // rethrown and the screen proceeds exactly as before. What changed
      // (2026-09-02) is that it is no longer SILENT: the previous bare
      // `catch {}` meant a movers fetch that had been failing for weeks
      // looked identical, from every vantage point in the app, to one
      // returning an empty premarket. The caller journals this.
      moversError = e instanceof Error ? e.message : String(e);
    }
  }

  const symbols = Array.from(new Set([...universeSymbols, ...fromMovers]));
  return { symbols, universeCount: universeSymbols.length, moversCount: fromMovers.size, fromMovers, moversError };
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
  /** Relative-volume PACE floor — a multiple of the universe's median relVolume
   *  this tick, so it means the same thing at any hour (indicators/relVolPace.ts).
   *  0 = off. Read from AutotradeConfig.minRelVolPace by the caller. */
  minRelVolPace?: number;
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

type RejectedEntry = { symbol: string; direction: Direction; total: number; reasons: string[] };

/**
 * Score a snapshot and decide which direction (if either) qualifies.
 *
 * ONE implementation, called by both scoring passes below — the ordinary pass
 * and the relative-volume PACE pass that re-scores the same snapshots once the
 * universe median exists. Two copies that agree today is exactly what
 * CLAUDE.md's "agree by construction" rule is about, and here the drift would
 * be invisible in the worst way: flag-on and flag-off would differ for reasons
 * having nothing to do with the flag, in the middle of the measurement meant
 * to decide whether to keep the flag on.
 */
function selectFromSnapshot(
  symbol: string,
  ind: IndicatorSnapshot | null,
  fallbackPrice: number,
  cfg: ScreenerConfig,
  directionMode: Direction | 'both',
): {
  picked: { direction: Direction; score: SymbolScore } | null;
  rejected: RejectedEntry | null;
  /** The score this selection judged — the chosen side, or the better side
   *  when neither qualified. Returned so a comparison of two scorings can
   *  cover EVERY scored symbol; reading only `picked` would restrict it to
   *  the survivors of the very scoring under examination. */
  best: SymbolScore;
} {
  if (directionMode === 'both') {
    const both = {
      long: scoreFromIndicators(symbol, ind, { ...cfg, direction: 'long' }, fallbackPrice),
      short: scoreFromIndicators(symbol, ind, { ...cfg, direction: 'short' }, fallbackPrice),
    };
    const chosen = pickDirection(both);
    if (chosen) return { picked: chosen, rejected: null, best: chosen.score };
    // Neither direction passed. Report the side that scored higher, since that
    // is the one the reader is asking about.
    const best = both.long.total >= both.short.total ? both.long : both.short;
    const dir: Direction = best === both.long ? 'long' : 'short';
    return {
      picked: null,
      rejected: { symbol, direction: dir, total: best.total, reasons: best.filterReasons },
      best,
    };
  }
  const score = scoreFromIndicators(symbol, ind, { ...cfg, direction: directionMode }, fallbackPrice);
  if (score.passedFilters) return { picked: { direction: directionMode, score }, rejected: null, best: score };
  return {
    picked: null,
    rejected: { symbol, direction: directionMode, total: score.total, reasons: score.filterReasons },
    best: score,
  };
}

/** Per-symbol fan-out for the screen. Gentle on the provider's rate limit;
 *  named so the retry below can be deliberately gentler still. */
const SCREEN_CONCURRENCY = 6;

/** The retry's own, lower, concurrency and the pause before it. A retry at the
 *  same rate as the burst that was refused is just the burst again. */
const RATE_LIMIT_RETRY_CONCURRENCY = 3;
const RATE_LIMIT_RETRY_PAUSE_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Does this provider error read as rate limiting? Matched on the message
 *  because that is all the provider layer surfaces here — deliberately broad
 *  across the shapes seen ("Too many requests", a bare 429, "rate limit"), and
 *  deliberately NOT a catch-all: a symbol whose data is genuinely broken must
 *  not be re-fetched on every tick of every session. */
export function isRateLimited(message: string): boolean {
  return /too many requests|rate.?limit|\b429\b/i.test(message);
}

/**
 * Whether `earningsDate` (YYYY-MM-DD) falls within `blackoutDays` calendar
 * days from now, inclusive of today — a pure calendar-date comparison, not a
 * fractional-hours one, so the window's meaning doesn't shift with what time
 * of day the loop happens to run.
 *
 * "TODAY" IS THE ET DATE, not the UTC one (fixed 2026-09-12). The earnings
 * date is a US market calendar date, so the comparison has to be made on the
 * same calendar. Taking `toISOString()` made today's date roll over at 20:00
 * ET (19:00 under EST) — so on an evening tick the whole window shifted a day
 * forward, and a symbol reporting THAT DAY came back as diffDays -1 and left
 * the blackout entirely. Exactly the drift the sentence above promises not to
 * have.
 *
 * Latent rather than live: entries only screen inside the session, and every
 * ET time before 19:00 shares a UTC date. It is fixed because the guarantee
 * is supposed to hold for any caller at any hour, not because the loop
 * happens to avoid the window today.
 */
function withinEarningsBlackout(earningsDate: string, blackoutDays: number, now: number = Date.now()): boolean {
  const todayMs = Date.parse(`${etToday(now)}T00:00:00Z`);
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
  const { symbols, universeCount, moversCount, fromMovers, moversError } = opts.symbols?.length
    ? {
        symbols: Array.from(new Set(opts.symbols.map((s) => s.toUpperCase()))),
        universeCount: 0,
        moversCount: 0,
        fromMovers: new Set<string>(),
        moversError: null,
      }
    : await discoverSymbols(opts.moversEnabled ?? true);

  const candidates: ScreenCandidate[] = [];
  // Every scored symbol's raw relVolume — pass or fail — so the universe median
  // below is the market's true current pace, not just the survivors'.
  const relVolSamples: (number | null)[] = [];
  // Every scored symbol's snapshot, retained so the relative-volume PACE pass
  // can re-score without a second fetch or a second indicator computation.
  // Flat objects of ~17 numbers each; a 560-symbol universe is nothing next to
  // the candle arrays already held during the fetch.
  const scoredSnapshots: { symbol: string; ind: IndicatorSnapshot | null; fallbackPrice: number }[] = [];
  // candidate_found is journaled AFTER the pace filter, so the journal never
  // announces a candidate this screen then discards.
  const pendingCandidates: { symbol: string; candidate: ScreenCandidate }[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  const rejected: { symbol: string; direction: Direction; total: number; reasons: string[] }[] = [];
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

  // Hoisted so the rate-limit retry below can run the SAME body again over the
  // symbols the provider refused, without a second copy of it.
  const scoreSymbol = async (symbol: string): Promise<void> => {
    // Real-estate exclusion runs FIRST, before any scoring — a listed or
    // classified RE symbol never reaches Decision/Risk Check, per the spec.
    if (isExcluded(symbol)) {
      const reason = 'On the real-estate exclusion list';
      excluded.push({ symbol, reason });
      // Once per symbol per ET day — the classification is a standing fact and
      // every later tick's row was a copy of the first. See oncePerDayEvents.ts.
      if (claimOncePerDay('excluded_re', symbol)) {
        logAutotradeEvent({
          symbol,
          stage: 'screen',
          action: 'excluded_re',
          detail: { reason, source: 'list', firstOfDay: true },
        });
      }
      return;
    }

    const classification = await classifySector(symbol, universeSectorBySymbol);
    if (classification.outcome === 'real_estate') {
      const reason = `Classified as real estate (${classification.sector ?? classification.industry ?? 'sector match'})`;
      excluded.push({ symbol, reason });
      if (claimOncePerDay('excluded_re', symbol)) {
        logAutotradeEvent({
          symbol,
          stage: 'screen',
          action: 'excluded_re',
          detail: {
            reason,
            source: classification.source,
            sector: classification.sector,
            industry: classification.industry,
            firstOfDay: true,
          },
        });
      }
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
      // The indicator snapshot is computed ONCE and everything downstream
      // scores from it — including the pace pass below, which re-scores the
      // same snapshots after the universe median is known. Scoring twice from
      // one snapshot is cheap arithmetic; recomputing indicators, or worse
      // re-fetching, is not.
      const ind = computeIndicators(
        candles,
        quote,
        cfg,
        cachedIndicators,
        undefined,
        weeklyIndicators,
        benchmarkLookbackReturnPct,
        sentimentNetScore,
      );
      const fallbackPrice = quote?.last ?? 0;
      // Sampled whether or not it passes: the median is the MARKET's pace, so
      // it must come from the whole scored universe, not from the survivors of
      // the very filter it feeds.
      relVolSamples.push(ind?.relVolume ?? null);
      // SCORING happens after this loop, not here. The relative-volume
      // component can be scored on PACE, which needs the universe median, and
      // the median needs every symbol's relVolume — so no symbol can be scored
      // until all of them have been read. Retaining the snapshot is what makes
      // that orderable; it is also what lets both scorings be compared without
      // a second fetch.
      scoredSnapshots.push({ symbol, ind, fallbackPrice });
    } catch (err) {
      errors.push({ symbol, message: (err as Error).message });
    }
  };

  await mapPool(symbols, SCREEN_CONCURRENCY, scoreSymbol);

  // ---------------------------------------------------------------------
  // ONE RETRY FOR THE SYMBOLS THE PROVIDER RATE-LIMITED (2026-09-12).
  //
  // `screen_data_incomplete` exists because ~7% of a 560-symbol universe was
  // vanishing from every scan with nothing recorded. It is recorded now — and
  // on the deployed book it reads **67 of 562 unscored**, message "Too many
  // requests", on 192 ticks on 2026-09-11, 201 on 09-10, 140 on 09-09. Twelve
  // percent of the universe, every tick, and rising.
  //
  // That is not a reporting problem, it is the FLOW term of the plan's own
  // identity (expected day % = trades/session × risk% × edge R). A symbol that
  // is never scored cannot be a candidate, so a twelfth of the book's
  // opportunity is dropped before any gate gets an opinion — and unlike every
  // gate, this one leaves no per-symbol row to attribute it to.
  //
  // The retry is deliberately narrow:
  //   - only errors that LOOK like rate limiting, so a genuinely bad symbol
  //     does not cost a second round trip on every tick of every session;
  //   - ONE pass, never a loop;
  //   - at a LOWER concurrency, and after a pause, or it just re-triggers the
  //     limit it is recovering from;
  //   - the failed entries are removed from `errors` first, so a symbol that
  //     succeeds on the retry is not also reported as unscored.
  //
  // Safe to re-run the same body: everything before the `try` returns early and
  // never reaches the catch, and the only pushes inside it happen on the
  // success path immediately before it ends — so a symbol that threw has
  // recorded nothing and cannot be double-counted.
  const retryable = errors.filter((e) => isRateLimited(e.message)).map((e) => e.symbol);
  if (retryable.length > 0) {
    for (let i = errors.length - 1; i >= 0; i--) if (isRateLimited(errors[i].message)) errors.splice(i, 1);
    await sleep(RATE_LIMIT_RETRY_PAUSE_MS);
    await mapPool(retryable, RATE_LIMIT_RETRY_CONCURRENCY, scoreSymbol);
  }

  // ---------------------------------------------------------------------
  // Relative-volume PACE gate. Runs here rather than inside the per-symbol
  // filters because it needs the whole universe: the median relVolume across
  // everything scored this tick IS the fraction of a normal day's volume
  // elapsed, so dividing by it makes the threshold mean the same thing at
  // 10:00 and 15:30 (see indicators/relVolPace.ts for the measurements that
  // motivated it). Fails OPEN — too few samples, or an unmeasurable symbol,
  // lets the candidate through rather than rejecting on a guess.
  // ---------------------------------------------------------------------
  const paceFloor = opts.minRelVolPace ?? 0;
  // Computed whether or not the GATE is on: the pace is now also read
  // downstream (levelPlan's breakout test), and tying its existence to an
  // unrelated filter's setting is how a value ends up silently null in
  // production. relVolMedian over the same samples is cheap.
  const median = relVolMedian(relVolSamples);

  // ---------------------------------------------------------------------
  // Relative-volume PACE *scoring* (2026-09-08) — the same replacement the
  // gate above already made, applied to the SCORE component, which the gate
  // change never touched.
  //
  // scoreRelVol reads raw relVolume: today's cumulative volume over an average
  // FULL day. Before roughly midday almost nothing can reach relVolTarget, so
  // the component scores 0 for a reason that has nothing to do with the stock
  // — 8 of 15 live entries scored exactly 0 on it, and it carries 20% of the
  // weight by default. Scoring on pace instead makes it mean the same thing
  // at 10:00 and 15:30.
  //
  // Both scorings are computed every tick, and ONE aggregate row is journaled
  // (not one per symbol — see the excluded_re volume problem). That is the
  // point of the flag: the shift is measurable while the flag is still OFF,
  // rather than only after it has already moved a live entry. Turning it on
  // rescales the whole distribution, and liveMinSignalScore was fitted to the
  // RAW distribution against realized P&L, so enabling it without re-fitting
  // that floor silently moves the entry gate.
  //
  // Re-scores from the retained snapshots — no second fetch, no second
  // indicator computation, and through the same selectFromSnapshot the first
  // pass used, so the two passes cannot differ except in the component.
  // ---------------------------------------------------------------------
  const paceCfg: ScreenerConfig = { ...cfg, relVolUsePaceScoring: true };
  const rawCfg: ScreenerConfig = { ...cfg, relVolUsePaceScoring: false };
  const withPace = (ind: IndicatorSnapshot | null): IndicatorSnapshot | null =>
    ind === null ? null : { ...ind, relVolPace: relVolPace(ind.relVolume, median) };

  const shadow = { n: 0, rawZero: 0, paceZero: 0, totalDelta: 0, wouldPass: 0, wouldFail: 0 };
  for (const { symbol, ind, fallbackPrice } of scoredSnapshots) {
    const paced = withPace(ind);
    const rawPick = selectFromSnapshot(symbol, ind, fallbackPrice, rawCfg, directionMode);
    const pacePick = selectFromSnapshot(symbol, paced, fallbackPrice, paceCfg, directionMode);

    // Whichever scoring is CONFIGURED is the one that decides what happens;
    // the other exists only to be counted. Selected here, from the same two
    // results the comparison below reads, so the journal can never describe a
    // decision the screen did not actually make.
    const chosen = cfg.relVolUsePaceScoring ? pacePick : rawPick;
    if (chosen.rejected) rejected.push(chosen.rejected);
    if (chosen.picked) {
      pendingCandidates.push({
        symbol,
        candidate: {
          ...chosen.picked.score,
          direction: chosen.picked.direction,
          discoverySource: fromMovers.has(symbol) ? 'movers' : 'universe',
          // Filled in below, once the universe median this tick is known.
          relVolPace: null,
        },
      });
    }
    // Symbols that fail the score filters (not RE) are just omitted — logging
    // every routine non-match would flood the journal every cycle.

    // Counted over EVERY scored symbol, not just the ones that passed — the
    // component-zero rate this exists to measure is a property of the whole
    // universe, and restricting it to survivors would measure it only where
    // the rest of the score already carried the symbol through.
    //
    // The relative-volume component is direction-free (scoreRelVol never reads
    // cfg.direction), so its two scores are comparable even when the better
    // SIDE differs between the two scorings. The totals are compared on each
    // scoring's own better side, which is the number the screen would act on.
    const rawComponent = rawPick.best.components.find((c) => c.key === 'relativeVolume');
    const paceComponent = pacePick.best.components.find((c) => c.key === 'relativeVolume');
    if (rawComponent && paceComponent) {
      shadow.n += 1;
      if (rawComponent.score === 0) shadow.rawZero += 1;
      if (paceComponent.score === 0) shadow.paceZero += 1;
      shadow.totalDelta += pacePick.best.total - rawPick.best.total;
    }
    // A symbol that only ONE of the two scorings lets through is the thing
    // that actually changes what gets traded, so it is counted separately
    // from the average score move — an average can be flat while the set of
    // candidates turns over completely.
    if (!rawPick.picked && pacePick.picked) shadow.wouldPass += 1;
    if (rawPick.picked && !pacePick.picked) shadow.wouldFail += 1;
  }
  logAutotradeEvent({
    stage: 'screen',
    action: 'relvol_pace_scoring_shadow',
    detail: {
      enabled: cfg.relVolUsePaceScoring,
      universeMedian: median,
      scored: scoredSnapshots.length,
      // Across every scored symbol: how many score zero on this component
      // under each scoring. The headline number this exists to track — 8 of
      // 15 live ENTRIES scored zero on it, on 20% of the weight.
      compared: shadow.n,
      relVolComponentZeroRaw: shadow.rawZero,
      relVolComponentZeroPace: shadow.paceZero,
      meanTotalDelta: shadow.n > 0 ? Math.round((shadow.totalDelta / shadow.n) * 100) / 100 : null,
      // The set change, which an average score move can completely hide.
      wouldNewlyPass: shadow.wouldPass,
      wouldNewlyFail: shadow.wouldFail,
      relVolPaceTarget: cfg.relVolPaceTarget,
      note: cfg.relVolUsePaceScoring
        ? 'pace scoring is ACTIVE — the counts describe what raw scoring would have done instead'
        : 'pace scoring is OFF — the counts describe what it would do if enabled',
    },
  });

  for (const { symbol, candidate } of pendingCandidates) {
    const pace = relVolPace(candidate.indicators.relVolume, median);
    if (paceFloor > 0 && pace !== null && pace < paceFloor) {
      const reason = `Trading at ${pace}x the market's current pace (needs ${paceFloor}x)`;
      excluded.push({ symbol, reason });
      logAutotradeEvent({
        symbol,
        stage: 'screen',
        action: 'excluded_rel_vol_pace',
        detail: { reason, pace, paceFloor, relVolume: candidate.indicators.relVolume, universeMedian: median },
      });
      continue;
    }
    candidate.relVolPace = pace;
    candidates.push(candidate);
    logAutotradeEvent({
      symbol,
      stage: 'screen',
      action: 'candidate_found',
      detail: {
        direction: candidate.direction,
        total: candidate.total,
        price: candidate.price,
        gapPct: candidate.indicators.gapPct,
        relVolume: candidate.indicators.relVolume,
        relVolPace: pace,
        // 'universe' or 'movers' (2026-09-02). The field has existed on
        // ScreenCandidate since movers discovery shipped and drives real
        // behaviour — moversPromotion counts occurrences only for 'movers',
        // and the options decision considers only 'universe' — but it was
        // recorded NOWHERE, so "how much is movers discovery actually
        // contributing" was unanswerable from the journal across 400
        // sampled candidate_found rows. Measured once by hand on 2026-09-02:
        // 35 movers fetched, 563 symbols scanned, 225 candidates, of which
        // exactly ONE was movers-sourced. That ratio is the thing this field
        // makes visible over time instead of on demand.
        discoverySource: candidate.discoverySource,
        // Per-component scores (2026-08-26). The total alone cannot answer the
        // question the weights argument keeps running into: which components
        // actually predict a realized outcome, and which are along for the
        // ride? Nothing recorded them anywhere — not here, and not on the
        // position, whose entry_score is likewise only the total — so any
        // attribution over historical trades would have been reconstructed
        // from a snapshot rather than measured.
        //
        // Recorded as {key: score} without the weights: the weights are a
        // config value that can be read for the same date, while the SCORES
        // are the perishable part, computed from indicator values this tick
        // that nothing else keeps. Joined to a closed position by
        // symbol + ET date, which is unambiguous here because a symbol can
        // hold only one live position at a time.
        components: Object.fromEntries(candidate.components.map((c) => [c.key, Math.round(c.score * 10) / 10])),
      },
    });
  }

  candidates.sort((a, b) => b.total - a.total);
  return {
    generatedAt: Date.now(),
    candidates,
    excluded,
    skipped,
    errors,
    rejected,
    relVolMedian: median,
    discovery: { universeCount, moversCount, scannedCount: symbols.length, moversError },
  };
}

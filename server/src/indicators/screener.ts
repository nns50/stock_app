import { Candle, Quote } from '../providers/types';
import {
  atrSeries,
  distanceFromMa,
  gapPercent,
  latest,
  meanOfLast,
  percentChange,
  relativeVolume,
  rsiSeries,
  smaSeries,
} from './indicators';

// ---------------------------------------------------------------------------
// Transparent, configurable scoring engine.
//
// Design goals (from the spec): "No black boxes — every score must be
// explainable from its components." So each indicator produces a normalized
// 0..100 sub-score, multiplied by its weight; the total is the weighted average
// (also 0..100). The full breakdown (raw value, sub-score, weight, contribution,
// and a human note) travels with every result.
// ---------------------------------------------------------------------------

export type Direction = 'long' | 'short';

export type IndicatorKey = 'momentum' | 'relativeVolume' | 'rsi' | 'volatility' | 'gap' | 'trend' | 'relativeStrength';

export type IndicatorWeights = Record<IndicatorKey, number>;

export interface ScreenerFilters {
  minPrice?: number;
  maxPrice?: number;
  minAvgVolume?: number;
  minRelVol?: number;
  rsiMin?: number;
  rsiMax?: number;
  /** Require price to align with the chosen direction relative to its MAs. */
  requireTrendAlignment?: boolean;
  /** Require price to ALSO align with the chosen direction relative to its
   *  WEEKLY moving average (2026-07-16, docs/AUTOTRADING_SPEC.md phase 19) —
   *  a second, longer-horizon confirmation on top of requireTrendAlignment's
   *  daily-only check, same cfg.maShort period reused on a weekly candle
   *  series instead of a second config field. Fails CLOSED like
   *  requireTrendAlignment does: unavailable weekly data (insufficient
   *  history, or the caller didn't compute one at all — see
   *  IndicatorSnapshot.weeklyMaShort) blocks the candidate rather than
   *  silently passing it. */
  requireWeeklyTrendAlignment?: boolean;
}

export interface ScreenerConfig {
  direction: Direction;
  weights: IndicatorWeights;
  maShort: number;
  maLong: number;
  rsiPeriod: number;
  atrPeriod: number;
  /** % move that maps to a full momentum sub-score. */
  momentumScale: number;
  /** Relative volume that maps to a full rel-vol sub-score. */
  relVolTarget: number;
  /** RSI value that scores best for a LONG; mirrored for SHORT. */
  rsiSweetSpot: number;
  /** Half-width of the RSI "tent" scoring function. */
  rsiWidth: number;
  /** ATR% that maps to a full volatility sub-score. */
  atrPctScale: number;
  /** Gap% (in the trade direction) that maps to a full gap sub-score. */
  gapScale: number;
  /** Trading days back for both the candidate's own and the benchmark's
   *  lookback return (relativeStrength component below). */
  relativeStrengthLookbackDays: number;
  /** Excess return (candidate's lookback return minus the benchmark's, in
   *  the trade direction) that maps to a full relativeStrength sub-score. */
  relativeStrengthScale: number;
  /** Symbol the relativeStrength component measures outperformance against
   *  — e.g. 'SPY'. Only matters when weights.relativeStrength is nonzero;
   *  the caller (screen.ts) is responsible for fetching this symbol's own
   *  candles and passing its lookback return into computeIndicators/
   *  scoreSymbol as benchmarkLookbackReturnPct — this module never fetches
   *  data itself. */
  benchmarkSymbol: string;
  filters: ScreenerFilters;
}

export interface IndicatorSnapshot {
  price: number;
  changePct: number | null;
  maShort: number | null;
  maLong: number | null;
  distShortPct: number | null;
  distLongPct: number | null;
  rsi: number | null;
  atr: number | null;
  atrPct: number | null;
  relVolume: number | null;
  avgVolume: number | null;
  volume: number | null;
  gapPct: number | null;
  /** WEEKLY-timeframe maShort (2026-07-16) — null when the caller didn't
   *  compute/pass one in (see computeIndicators's own weeklyIndicators
   *  param), not just when weekly history is insufficient; either way,
   *  requireWeeklyTrendAlignment treats null as "not confirmed," same
   *  fail-closed posture as requireTrendAlignment's own daily maShort. */
  weeklyMaShort: number | null;
  /** This symbol's own % price change over cfg.relativeStrengthLookbackDays
   *  trading days (computed straight from the same daily `candles` array
   *  every other indicator here already uses — no extra fetch). Null when
   *  history doesn't reach back that far. */
  symbolLookbackReturnPct: number | null;
  /** The benchmark's (cfg.benchmarkSymbol) % change over the SAME lookback
   *  window — null whenever the caller didn't pass one in (see
   *  computeIndicators's own benchmarkLookbackReturnPct param), same
   *  "null means not computed this cycle" convention as weeklyMaShort. */
  benchmarkLookbackReturnPct: number | null;
}

export interface ComponentScore {
  key: IndicatorKey;
  label: string;
  value: number | null;
  display: string;
  score: number; // 0..100
  weight: number;
  contribution: number; // score * weight (pre-normalization)
  note: string;
}

export interface SymbolScore {
  symbol: string;
  price: number;
  total: number; // 0..100 weighted average
  passedFilters: boolean;
  filterReasons: string[];
  components: ComponentScore[];
  indicators: IndicatorSnapshot;
}

export function defaultScreenerConfig(): ScreenerConfig {
  return {
    direction: 'long',
    weights: { momentum: 30, relativeVolume: 20, rsi: 15, volatility: 10, gap: 10, trend: 15, relativeStrength: 0 },
    maShort: 20,
    maLong: 50,
    rsiPeriod: 14,
    atrPeriod: 14,
    momentumScale: 5,
    relVolTarget: 2,
    rsiSweetSpot: 60,
    rsiWidth: 25,
    atrPctScale: 5,
    gapScale: 3,
    relativeStrengthLookbackDays: 20,
    relativeStrengthScale: 10,
    benchmarkSymbol: 'SPY',
    filters: { minPrice: 1, minAvgVolume: 200_000 },
  };
}

/** Merge a partial (from an API request / preset) onto the defaults. */
export function resolveScreenerConfig(partial?: Partial<ScreenerConfig>): ScreenerConfig {
  const base = defaultScreenerConfig();
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    weights: { ...base.weights, ...(partial.weights ?? {}) },
    filters: { ...base.filters, ...(partial.filters ?? {}) },
  };
}

// --- normalization helpers -------------------------------------------------

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear map of `value` in [from..to] -> [0..100], clamped. */
function scale01(value: number, from: number, to: number): number {
  if (to === from) return 0;
  return clamp(((value - from) / (to - from)) * 100);
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  return v === null ? '—' : v.toFixed(digits);
}

/** The candle-only (quote-independent) piece of computeIndicators — SMA/RSI/
 *  ATR only ever depend on historical bars, never the live quote, so a
 *  caller re-scoring the SAME symbol on an UNCHANGED latest candle (screen.ts's
 *  every-60s tick — a daily bar only actually changes once a day) can cache
 *  and reuse this exact result, rather than recomputing smaSeries/rsiSeries/
 *  atrSeries (the heaviest part of scoring) on every tick regardless. */
export interface CandleIndicators {
  maShort: number | null;
  maLong: number | null;
  rsiVal: number | null;
  atrVal: number | null;
}

export function computeCandleIndicators(candles: Candle[], cfg: ScreenerConfig): CandleIndicators | null {
  if (candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  return {
    maShort: latest(smaSeries(closes, cfg.maShort)),
    maLong: latest(smaSeries(closes, cfg.maLong)),
    rsiVal: latest(rsiSeries(closes, cfg.rsiPeriod)),
    atrVal: latest(atrSeries(candles, cfg.atrPeriod)),
  };
}

export interface CandleIndicatorSeries {
  maShort: (number | null)[];
  maLong: (number | null)[];
  rsi: (number | null)[];
  atr: (number | null)[];
}

/** Precomputes the full SMA/RSI/ATR series over the ENTIRE candles array in a
 *  single O(n) pass each. A caller that needs the candle-indicator snapshot at
 *  MANY different "as of index i" points over the SAME candles array — a
 *  backtest's day-by-day walk-forward loop, one lookup per simulated day — can
 *  compute this ONCE up front, then read each day's answer via the O(1)
 *  candleIndicatorsAt() lookup below, instead of re-slicing history and
 *  recomputing computeCandleIndicators() from scratch on every single
 *  simulated day (the O(days²) cost this replaces).
 *
 *  This is mathematically IDENTICAL to calling computeCandleIndicators()
 *  fresh on candles.slice(0, i + 1) for every i: smaSeries/rsiSeries/
 *  atrSeries are all already causal — index i's value depends only on
 *  candles[0..i], never anything after it (a fixed trailing window for SMA;
 *  a forward-only Wilder recurrence seeded from a fixed start for RSI/ATR).
 *  Verified in screener.test.ts. */
export function computeCandleIndicatorSeries(candles: Candle[], cfg: ScreenerConfig): CandleIndicatorSeries {
  const closes = candles.map((c) => c.close);
  return {
    maShort: smaSeries(closes, cfg.maShort),
    maLong: smaSeries(closes, cfg.maLong),
    rsi: rsiSeries(closes, cfg.rsiPeriod),
    atr: atrSeries(candles, cfg.atrPeriod),
  };
}

/** O(1) lookup of the candle-indicator snapshot at index `i` of a precomputed
 *  computeCandleIndicatorSeries() result. Null whenever computeCandleIndicators
 *  itself would be — out of range, or fewer than 2 candles through `i` — a
 *  still-warming-up index short of that (e.g. i < maLong's period) instead
 *  returns an object with those individual fields null, same as
 *  computeCandleIndicators would for a too-short-but-still-≥2 history. */
export function candleIndicatorsAt(series: CandleIndicatorSeries, i: number): CandleIndicators | null {
  if (i < 1 || i >= series.maShort.length) return null;
  return { maShort: series.maShort[i], maLong: series.maLong[i], rsiVal: series.rsi[i], atrVal: series.atr[i] };
}

/** Build the indicator snapshot from candles + (optional) live quote.
 *
 *  `cachedCandleIndicators`, when passed, must already be the correct
 *  computeCandleIndicators() (or candleIndicatorsAt()) result as of
 *  `asOfIndex` — skips recomputing SMA/RSI/ATR, but every quote-dependent
 *  field below (price, change%, volume, gap) is still derived fresh every
 *  call regardless, since those genuinely change on every live quote tick
 *  and must never be served stale.
 *
 *  `asOfIndex` (default candles.length - 1, i.e. "the whole array" — the
 *  original behavior, unchanged for any caller that omits it) lets a caller
 *  treat `candles` as a fixed FULL history and simulate "as of this earlier
 *  day" without slicing it down first — a backtest's day-by-day loop needs
 *  exactly this to avoid an O(n) array copy on every single simulated day.
 *
 *  `weeklyIndicators` (2026-07-16): the CLOSED-week counterpart of
 *  `cachedCandleIndicators` — the caller computes it (via
 *  computeCandleIndicators/candleIndicatorsAt against a WEEKLY candle
 *  series, using closedWeeklyIndexAsOf — see backtest.ts's own doc comment
 *  on why the plain daily indexAsOf() can't be reused here) and passes only
 *  its `.maShort` through onto the returned snapshot. Undefined/null (the
 *  default) when the caller hasn't computed one — e.g. because
 *  requireWeeklyTrendAlignment isn't actually enabled, matching this
 *  codebase's established "don't do work nobody asked for" convention (see
 *  optionsExecute.ts's priceRulesActive gate for the same pattern).
 *
 *  `benchmarkLookbackReturnPct` (2026-07-17): the benchmark's own % change
 *  over cfg.relativeStrengthLookbackDays trading days, ending on the SAME
 *  date this call is scoring — the caller (screen.ts, or a backtest engine)
 *  computes it once per cycle/day from the benchmark's OWN candle series and
 *  passes it straight through onto the returned snapshot, mirroring how
 *  weeklyIndicators is computed by the caller and passed through above.
 *  Undefined/null (the default) when the caller hasn't computed one — e.g.
 *  because weights.relativeStrength is 0, matching requireWeeklyTrendAlignment's
 *  own don't-do-unrequested-work convention. */
/** % change of `candles`' close at `asOfIndex` (default the last one) vs. the
 *  close `lookbackDays` trading days earlier. Null when history doesn't
 *  reach back that far — same "insufficient history means null, never a
 *  fabricated 0" posture every other indicator in this file has. Exported so
 *  a caller (screen.ts, or a backtest engine) can apply the EXACT SAME index
 *  arithmetic computeIndicators uses internally for a candidate's own
 *  symbolLookbackReturnPct to a SEPARATE symbol's candles — the benchmark —
 *  without a second, potentially-drifting implementation. */
export function lookbackReturnPct(candles: Candle[], lookbackDays: number, asOfIndex?: number): number | null {
  const end = asOfIndex ?? candles.length - 1;
  if (end < 0 || end >= candles.length) return null;
  const lookbackIndex = end - lookbackDays;
  if (lookbackIndex < 0) return null;
  return percentChange(candles[end].close, candles[lookbackIndex].close);
}

export function computeIndicators(
  candles: Candle[],
  quote: Quote | undefined,
  cfg: ScreenerConfig,
  cachedCandleIndicators?: CandleIndicators,
  asOfIndex?: number,
  weeklyIndicators?: CandleIndicators | null,
  benchmarkLookbackReturnPct?: number | null,
): IndicatorSnapshot | null {
  const end = asOfIndex ?? candles.length - 1;
  if (end < 1 || end >= candles.length) return null;
  const last = candles[end];
  const prev = candles[end - 1];
  const price = quote?.last ?? last.close;

  // Only reached when the caller didn't already supply a cache — falls back
  // to computing fresh over exactly the bars through `end` (never the full
  // array beyond it, which would leak future bars into a backtest's "as of
  // today" score).
  const candleIndicators = cachedCandleIndicators ?? computeCandleIndicators(candles.slice(0, end + 1), cfg);
  if (!candleIndicators) return null;
  const { maShort, maLong, rsiVal, atrVal } = candleIndicators;

  const changePct = quote?.changePct ?? percentChange(last.close, prev.close);
  // The 20 bars immediately preceding `end` (today excluded) — bounded
  // window instead of mapping/slicing the full candles array, matching
  // meanOfLast(volumes.slice(0, -1), 20)'s original semantics exactly.
  const priorVolumes = candles.slice(Math.max(0, end - 20), end).map((c) => c.volume);
  const avgVolume = quote?.avgVolume ?? meanOfLast(priorVolumes, 20);
  const volume = quote?.volume ?? last.volume;
  const relVol = avgVolume ? relativeVolume(volume, avgVolume) : null;
  const openForGap = quote?.open ?? last.open;
  const gap = gapPercent(openForGap, prev.close);

  // Candidate's own lookback return — straight from the same daily candles
  // array every other indicator here already has in hand, no extra fetch.
  const symbolLookbackReturnPct = lookbackReturnPct(candles, cfg.relativeStrengthLookbackDays, end);

  return {
    price,
    changePct,
    maShort,
    maLong,
    distShortPct: distanceFromMa(price, maShort),
    distLongPct: distanceFromMa(price, maLong),
    rsi: rsiVal,
    atr: atrVal,
    atrPct: atrVal !== null && price ? (atrVal / price) * 100 : null,
    relVolume: relVol,
    avgVolume,
    volume,
    gapPct: gap,
    weeklyMaShort: weeklyIndicators?.maShort ?? null,
    symbolLookbackReturnPct,
    benchmarkLookbackReturnPct: benchmarkLookbackReturnPct ?? null,
  };
}

// --- per-component scoring (direction-aware) -------------------------------

function scoreMomentum(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  const sign = cfg.direction === 'long' ? 1 : -1;
  const parts: number[] = [];
  const descr: string[] = [];
  if (ind.changePct !== null) {
    parts.push(scale01(sign * ind.changePct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`Δ ${fmtPct(ind.changePct)}`);
  }
  if (ind.distShortPct !== null) {
    parts.push(scale01(sign * ind.distShortPct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`${cfg.maShort}MA ${fmtPct(ind.distShortPct)}`);
  }
  if (ind.distLongPct !== null) {
    parts.push(scale01(sign * ind.distLongPct, -cfg.momentumScale, cfg.momentumScale));
    descr.push(`${cfg.maLong}MA ${fmtPct(ind.distLongPct)}`);
  }
  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { score, note: `${cfg.direction} momentum from ${descr.join(', ') || 'n/a'}` };
}

function scoreRelVol(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.relVolume === null) return { score: 0, note: 'no volume data' };
  const score = scale01(ind.relVolume, 0.5, cfg.relVolTarget);
  return { score, note: `${ind.relVolume.toFixed(2)}× avg volume (target ${cfg.relVolTarget}×)` };
}

function scoreRsi(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.rsi === null) return { score: 0, note: 'no RSI (insufficient history)' };
  const sweet = cfg.direction === 'long' ? cfg.rsiSweetSpot : 100 - cfg.rsiSweetSpot;
  const score = clamp((1 - Math.abs(ind.rsi - sweet) / cfg.rsiWidth) * 100);
  return { score, note: `RSI ${ind.rsi.toFixed(1)} vs sweet spot ${sweet} (±${cfg.rsiWidth})` };
}

function scoreVolatility(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.atrPct === null) return { score: 0, note: 'no ATR (insufficient history)' };
  const score = scale01(ind.atrPct, 0, cfg.atrPctScale);
  return { score, note: `ATR ${ind.atrPct.toFixed(2)}% of price (more range scores higher, capped)` };
}

function scoreGap(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.gapPct === null) return { score: 0, note: 'no gap data' };
  const sign = cfg.direction === 'long' ? 1 : -1;
  const score = scale01(sign * ind.gapPct, 0, cfg.gapScale);
  return { score, note: `gap ${fmtPct(ind.gapPct)} (${cfg.direction}-favorable gaps score higher)` };
}

/** Outperformance vs. cfg.benchmarkSymbol over cfg.relativeStrengthLookbackDays
 *  — direction-aware like every other component: a LONG candidate scores
 *  higher for beating the benchmark, a SHORT candidate scores higher for
 *  lagging it (relative WEAKNESS favors a short thesis). 0/no-note whenever
 *  either side of the comparison is unavailable (insufficient candidate
 *  history, or the caller never computed a benchmark return — see
 *  computeIndicators's own benchmarkLookbackReturnPct param) rather than
 *  guessing — matches every other "no data" branch in this file. */
function scoreRelativeStrength(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.symbolLookbackReturnPct === null || ind.benchmarkLookbackReturnPct === null) {
    return { score: 0, note: 'no relative-strength data' };
  }
  const excess = ind.symbolLookbackReturnPct - ind.benchmarkLookbackReturnPct;
  const sign = cfg.direction === 'long' ? 1 : -1;
  const score = scale01(sign * excess, -cfg.relativeStrengthScale, cfg.relativeStrengthScale);
  return {
    score,
    note:
      `${fmtPct(ind.symbolLookbackReturnPct)} vs ${cfg.benchmarkSymbol} ${fmtPct(ind.benchmarkLookbackReturnPct)} ` +
      `over ${cfg.relativeStrengthLookbackDays}d (${fmtPct(excess)} excess)`,
  };
}

function scoreTrend(ind: IndicatorSnapshot, cfg: ScreenerConfig): { score: number; note: string } {
  if (ind.maShort === null || ind.maLong === null) {
    return { score: 0, note: 'no MAs (insufficient history)' };
  }
  const long = cfg.direction === 'long';
  const conds = [
    long ? ind.price > ind.maShort : ind.price < ind.maShort,
    long ? ind.price > ind.maLong : ind.price < ind.maLong,
    long ? ind.maShort > ind.maLong : ind.maShort < ind.maLong,
  ];
  const passed = conds.filter(Boolean).length;
  const score = (passed / conds.length) * 100;
  return {
    score,
    note: `${passed}/3 trend conditions met (price vs ${cfg.maShort}/${cfg.maLong}MA, MA alignment)`,
  };
}

// --- main entry ------------------------------------------------------------

const LABELS: Record<IndicatorKey, string> = {
  momentum: 'Momentum',
  relativeVolume: 'Rel. Volume',
  rsi: 'RSI',
  volatility: 'Volatility (ATR%)',
  gap: 'Gap',
  trend: 'Trend',
  relativeStrength: 'Rel. Strength',
};

/** Score a single symbol; returns the full transparent breakdown.
 *  `cachedCandleIndicators`/`asOfIndex`/`weeklyIndicators`/
 *  `benchmarkLookbackReturnPct` pass straight through to computeIndicators —
 *  see its own doc comment. */
export function scoreSymbol(
  symbol: string,
  candles: Candle[],
  quote: Quote | undefined,
  cfg: ScreenerConfig,
  cachedCandleIndicators?: CandleIndicators,
  asOfIndex?: number,
  weeklyIndicators?: CandleIndicators | null,
  benchmarkLookbackReturnPct?: number | null,
): SymbolScore {
  const ind = computeIndicators(
    candles,
    quote,
    cfg,
    cachedCandleIndicators,
    asOfIndex,
    weeklyIndicators,
    benchmarkLookbackReturnPct,
  );
  return scoreFromIndicators(symbol, ind, cfg, quote?.last ?? 0);
}

/** Score both directions for the same symbol from ONE indicator computation —
 *  the indicators themselves (SMA/RSI/ATR/price/volume/gap) never depend on
 *  `cfg.direction`; only the per-component SCORING math below does (a cheap,
 *  already-computed-snapshot pass). Lets a caller that wants to know "is this
 *  symbol a better long or short candidate right now" avoid computing
 *  SMA/RSI/ATR series twice (scoreSymbol's own heaviest work) just to answer
 *  a question that's cheap once the snapshot exists. `cfg.direction` itself
 *  is ignored here — both directions are always scored regardless of what it
 *  was set to, so callers can pass their existing single-direction config
 *  unchanged. */
export function scoreSymbolBothDirections(
  symbol: string,
  candles: Candle[],
  quote: Quote | undefined,
  cfg: ScreenerConfig,
  cachedCandleIndicators?: CandleIndicators,
  asOfIndex?: number,
  weeklyIndicators?: CandleIndicators | null,
  benchmarkLookbackReturnPct?: number | null,
): { long: SymbolScore; short: SymbolScore } {
  const ind = computeIndicators(
    candles,
    quote,
    cfg,
    cachedCandleIndicators,
    asOfIndex,
    weeklyIndicators,
    benchmarkLookbackReturnPct,
  );
  const fallbackPrice = quote?.last ?? 0;
  return {
    long: scoreFromIndicators(symbol, ind, { ...cfg, direction: 'long' }, fallbackPrice),
    short: scoreFromIndicators(symbol, ind, { ...cfg, direction: 'short' }, fallbackPrice),
  };
}

function scoreFromIndicators(
  symbol: string,
  ind: IndicatorSnapshot | null,
  cfg: ScreenerConfig,
  fallbackPrice: number,
): SymbolScore {
  if (!ind) {
    return {
      symbol,
      price: fallbackPrice,
      total: 0,
      passedFilters: false,
      filterReasons: ['insufficient price history'],
      components: [],
      indicators: emptySnapshot(fallbackPrice),
    };
  }

  const scored: Record<IndicatorKey, { score: number; note: string }> = {
    momentum: scoreMomentum(ind, cfg),
    relativeVolume: scoreRelVol(ind, cfg),
    rsi: scoreRsi(ind, cfg),
    volatility: scoreVolatility(ind, cfg),
    gap: scoreGap(ind, cfg),
    trend: scoreTrend(ind, cfg),
    relativeStrength: scoreRelativeStrength(ind, cfg),
  };

  const rawValues: Record<IndicatorKey, { value: number | null; display: string }> = {
    momentum: { value: ind.changePct, display: fmtPct(ind.changePct) },
    relativeVolume: { value: ind.relVolume, display: ind.relVolume === null ? '—' : `${ind.relVolume.toFixed(2)}×` },
    rsi: { value: ind.rsi, display: fmtNum(ind.rsi, 1) },
    volatility: { value: ind.atrPct, display: ind.atrPct === null ? '—' : `${ind.atrPct.toFixed(2)}%` },
    gap: { value: ind.gapPct, display: fmtPct(ind.gapPct) },
    trend: { value: ind.maShort, display: ind.maShort === null ? '—' : `${cfg.maShort}MA ${ind.maShort.toFixed(2)}` },
    relativeStrength: {
      value:
        ind.symbolLookbackReturnPct !== null && ind.benchmarkLookbackReturnPct !== null
          ? ind.symbolLookbackReturnPct - ind.benchmarkLookbackReturnPct
          : null,
      display:
        ind.symbolLookbackReturnPct === null || ind.benchmarkLookbackReturnPct === null
          ? '—'
          : fmtPct(ind.symbolLookbackReturnPct - ind.benchmarkLookbackReturnPct),
    },
  };

  const keys = Object.keys(cfg.weights) as IndicatorKey[];
  let weightSum = 0;
  let weighted = 0;
  const components: ComponentScore[] = keys.map((key) => {
    const weight = Math.max(0, cfg.weights[key] ?? 0);
    const { score, note } = scored[key];
    weightSum += weight;
    weighted += score * weight;
    return {
      key,
      label: LABELS[key],
      value: rawValues[key].value,
      display: rawValues[key].display,
      score: Math.round(score * 10) / 10,
      weight,
      contribution: Math.round(score * weight * 10) / 10,
      note,
    };
  });

  const total = weightSum > 0 ? weighted / weightSum : 0;
  const { passed, reasons } = applyFilters(ind, cfg);

  return {
    symbol,
    price: ind.price,
    total: Math.round(total * 10) / 10,
    passedFilters: passed,
    filterReasons: reasons,
    components,
    indicators: ind,
  };
}

function applyFilters(ind: IndicatorSnapshot, cfg: ScreenerConfig): { passed: boolean; reasons: string[] } {
  const f = cfg.filters;
  const reasons: string[] = [];
  if (f.minPrice !== undefined && ind.price < f.minPrice) reasons.push(`price < ${f.minPrice}`);
  if (f.maxPrice !== undefined && ind.price > f.maxPrice) reasons.push(`price > ${f.maxPrice}`);
  if (f.minAvgVolume !== undefined && (ind.avgVolume ?? 0) < f.minAvgVolume)
    reasons.push(`avg vol < ${f.minAvgVolume.toLocaleString()}`);
  if (f.minRelVol !== undefined && (ind.relVolume ?? 0) < f.minRelVol) reasons.push(`rel vol < ${f.minRelVol}`);
  if (f.rsiMin !== undefined && (ind.rsi ?? -1) < f.rsiMin) reasons.push(`RSI < ${f.rsiMin}`);
  if (f.rsiMax !== undefined && (ind.rsi ?? 101) > f.rsiMax) reasons.push(`RSI > ${f.rsiMax}`);
  if (f.requireTrendAlignment) {
    const long = cfg.direction === 'long';
    const aligned =
      ind.maShort !== null && ind.maLong !== null && (long ? ind.price > ind.maShort : ind.price < ind.maShort);
    if (!aligned) reasons.push(`not ${cfg.direction}-aligned vs ${cfg.maShort}MA`);
  }
  if (f.requireWeeklyTrendAlignment) {
    const long = cfg.direction === 'long';
    const aligned =
      ind.weeklyMaShort !== null && (long ? ind.price > ind.weeklyMaShort : ind.price < ind.weeklyMaShort);
    if (!aligned) reasons.push(`not ${cfg.direction}-aligned vs weekly ${cfg.maShort}MA`);
  }
  return { passed: reasons.length === 0, reasons };
}

function emptySnapshot(price: number): IndicatorSnapshot {
  return {
    price,
    changePct: null,
    maShort: null,
    maLong: null,
    distShortPct: null,
    distLongPct: null,
    rsi: null,
    atr: null,
    atrPct: null,
    relVolume: null,
    avgVolume: null,
    volume: null,
    gapPct: null,
    weeklyMaShort: null,
    symbolLookbackReturnPct: null,
    benchmarkLookbackReturnPct: null,
  };
}

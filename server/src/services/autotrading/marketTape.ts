import { MarketBreadth, MarketDirection, MIN_BREADTH_SAMPLE } from './marketDirection';

// ---------------------------------------------------------------------------
// The tape score (2026-09-26, the tape plan's PR 6): MEASUREMENT ONLY.
//
// The market-direction reading (marketDirection.ts) answers one question with
// a label: is the market broadly red, broadly green, or neither? A label has
// three values, so it cannot say how red a red day is, whether a mixed tape is
// leaning, or whether the lean is growing or fading. The score answers those
// on a -100..+100 scale from six legs, each a plain market quantity:
//
//   leg                                   weight   saturates at (P90 of |x|)
//   SPY+QQQ vs the previous close           25      1.17%
//   breadth: (green - red) / sample         25      0.42
//   SPY+QQQ vs today's open                 15      0.77%
//   SPY+QQQ vs the session VWAP             15      0.39%
//   SPY+QQQ over the last 30 minutes        10      0.23%
//   breadth's change over 30 minutes        10      0.11
//
// Each leg's sub-score is its value over its scale, clamped to [-1, +1]; the
// score is 100 x the weighted mean of the legs present. A missing leg is left
// out and the weights renormalize over the rest (`coverage` says how much of
// the weight was present). The SPY+QQQ legs average the two indexes over
// whichever answered.
//
// The scales are FROZEN, not config: each is that leg's 90th percentile of
// |value| over 40 sessions (2026-07-31..09-25, 3,120 five-minute slots,
// every name in the universe for breadth), measured on the tape backfill's
// copy (docs/AUTOTRADING_SPEC.md, 2026-09-26 (tenth)). A setting would let a
// scale be tuned to whatever the score is later asked to predict.
//
// The score is NULL exactly when the label is `unknown`. When the label can
// be read, the first two legs are the label's own inputs (its SPY move and its
// breadth), so a known label always has a score.
//
// IT GATES NOTHING AND SIZES NOTHING. Nothing on the entry path reads it; the
// loop records it on each tick's summary and journals it (MARKET_TAPE_ACTION),
// so the edge-leak scan can place every entry of both books against it. The
// plan's rule D gives it a first decision role only after 20 live-scored
// sessions, and only where the backfill and the live window agree.
//
// A LEAF module on purpose: its only import is marketDirection.ts, so the test
// setup can reset its state (test/setupProcessState.ts).
// ---------------------------------------------------------------------------

export type TapeLeg =
  'indexVsPrevClose' | 'breadthNet' | 'indexVsOpen' | 'indexVsVwap' | 'indexSlope30' | 'breadthMomentum30';

export interface TapeLegSpec {
  leg: TapeLeg;
  /** Points of the 100 the leg carries. */
  weight: number;
  /** The |value| at which the leg's sub-score reaches +/-1: the leg's P90. */
  scale: number;
  /** `pct`: a percent move. `share`: a net share of the universe, -1..+1. */
  unit: 'pct' | 'share';
}

export const TAPE_LEGS: readonly TapeLegSpec[] = [
  { leg: 'indexVsPrevClose', weight: 25, scale: 1.17, unit: 'pct' },
  { leg: 'breadthNet', weight: 25, scale: 0.42, unit: 'share' },
  { leg: 'indexVsOpen', weight: 15, scale: 0.77, unit: 'pct' },
  { leg: 'indexVsVwap', weight: 15, scale: 0.39, unit: 'pct' },
  { leg: 'indexSlope30', weight: 10, scale: 0.23, unit: 'pct' },
  { leg: 'breadthMomentum30', weight: 10, scale: 0.11, unit: 'share' },
];

/** Each leg's value this tick; null when it could not be measured. */
export type TapeLegInputs = Record<TapeLeg, number | null>;

export interface TapeComponent {
  leg: TapeLeg;
  /** The measured value (4 decimals), in the leg's unit. */
  value: number | null;
  /** value / scale, clamped to [-1, +1] (3 decimals). Null when unmeasured. */
  sub: number | null;
  weight: number;
  scale: number;
}

export interface TapeScore {
  /** -100 (every leg at its red extreme) .. +100. Null when the label is
   *  `unknown`. */
  score: number | null;
  /** Percent of the legs' total weight that was measured. */
  coverage: number;
  components: TapeComponent[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Score the tape from its legs (see the header for the rule). Pure. */
export function scoreMarketTape(direction: MarketDirection, inputs: TapeLegInputs): TapeScore {
  let weighted = 0;
  let presentWeight = 0;
  let totalWeight = 0;
  const components: TapeComponent[] = TAPE_LEGS.map((spec) => {
    totalWeight += spec.weight;
    const raw = inputs[spec.leg];
    if (raw === null || !Number.isFinite(raw)) {
      return { leg: spec.leg, value: null, sub: null, weight: spec.weight, scale: spec.scale };
    }
    const sub = clamp(raw / spec.scale, -1, 1);
    weighted += spec.weight * sub;
    presentWeight += spec.weight;
    return { leg: spec.leg, value: round(raw, 4), sub: round(sub, 3), weight: spec.weight, scale: spec.scale };
  });
  const coverage = totalWeight > 0 ? Math.round((presentWeight / totalWeight) * 100) : 0;
  if (direction === 'unknown' || presentWeight === 0) return { score: null, coverage, components };
  // `|| 0` folds a -0 (a flat tape) into 0.
  return { score: Math.round((100 * weighted) / presentWeight) || 0, coverage, components };
}

/** Breadth as a net share, (green - red) / sample, in -1..+1: the direction
 *  reading's own counts. Null under MIN_BREADTH_SAMPLE, where the reading does
 *  not call breadth a reading either. */
export function breadthNetOf(breadth: MarketBreadth): number | null {
  return breadth.sample >= MIN_BREADTH_SAMPLE ? (breadth.green - breadth.red) / breadth.sample : null;
}

/** A price's move from a reference, in percent; null when either is unusable. */
export function pctFrom(price: number | null, ref: number | null): number | null {
  if (price === null || ref === null || !Number.isFinite(price) || !Number.isFinite(ref) || !(ref > 0)) return null;
  return ((price - ref) / ref) * 100;
}

/** The mean of the values that are present; null when none is. */
export function meanOfPresent(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** What one index contributes to the four index legs. */
export interface IndexLegReading {
  symbol: string;
  /** Its move vs the previous close, in percent. */
  vsPrevClose: number | null;
  /** The latest price, and the three references it is measured against. */
  last: number | null;
  open: number | null;
  vwap: number | null;
  closeThirtyMinAgo: number | null;
}

/** The four index legs, each averaged over the indexes that answered. */
export function indexLegsOf(
  readings: readonly IndexLegReading[],
): Pick<TapeLegInputs, 'indexVsPrevClose' | 'indexVsOpen' | 'indexVsVwap' | 'indexSlope30'> {
  return {
    indexVsPrevClose: meanOfPresent(readings.map((r) => r.vsPrevClose)),
    indexVsOpen: meanOfPresent(readings.map((r) => pctFrom(r.last, r.open))),
    indexVsVwap: meanOfPresent(readings.map((r) => pctFrom(r.last, r.vwap))),
    indexSlope30: meanOfPresent(readings.map((r) => pctFrom(r.last, r.closeThirtyMinAgo))),
  };
}

// --- breadth momentum: an in-memory ring of this session's breadth ----------
//
// The loop reads breadth once a tick (~2m10s). Momentum is this tick's net
// breadth minus the one read closest to 30 minutes earlier, and it exists only
// when such a reading is within 5 minutes of that mark: after a gap (a restart,
// the kill switch, a stalled screen) it is null, never a change measured over
// an hour. The ring holds one session and clears when the ET day changes.

export const BREADTH_MOMENTUM_WINDOW_MS = 30 * 60_000;
export const BREADTH_MOMENTUM_TOLERANCE_MS = 5 * 60_000;

let breadthRing: { day: string; samples: { at: number; value: number }[] } | null = null;

/** `value` minus the sample closest to 30 minutes before `now`, when one lies
 *  within 5 minutes of that mark; null otherwise. Pure: the ring below and the
 *  tape rebuild (historicalTape.ts) both call it, so a rebuilt session's
 *  momentum and a live one's are one rule. */
export function momentumFromSamples(
  samples: readonly { at: number; value: number }[],
  now: number,
  value: number | null,
): number | null {
  if (value === null) return null;
  const target = now - BREADTH_MOMENTUM_WINDOW_MS;
  let best: { at: number; value: number } | null = null;
  for (const s of samples) {
    if (Math.abs(s.at - target) > BREADTH_MOMENTUM_TOLERANCE_MS) continue;
    if (best === null || Math.abs(s.at - target) < Math.abs(best.at - target)) best = s;
  }
  return best === null ? null : value - best.value;
}

/** Net breadth's change over the last ~30 minutes of this session, from the
 *  ring; null until the ring reaches back 25 minutes. Read it BEFORE
 *  recordBreadthNet adds the current tick. */
export function breadthMomentum30(day: string, now: number, value: number | null): number | null {
  if (breadthRing === null || breadthRing.day !== day) return null;
  return momentumFromSamples(breadthRing.samples, now, value);
}

/** Add this tick's net breadth to the ring (a null is not a reading and is not
 *  kept); a new ET day starts a new ring, and samples older than the window
 *  plus its tolerance are dropped. */
export function recordBreadthNet(day: string, at: number, value: number | null): void {
  if (breadthRing === null || breadthRing.day !== day) breadthRing = { day, samples: [] };
  if (value !== null && Number.isFinite(value)) breadthRing.samples.push({ at, value });
  const oldest = at - BREADTH_MOMENTUM_WINDOW_MS - BREADTH_MOMENTUM_TOLERANCE_MS;
  breadthRing.samples = breadthRing.samples.filter((s) => s.at >= oldest);
}

// --- the journal row ----------------------------------------------------------

/** The journal action the loop writes a tape reading under. Its own action,
 *  not a field on `market_direction_read`: that row is one per CHANGE of
 *  direction or hold, and the flip counts, the backfill's parity and the
 *  nightly review all read it that way. */
export const MARKET_TAPE_ACTION = 'market_tape_read';

/** A new row once the score has moved this far from the last row's. */
export const TAPE_JOURNAL_SCORE_STEP = 5;
/** ...or this long after the last row, so a quiet tape still has a reading in
 *  force at every entry. */
export const TAPE_JOURNAL_HEARTBEAT_MS = 10 * 60_000;

let lastTapeRow: { day: string; direction: MarketDirection; score: number | null; at: number } | null = null;

/**
 * Whether this tick's tape reading gets a journal row: the first of the ET
 * day, a change of the label, a score that moved TAPE_JOURNAL_SCORE_STEP or
 * more from the LAST ROW's (so a slow drift still lands), a score appearing or
 * going null, or TAPE_JOURNAL_HEARTBEAT_MS since the last row: at least one
 * row every 10 minutes (39 over a full session), more when the score moves.
 * Claims the row when it answers yes.
 */
export function claimTapeJournal(day: string, direction: MarketDirection, score: number | null, at: number): boolean {
  const last = lastTapeRow;
  const due =
    last === null ||
    last.day !== day ||
    last.direction !== direction ||
    (score === null) !== (last.score === null) ||
    (score !== null && last.score !== null && Math.abs(score - last.score) >= TAPE_JOURNAL_SCORE_STEP) ||
    at - last.at >= TAPE_JOURNAL_HEARTBEAT_MS;
  if (due) lastTapeRow = { day, direction, score, at };
  return due;
}

/** One line a person can read: "Tape -62 · SPY -0.45% · 73% red · breadth
 *  falling". */
export function tapeDetailLine(
  tape: TapeScore,
  label: { indexSymbol: string; indexChangePct: number | null; redPct: number | null; greenPct: number | null },
): string {
  if (tape.score === null) return 'Tape unscored: the market direction is unknown this tick';
  const parts = [`Tape ${tape.score > 0 ? '+' : ''}${tape.score}`];
  if (label.indexChangePct !== null) {
    parts.push(`${label.indexSymbol} ${label.indexChangePct > 0 ? '+' : ''}${label.indexChangePct.toFixed(2)}%`);
  }
  if (label.redPct !== null && label.greenPct !== null) {
    parts.push(label.redPct >= label.greenPct ? `${label.redPct}% red` : `${label.greenPct}% green`);
  }
  const momentum = tape.components.find((c) => c.leg === 'breadthMomentum30')?.sub ?? null;
  if (momentum !== null) {
    parts.push(momentum <= -0.25 ? 'breadth falling' : momentum >= 0.25 ? 'breadth rising' : 'breadth steady');
  }
  if (tape.coverage < 100) parts.push(`${tape.coverage}% of legs`);
  return parts.join(' · ');
}

/** Clear the ring and the journal claim (tests; a new process starts empty). */
export function resetMarketTapeState(): void {
  breadthRing = null;
  lastTapeRow = null;
}

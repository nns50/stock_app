import { AutotradeConfig } from '../../db/autotradeConfig';
import { CandleSource } from '../excursion';
import { DeclinedEntry } from './declinedEntry';
import {
  buildDeclinedEntryShadow,
  DeclinedEntryShadow,
  memoCandleSource,
  replayByTape,
  ShadowOptions,
} from './declinedEntryShadow';
import { TAPE_BUCKETS, TapeBucket, tapeBucketOf } from './marketDirection';

/**
 * What the live book WOULD have made on the shorts it declined — measured on
 * real bars, independently of the paper book's slots.
 *
 * WHY THIS EXISTS. Task #21's enabling rule reads paper's closed shorts, and
 * paper is the wrong instrument for the question. It has three slots and a
 * score floor of 60 against live's 72, so it fills those slots first-come with
 * names live would never take and is then unable to record the higher-scoring
 * short that arrives an hour later. On 2026-09-10 every one of 1000 sampled
 * paper risk checks was refused on max_concurrent_positions, and two of five
 * paper entries scored below the live floor. The sample the decision reads is
 * therefore a slot lottery biased toward early-session signals, not a sample of
 * live-eligible shorts — and it accrues slowly for the same structural reason.
 *
 * This replays the DECLINED signals themselves. `live_short_skipped` already
 * carries everything a trade needs — score, entry, stop, target, and the moment
 * live saw it — so the shadow record needs no new capture, only bars.
 *
 * THREE THINGS IT IS NOT, and each matters when reading the number:
 *
 *  1. Not a P&L. It ignores slots, aggregate-risk room and cooldowns, so it
 *     measures per-trade EXPECTANCY, not money the book could have made. That
 *     is the right quantity for #21's avgR/win-rate gate and the wrong one for
 *     "how much did we leave on the table".
 *  2. A fill the live book could have had, from replay version 2
 *     (2026-09-26; declinedEntryShadow.ts): the first bar's open plus the
 *     share of the buffer live entries pay, with honest exits. Still no
 *     assumption that a short was borrowable at that moment.
 *  3. Not neutral about ambiguity — deliberately. It reuses exitReplay, which
 *     resolves every intrabar stop/target collision AGAINST the trade. So this
 *     understates shorts. A gate that passes here passes on a pessimistic read,
 *     which is the only direction worth being wrong in when the decision is
 *     whether to point real money at a new direction.
 */

/** One declined short, as journaled. */
/** A row from `live_short_skipped`. It carries no `side`, and should not: the
 *  ACTION is the side. buildShortShadowRecord stamps it on the way into the
 *  shared replay, which is the one place that knows both. */
export type SkippedShort = Omit<DeclinedEntry, 'side'>;

export type { ShadowSkipReason, ShadowTrade } from './declinedEntryShadow';
export { dedupeBySymbolDay, barsFromSignal, liveExitRules } from './declinedEntryShadow';

/** One tape's replay, as the record carries it. */
export type TapeShadowReading = Pick<DeclinedEntryShadow, 'trades' | 'n' | 'avgR' | 'winRatePct' | 'byReason'>;

/** The red-tape bar (rule B of the tape plan) against this record's red-tape
 *  trades: each number, its bar, and whether it passes. */
export interface ShortRedTapeGate {
  minTrades: number;
  minAvgR: number;
  minWinRatePct: number;
  minEdgeOverOtherTapesR: number;
  n: number;
  avgR: number | null;
  winRatePct: number | null;
  /** The shorts declined on the other LABELED tapes (mixed and green),
   *  pooled: what the red tape has to beat. */
  otherTapesN: number;
  otherTapesAvgR: number | null;
  /** avgR less otherTapesAvgR; null while either side has no trade. */
  edgeR: number | null;
  passesN: boolean;
  passesAvgR: boolean;
  passesWinRate: boolean;
  passesEdge: boolean;
  passes: boolean;
}

export interface ShortShadowRecord extends DeclinedEntryShadow {
  /** The three numbers task #21's rule reads, and whether each passes. */
  gate: {
    minTrades: number;
    minAvgR: number;
    minWinRatePct: number;
    passesN: boolean;
    passesAvgR: boolean;
    passesWinRate: boolean;
    passes: boolean;
  };
  /**
   * The same shorts, replayed once per tape they were declined on (2026-09-24;
   * replayByTape): each tape keeps its own first row per symbol-day. A row's
   * tape is the loop's own reading, stamped on the row or read from the
   * journal's `market_direction_read` rows at that moment, never a backfilled
   * one, so rows from before the loop read the market (2026-09-24) are
   * `unlabeled`. Not the direction gate replayed: every tape is read.
   */
  byTape: Record<TapeBucket, TapeShadowReading>;
  /** The red-tape bar against byTape.red (SHORT_RED_TAPE_GATE). */
  redTapeGate: ShortRedTapeGate;
}

/** Task #21's pre-committed enabling rule, in one place so the report and any
 *  future reader cannot drift from it. Changing these is changing the DECISION,
 *  which is a written-down operator call, not a tuning knob. */
export const SHORT_ENABLE_GATE = { minTrades: 30, minAvgR: 0.1, minWinRatePct: 50 } as const;

/**
 * The red-tape bar (the tape plan's rule B, the operator's call of 2026-09-23):
 * live stock shorts are proposed only for a red tape, and only once the shorts
 * declined on red tapes have made at least this. The edge term is what makes it
 * a RED-tape bar and not the old one on fewer trades: red tapes have to beat the
 * other tapes, or the tape is not what is paying.
 */
export const SHORT_RED_TAPE_GATE = {
  minTrades: 20,
  minAvgR: 0.15,
  minWinRatePct: 50,
  minEdgeOverOtherTapesR: 0.1,
} as const;

/** Float slack for the bar's comparisons: a mean of exactly +0.15R can come
 *  out of the sum as 0.1499999…, and a bar must not fail on the last bit. */
const GATE_EPS = 1e-9;

/** The red-tape bar against the per-tape replays. PURE. */
export function redTapeGateOf(byTape: Record<TapeBucket, Pick<DeclinedEntryShadow, 'trades'>>): ShortRedTapeGate {
  const g = SHORT_RED_TAPE_GATE;
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((sum, v) => sum + v, 0) / xs.length : null);
  const red = byTape.red.trades.map((t) => t.exitR);
  const other = [...byTape.mixed.trades, ...byTape.green.trades].map((t) => t.exitR);
  const avgR = mean(red);
  const winRatePct = red.length ? (red.filter((v) => v > 0).length / red.length) * 100 : null;
  const otherTapesAvgR = mean(other);
  const edgeR = avgR !== null && otherTapesAvgR !== null ? avgR - otherTapesAvgR : null;
  const passesN = red.length >= g.minTrades;
  const passesAvgR = avgR !== null && avgR >= g.minAvgR - GATE_EPS;
  const passesWinRate = winRatePct !== null && winRatePct >= g.minWinRatePct - GATE_EPS;
  const passesEdge = edgeR !== null && edgeR >= g.minEdgeOverOtherTapesR - GATE_EPS;
  return {
    ...g,
    n: red.length,
    avgR,
    winRatePct,
    otherTapesN: other.length,
    otherTapesAvgR,
    edgeR,
    passesN,
    passesAvgR,
    passesWinRate,
    passesEdge,
    passes: passesN && passesAvgR && passesWinRate && passesEdge,
  };
}

/**
 * The short half of the declined-entry shadow: the same replay, plus task #21's
 * enabling gate.
 *
 * The replay itself lives in declinedEntryShadow.ts and is shared with every
 * other refusal class (2026-09-14). It was written here first, for shorts, and
 * then the same question turned out to be open for the ATR reachability gate,
 * which refuses ten times as many symbol-days — so it moved rather than being
 * copied. Two modules replaying the same geometry would agree on the day they
 * were written and not for long, which is the rule this codebase keeps
 * relearning.
 */
export async function buildShortShadowRecord(
  source: CandleSource,
  rows: SkippedShort[],
  cfg: AutotradeConfig,
  /** The replay's fill inputs (the live entry concession, the direction
   *  readings): shortShadowRecordData.ts supplies them from the database. */
  options: Pick<ShadowOptions, 'entryConcessionPct' | 'directionAt'> = {},
): Promise<ShortShadowRecord> {
  // Every row here came from the naked-short skip, so the side is not in
  // doubt even for rows written before `side` was stamped.
  const shorts = rows.map((r) => ({ ...r, side: 'short' as const }));
  // The ATR reachability gate comes straight after the shorts-off skip on the
  // live path (2026-09-24, the tape plan's F7): a short the switch admitted
  // would meet it next, so the record replays it, at the book's own fraction.
  const replay: ShadowOptions = { ...options, maxRiskAtrFraction: cfg.maxRiskAtrFraction };
  const memo = memoCandleSource(source);
  const shadow = await buildDeclinedEntryShadow(memo, shorts, cfg, replay);
  const g = SHORT_ENABLE_GATE;
  const passesN = shadow.n >= g.minTrades;
  const passesAvgR = shadow.avgR !== null && shadow.avgR >= g.minAvgR;
  const passesWinRate = shadow.winRatePct !== null && shadow.winRatePct >= g.minWinRatePct;

  // The tape a row was declined on: its own stamp, else the loop's journaled
  // reading at that moment. Both are live readings, so nothing backfilled can
  // put a trade on a tape here.
  const tapes = await replayByTape(
    memo,
    shorts,
    (r) => tapeBucketOf(r.directionAtSkip ?? options.directionAt?.(r.at) ?? null),
    cfg,
    replay,
  );
  const byTape = {} as Record<TapeBucket, TapeShadowReading>;
  for (const tape of TAPE_BUCKETS) {
    const t = tapes[tape];
    byTape[tape] = { trades: t.trades, n: t.n, avgR: t.avgR, winRatePct: t.winRatePct, byReason: t.byReason };
  }
  return {
    ...shadow,
    gate: { ...g, passesN, passesAvgR, passesWinRate, passes: passesN && passesAvgR && passesWinRate },
    byTape,
    redTapeGate: redTapeGateOf(tapes),
  };
}

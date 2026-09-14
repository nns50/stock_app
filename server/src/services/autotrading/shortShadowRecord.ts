import { AutotradeConfig } from '../../db/autotradeConfig';
import { CandleSource } from '../excursion';
import { DeclinedEntry } from './declinedEntry';
import { buildDeclinedEntryShadow, DeclinedEntryShadow } from './declinedEntryShadow';

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
 *  2. Not a fill. The entry is the signal's price, with no slippage and no
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
}

/** Task #21's pre-committed enabling rule, in one place so the report and any
 *  future reader cannot drift from it. Changing these is changing the DECISION,
 *  which is a written-down operator call, not a tuning knob. */
export const SHORT_ENABLE_GATE = { minTrades: 30, minAvgR: 0.1, minWinRatePct: 50 } as const;

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
): Promise<ShortShadowRecord> {
  const shadow = await buildDeclinedEntryShadow(
    source,
    // Every row here came from the naked-short skip, so the side is not in
    // doubt even for rows written before `side` was stamped.
    rows.map((r) => ({ ...r, side: 'short' as const })),
    cfg,
  );
  const g = SHORT_ENABLE_GATE;
  const passesN = shadow.n >= g.minTrades;
  const passesAvgR = shadow.avgR !== null && shadow.avgR >= g.minAvgR;
  const passesWinRate = shadow.winRatePct !== null && shadow.winRatePct >= g.minWinRatePct;
  return {
    ...shadow,
    gate: { ...g, passesN, passesAvgR, passesWinRate, passes: passesN && passesAvgR && passesWinRate },
  };
}

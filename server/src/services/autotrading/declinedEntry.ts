import { TradeSignal } from './decide';
import type { MarketDirection } from './marketDirection';
import { journalEntrySkipOncePerDay } from './symbolCooldown';

// ---------------------------------------------------------------------------
// What a DECLINED live entry has to record to be worth anything (2026-09-14).
//
// Every gate on the live entry path journals its refusal. Task #45 audited that
// and found no gate silent. What it did not ask is whether the rows can be
// SCORED, and none of them could: they carried the reason and the numbers the
// rule itself reasoned about, and not the entry price, the stop or the side —
// the three a replay needs to say what the refused trade would have done.
//
// So the largest refusal class on the entry path was unmeasurable. On
// 2026-09-02..09-14 `risk_atr_unreachable_skipped` refused 80 symbol-days over
// eight sessions, 16 on 09-14 alone against FOUR entries actually placed, and
// nothing anywhere could answer whether that was the gate protecting the book
// or the gate being the reason the book has no flow.
//
// `live_short_skipped` was the exception — it carries entry and stop, which is
// the only reason the short shadow record exists at all. This generalises that
// accident into the rule.
//
// TWO FIELDS, AND BOTH ARE LOAD-BEARING:
//
//   `entry` / `stop` / `side` — a replay's inputs. 1R is |entry - stop|, and
//   without the pair there is no denominator, so the row can be counted and
//   never scored.
//
//   `liveMinSignalScore` — the floor IN FORCE at the moment of the refusal. It
//   is here rather than left to the reader because leaving it to the reader is
//   precisely the bug that shipped: several of these gates run BEFORE the score
//   floor, so their rows include candidates the book would have declined
//   anyway, and a reader filtering them by TODAY's floor silently re-scores its
//   own history every time the floor moves. Raising the floor 72 -> 81 on
//   2026-09-14 cut the short shadow's eligible rows from 32 to 1 that way. The
//   fix was `floorAtSkip`; this makes it impossible to forget on the next gate
//   someone writes.
//
// A new gate calls this instead of `journalEntrySkipOncePerDay` and is
// replayable on its first day, rather than discovering three weeks later that
// its rows cannot answer the question it was built to settle.
// ---------------------------------------------------------------------------

/** The subset of a signal a declined-entry row needs. */
export type DeclinedSignal = Pick<TradeSignal, 'symbol' | 'side' | 'entry' | 'stop' | 'score'>;

/** A declined entry as it comes back OUT of the journal — the replay's input. */
export interface DeclinedEntry {
  symbol: string;
  /** Epoch ms the live book declined it. A replay may only use bars at or
   *  after this: a name declined at 14:00 must not be credited with the
   *  morning's move. */
  at: number;
  score: number;
  entry: number;
  stop: number;
  side: 'long' | 'short';
  /** The live score floor in force when this row was written. Undefined for
   *  rows predating the field; a reader falls back to the current floor, which
   *  is the old behaviour and the best available. */
  floorAtSkip?: number;
  /**
   * A re-entry cooldown refusal only (2026-09-19): minutes between the
   * symbol's last closed live exit and this refusal, as the gate itself
   * measured it (`minutesSince` on the row). That gate journals EVERY tick, so
   * one symbol-day carries the whole series — which is what lets a replay ask
   * "the first re-entry at or after N minutes" (declinedEntryShadow.ts's
   * `minMinutesSinceExit`) rather than only "the first refusal of the day".
   * Undefined on every other gate's rows.
   */
  minutesSinceExit?: number;
  /**
   * The shorts-off skip only (2026-09-24): the market's direction when the row
   * was written, as the loop read it that tick (held, as the gate acts on it).
   * What the short shadow record groups by tape. Undefined on older rows.
   */
  directionAtSkip?: MarketDirection;
  /**
   * The shorts-off skip only (2026-09-24): the signal's ATR in dollars, which
   * the live path's ATR reachability gate reads right after that skip
   * (atrReach.ts). The one gate that runs BEFORE it is the only one whose rows
   * need it. Undefined on older rows, which a replay counts, never guesses.
   */
  atr?: number;
}

/** A skip row's side, in the replay's vocabulary rather than the order's. */
export function declinedSide(side: TradeSignal['side']): 'long' | 'short' {
  return side === 'sell' ? 'short' : 'long';
}

/**
 * Journal a refused live entry, once per symbol per ET day, with everything a
 * later replay needs already on the row.
 *
 * The caller's `detail` goes on FIRST so the replay fields cannot be shadowed
 * by a rule's own key of the same name: a gate that happens to journal its own
 * `score` must not be able to overwrite the signal's, because the two have
 * drifted apart before and the replay is the thing that has to be right.
 */
export function journalDeclinedEntry(
  signal: DeclinedSignal,
  action: string,
  liveMinSignalScore: number,
  detail: Record<string, unknown> = {},
): void {
  journalEntrySkipOncePerDay(signal.symbol.toUpperCase(), action, {
    ...detail,
    side: declinedSide(signal.side),
    score: signal.score,
    entry: signal.entry,
    stop: signal.stop,
    // Whether the book would have wanted this candidate at all, and the number
    // that decided — so a reader never has to know where in the gate order
    // this particular refusal sits.
    liveEligible: signal.score >= liveMinSignalScore,
    liveMinSignalScore,
  });
}

/**
 * Parse a journaled skip row back into a replayable declined entry, or null.
 *
 * Null rather than a partial: a row missing its entry or stop predates the
 * fields above and cannot be scored, and counting it as a zero would quietly
 * drag every average toward nothing. The caller counts what it dropped.
 */
export function parseDeclinedEntry(row: {
  symbol: string | null;
  detail: string | null;
  createdAt: number;
}): DeclinedEntry | null {
  if (!row.symbol || !row.detail) return null;
  let d: {
    score?: unknown;
    entry?: unknown;
    stop?: unknown;
    side?: unknown;
    liveMinSignalScore?: unknown;
    minutesSince?: unknown;
  };
  try {
    d = JSON.parse(row.detail) as typeof d;
  } catch {
    return null;
  }
  if (typeof d.score !== 'number' || typeof d.entry !== 'number' || typeof d.stop !== 'number') return null;
  return {
    symbol: row.symbol,
    at: row.createdAt,
    score: d.score,
    entry: d.entry,
    stop: d.stop,
    // A row written before `side` was stamped is a long: every gate that
    // predates the field sat after the naked-short skip, so a short never
    // reached it.
    side: d.side === 'short' ? 'short' : 'long',
    ...(typeof d.liveMinSignalScore === 'number' ? { floorAtSkip: d.liveMinSignalScore } : {}),
    ...(typeof d.minutesSince === 'number' && Number.isFinite(d.minutesSince)
      ? { minutesSinceExit: d.minutesSince }
      : {}),
  };
}

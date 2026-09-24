// ---------------------------------------------------------------------------
// How many short-dated options positions may be open at once (2026-09-24).
//
// The rule was "one short-dated position at a time", asked ONCE per batch and
// against open positions only. So it held neither way:
//
//   - a batch that started with none open placed as many as passed the other
//     gates: on 2026-09-23 two opened in the same tick three times (09:38,
//     09:55, 10:13);
//   - a batch that started with one open placed none, although the sleeve's
//     own slot cap (optionsMaxConcurrentPositions) was 2 — the operator's
//     2026-09-12 setting;
//   - an entry order still working at the broker counted as nothing, so the
//     tick after a placement could place again before the first one filled.
//
// The operator's decision (2026-09-24): up to the sleeve's own slot cap at any
// time, counting working entry orders. One rule, asked before EVERY candidate
// by both books (liveOptionsExecute.ts, and optionsExecute.ts so the paper
// control keeps the same rule), from the same three counts.
//
// Where the sleeve has no cap of its own (optionsMaxConcurrentPositions 0, the
// shipped default: options share the book's slots), the old one-at-a-time rule
// stands. Two 0DTE positions can both go to zero inside the same half hour on a
// single adverse market move, a correlation stock positions do not have, so
// more than one is a decision someone makes by setting the sleeve's own cap.
// ---------------------------------------------------------------------------

/** The journal action for a candidate refused because the slots are full.
 *  The tuning plan's F7 counts these rows' `refused`. */
export const SHORT_DATED_SLOTS_FULL_ACTION = 'short_dated_position_already_open';

/** What holds a short-dated slot right now. */
export interface ShortDatedSlots {
  /** Open options positions in this book (the account the loop trades). */
  open: number;
  /** Entry orders placed on an earlier tick that are not positions yet: still
   *  working, or filled and not yet booked. Always 0 on paper, which fills at
   *  once. */
  pendingEntries: number;
  /** Entries this batch has placed so far. */
  placedThisBatch: number;
}

/** How many short-dated positions may be open at once: the sleeve's own slot
 *  cap, or 1 when the sleeve shares the book's slots. */
export function shortDatedSlotCap(cfg: { optionsMaxConcurrentPositions: number }): number {
  return cfg.optionsMaxConcurrentPositions > 0 ? cfg.optionsMaxConcurrentPositions : 1;
}

export function shortDatedSlotsTaken(s: ShortDatedSlots): number {
  return s.open + s.pendingEntries + s.placedThisBatch;
}

/** True when the short-dated sleeve has no slot left for another entry. Always
 *  false while short-dated options are off: the general slot cap in the risk
 *  check is then the only rule. */
export function shortDatedSlotsFull(
  cfg: { shortDatedOptionsEnabled: boolean; optionsMaxConcurrentPositions: number },
  s: ShortDatedSlots,
): boolean {
  return cfg.shortDatedOptionsEnabled && shortDatedSlotsTaken(s) >= shortDatedSlotCap(cfg);
}

/** The refusal's reason and journal detail, shared by both books so the two
 *  rows read the same. */
export function shortDatedSlotsFullDetail(
  book: 'live' | 'paper',
  cfg: { optionsMaxConcurrentPositions: number },
  s: ShortDatedSlots,
  refused: number,
): { reason: string; detail: Record<string, unknown> } {
  const cap = shortDatedSlotCap(cfg);
  const taken = shortDatedSlotsTaken(s);
  const reason =
    `short-dated options: ${taken} of ${cap} slots taken (${s.open} open, ${s.pendingEntries} working, ` +
    `${s.placedThisBatch} placed this tick) — max ${cap} at a time`;
  return {
    reason,
    detail: {
      book,
      reason,
      refused,
      openPositions: s.open,
      pendingEntries: s.pendingEntries,
      placedThisBatch: s.placedThisBatch,
      slotCap: cap,
    },
  };
}

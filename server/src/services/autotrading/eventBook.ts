// ---------------------------------------------------------------------------
// Which BOOK a journal row belongs to (2026-09-14).
//
// Asked for after an afternoon lost to the answer: the journal filled with
// `max_concurrent_positions: 3 open vs cap 3` while the live account was flat.
// Those were the PAPER book at its cap, and nothing on screen said so.
//
// WHY THIS IS NOT A PREFIX CHECK. Of the 159 actions the loop can write, 86
// carry neither a `live_` nor a `paper_` prefix, and they do not split the way
// the names suggest:
//
//   risk_atr_unreachable_skipped, absorbed_price_skipped, entry_filled,
//   exit_filled, level_veto, per_lot_*, entry_window_closed, equity_synced
//     -> all written by liveExecute.ts. LIVE, every one.
//
//   options_paper_*
//     -> optionsExecute.ts. PAPER, despite no `paper_` prefix.
//
//   finish_line_skipped, symbol_cooldown_skipped, options_probation_at_minimum
//     -> liveOptionsExecute.ts. LIVE.
//
//   short_dated_*
//     -> written by BOTH options sleeves. These look like paper's and are not;
//        they resolve from the detail, never from a table.
//
// A prefix filter would have put dozens of live rows in the paper bucket and
// vice versa, which is a worse failure than the ambiguity it set out to fix: an
// unlabelled row makes you look it up, a mislabelled one makes you sure.
//
// THE RULE, IN ORDER:
//
//   1. An explicit `book` in the detail wins. The writer knows; nothing here
//      should second-guess it. This is how `blocked`/`passed` are resolved —
//      both books write that same action, so no table on the action alone could
//      ever separate them, and how `entry_extension_shadow` is, which both
//      books also write.
//   2. The action prefix, for the 73 that carry one.
//   3. An explicit table for the exceptions above.
//   4. Everything else is `shared`: screening, decisions, config changes and
//      system rows that happen ONCE per tick, before or outside the two books.
//      Filing those under a book would claim an attribution that does not
//      exist.
//
// The table is checked against the SOURCE by eventBook.test.ts: it re-derives
// each action's book from the module that writes it, so an action added to
// liveExecute.ts next month and not classified here fails the build rather
// than quietly landing in `shared`.
// ---------------------------------------------------------------------------

/** Which book's activity a journal row describes. */
export type EventBook = 'live' | 'paper' | 'shared';

/**
 * Actions written by a LIVE module that carry no `live_` prefix.
 *
 * Grouped by the file that writes them, because that is where the next one will
 * come from and the guard test re-derives this list from exactly that.
 */
export const LIVE_ACTIONS = new Set([
  // liveExecute.ts — the equity entry path and its refusals
  'absorbed_price_skipped',
  'bracket_groups_observed',
  'entry_filled',
  'entry_window_closed',
  'equity_moved_far_from_open',
  'equity_sync_rejected',
  'equity_synced',
  'exit_filled',
  'level_exits_applied',
  'level_veto',
  'per_lot_entry_planned',
  'per_lot_second_lot_blocked',
  'per_lot_second_lot_direction_skipped',
  'per_lot_second_lot_failed',
  'per_lot_second_lot_placed',
  'risk_atr_unreachable_skipped',
  'stagnation_exit_held_slot_free',
  'symbol_reentry_cooldown_skipped',
  'symbol_unplaceable_skipped',
  // liveOptionsExecute.ts — the live options sleeve
  'finish_line_skipped',
  'options_probation_at_minimum',
  'symbol_cooldown_skipped',
  // entryScoreGate.ts, reached only from the live path
  'regime_score_floor_skipped',
  // liveCapsReanchor.ts — the live dollar caps
  'equity_read_suspect',
  // The broker's own truth about REAL positions. Paper has no broker.
  'position_quantity_drift',
  'position_reconcile_skipped',
  'position_reconciled_from_broker',
  'webull_sync_failed',
  'webull_sync_recovered',
  'split_detected',
]);

/**
 * Actions written by a PAPER module that carry no `paper_` prefix.
 *
 * The three `short_dated_*` actions are deliberately ABSENT. They look like
 * paper's — `optionsExecute.ts` writes them — but `liveOptionsExecute.ts`
 * writes the same three, so listing them here would have filed every LIVE
 * options cutoff, exit and slot refusal under Paper. They carry `book` in the
 * detail instead and resolve above, like `blocked`/`passed` do. The guard test
 * found this by re-deriving from the source; the table alone looked right.
 */
export const PAPER_ACTIONS = new Set([
  // optionsExecute.ts — the paper options sleeve
  'options_paper_entry_failed',
  'options_paper_exit_decided',
  'options_paper_order_placed',
  'options_paper_partial_exit',
  'options_paper_position_closed',
  'options_paper_stop_ratcheted',
]);

/**
 * Detail `book` values a writer can stamp, mapped to a bucket.
 *
 * `preview` is the manual /risk-check endpoint. It is deliberately NOT live:
 * it is a tool someone ran by hand, and showing it under Live would put a
 * hypothetical in the same list as the things the book really did.
 */
const DETAIL_BOOK: Record<string, EventBook> = {
  live: 'live',
  paper: 'paper',
  preview: 'shared',
};

/**
 * Which book a journal row belongs to.
 *
 * `detail` is the raw stored string; unparseable JSON is not an error here,
 * just an absent opinion — the action rules below still apply.
 */
export function eventBook(action: string, detail?: string | null): EventBook {
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { book?: unknown };
      if (typeof parsed.book === 'string' && parsed.book in DETAIL_BOOK) return DETAIL_BOOK[parsed.book];
    } catch {
      // Not JSON, or not an object. No opinion from the detail.
    }
  }
  if (action.startsWith('live_')) return 'live';
  if (action.startsWith('paper_')) return 'paper';
  if (LIVE_ACTIONS.has(action)) return 'live';
  if (PAPER_ACTIONS.has(action)) return 'paper';
  return 'shared';
}

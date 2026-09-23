// ---------------------------------------------------------------------------
// The page rule of the four autotrade position lists (paper stock, paper
// options, live options in SQL; live stock filtered in memory), one rule for
// all four.
//
// OMITTED MEANS EVERY ROW (2026-09-23). The lists used to default to the newest
// 200 rows, and every history reader called them without a limit: the edge-leak
// scan's paper control, the daily-target sweep, the results row and backfill,
// the tune advisor, the symbol cooldowns, method sizing. None of them could
// tell a book of 200 closed trades from a longer one, so the day the paper book
// passed 200 each would have started dropping its oldest trades without a word.
// It had 179 on 2026-09-23. A page for the UI is the caller's choice and is
// asked for explicitly (routes/autotrade.ts, POSITIONS_PAGE_SIZE).
// ---------------------------------------------------------------------------

function pageSize(limit: number): number {
  return Math.max(1, Math.floor(limit));
}

/** For a list read in SQL: an empty clause when no page is asked for. */
export function rowLimitClause(limit: number | undefined): { sql: string; params: number[] } {
  if (limit === undefined) return { sql: '', params: [] };
  return { sql: 'LIMIT ?', params: [pageSize(limit)] };
}

/** For a list filtered in memory, newest first already. */
export function takeRowLimit<T>(rows: T[], limit: number | undefined): T[] {
  return limit === undefined ? rows : rows.slice(0, pageSize(limit));
}

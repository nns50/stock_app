import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, db } from '../src/db';
import { logAutotradeEvent, listAutotradeEvents } from '../src/db/autotradeEvents';

// ---------------------------------------------------------------------------
// The autotrade loop asks "have I already said this today?" several times a
// tick — the unprotected-position alarm, the bracket-groups observer, the
// failure and ambiguity alerts, the daily-halt alert, auto-tune's own guard —
// and every one of them is a `WHERE action IN (...) ORDER BY id DESC LIMIT N`
// over an action with a handful of rows in the entire table.
//
// With only (stage, id) to work with, SQLite walks EVERY row of that stage,
// newest to oldest, looking for matches that mostly are not there, and stops
// only when the table runs out. Measured 2026-09-06 on a 482k-row copy shaped
// like production — 506,945 rows, growing ~21,300/day, nothing pruning it —
// the live_position_unprotected lookup (6 matching rows, ever) cost
//   12.55 ms without an action index, 0.031 ms with one.
//
// This asserts the PLAN rather than a duration. A timing assertion on a table
// small enough to build in a test would measure the test's own noise, and in
// CI it would measure the runner's; the plan is the thing that actually
// changed, and it is what stops the index being dropped as redundant.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());

/** The exact statement listAutotradeEvents builds for an action-filtered read
 *  — kept in the same shape so this measures the real query, not a lookalike. */
const ACTION_QUERY = 'SELECT * FROM autotrade_events WHERE stage = ? AND action IN (?) ORDER BY id DESC LIMIT ?';

const plan = (sql: string, ...params: unknown[]): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');

describe('autotrade_events indexes', () => {
  it('seeks a rare action by index instead of scanning its whole stage', () => {
    const p = plan(ACTION_QUERY, 'execution', 'live_position_unprotected', 200);
    expect(p).toMatch(/USING (?:COVERING )?INDEX idx_autotrade_events_action/);
    expect(p).not.toMatch(/SCAN autotrade_events/);
  });

  it('still walks stage(+id) in id order when no action is named', () => {
    // The dashboard's read. It has no action to seek on, so (stage, id) is
    // still the right index — adding the action one must not have displaced it.
    const p = plan('SELECT * FROM autotrade_events WHERE stage = ? ORDER BY id DESC LIMIT ?', 'risk_check', 200);
    expect(p).toMatch(/idx_autotrade_events_stage/);
  });

  it('returns the same rows through the real reader, index or not', () => {
    // A plan assertion proves nothing about correctness. This drives
    // listAutotradeEvents itself so a wrong index can't pass by being fast.
    const symbol = 'ZIDX';
    db.exec(`DELETE FROM autotrade_events WHERE symbol = '${symbol}'`);
    for (const action of ['live_position_unprotected', 'live_order_placed', 'live_position_unprotected']) {
      logAutotradeEvent({ symbol, stage: 'execution', action });
    }
    const got = listAutotradeEvents({ stage: 'execution', actions: ['live_position_unprotected'], limit: 200 }).filter(
      (e) => e.symbol === symbol,
    );
    expect(got).toHaveLength(2);
    expect(got.every((e) => e.action === 'live_position_unprotected')).toBe(true);
  });
});

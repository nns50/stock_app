import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { backfillPaperPartialPnl } from '../src/db';

// ---------------------------------------------------------------------------
// The repair half of the 2026-09-05 partial-P&L fix.
//
// Adding realized_partial_pnl only fixes trades from here on. The book's
// HISTORY is what the grade-expectancy multipliers size from and what task
// #20's scale-out verdict is judged on, so leaving 17 of 70 closed rows
// understated would have kept the paper book sized down off its own deleted
// profits and produced a verdict on evidence that omitted exactly the thing
// being judged.
//
// The `paper_partial_exit` journal event is the only surviving record of those
// slices, and it never carried the position id — so each event is matched to
// the one paper row for that symbol that was open when it fired. These pin
// that matching, including the cases where it must REFUSE to guess.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE autotrade_paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_at INTEGER NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  risk_amount REAL NOT NULL,
  risk_profile TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  exit_price REAL,
  exit_at INTEGER,
  exit_reason TEXT,
  realized_partial_pnl REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE autotrade_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT,
  stage TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  risk_profile TEXT,
  created_at INTEGER NOT NULL
);`;

interface PosOpts {
  symbol: string;
  entryAt: number;
  exitAt: number | null;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function addPosition(db: Database.Database, o: PosOpts): number {
  const info = db
    .prepare(
      `INSERT INTO autotrade_paper_positions
         (symbol, side, quantity, entry_price, entry_at, stop_price, target_price, risk_amount,
          risk_profile, rationale, status, exit_price, exit_at, exit_reason, created_at, updated_at)
       VALUES (?, 'buy', 33, 50, ?, 45, 60, 500, 'MODERATE', 'fixture', ?, ?, ?, 'stop', ?, ?)`,
    )
    .run(
      o.symbol,
      o.entryAt,
      o.exitAt === null ? 'open' : 'closed',
      o.exitAt === null ? null : 50,
      o.exitAt,
      o.entryAt,
      o.exitAt ?? o.entryAt,
    );
  return Number(info.lastInsertRowid);
}

function addEvent(db: Database.Database, symbol: string | null, at: number, detail: string | null): void {
  db.prepare(
    "INSERT INTO autotrade_events (symbol, stage, action, detail, created_at) VALUES (?, 'execution', 'paper_partial_exit', ?, ?)",
  ).run(symbol, detail, at);
}

const pnlOf = (db: Database.Database, id: number): number =>
  (db.prepare('SELECT realized_partial_pnl AS p FROM autotrade_paper_positions WHERE id = ?').get(id) as { p: number })
    .p;

describe('backfillPaperPartialPnl', () => {
  it('banks the journaled slice onto the row that was open at the time', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'IOT', entryAt: 1_000, exitAt: 3_000 });
    addEvent(db, 'IOT', 2_000, JSON.stringify({ quantity: 41, exitPrice: 40.245, pnl: 12.3 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBeCloseTo(12.3, 6);
  });

  it('repairs a position that is still open', () => {
    // exit_at IS NULL must not exclude the row — a scale-out lives on an OPEN
    // position by definition; that is the whole point of a scale-out.
    const db = makeDb();
    const id = addPosition(db, { symbol: 'BIAF', entryAt: 1_000, exitAt: null });
    addEvent(db, 'BIAF', 2_000, JSON.stringify({ pnl: 31.56 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBeCloseTo(31.56, 6);
  });

  it('sums several partials on the same position', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'LULU', entryAt: 1_000, exitAt: 5_000 });
    addEvent(db, 'LULU', 2_000, JSON.stringify({ pnl: 12.97 }));
    addEvent(db, 'LULU', 3_000, JSON.stringify({ pnl: 17.51 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBeCloseTo(30.48, 6);
  });

  it('picks the right trade when the same symbol was traded twice', () => {
    // BIAF was re-entered repeatedly in the real data. The event's timestamp
    // against each row's open window is the only thing separating them.
    const db = makeDb();
    const first = addPosition(db, { symbol: 'BIAF', entryAt: 1_000, exitAt: 2_000 });
    const second = addPosition(db, { symbol: 'BIAF', entryAt: 3_000, exitAt: 4_000 });
    addEvent(db, 'BIAF', 3_500, JSON.stringify({ pnl: 21.09 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, first)).toBe(0);
    expect(pnlOf(db, second)).toBeCloseTo(21.09, 6);
  });

  it('refuses to guess when two positions were open at once', () => {
    // Overlapping windows on one symbol: a wrong attribution is worse than a
    // known-pessimistic number, so neither row is touched.
    const db = makeDb();
    const a = addPosition(db, { symbol: 'HOOD', entryAt: 1_000, exitAt: 5_000 });
    const b = addPosition(db, { symbol: 'HOOD', entryAt: 2_000, exitAt: 6_000 });
    addEvent(db, 'HOOD', 3_000, JSON.stringify({ pnl: 7.59 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, a)).toBe(0);
    expect(pnlOf(db, b)).toBe(0);
  });

  it('skips an event with no matching position at all', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'IOT', entryAt: 1_000, exitAt: 2_000 });
    addEvent(db, 'IOT', 9_999, JSON.stringify({ pnl: 5 })); // after the exit
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBe(0);
  });

  it('survives a malformed, missing, or non-numeric detail without throwing', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'IOT', entryAt: 1_000, exitAt: 3_000 });
    addEvent(db, 'IOT', 2_000, 'not json at all');
    addEvent(db, 'IOT', 2_000, null);
    addEvent(db, null, 2_000, JSON.stringify({ pnl: 1 })); // no symbol
    addEvent(db, 'IOT', 2_000, JSON.stringify({ pnl: 'lots' }));
    addEvent(db, 'IOT', 2_000, JSON.stringify({ pnl: Number.POSITIVE_INFINITY })); // JSON -> null
    addEvent(db, 'IOT', 2_000, JSON.stringify({}));
    expect(() => backfillPaperPartialPnl(db)).not.toThrow();
    expect(pnlOf(db, id)).toBe(0);
  });

  it('is a no-op on a book that never scaled out', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'IOT', entryAt: 1_000, exitAt: 2_000 });
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBe(0);
  });

  it('repairs the OPTIONS book from its own event action', () => {
    // Same repair, different table and a different journal action. Nothing to
    // fix in production (that book had taken no partials when the column
    // landed), but the two must not be able to drift: an options event must
    // never land on an equity row, or the reverse.
    const db = makeDb();
    db.exec(`CREATE TABLE autotrade_options_paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, entry_at INTEGER NOT NULL,
      exit_at INTEGER, realized_partial_pnl REAL NOT NULL DEFAULT 0);`);
    db.prepare('INSERT INTO autotrade_options_paper_positions (symbol, entry_at, exit_at) VALUES (?,?,?)').run(
      'SPY',
      1_000,
      3_000,
    );
    const equityId = addPosition(db, { symbol: 'SPY', entryAt: 1_000, exitAt: 3_000 });
    db.prepare(
      "INSERT INTO autotrade_events (symbol, stage, action, detail, created_at) VALUES ('SPY','execution','options_paper_partial_exit',?,?)",
    ).run(JSON.stringify({ pnl: 400 }), 2_000);

    backfillPaperPartialPnl(db, 'options');
    const opt = db
      .prepare('SELECT realized_partial_pnl AS p FROM autotrade_options_paper_positions WHERE id = 1')
      .get() as { p: number };
    expect(opt.p).toBeCloseTo(400, 6);
    // The equity book must not have picked up an options event.
    expect(pnlOf(db, equityId)).toBe(0);
  });

  it('adds to whatever is already banked rather than overwriting it', () => {
    const db = makeDb();
    const id = addPosition(db, { symbol: 'IOT', entryAt: 1_000, exitAt: 3_000 });
    db.prepare('UPDATE autotrade_paper_positions SET realized_partial_pnl = 10 WHERE id = ?').run(id);
    addEvent(db, 'IOT', 2_000, JSON.stringify({ pnl: 5 }));
    backfillPaperPartialPnl(db);
    expect(pnlOf(db, id)).toBeCloseTo(15, 6);
  });
});

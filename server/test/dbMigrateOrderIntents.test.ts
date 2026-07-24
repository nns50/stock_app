import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rebuildOrderIntentsTable } from '../src/db';

// An older `order_intents` table: order_type pinned to ('market','limit') by a
// CHECK, with the order_events child FK. A stop order (stop_loss /
// stop_loss_limit) threw a CHECK violation at INSERT. rebuildOrderIntentsTable
// should lift the CHECK while preserving rows and the child FK.
const OLD_SCHEMA = `
CREATE TABLE order_intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  symbol          TEXT NOT NULL,
  asset_kind      TEXT NOT NULL CHECK(asset_kind IN ('stock','option')),
  side            TEXT NOT NULL CHECK(side IN ('buy','sell')),
  open_close      TEXT NOT NULL CHECK(open_close IN ('open','close')),
  quantity        REAL NOT NULL,
  order_type      TEXT NOT NULL CHECK(order_type IN ('market','limit')),
  limit_price     REAL,
  option_type     TEXT,
  strike          REAL,
  expiration      TEXT,
  option_strategy TEXT,
  is_bracket      INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL,
  broker_order_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   INTEGER NOT NULL REFERENCES order_intents(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);`;

const insertIntent = (db: Database.Database, key: string, orderType: string) =>
  db
    .prepare(
      `INSERT INTO order_intents (idempotency_key, symbol, asset_kind, side, open_close, quantity, order_type, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(key, 'AMC', 'stock', 'buy', 'open', 1, orderType, 'draft', 1, 1);

describe('rebuildOrderIntentsTable', () => {
  it('lifts the order_type CHECK while preserving rows and the child FK', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    insertIntent(db, 'k1', 'limit');
    db.prepare('INSERT INTO order_events (intent_id, state, detail, created_at) VALUES (?,?,?,?)').run(
      1,
      'draft',
      'created',
      1,
    );

    // Before: a stop order is rejected by the CHECK.
    expect(() => insertIntent(db, 'k-stop-pre', 'stop_loss')).toThrow(/CHECK/);

    rebuildOrderIntentsTable(db);

    // The existing intent and its child event survived the rebuild.
    expect(
      (db.prepare('SELECT order_type FROM order_intents WHERE id = 1').get() as { order_type: string }).order_type,
    ).toBe('limit');
    expect((db.prepare('SELECT COUNT(*) AS n FROM order_events').get() as { n: number }).n).toBe(1);

    // After: stop / stop-limit now insert fine.
    expect(() => insertIntent(db, 'k-stop', 'stop_loss')).not.toThrow();
    expect(() => insertIntent(db, 'k-stoplim', 'stop_loss_limit')).not.toThrow();

    // The child FK is still wired to the rebuilt table: deleting the intent
    // cascade-deletes its events.
    db.prepare('DELETE FROM order_intents WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE intent_id = 1').get() as { n: number }).n).toBe(0);
  });

  it('is a no-op once the CHECK is gone (idempotent)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    rebuildOrderIntentsTable(db); // lifts the CHECK
    const cols = db.prepare('PRAGMA table_info(order_intents)').all().length;
    rebuildOrderIntentsTable(db); // second call detects no CHECK and bails
    expect(db.prepare('PRAGMA table_info(order_intents)').all().length).toBe(cols);
  });
});

describe('rebuildOrderIntentsTable — ALTER-added columns', () => {
  it('preserves an ALTER-added materialization mark instead of resetting it to the default', () => {
    // The data-loss shape this rebuild has hit before: a column added by ALTER
    // is absent from the hard-coded copy list, so the rebuild silently resets
    // it. For materialized_qty that is not cosmetic — a `filled` intent whose
    // mark resets to 0 looks entirely unbooked, so the next reconcile would
    // book its position a SECOND time and invent cost basis that never existed.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    db.exec('ALTER TABLE order_intents ADD COLUMN materialized_qty REAL NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE order_intents ADD COLUMN materialized_notional REAL NOT NULL DEFAULT 0');
    insertIntent(db, 'k-filled', 'limit');
    db.prepare("UPDATE order_intents SET state = 'filled', materialized_qty = 1, materialized_notional = 4.5").run();

    rebuildOrderIntentsTable(db);

    const row = db.prepare('SELECT materialized_qty, materialized_notional FROM order_intents WHERE id = 1').get() as {
      materialized_qty: number;
      materialized_notional: number;
    };
    expect(row.materialized_qty).toBe(1);
    expect(row.materialized_notional).toBe(4.5);
  });

  it('still rebuilds a table that predates those columns, defaulting them', () => {
    // Order-independence: the rebuild must not require the ADD COLUMNs to have
    // run first. Before the column-intersection fix this threw "no such column".
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(OLD_SCHEMA);
    insertIntent(db, 'k1', 'limit');

    expect(() => rebuildOrderIntentsTable(db)).not.toThrow();
    const row = db.prepare('SELECT materialized_qty FROM order_intents WHERE id = 1').get() as {
      materialized_qty: number;
    };
    expect(row.materialized_qty).toBe(0);
  });
});

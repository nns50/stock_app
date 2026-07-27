import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeBacktestBarTimes } from '../src/db';

// Repairs cached Polygon daily/weekly bars stamped at midnight EASTERN
// (04:00/05:00 UTC) instead of midnight UTC — the pre-2026-07-27 client cached
// them raw, and the backtest engines' exact-midnight day matching then skipped
// every bar, silently reporting zero trades over perfectly good data.

const SCHEMA = `
CREATE TABLE backtest_bars (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  time        INTEGER NOT NULL,
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      REAL NOT NULL,
  PRIMARY KEY (symbol, timeframe, time)
);`;

let mem: Database.Database;
beforeEach(() => {
  mem = new Database(':memory:');
  mem.exec(SCHEMA);
});

function insert(symbol: string, timeframe: string, time: number, close = 100): void {
  mem
    .prepare(
      'INSERT INTO backtest_bars (symbol, timeframe, time, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?,1000)',
    )
    .run(symbol, timeframe, time, close, close, close, close);
}

function times(symbol: string, timeframe: string): number[] {
  return (
    mem
      .prepare('SELECT time FROM backtest_bars WHERE symbol = ? AND timeframe = ? ORDER BY time')
      .all(symbol, timeframe) as {
      time: number;
    }[]
  ).map((r) => r.time);
}

describe('normalizeBacktestBarTimes', () => {
  it('floors ET-stamped daily and weekly bars to UTC midnight of the same date', () => {
    insert('AAPL', 'daily', Date.parse('2024-01-02T05:00:00Z')); // EST midnight ET
    insert('AAPL', 'daily', Date.parse('2024-07-01T04:00:00Z')); // EDT midnight ET
    insert('AAPL', 'weekly', Date.parse('2024-01-01T05:00:00Z'));
    normalizeBacktestBarTimes(mem);
    expect(times('AAPL', 'daily')).toEqual([Date.parse('2024-01-02T00:00:00Z'), Date.parse('2024-07-01T00:00:00Z')]);
    expect(times('AAPL', 'weekly')).toEqual([Date.parse('2024-01-01T00:00:00Z')]);
  });

  it('leaves already-normalized rows and intraday timeframes untouched', () => {
    const midnight = Date.parse('2024-01-02T00:00:00Z');
    const minuteBar = Date.parse('2024-01-02T14:35:00Z');
    insert('MSFT', 'daily', midnight);
    insert('MSFT', '5min', minuteBar);
    normalizeBacktestBarTimes(mem);
    expect(times('MSFT', 'daily')).toEqual([midnight]);
    expect(times('MSFT', '5min')).toEqual([minuteBar]);
  });

  it('resolves a collision with an existing normalized twin by replacing it, and is idempotent', () => {
    // A normalized row (cached AFTER the client fix) coexisting with the raw
    // ET-stamped row for the same logical bar (cached BEFORE it) — the raw
    // row's values win via the primary-key REPLACE, and one row remains.
    insert('NVDA', 'daily', Date.parse('2024-01-02T00:00:00Z'), 111);
    insert('NVDA', 'daily', Date.parse('2024-01-02T05:00:00Z'), 222);
    normalizeBacktestBarTimes(mem);
    normalizeBacktestBarTimes(mem);
    const rows = mem.prepare("SELECT time, close FROM backtest_bars WHERE symbol = 'NVDA'").all() as {
      time: number;
      close: number;
    }[];
    expect(rows).toEqual([{ time: Date.parse('2024-01-02T00:00:00Z'), close: 222 }]);
  });
});

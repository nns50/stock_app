import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { cachedRange, getCachedBars, isRangeFetched, logFetchedRange, saveBars } from '../src/db/backtestBars';
import { Candle } from '../src/providers/types';

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM backtest_bars WHERE symbol LIKE 'BTBAR%'"));

const bar = (time: number, close: number): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
});

describe('backtest_bars cache', () => {
  it('round-trips saved bars through getCachedBars, ascending', () => {
    saveBars('BTBAR1', 'daily', [bar(300, 3), bar(100, 1), bar(200, 2)]);
    expect(getCachedBars('BTBAR1', 'daily', 0, 1000)).toEqual([bar(100, 1), bar(200, 2), bar(300, 3)]);
  });

  it('is case-insensitive on symbol', () => {
    saveBars('btbar2', 'daily', [bar(100, 1)]);
    expect(getCachedBars('BTBAR2', 'daily', 0, 1000)).toHaveLength(1);
  });

  it('filters strictly to the requested [from, to] range', () => {
    saveBars('BTBAR3', 'daily', [bar(100, 1), bar(200, 2), bar(300, 3)]);
    expect(getCachedBars('BTBAR3', 'daily', 150, 250)).toEqual([bar(200, 2)]);
  });

  it('upserts — re-saving the same time updates values instead of duplicating', () => {
    saveBars('BTBAR4', 'daily', [bar(100, 1)]);
    saveBars('BTBAR4', 'daily', [bar(100, 999)]);
    const rows = getCachedBars('BTBAR4', 'daily', 0, 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].close).toBe(999);
  });

  it('keeps timeframes independent for the same symbol/time', () => {
    saveBars('BTBAR5', 'daily', [bar(100, 1)]);
    saveBars('BTBAR5', '1min', [bar(100, 2)]);
    expect(getCachedBars('BTBAR5', 'daily', 0, 1000)).toEqual([bar(100, 1)]);
    expect(getCachedBars('BTBAR5', '1min', 0, 1000)).toEqual([bar(100, 2)]);
  });

  it('cachedRange reports null when nothing is cached, else min/max', () => {
    expect(cachedRange('BTBARNONE', 'daily')).toBeNull();
    saveBars('BTBAR6', 'daily', [bar(100, 1), bar(300, 3)]);
    expect(cachedRange('BTBAR6', 'daily')).toEqual({ min: 100, max: 300 });
  });

  it('saveBars with an empty array is a no-op', () => {
    saveBars('BTBAR7', 'daily', []);
    expect(cachedRange('BTBAR7', 'daily')).toBeNull();
  });
});

describe('backtest_fetch_log', () => {
  beforeEach(() => db.exec("DELETE FROM backtest_fetch_log WHERE symbol LIKE 'BTLOG%'"));

  it('reports unfetched when nothing has been logged', () => {
    expect(isRangeFetched('BTLOG1', 'daily', '2024-01-01', '2024-01-31')).toBe(false);
  });

  it('reports fetched for the exact logged range', () => {
    logFetchedRange('BTLOG2', 'daily', '2024-01-01', '2024-01-31');
    expect(isRangeFetched('BTLOG2', 'daily', '2024-01-01', '2024-01-31')).toBe(true);
  });

  it('reports fetched for a range strictly inside a wider logged range', () => {
    logFetchedRange('BTLOG3', 'daily', '2024-01-01', '2024-12-31');
    expect(isRangeFetched('BTLOG3', 'daily', '2024-06-01', '2024-06-30')).toBe(true);
  });

  it('reports unfetched when the request extends beyond the logged range', () => {
    logFetchedRange('BTLOG4', 'daily', '2024-01-01', '2024-06-30');
    expect(isRangeFetched('BTLOG4', 'daily', '2024-01-01', '2024-12-31')).toBe(false);
  });

  it('does not confuse gaps around non-trading days with an uncovered range', () => {
    // The literal point of this table: backtest_bars has no bar on a Sunday,
    // but the fetch DID cover through it — isRangeFetched must say true.
    logFetchedRange('BTLOG5', 'daily', '2024-01-01', '2024-01-07'); // Mon..Sun
    expect(isRangeFetched('BTLOG5', 'daily', '2024-01-01', '2024-01-07')).toBe(true);
  });

  it('keeps timeframes independent', () => {
    logFetchedRange('BTLOG6', 'daily', '2024-01-01', '2024-01-31');
    expect(isRangeFetched('BTLOG6', '1min', '2024-01-01', '2024-01-31')).toBe(false);
  });
});

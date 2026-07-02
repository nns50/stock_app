import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { getProvider } from '../src/providers';
import {
  checkSessionWindow,
  checkVolatility,
  getMarketAtrPct,
  defaultVolatilityFilterConfig,
} from '../src/services/autotrading/executionGuards';
import { Candle } from '../src/providers/types';

const mockGetProvider = vi.mocked(getProvider);

// A January weekday (2024-01-10, a Wednesday), so America/New_York is
// unambiguously EST (UTC-5) — avoids any DST-transition ambiguity.
function et(hh: number, mm: number): Date {
  const utcH = (hh + 5) % 24; // EST is UTC-5
  return new Date(`2024-01-10T${String(utcH).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
}
const SATURDAY_NOON_ET = new Date('2024-01-13T17:00:00Z'); // Sat, 12:00 ET

describe('checkSessionWindow', () => {
  it('blocks entirely when the market is closed (weekend)', () => {
    expect(checkSessionWindow(15, SATURDAY_NOON_ET)).toEqual({ ok: false, reason: 'Market is closed' });
  });

  it('blocks within the buffer after the open', () => {
    expect(checkSessionWindow(15, et(9, 30)).ok).toBe(false); // exactly at the open
    expect(checkSessionWindow(15, et(9, 44)).ok).toBe(false); // 14 min in
  });

  it('allows exactly at the end of the open buffer and after', () => {
    expect(checkSessionWindow(15, et(9, 45)).ok).toBe(true); // exactly 15 min in
    expect(checkSessionWindow(15, et(12, 0)).ok).toBe(true); // midday
  });

  it('blocks within the buffer before the close', () => {
    expect(checkSessionWindow(15, et(15, 46)).ok).toBe(false); // 14 min before close
  });

  it('allows exactly at the start of the close buffer and before', () => {
    expect(checkSessionWindow(15, et(15, 45)).ok).toBe(true); // exactly 15 min before close
  });

  it('uses a zero buffer to mean "any time the market is open"', () => {
    expect(checkSessionWindow(0, et(9, 30)).ok).toBe(true);
    expect(checkSessionWindow(0, et(15, 59)).ok).toBe(true);
  });
});

describe('checkVolatility', () => {
  const cfg = defaultVolatilityFilterConfig();

  it('blocks when the candidate has no usable ATR', () => {
    expect(checkVolatility(null, 2, cfg)).toEqual({ ok: false, reason: 'Ticker ATR unavailable' });
  });

  it('blocks when ticker ATR% exceeds the max', () => {
    const result = checkVolatility(20, 2, cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Ticker ATR/);
  });

  it('blocks when market ATR% exceeds the max, even with a fine ticker ATR', () => {
    const result = checkVolatility(2, 10, cfg);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SPY ATR/);
  });

  it('does not block on an unknown (null) market ATR — only on a confirmed elevated reading', () => {
    expect(checkVolatility(2, null, cfg)).toEqual({ ok: true });
  });

  it('passes when both are within range', () => {
    expect(checkVolatility(2, 1, cfg)).toEqual({ ok: true });
  });
});

describe('getMarketAtrPct', () => {
  beforeEach(() => mockGetProvider.mockReset());

  function candle(close: number, high: number, low: number): Candle {
    return { time: Date.now(), open: close, high, low, close, volume: 1000 };
  }

  it('computes ATR as a percentage of the latest close', () => {
    const candles: Candle[] = [];
    // 20 flat-ish days so ATR settles to a known value; true range ≈ 2 each day.
    for (let i = 0; i < 20; i++) candles.push(candle(100, 101, 99));
    mockGetProvider.mockReturnValue({ getCandles: vi.fn().mockResolvedValue(candles) } as never);
    return getMarketAtrPct('SPY').then((pct) => {
      expect(pct).not.toBeNull();
      expect(pct!).toBeCloseTo(2, 0); // ATR ≈ 2, close = 100 -> ATR% ≈ 2%
    });
  });

  it('returns null when the provider throws', async () => {
    mockGetProvider.mockReturnValue({ getCandles: vi.fn().mockRejectedValue(new Error('boom')) } as never);
    expect(await getMarketAtrPct('SPY')).toBeNull();
  });

  it('returns null when there is not enough history for ATR', async () => {
    mockGetProvider.mockReturnValue({ getCandles: vi.fn().mockResolvedValue([candle(100, 101, 99)]) } as never);
    expect(await getMarketAtrPct('SPY')).toBeNull();
  });
});

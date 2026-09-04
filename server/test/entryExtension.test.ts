import { describe, expect, it } from 'vitest';
import { Candle } from '../src/providers/types';
import {
  computeSessionRange,
  evaluateEntryExtension,
  REFERENCE_MAX_PCT_OF_RANGE,
  REFERENCE_MAX_VWAP_EXT_PCT,
} from '../src/services/autotrading/entryExtension';

// 2026-09-04 is a Friday; 13:30Z = 09:30 ET.
const ET = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 8, 4, h + 4, m, 0);
};
const bar = (hhmm: string, low: number, high: number): Candle => ({
  time: ET(hhmm),
  open: low,
  high,
  low,
  close: high,
  volume: 1000,
});
const NOW = ET('11:00');

describe('computeSessionRange', () => {
  it('takes the high and low of the regular session', () => {
    const c = [bar('09:35', 40, 41), bar('10:00', 39, 42), bar('10:30', 40.5, 41.5)];
    expect(computeSessionRange(c, NOW)).toEqual({ high: 42, low: 39 });
  });

  // The reason the session filter exists: a thin pre-market print setting the
  // day's high would push every regular-session entry artificially low in the
  // range, making extended entries look cheap.
  it('ignores pre-market and after-hours bars', () => {
    const c = [bar('08:00', 30, 99), bar('09:35', 40, 41), bar('16:30', 10, 50)];
    expect(computeSessionRange(c, NOW)).toEqual({ high: 41, low: 40 });
  });

  it('ignores bars from another day', () => {
    const other: Candle = { ...bar('10:00', 1, 200), time: Date.UTC(2026, 8, 3, 14, 0) };
    expect(computeSessionRange([other, bar('09:35', 40, 41)], NOW)).toEqual({ high: 41, low: 40 });
  });

  it('returns null when today has no usable session bars', () => {
    expect(computeSessionRange([bar('08:00', 30, 99)], NOW)).toBeNull();
    expect(computeSessionRange([], NOW)).toBeNull();
  });
});

describe('evaluateEntryExtension', () => {
  const range = { high: 42, low: 40 };

  it('puts a long at the session high at 100% of range', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 42, vwap: 41, range });
    expect(e.pctOfRange).toBe(100);
  });

  it('puts a long at the session low at 0% of range', () => {
    expect(evaluateEntryExtension({ side: 'long', price: 40, vwap: 41, range }).pctOfRange).toBe(0);
  });

  // Orientation matters: a short near the session LOW is as extended as a long
  // near the high. If these did not flip, aggregating the journal across sides
  // would cancel the signal out.
  it('flips the range orientation for a short', () => {
    expect(evaluateEntryExtension({ side: 'short', price: 40, vwap: 41, range }).pctOfRange).toBe(100);
    expect(evaluateEntryExtension({ side: 'short', price: 42, vwap: 41, range }).pctOfRange).toBe(0);
  });

  it('flips the vwap orientation for a short', () => {
    const long = evaluateEntryExtension({ side: 'long', price: 41.41, vwap: 41, range });
    const short = evaluateEntryExtension({ side: 'short', price: 40.59, vwap: 41, range });
    expect(long.vwapExtPct).toBeGreaterThan(0);
    expect(short.vwapExtPct).toBeGreaterThan(0);
  });

  it('reports a long below vwap as negative extension', () => {
    expect(evaluateEntryExtension({ side: 'long', price: 40.59, vwap: 41, range }).vwapExtPct).toBeLessThan(0);
  });

  // A symbol that has not moved is unmeasurable, which is NOT the same as
  // "at the high" — scoring it 100 would invent a blocked entry.
  it('returns null pctOfRange for a degenerate range rather than 100', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 41, vwap: 41, range: { high: 41, low: 41 } });
    expect(e.pctOfRange).toBeNull();
    expect(e.wouldBlock).toBe(false);
  });

  it('is unmeasured, not blocking, when context is missing', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 41, vwap: null, range: null });
    expect(e).toMatchObject({ vwapExtPct: null, pctOfRange: null, wouldBlock: false, reasons: [] });
  });

  it('flags an entry above the reference range cut', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 41.8, vwap: 41.8, range });
    expect(e.pctOfRange).toBeGreaterThan(REFERENCE_MAX_PCT_OF_RANGE);
    expect(e.wouldBlock).toBe(true);
    expect(e.reasons.join(' ')).toContain('session range');
  });

  it('flags an entry beyond the reference vwap cut', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 40.2, vwap: 40, range: { high: 44, low: 40 } });
    expect(e.vwapExtPct).toBeGreaterThan(REFERENCE_MAX_VWAP_EXT_PCT);
    expect(e.wouldBlock).toBe(true);
    expect(e.reasons.join(' ')).toContain('VWAP');
  });

  it('does not flag an entry inside both cuts', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 40.4, vwap: 40.4, range });
    expect(e.wouldBlock).toBe(false);
    expect(e.reasons).toEqual([]);
  });

  // The measured shape of a real trade: ORCL 2026-09-04 entered at 59.1% of
  // range — inside the cut on range, so the verdict must come from vwap alone.
  it('can flag on vwap while the range cut passes', () => {
    const e = evaluateEntryExtension({ side: 'long', price: 41, vwap: 40.5, range: { high: 42.7, low: 40 } });
    expect(e.pctOfRange).toBeLessThan(REFERENCE_MAX_PCT_OF_RANGE);
    expect(e.vwapExtPct).toBeGreaterThan(REFERENCE_MAX_VWAP_EXT_PCT);
    expect(e.wouldBlock).toBe(true);
  });
});

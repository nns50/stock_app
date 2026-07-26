import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { ago, cx, daysUntilLocal, fmtCompact, fmtDate, fmtNum, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from './format';

describe('currency formatting', () => {
  it('fmtUsd', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(-50)).toBe('-$50.00');
    expect(fmtUsd(null)).toBe('—');
  });
  it('fmtSignedUsd always shows a sign', () => {
    expect(fmtSignedUsd(50)).toBe('+$50.00');
    expect(fmtSignedUsd(-50)).toBe('-$50.00');
    expect(fmtSignedUsd(0)).toBe('+$0.00');
  });
});

describe('fmtPct', () => {
  it('adds a leading + for non-negative when signed', () => {
    expect(fmtPct(2.5)).toBe('+2.50%');
    expect(fmtPct(-1)).toBe('-1.00%');
    expect(fmtPct(5, 1, false)).toBe('5.0%');
    expect(fmtPct(null)).toBe('—');
  });
});

describe('fmtCompact / fmtNum', () => {
  it('compacts large numbers', () => {
    expect(fmtCompact(1_500_000)).toBe('1.5M');
    expect(fmtCompact(2_500)).toBe('2.5K');
    expect(fmtCompact(null)).toBe('—');
  });
  it('fmtNum respects digits and null', () => {
    expect(fmtNum(3.14159, 2)).toBe('3.14');
    expect(fmtNum(null)).toBe('—');
  });
});

describe('pnlClass', () => {
  it('colors by sign', () => {
    expect(pnlClass(5)).toBe('text-bull');
    expect(pnlClass(-5)).toBe('text-bear');
    expect(pnlClass(0)).toBe('text-slate-300');
    expect(pnlClass(null)).toBe('text-slate-300');
  });
});

describe('cx / ago', () => {
  it('cx joins truthy class names', () => {
    expect(cx('a', false, 'b', undefined, null, 'c')).toBe('a b c');
  });
  it('ago renders relative time', () => {
    expect(ago(null)).toBe('never');
    expect(ago(Date.now() - 65_000)).toBe('1m ago');
    expect(ago(Date.now() - 2 * 3_600_000)).toBe('2h ago');
  });
});

describe('fmtDate', () => {
  it('renders a date-only string as its own calendar day (no UTC-midnight off-by-one)', () => {
    // Must equal the LOCAL calendar day for those Y/M/D parts, in any timezone.
    // The old `new Date("2026-01-17")` parsed as UTC midnight and rendered the
    // previous day in every US (negative-UTC) zone.
    const expected = new Date(2026, 0, 17).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    expect(fmtDate('2026-01-17')).toBe(expected);
    expect(fmtDate('2026-01-17')).toContain('17');
  });

  it('returns the em dash for empty input', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
  });
});

describe('daysUntilLocal', () => {
  // The bug this replaces: `Date.parse(`${d}T00:00:00Z`) - Date.now()` compares a
  // UTC midnight against a local instant, so for part of every day in any
  // negative-UTC zone the count is one short. Pin the exact window.
  // The timezone is pinned, and that is the whole point. CI runs in UTC, where
  // the broken UTC-midnight arithmetic and the correct local-calendar version
  // agree on every input — so without this these assertions pass either way and
  // prove nothing. America/New_York is both negative-UTC and the timezone the
  // app's market logic is written against.
  const origTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = origTz;
  });

  // Local wall-clock, not an instant: `new Date('2026-07-30T21:00:00')` with no
  // zone suffix is parsed in that pinned timezone, which is what puts the clock
  // on the far side of UTC midnight.
  const freeze = (localIso: string) => vi.setSystemTime(new Date(localIso));
  afterEach(() => vi.useRealTimers());

  it('counts 0 for today and 1 for tomorrow at midday', () => {
    freeze('2026-07-30T12:00:00');
    expect(daysUntilLocal('2026-07-30')).toBe(0);
    expect(daysUntilLocal('2026-07-31')).toBe(1);
    expect(daysUntilLocal('2026-08-06')).toBe(7);
  });

  it('still says 1 for tomorrow late in the evening', () => {
    // 21:00 local. If the machine is behind UTC, "tomorrow" is already today in
    // UTC — the old code returned 0 here and an option expiring tomorrow was
    // shown as expiring today.
    freeze('2026-07-30T21:00:00');
    expect(daysUntilLocal('2026-07-31')).toBe(1);
    expect(daysUntilLocal('2026-07-30')).toBe(0);
  });

  it('goes negative for past dates', () => {
    freeze('2026-07-30T12:00:00');
    expect(daysUntilLocal('2026-07-29')).toBe(-1);
    expect(daysUntilLocal('2026-07-23')).toBe(-7);
  });

  it('returns null for absent or malformed input rather than NaN', () => {
    // NaN would compare false against every threshold and silently disable the
    // expiry and earnings warnings.
    expect(daysUntilLocal(undefined)).toBeNull();
    expect(daysUntilLocal(null)).toBeNull();
    expect(daysUntilLocal('')).toBeNull();
    expect(daysUntilLocal('07/31/2026')).toBeNull();
    expect(daysUntilLocal('2026-7-31')).toBeNull();
  });
});

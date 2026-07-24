import { describe, it, expect } from 'vitest';
import { ago, cx, fmtCompact, fmtDate, fmtNum, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from './format';

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

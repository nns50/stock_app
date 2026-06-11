import { describe, it, expect } from 'vitest';
import { ago, cx, fmtCompact, fmtNum, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from './format';

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

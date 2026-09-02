import { describe, it, expect } from 'vitest';
import {
  bsPrice,
  bsGreeks,
  impliedVol,
  normCdf,
  daysToExpiration,
  calendarDaysToExpiration,
  calendarDaysBetween,
} from '../src/options/blackScholes';

describe('normCdf', () => {
  it('is 0.5 at 0 and saturates at the tails', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(-6)).toBeCloseTo(0, 4);
    expect(normCdf(6)).toBeCloseTo(1, 4);
  });
  it('matches a known quantile (N(1.96) ≈ 0.975)', () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe('bsPrice', () => {
  const base = { S: 100, K: 100, T: 0.5, r: 0.04, sigma: 0.2, q: 0 } as const;

  it('satisfies put–call parity: C - P = S - K e^{-rT} (q=0)', () => {
    const call = bsPrice({ ...base, type: 'call' });
    const put = bsPrice({ ...base, type: 'put' });
    const parity = base.S - base.K * Math.exp(-base.r * base.T);
    expect(call - put).toBeCloseTo(parity, 6);
  });

  it('returns intrinsic value at expiry (T=0)', () => {
    expect(bsPrice({ type: 'call', S: 110, K: 100, T: 0, r: 0.04, sigma: 0.2 })).toBeCloseTo(10, 6);
    expect(bsPrice({ type: 'put', S: 90, K: 100, T: 0, r: 0.04, sigma: 0.2 })).toBeCloseTo(10, 6);
    expect(bsPrice({ type: 'call', S: 90, K: 100, T: 0, r: 0.04, sigma: 0.2 })).toBe(0);
  });

  it('is increasing in volatility', () => {
    const low = bsPrice({ ...base, type: 'call', sigma: 0.1 });
    const high = bsPrice({ ...base, type: 'call', sigma: 0.4 });
    expect(high).toBeGreaterThan(low);
  });
});

describe('bsGreeks', () => {
  const base = { S: 100, K: 100, T: 0.5, r: 0.04, sigma: 0.3, q: 0 } as const;

  it('call delta in (0,1), put delta in (-1,0)', () => {
    expect(bsGreeks({ ...base, type: 'call' }).delta).toBeGreaterThan(0);
    expect(bsGreeks({ ...base, type: 'call' }).delta).toBeLessThan(1);
    expect(bsGreeks({ ...base, type: 'put' }).delta).toBeLessThan(0);
    expect(bsGreeks({ ...base, type: 'put' }).delta).toBeGreaterThan(-1);
  });

  it('gamma and vega are positive; theta is negative for long ATM', () => {
    const g = bsGreeks({ ...base, type: 'call' });
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.vega).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
  });

  it('call and put delta differ by ~e^{-qT} (=1 when q=0)', () => {
    const c = bsGreeks({ ...base, type: 'call' }).delta;
    const p = bsGreeks({ ...base, type: 'put' }).delta;
    expect(c - p).toBeCloseTo(1, 3);
  });
});

describe('impliedVol', () => {
  it('recovers the volatility used to price the option', () => {
    for (const sigma of [0.15, 0.3, 0.55, 0.8]) {
      const S = 100;
      const K = 105;
      const T = 0.4;
      const r = 0.04;
      const price = bsPrice({ type: 'call', S, K, T, r, sigma });
      const iv = impliedVol({ type: 'call', marketPrice: price, S, K, T, r });
      expect(iv).toBeDefined();
      expect(iv as number).toBeCloseTo(sigma, 3);
    }
  });

  it('returns undefined when the price is below intrinsic', () => {
    const iv = impliedVol({ type: 'call', marketPrice: 1, S: 150, K: 100, T: 0.5, r: 0.04 });
    expect(iv).toBeUndefined();
  });
});

// The unit every DTE *window* is configured in. daysToExpiration is fractional
// and is right for pricing; comparing it against a whole-day setting is what
// made a 0-2 window reject every Friday contract on a Wednesday.
describe('calendarDaysToExpiration', () => {
  it('is 2 for Wednesday -> Friday at EVERY hour of the session', () => {
    // 2026-09-02 is a Wednesday; 2026-09-04 the Friday weekly expiry that
    // DE, TXN and the rest of the universe all list. Fractional DTE scores
    // this 2.27 at the open and 2.00 only after the close, so the window
    // admitted it on Thursday and Friday alone.
    for (const t of ['13:35', '16:00', '19:59']) {
      const from = new Date(`2026-09-02T${t}:00Z`);
      expect(calendarDaysToExpiration('2026-09-04', from), `at ${t}Z`).toBe(2);
      expect(daysToExpiration('2026-09-04', from)).toBeGreaterThan(2); // the old comparison
    }
  });

  it('is 0 on the expiration day itself, at any hour', () => {
    expect(calendarDaysToExpiration('2026-09-04', new Date('2026-09-04T13:35:00Z'))).toBe(0);
    expect(calendarDaysToExpiration('2026-09-04', new Date('2026-09-04T19:59:00Z'))).toBe(0);
  });

  it('floors at 0 for an expiration already past, like its fractional sibling', () => {
    expect(calendarDaysToExpiration('2026-08-28', new Date('2026-09-02T13:35:00Z'))).toBe(0);
  });

  it('is anchored to the ET calendar day, not the server clock', () => {
    // 03:00Z on Sep 2 is 23:00 ET on Sep 1 — still the Sep 1 market day, so
    // Friday Sep 4 is 3 days out, not 2. A UTC-anchored version would say 2
    // and quietly admit a contract a day early.
    expect(calendarDaysToExpiration('2026-09-04', new Date('2026-09-02T03:00:00Z'))).toBe(3);
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole days between two market dates', () => {
    expect(calendarDaysBetween('2026-09-02', '2026-09-04')).toBe(2); // Wed -> Fri
    expect(calendarDaysBetween('2026-09-04', '2026-09-04')).toBe(0); // same day
    expect(calendarDaysBetween('2026-08-31', '2026-09-04')).toBe(4); // Mon -> Fri
  });

  it('floors at 0 rather than going negative', () => {
    expect(calendarDaysBetween('2026-09-04', '2026-08-31')).toBe(0);
  });

  it('is the definition calendarDaysToExpiration is built on', () => {
    // One function, so the live window gates and the options backtest cannot
    // select different contracts for the same configured window.
    const from = new Date('2026-09-02T13:35:00Z'); // Wed 09:35 ET
    expect(calendarDaysToExpiration('2026-09-04', from)).toBe(calendarDaysBetween('2026-09-02', '2026-09-04'));
  });
});

describe('daysToExpiration', () => {
  it('is ~7 for a week out and 0 in the past', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(daysToExpiration('2026-01-08', from)).toBeGreaterThan(6.5);
    expect(daysToExpiration('2026-01-08', from)).toBeLessThan(8);
    expect(daysToExpiration('2025-12-01', from)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buyableEntryLimit,
  buyableSpreadEntryLimit,
  CONTRACT_QUOTE_MAX_AGE_MS,
  EXIT_QUOTE_MAX_AGE_MS,
  resolveContractQuote,
  resolveExitQuote,
} from '../src/services/autotrading/optionsExitPricing';

// ---------------------------------------------------------------------------
// The buy side of an options order (2026-09-18). An entry is priced from the
// ASK — what a buyer actually pays — with the buffer on top so a quote that
// ticks up between the snapshot and the order still fills, and the buffered
// mark only when no ask was quoted. These are the pure helpers both books call;
// what each executor does with them is pinned in liveOptionsExecute.test.ts
// and autotradeOptionsExecute.test.ts.
// ---------------------------------------------------------------------------

describe('buyableEntryLimit', () => {
  it('prices from the ask, with the buffer on top, rounded UP onto the grid', () => {
    const e = buyableEntryLimit({ ask: 4.6, mark: 4.5, fromLastTrade: false });
    expect(e.basis).toBe('ask');
    expect(e.fillPremium).toBe(4.6); // the sizer and the reference read the ask, never the limit
    expect(e.limitPrice).toBe(4.83); // 4.6 × 1.05 on the penny grid
  });

  it('rounds up onto the nickel grid under $3', () => {
    const e = buyableEntryLimit({ ask: 2.2, mark: 2.1, fromLastTrade: false });
    expect(e.limitPrice).toBe(2.35); // 2.31 rounds up to the next nickel
    expect(e.fillPremium).toBe(2.2);
  });

  it('falls back to the buffered mark when there is no ask, and says so', () => {
    const e = buyableEntryLimit({ mark: 4, fromLastTrade: false });
    expect(e).toEqual({ limitPrice: 4.2, fillPremium: 4, basis: 'mark' });
  });

  it('labels a last-trade-only quote as such — the paper book fills on one, the live book refuses first', () => {
    const e = buyableEntryLimit({ mark: 2.5, fromLastTrade: true });
    expect(e).toEqual({ limitPrice: 2.65, fillPremium: 2.5, basis: 'last' });
  });

  it('ignores an ask that is not a real premium', () => {
    expect(buyableEntryLimit({ ask: 0, mark: 4, fromLastTrade: false }).basis).toBe('mark');
    expect(buyableEntryLimit({ ask: -1, mark: 4, fromLastTrade: false }).basis).toBe('mark');
    expect(buyableEntryLimit({ ask: Number.NaN, mark: 4, fromLastTrade: false }).basis).toBe('mark');
  });

  it('returns an unplaceable limit for an unquoted contract, so the caller refuses', () => {
    const e = buyableEntryLimit({ mark: 0, fromLastTrade: false });
    expect(e.limitPrice).toBe(0);
    expect(e.fillPremium).toBe(0);
  });
});

describe('buyableSpreadEntryLimit', () => {
  it('buys the long leg at its ask and sells the short at its bid — the net a vertical really costs', () => {
    const e = buyableSpreadEntryLimit({ longAsk: 3.1, shortBid: 0.9, longMark: 3, shortMark: 1, fromLastTrade: false });
    expect(e.basis).toBe('ask');
    expect(e.fillPremium).toBeCloseTo(2.2, 10);
    expect(e.limitPrice).toBe(2.35); // 2.31 up onto the nickel grid
  });

  it('falls back to the buffered net mark when a leg has no quoted side', () => {
    const e = buyableSpreadEntryLimit({ longAsk: 3.1, longMark: 3, shortMark: 1, fromLastTrade: false });
    expect(e).toEqual({ limitPrice: 2.1, fillPremium: 2, basis: 'mark' });
  });

  it('returns an unplaceable limit when the net is not a debit', () => {
    const e = buyableSpreadEntryLimit({
      longAsk: 1,
      shortBid: 1.2,
      longMark: 1.1,
      shortMark: 1.1,
      fromLastTrade: false,
    });
    expect(e.fillPremium).toBeCloseTo(-0.2, 10);
    expect(e.limitPrice).toBe(0);
  });
});

describe('one resolver, both sides', () => {
  it('the exit names are the entry names — nothing derives a second quote', () => {
    expect(resolveExitQuote).toBe(resolveContractQuote);
    expect(EXIT_QUOTE_MAX_AGE_MS).toBe(CONTRACT_QUOTE_MAX_AGE_MS);
  });
});

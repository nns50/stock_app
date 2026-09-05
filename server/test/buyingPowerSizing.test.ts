import { describe, it, expect } from 'vitest';
import {
  fundableMaxQuantity,
  isTooSmallToFund,
  MIN_FUNDED_SIZE_FRACTION,
} from '../src/services/autotrading/buyingPowerSizing';

// The real 2026-08-28 session: $5,161.18 of cash, but only $2,161.18 of buying
// power (a $5,000 deposit had not settled). The sizer kept producing
// $3,600-$5,378 orders, the guardrail refused all 627 of them, and the day
// produced zero live entries.
const BP = 2_161.18;

describe('fundableMaxQuantity — every dollar bound, tightest wins', () => {
  const base = { entryPrice: 100, openClose: 'open' as const };

  it('takes the tightest of the three bounds and names it', () => {
    // Buying power is roomy, the per-order cap is tighter, exposure headroom
    // tighter still. Before 2026-09-05 only the first was even passed in.
    const r = fundableMaxQuantity({
      ...base,
      buyingPowerUsd: 50_000,
      maxOrderUsd: 20_000,
      exposureHeadroomUsd: 5_000,
    });
    expect(r.boundBy).toBe('account_exposure');
    expect(r.maxQuantity).toBe(Math.floor((5_000 * 0.98) / 100));
  });

  it('values the order at the marketable limit when one is supplied', () => {
    // The guardrail values at the LIMIT price, so the sizer must too — this is
    // the whole "two places deriving one quantity" hazard.
    const atEntry = fundableMaxQuantity({ ...base, buyingPowerUsd: 10_000 });
    const atLimit = fundableMaxQuantity({ ...base, buyingPowerUsd: 10_000, limitBufferPct: 0.5 });
    expect(atLimit.maxQuantity!).toBeLessThan(atEntry.maxQuantity!);
    expect(atLimit.maxQuantity).toBe(Math.floor((10_000 * 0.98) / 100.5));
  });

  it('a short values cheaper, matching its limit sitting BELOW the quote', () => {
    const long = fundableMaxQuantity({ ...base, buyingPowerUsd: 10_000, limitBufferPct: 0.5 });
    const short = fundableMaxQuantity({ ...base, buyingPowerUsd: 10_000, limitBufferPct: -0.5 });
    expect(short.maxQuantity!).toBeGreaterThan(long.maxQuantity!);
  });

  it('treats zero exposure headroom as a real zero, not as unknown', () => {
    // An account AT its cap has genuinely no room. Reading that as "no
    // constraint" would size as if the cap did not exist — the exact failure
    // this exists to stop.
    const r = fundableMaxQuantity({ ...base, buyingPowerUsd: 50_000, exposureHeadroomUsd: 0 });
    expect(r.maxQuantity).toBe(0);
    expect(r.boundBy).toBe('account_exposure');
  });

  it('still imposes nothing when no bound is known at all', () => {
    expect(fundableMaxQuantity({ ...base, buyingPowerUsd: undefined })).toEqual({
      maxQuantity: undefined,
      usableUsd: undefined,
    });
  });
});

describe('fundableMaxQuantity', () => {
  it('caps the size to what the account can actually fund', () => {
    // PGY on the day: the sizer wanted $3,607.74 of stock.
    const r = fundableMaxQuantity({ buyingPowerUsd: BP, entryPrice: 36.08, openClose: 'open' });
    // 2% reserve => $2,117.96 usable => 58 shares ($2,092.64), inside BP.
    expect(r.maxQuantity).toBe(58);
    expect(r.maxQuantity! * 36.08).toBeLessThan(BP);
  });

  it('holds back a reserve rather than sizing to the last cent', () => {
    // Sizing to exactly the available figure leaves a fundable order one tick
    // of drift from a broker rejection, because the guardrail values the order
    // at its limit price.
    const r = fundableMaxQuantity({ buyingPowerUsd: 1_000, entryPrice: 100, openClose: 'open' });
    expect(r.maxQuantity).toBe(9); // not 10
    expect(r.usableUsd).toBeCloseTo(980, 6);
  });

  it('imposes NO constraint when buying power is unknown', () => {
    // Paper, or a failed broker read. Must behave exactly as before this
    // module existed, rather than guessing a cap that shrinks every order.
    expect(fundableMaxQuantity({ buyingPowerUsd: undefined, entryPrice: 50, openClose: 'open' })).toEqual({
      maxQuantity: undefined,
      usableUsd: undefined,
    });
  });

  it('leaves CLOSING orders alone — they free buying power', () => {
    // Mirrors guardrails.ts, so the two cannot disagree about which orders are
    // constrained.
    expect(
      fundableMaxQuantity({ buyingPowerUsd: 10, entryPrice: 500, openClose: 'close' }).maxQuantity,
    ).toBeUndefined();
  });

  it('CONSTRAINS a short entry — an opening sell consumes margin', () => {
    // The bug this replaced: keying on `side` waved every sell through as
    // "frees cash". True of closing a long, false of opening a short. It was
    // inert only because liveAllowNakedShort was off, and would have become
    // live money the moment shorts were enabled.
    const r = fundableMaxQuantity({ buyingPowerUsd: 1_000, entryPrice: 100, openClose: 'open' });
    expect(r.maxQuantity).toBe(9);
  });

  it('returns 0 — not undefined — when not even one share is affordable', () => {
    // 0 is a real answer that must block the trade; undefined would wave it
    // through unconstrained, which is the opposite.
    const r = fundableMaxQuantity({ buyingPowerUsd: 100, entryPrice: 500, openClose: 'open' });
    expect(r.maxQuantity).toBe(0);
  });

  it('refuses to invent a cap from unusable inputs', () => {
    for (const bad of [0, -10, Number.NaN]) {
      expect(fundableMaxQuantity({ buyingPowerUsd: 1_000, entryPrice: bad, openClose: 'open' }).maxQuantity).toBe(
        undefined,
      );
    }
    expect(fundableMaxQuantity({ buyingPowerUsd: Number.NaN, entryPrice: 50, openClose: 'open' }).maxQuantity).toBe(
      undefined,
    );
  });

  it('treats negative buying power as zero rather than a negative size', () => {
    expect(fundableMaxQuantity({ buyingPowerUsd: -500, entryPrice: 50, openClose: 'open' }).maxQuantity).toBe(0);
  });
});

describe('isTooSmallToFund', () => {
  it('lets the whole 2026-08-28 candidate set through — they were all affordable enough', () => {
    // Fundable fractions that day ran ~0.45-0.60. Every one clears the floor,
    // so the fix would have produced trades rather than a quieter kind of zero.
    for (const frac of [0.45, 0.5, 0.6]) {
      expect(isTooSmallToFund(Math.floor(100 * frac), 100)).toBe(false);
    }
  });

  it('skips a token position that would still cost a slot and a daily trade', () => {
    expect(isTooSmallToFund(10, 100)).toBe(true);
  });

  it('is exactly at the floor, not near it', () => {
    const n = 100;
    expect(isTooSmallToFund(Math.ceil(n * MIN_FUNDED_SIZE_FRACTION), n)).toBe(false);
    expect(isTooSmallToFund(Math.ceil(n * MIN_FUNDED_SIZE_FRACTION) - 1, n)).toBe(true);
  });

  it('never calls a full-size or unconstrained position too small', () => {
    expect(isTooSmallToFund(100, 100)).toBe(false);
    expect(isTooSmallToFund(120, 100)).toBe(false);
    expect(isTooSmallToFund(0, 0)).toBe(false);
  });
});

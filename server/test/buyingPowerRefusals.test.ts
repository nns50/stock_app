import { describe, it, expect, beforeEach } from 'vitest';
import {
  ceilingCappedQuantity,
  isInsufficientBuyingPowerError,
  learnedOpenNotionalCeiling,
  markBuyingPowerAccepted,
  markBuyingPowerRefusal,
  resetBuyingPowerRefusals,
} from '../src/services/autotrading/buyingPowerRefusals';

const ACC = 'ACC1';
const DAY = '2026-09-14';

describe('buyingPowerRefusals', () => {
  beforeEach(resetBuyingPowerRefusals);

  it('has nothing to say until the broker refuses something', () => {
    // The guarantee that makes this safe to leave on: no refusal, no ceiling,
    // so a normal session sizes exactly as it did before.
    markBuyingPowerAccepted(ACC, DAY, 3_312);
    expect(learnedOpenNotionalCeiling(ACC, DAY)).toBeUndefined();
  });

  it('steps 10% below the refusal when nothing has been accepted yet', () => {
    // 09:57 on 2026-09-14: the book was flat, nothing had filled since the
    // pool was spent, so there is no lower bracket to bisect against.
    markBuyingPowerRefusal(ACC, DAY, 3_720.12);
    expect(learnedOpenNotionalCeiling(ACC, DAY)).toMatchObject({
      ceilingUsd: 3_348.108,
      refusedUsd: 3_720.12,
      acceptedUsd: null,
    });
  });

  it('bisects between the largest accepted and the smallest refused', () => {
    markBuyingPowerAccepted(ACC, DAY, 3_312);
    markBuyingPowerRefusal(ACC, DAY, 3_720.12);
    const out = learnedOpenNotionalCeiling(ACC, DAY);
    expect(out?.ceilingUsd).toBeCloseTo(3_516.06, 2);
    expect(out?.acceptedUsd).toBe(3_312);
    // The real answer that day sat between $3,479.55 (CRWD filled) and
    // $3,720.12 (BWIN refused), so one more round lands inside it.
    markBuyingPowerRefusal(ACC, DAY, 3_516.06);
    expect(learnedOpenNotionalCeiling(ACC, DAY)?.ceilingUsd).toBeCloseTo(3_414.03, 2);
  });

  it('keeps the SMALLEST refusal and the LARGEST acceptance', () => {
    // The ceiling is bounded by the tightest refusal seen, not the latest one;
    // a later, larger refusal says nothing new.
    markBuyingPowerRefusal(ACC, DAY, 3_720.12);
    markBuyingPowerRefusal(ACC, DAY, 3_076.8);
    markBuyingPowerRefusal(ACC, DAY, 9_999);
    markBuyingPowerAccepted(ACC, DAY, 1_000);
    markBuyingPowerAccepted(ACC, DAY, 2_937.48);
    markBuyingPowerAccepted(ACC, DAY, 500);
    const out = learnedOpenNotionalCeiling(ACC, DAY);
    expect(out?.refusedUsd).toBe(3_076.8);
    expect(out?.acceptedUsd).toBe(2_937.48);
  });

  it('falls back to the blind step when the acceptance is not below the refusal', () => {
    // The pool moves during a session, so an acceptance ABOVE the refusal is
    // not a contradiction to argue with — it is just no longer a valid lower
    // bracket, and bisecting on it would aim ABOVE what was refused.
    markBuyingPowerRefusal(ACC, DAY, 3_000);
    markBuyingPowerAccepted(ACC, DAY, 5_000);
    expect(learnedOpenNotionalCeiling(ACC, DAY)).toMatchObject({ ceilingUsd: 2_700, acceptedUsd: null });
  });

  it('forgets everything on a new ET day', () => {
    // A ceiling is a within-session fact: the pool is restored overnight.
    markBuyingPowerRefusal(ACC, DAY, 3_720.12);
    expect(learnedOpenNotionalCeiling(ACC, '2026-09-15')).toBeUndefined();
  });

  it('keeps accounts apart', () => {
    markBuyingPowerRefusal(ACC, DAY, 3_720.12);
    expect(learnedOpenNotionalCeiling('ACC2', DAY)).toBeUndefined();
  });

  it('ignores a non-positive notional rather than learning a zero ceiling', () => {
    markBuyingPowerRefusal(ACC, DAY, 0);
    markBuyingPowerRefusal(ACC, DAY, -5);
    expect(learnedOpenNotionalCeiling(ACC, DAY)).toBeUndefined();
  });

  describe('isInsufficientBuyingPowerError', () => {
    it("matches the broker's own wording", () => {
      expect(
        isInsufficientBuyingPowerError(
          'Buying power is insufficient. Please cancel open buy orders (if any) and try again.',
        ),
      ).toBe(true);
      expect(isInsufficientBuyingPowerError('Not enough buying power')).toBe(true);
      expect(isInsufficientBuyingPowerError('INSUFFICIENT BUYING POWER')).toBe(true);
    });

    it('does not match an unrelated rejection', () => {
      // Over-matching costs one order sized smaller than it needed to be;
      // learning a ceiling from a bad symbol would shrink every later order.
      expect(isInsufficientBuyingPowerError('Order price is invalid')).toBe(false);
      expect(isInsufficientBuyingPowerError('Symbol not found')).toBe(false);
      expect(isInsufficientBuyingPowerError(undefined)).toBe(false);
      expect(isInsufficientBuyingPowerError('')).toBe(false);
    });
  });

  describe('ceilingCappedQuantity', () => {
    it('values the order at the LIMIT price the broker will judge', () => {
      // A marketable buy limit sits above the quote, so pricing at the signal
      // entry would send an order dearer than the ceiling it was sized to fit.
      expect(ceilingCappedQuantity(3_348.11, 100.5)).toBe(33);
      expect(33 * 100.5).toBeLessThanOrEqual(3_348.11);
    });

    it('returns undefined on an unusable price rather than a zero quantity', () => {
      expect(ceilingCappedQuantity(1_000, 0)).toBeUndefined();
      expect(ceilingCappedQuantity(1_000, -1)).toBeUndefined();
    });

    it('returns 0 when nothing fits, so the caller can skip rather than send one share', () => {
      expect(ceilingCappedQuantity(50, 100.5)).toBe(0);
    });
  });
});

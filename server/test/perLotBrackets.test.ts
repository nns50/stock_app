import { describe, it, expect } from 'vitest';
import {
  classifySecondBracketRefusal,
  lotsFitProtectiveBound,
  planLotBrackets,
  planRollbackToSingle,
  REVERSE_POSITION_CODE,
  type BracketLot,
} from '../src/services/autotrading/perLotBrackets';

const plan = (over: Partial<Parameters<typeof planLotBrackets>[0]> = {}) =>
  planLotBrackets({
    filledQuantity: 38,
    partialExitPct: 67,
    partialExitRMultiple: 0.25,
    targetRMultiple: 2,
    ...over,
  });

describe('planLotBrackets', () => {
  it('splits the live config the way the scale-out already means to', () => {
    // 67% of 38 = 25.46 -> 25 on the near target, 13 carried to the full one.
    expect(plan()).toEqual([
      { quantity: 25, targetR: 0.25, role: 'partial' },
      { quantity: 13, targetR: 2, role: 'runner' },
    ]);
  });

  it('lots always sum to the FILLED quantity, at every size', () => {
    // The bound is measured against what the broker holds. A plan that sums to
    // more is refused; one that sums to less leaves shares unprotected. Neither
    // is recoverable after the fact, so this is checked exhaustively rather
    // than at a couple of convenient sizes.
    for (let q = 1; q <= 200; q++) {
      const lots = plan({ filledQuantity: q });
      expect(
        lots.reduce((s, l) => s + l.quantity, 0),
        `quantity ${q}`,
      ).toBe(q);
      expect(
        lots.every((l) => l.quantity >= 1),
        `quantity ${q} has an empty lot`,
      ).toBe(true);
    }
  });

  it('falls back to ONE lot whenever a split would be meaningless', () => {
    const single = (lots: BracketLot[]) => lots.length === 1 && lots[0].role === 'runner';
    expect(single(plan({ filledQuantity: 1 }))).toBe(true); // nothing to split
    expect(single(plan({ partialExitPct: 0 }))).toBe(true); // scale-out off
    expect(single(plan({ partialExitPct: 100 }))).toBe(true); // no runner left
    expect(single(plan({ partialExitRMultiple: 0 }))).toBe(true); // no near target
    // 1% of 38 rounds to 0 — a zero-share bracket is not an order.
    expect(single(plan({ partialExitPct: 1 }))).toBe(true);
  });

  it('the single-lot fallback is the RUNNER, never the partial', () => {
    // If only one bracket can exist it must not cap the trade at the near
    // target. Getting this backwards would silently convert every position
    // into a 0.25R exit.
    const lots = plan({ filledQuantity: 1 });
    expect(lots[0].targetR).toBe(2);
    expect(lots[0].role).toBe('runner');
  });

  it('refuses to put the near target at or beyond the full one', () => {
    // Not a scale-out: two orders at one price, with the SMALLER lot in front.
    // Strictly worse than a single bracket, so it collapses to one.
    expect(plan({ partialExitRMultiple: 2 })).toHaveLength(1);
    expect(plan({ partialExitRMultiple: 3 })).toHaveLength(1);
  });

  it('returns no lots at all for a quantity that cannot be protected', () => {
    // Zero-filled is not "one lot of zero" — there is nothing to bracket.
    expect(plan({ filledQuantity: 0 })).toEqual([]);
    expect(plan({ filledQuantity: Number.NaN })).toEqual([]);
  });
});

describe('lotsFitProtectiveBound', () => {
  const lots: BracketLot[] = [
    { quantity: 19, targetR: 0.25, role: 'partial' },
    { quantity: 19, targetR: 2, role: 'runner' },
  ];

  it('two lots over the full holding sit EXACTLY on the bound', () => {
    // The FCX shape: 38 held, nothing committed, 19 + 19 requested. Zero
    // headroom by construction — which is the point, and why the partial-fill
    // case below matters.
    const v = lotsFitProtectiveBound(lots, 38, 0);
    expect(v.ok).toBe(true);
    expect(v.available).toBe(38);
    expect(v.requested).toBe(38);
  });

  it('refuses when a bracket already rests — held MINUS committed', () => {
    // The probe's actual refusal: 38 held with a full 38-share bracket resting
    // leaves nothing available, whatever the new order asks for.
    const v = lotsFitProtectiveBound(lots, 38, 38);
    expect(v.ok).toBe(false);
    expect(v.available).toBe(0);
    expect(v.reason).toMatch(/38 held/);
  });

  it('refuses on a PARTIAL fill, which is the race this design is exposed to', () => {
    // Planned for 38 but only 30 filled: the plan still asks for 38 and the
    // broker holds 30. Catching it here is the difference between a refused
    // order and eight naked shares.
    const v = lotsFitProtectiveBound(lots, 30, 0);
    expect(v.ok).toBe(false);
    expect(v.requested).toBe(38);
    expect(v.available).toBe(30);
  });

  it('treats an UNKNOWN commitment as not ok, never as zero', () => {
    // committedProtectiveQuantity returns null when an open order's quantity
    // is unreadable. Reading null as 0 would place into an unknown commitment
    // and learn the bound by having shares exposed.
    const v = lotsFitProtectiveBound(lots, 38, null);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unknown/);
  });
});

describe('classifySecondBracketRefusal', () => {
  it('does NOT retry a reverse-position refusal — retrying cannot change it', () => {
    // The whole point of the FCX probe. When the arithmetic already fits, this
    // code on the SECOND bracket can only mean the broker is counting the
    // FIRST one against us — two groups do not coexist. That is a fact about
    // the account, not a transient.
    expect(classifySecondBracketRefusal(`error: ${REVERSE_POSITION_CODE}`, 1)).toBe('fallback_single');
  });

  it('retries once on anything that might be transient', () => {
    expect(classifySecondBracketRefusal('ETIMEDOUT', 1)).toBe('retry');
    expect(classifySecondBracketRefusal('rate limited', 1)).toBe('retry');
    expect(classifySecondBracketRefusal(null, 1)).toBe('retry');
  });

  it('falls back on the SECOND failure whatever the reason', () => {
    // One lot protected and one naked is not a state to keep probing from.
    expect(classifySecondBracketRefusal('ETIMEDOUT', 2)).toBe('fallback_single');
    expect(classifySecondBracketRefusal(null, 3)).toBe('fallback_single');
  });
});

describe('planRollbackToSingle', () => {
  it('names the window it reopens rather than leaving the caller to infer it', () => {
    const r = planRollbackToSingle(['bracket-1-stop', 'bracket-1-target'], 38);
    expect(r.cancelClientOrderIds).toEqual(['bracket-1-stop', 'bracket-1-target']);
    expect(r.fullQuantity).toBe(38);
    // The first bracket MUST be cancelled before the full one is placed — the
    // broker counts it against the new order, which is the very bound being
    // rolled back from. That is what reopens the window.
    expect(r.reopensNakedWindow).toBe(true);
  });

  it('reopens nothing when the first bracket never rested', () => {
    // If bracket 1 itself failed there is nothing to cancel, so the fallback
    // places the full bracket into a clean book with no window at all.
    expect(planRollbackToSingle([], 38).reopensNakedWindow).toBe(false);
  });
});

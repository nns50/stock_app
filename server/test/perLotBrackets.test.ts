import { describe, it, expect } from 'vitest';
import {
  classifySecondBracketRefusal,
  lotsFitProtectiveBound,
  planLotBrackets,
  planRollbackToSingle,
  REVERSE_POSITION_CODE,
  type BracketLot,
  splitEntryForPerLot,
  lotTargetPrice,
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

// ---------------------------------------------------------------------------
// WHAT THE 2026-09-09 SIRI PROBE ESTABLISHED, pinned as a test so the finding
// cannot be quietly un-learned by someone reading only lotsFitProtectiveBound.
//
// One share, six cents: OTOCO #1 filled and rested a bracket (1 held, 1
// committed, available 0), then OTOCO #2 was submitted on the SAME symbol with
// its own bracket and an unfillable entry — and was ACCEPTED, both groups
// resting simultaneously. So contingent exits are not counted against
// holdings, and two combo groups do coexist on one symbol.
// ---------------------------------------------------------------------------
describe('the standalone bound does not govern the OTOCO path (2026-09-09 probe)', () => {
  it('would REFUSE the very plan the broker accepted, which is why it must not gate entries', () => {
    // The probe's exact state: 1 share held, 1 already committed to the first
    // bracket. lotsFitProtectiveBound says no room for a single further share.
    const verdict = lotsFitProtectiveBound([{ quantity: 1, targetR: 2, role: 'runner' }], 1, 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.available).toBe(0);
    // The broker accepted it anyway. This assertion is not describing a bug in
    // the function — it is correct for STANDALONE brackets — it pins the reason
    // the OTOCO entry path must not consult it.
  });

  it('still governs a standalone re-arm over shares already held', () => {
    // 38 held, nothing committed: a full-size standalone bracket fits.
    expect(lotsFitProtectiveBound([{ quantity: 38, targetR: 2, role: 'runner' }], 38, 0).ok).toBe(true);
    // 38 held with 38 already committed: no room, which is the FCX refusal.
    expect(lotsFitProtectiveBound([{ quantity: 38, targetR: 2, role: 'runner' }], 38, 38).ok).toBe(false);
  });

  it('a per-lot plan sums to exactly the filled quantity, so the lots never over-ask', () => {
    // The arithmetic the OTOCO design rests on: each group's exits cover only
    // its own lot, so together they equal what is held — never more. Checked
    // across sizes rather than at one convenient number.
    for (const qty of [2, 3, 7, 38, 47, 91, 100, 199]) {
      const lots = planLotBrackets({
        filledQuantity: qty,
        partialExitPct: 67,
        partialExitRMultiple: 0.25,
        targetRMultiple: 2,
      });
      expect(
        lots.reduce((s, l) => s + l.quantity, 0),
        `qty ${qty}`,
      ).toBe(qty);
    }
  });
});

describe('splitEntryForPerLot', () => {
  const base = { partialExitPct: 67, partialExitRMultiple: 0.25, targetRMultiple: 2 };

  it('places the LARGER lot first, so a failed second lot leaves most of the size', () => {
    // 67% partial of 100 = 67 partial / 33 runner. The partial is larger, so it
    // enters first and the failure mode is "67 shares capped at the near
    // target" rather than "33 shares".
    const split = splitEntryForPerLot({ filledQuantity: 100, ...base });
    expect(split?.first).toEqual({ quantity: 67, targetR: 0.25, role: 'partial' });
    expect(split?.second).toEqual({ quantity: 33, targetR: 2, role: 'runner' });
  });

  it('places the RUNNER first when it is the larger lot', () => {
    // 30% partial of 100 = 30 partial / 70 runner.
    const split = splitEntryForPerLot({ filledQuantity: 100, ...base, partialExitPct: 30 });
    expect(split?.first.role).toBe('runner');
    expect(split?.first.quantity).toBe(70);
    expect(split?.second.role).toBe('partial');
  });

  it('breaks a tie toward the RUNNER — an uncapped small trade beats a capped one', () => {
    const split = splitEntryForPerLot({ filledQuantity: 100, ...base, partialExitPct: 50 });
    expect(split?.first.quantity).toBe(50);
    expect(split?.second.quantity).toBe(50);
    expect(split?.first.role).toBe('runner');
  });

  it('returns null wherever planLotBrackets would not split, so the caller enters normally', () => {
    expect(splitEntryForPerLot({ filledQuantity: 1, ...base })).toBeNull(); // too small
    expect(splitEntryForPerLot({ filledQuantity: 100, ...base, partialExitPct: 0 })).toBeNull();
    expect(splitEntryForPerLot({ filledQuantity: 100, ...base, partialExitRMultiple: 0 })).toBeNull();
    // A near target at or beyond the full one is not a scale-out.
    expect(splitEntryForPerLot({ filledQuantity: 100, ...base, partialExitRMultiple: 2 })).toBeNull();
  });

  it('never loses or invents a share', () => {
    for (const qty of [2, 5, 33, 47, 91, 100, 199]) {
      const split = splitEntryForPerLot({ filledQuantity: qty, ...base });
      if (!split) continue;
      expect(split.first.quantity + split.second.quantity, `qty ${qty}`).toBe(qty);
      expect(split.first.quantity, `qty ${qty}`).toBeGreaterThanOrEqual(split.second.quantity);
    }
  });
});

describe('lotTargetPrice', () => {
  it('is the SAME definition of R the signal itself uses', () => {
    // entry 100, stop 95 => 1R = $5. The full 2R target is the signal's own
    // 110, which is the check that the near target below is on one scale with
    // it rather than a second, quietly different one.
    expect(lotTargetPrice(100, 95, 'buy', 2)).toBe(110);
    expect(lotTargetPrice(100, 95, 'buy', 0.25)).toBe(101.25);
    // Short: mirrored.
    expect(lotTargetPrice(100, 105, 'sell', 2)).toBe(90);
    expect(lotTargetPrice(100, 105, 'sell', 0.25)).toBe(98.75);
  });

  it('rounds to an exact cent, because the broker refuses anything else', () => {
    // 1R = 3.33; 0.25R = 0.8325 => 100.8325, which Webull rejects outright.
    expect(lotTargetPrice(100, 96.67, 'buy', 0.25)).toBe(100.83);
  });

  it('returns null on a zero-width risk rather than a target equal to entry', () => {
    expect(lotTargetPrice(100, 100, 'buy', 2)).toBeNull();
  });
});

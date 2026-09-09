// ---------------------------------------------------------------------------
// Per-lot protective brackets (task #26) — place the scale-out AT ENTRY as two
// independent bracket groups, so taking a partial is just one group's target
// filling. No modify, no cancel-then-replace, and therefore no window with the
// position unprotected.
//
// WHY, AND WHAT KILLED THE ALTERNATIVES. Three ways to scale a live position out
// of one bracket were tried:
//   modify the resting legs   144 refusals, 0 fills — dead (#54).
//   cancel then place         ships and works (#29/#31), but the window between
//                             the cancel and the replace is STRUCTURAL: if the
//                             replace fails, the remainder rests naked. It is
//                             live today and disclosed, not fixed.
//   two brackets at entry     this module.
//
// THE BROKER BOUND, learned from the 2026-09-08 FCX probe and now encoded in
// providers/webull/orders.ts's committedProtectiveQuantity: a new protective
// order is compared against shares HELD MINUS what is already committed to
// resting exits. Within one combo group the MAX leg counts (a 38 stop and a 38
// target rest together over 38 held); ACROSS groups they SUM. So two lots of 19
// over 38 held sits EXACTLY on the bound with zero headroom, and anything that
// makes the held count smaller than expected at the moment the second bracket
// goes out — a partial fill, or an entry not yet booked — refuses it.
//
// WHAT IS STILL UNKNOWN. Whether two combo groups may coexist on one symbol AT
// ALL. The probe sent 39 shares of exits against 38 held, so its refusal is
// fully explained by the quantity bound; it says nothing about the group count.
// The error text conflates the two. That is why classifySecondBracketRefusal
// below treats a reverse-position refusal ON THE SECOND BRACKET as a permanent
// answer rather than something to retry: if it fires when the arithmetic fits,
// the only remaining explanation is the group count, and no number of retries
// changes it.
// ---------------------------------------------------------------------------

/** One lot's protective bracket. Both lots share the STOP — the position has
 *  one risk level, and splitting it would mean two different ideas about where
 *  the trade is wrong. They differ only in target. */
export interface BracketLot {
  quantity: number;
  /** Where this lot takes profit, in R. */
  targetR: number;
  /** `partial` is the scale-out lot (the near target); `runner` carries the
   *  rest to the full target. A single-lot plan is always a `runner`: if only
   *  one bracket can be placed it must be the one that does not cap the trade. */
  role: 'partial' | 'runner';
}

export interface LotPlanInput {
  /** Shares actually FILLED — not ordered. The bound is measured against what
   *  the broker thinks is held, and an order that partially filled holds less
   *  than it asked for. */
  filledQuantity: number;
  /** AutotradeConfig.partialExitPct — % of the position the near target takes. */
  partialExitPct: number;
  /** AutotradeConfig.partialExitRMultiple — the near target, in R. */
  partialExitRMultiple: number;
  /** AutotradeConfig.targetRMultiple — the full target, in R. */
  targetRMultiple: number;
}

/**
 * Split a filled position into its bracket lots.
 *
 * Returns ONE lot whenever a split would be meaningless or harmful — the
 * scale-out disabled, a size too small to divide, or a percentage that rounds
 * either side to zero. A single lot is the current behaviour, so every
 * degenerate case falls back to what already works rather than to nothing.
 */
export function planLotBrackets(input: LotPlanInput): BracketLot[] {
  const { filledQuantity: qty, partialExitPct, partialExitRMultiple, targetRMultiple } = input;
  const single = (): BracketLot[] => [{ quantity: qty, targetR: targetRMultiple, role: 'runner' }];
  if (!Number.isFinite(qty) || qty < 1) return [];
  if (qty < 2) return single(); // nothing to split
  if (!(partialExitPct > 0) || partialExitPct >= 100) return single();
  if (!(partialExitRMultiple > 0)) return single();
  // A near target at or beyond the full one is not a scale-out, it is one exit
  // wearing two orders — and it would put the SMALLER lot in front of the
  // larger at the same price, which is strictly worse than a single bracket.
  if (partialExitRMultiple >= targetRMultiple) return single();

  const partialQty = Math.floor((partialExitPct / 100) * qty);
  const runnerQty = qty - partialQty;
  if (partialQty < 1 || runnerQty < 1) return single();
  return [
    { quantity: partialQty, targetR: partialExitRMultiple, role: 'partial' },
    { quantity: runnerQty, targetR: targetRMultiple, role: 'runner' },
  ];
}

export interface ProtectiveBoundVerdict {
  ok: boolean;
  /** Shares the broker will accept protective orders for right now. */
  available: number;
  /** What the plan asks for. */
  requested: number;
  reason?: string;
}

/**
 * Will the broker accept this plan, by the rule the FCX probe established?
 *
 * `committedProtective` is committedProtectiveQuantity's answer — NULL when it
 * could not be determined (an open order with an unreadable quantity). Null is
 * treated as NOT OK: placing into an unknown commitment is how you discover the
 * bound by having a bracket refused with shares already exposed.
 */
export function lotsFitProtectiveBound(
  lots: BracketLot[],
  heldQuantity: number,
  committedProtective: number | null,
): ProtectiveBoundVerdict {
  const requested = lots.reduce((sum, l) => sum + l.quantity, 0);
  if (committedProtective === null) {
    return { ok: false, available: 0, requested, reason: 'committed protective quantity is unknown' };
  }
  const available = Math.max(0, heldQuantity - committedProtective);
  if (requested > available) {
    return {
      ok: false,
      available,
      requested,
      // Both numbers are SHARE COUNTS, not R and not dollars — the one place
      // this comparison is made, so it says so.
      reason: `${requested} shares of protection requested against ${available} available (${heldQuantity} held − ${committedProtective} already committed)`,
    };
  }
  return { ok: true, available, requested };
}

/** Webull's refusal when a protective order exceeds held-minus-committed. */
export const REVERSE_POSITION_CODE = 'OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION';

export type SecondBracketVerdict =
  /** Retry the second bracket — the failure carries no information about the
   *  broker's group rules. */
  | 'retry'
  /** Stop trying to place two groups. Roll back to ONE full-size bracket, which
   *  is today's behaviour, and remember the answer. */
  | 'fallback_single';

/**
 * What to do when the SECOND bracket is refused.
 *
 * The distinction the probe bought: a reverse-position refusal on the second
 * bracket, when lotsFitProtectiveBound already said the arithmetic fits, can
 * only mean the broker is counting the FIRST bracket against us — i.e. two
 * groups do not coexist on one symbol. That is a fact about the account, not a
 * transient, and retrying cannot change it. Anything else (a timeout, a rate
 * limit, an unrecognised message) might be transient and is worth one retry.
 *
 * `attempt` is 1-based. The second failure falls back whatever the reason:
 * a position with one lot protected and one naked is not a state to keep
 * probing from.
 */
export function classifySecondBracketRefusal(error: string | null | undefined, attempt: number): SecondBracketVerdict {
  if (attempt >= 2) return 'fallback_single';
  if (error && error.includes(REVERSE_POSITION_CODE)) return 'fallback_single';
  return 'retry';
}

export interface RollbackPlan {
  /** Cancel these, then place one bracket for `fullQuantity`. */
  cancelClientOrderIds: string[];
  fullQuantity: number;
  /** Stated so the caller journals it rather than inferring: this reopens the
   *  very window per-lot brackets exist to remove. It is accepted ONLY on the
   *  branch where the broker has refused two groups, and leaves the position no
   *  worse protected than it is today. */
  reopensNakedWindow: boolean;
}

/**
 * Roll back to a single full-size bracket after the second lot was refused.
 *
 * Ordering is the caller's problem and it is not symmetric: the first bracket
 * must be cancelled BEFORE the full one is placed, because the broker counts it
 * against the new order — the exact bound that caused the refusal being rolled
 * back. That is what reopens the window, and why it is named in the result.
 */
export function planRollbackToSingle(restingClientOrderIds: string[], fullQuantity: number): RollbackPlan {
  return {
    cancelClientOrderIds: [...restingClientOrderIds],
    fullQuantity,
    reopensNakedWindow: restingClientOrderIds.length > 0,
  };
}

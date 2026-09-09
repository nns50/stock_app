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
// THE STANDALONE BOUND, learned from the 2026-09-08 FCX probe and encoded in
// providers/webull/orders.ts's committedProtectiveQuantity: a new STANDALONE
// protective order (exits only, no MASTER) is compared against shares HELD
// MINUS what is already committed to resting exits. Within one combo group the
// MAX leg counts (a 38 stop and a 38 target rest together over 38 held); ACROSS
// groups they SUM.
//
// THAT BOUND DOES NOT GOVERN THIS DESIGN — probe, 2026-09-09, SIRI, live.
// Answered with one share and six cents:
//
//   OTOCO #1  BUY 1 @ 28.95, stop 28.26 / target 29.99 -> FILLED @ 28.80, both
//             exit legs resting. State: 1 held, 1 committed, available = 0.
//   OTOCO #2  BUY 1 @ 24.50 (15% below market, unfillable), own stop/target,
//             SAME symbol -> ACCEPTED. Two combo groups rested simultaneously,
//             the second carrying TWO SELL exit legs against a single share
//             already fully committed to the first.
//
// So: (1) an OTOCO's CONTINGENT exit legs are NOT counted against holdings, and
// (2) two OTOCO combo groups DO coexist on one symbol — the question the FCX
// probe structurally could not answer, since its refusal was fully explained by
// quantity and the error text conflates the two.
//
// lotsFitProtectiveBound therefore encodes the STANDALONE rule and MUST NOT
// gate the OTOCO path. It is still correct for the re-arm endpoint, which
// really does place exits over shares already held.
//
// WHAT THE PROBE DID NOT SHOW, and it matters. OTOCO #2's entry never filled,
// so its exits were contingent-pending throughout — never ACTIVE protective
// orders over held shares. The design's steady state (both entries filled, both
// groups' exits live, summing to exactly the held quantity: 60 + 40 over 100)
// was not observed. The arithmetic fits by construction — each group's exits
// cover only its own lot — but "fits by construction" is the same class of
// claim that the FCX bound turned out to be, so the wiring must submit BOTH
// entries before either fills (the shape the probe did validate) rather than
// adding the second group against an already-filled first.
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
 * Will the broker accept a STANDALONE protective order, by the rule the FCX
 * probe established?
 *
 * NOT FOR THE OTOCO PATH. The 2026-09-09 SIRI probe showed contingent exits are
 * not counted against holdings, so gating a per-lot ENTRY plan on this would
 * refuse plans the broker demonstrably accepts. This governs the re-arm
 * endpoint and anything else placing exits over shares already held.
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
 * BEHAVIOUR UNCHANGED, PREMISE REPLACED (2026-09-09). This used to reason: a
 * reverse-position refusal on the second bracket can only mean two groups do
 * not coexist. The SIRI probe showed they DO coexist, so that reading is dead —
 * and the rule survives it. A reverse-position refusal now means the broker is
 * counting shares differently than the plan assumed (a partial fill, an entry
 * not yet booked, a lot size that does not sum to what is held). Every one of
 * those is a fact about the current state, not a transient, and placing the
 * same order again cannot fix any of them. Anything else (a timeout, a rate
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

// ---------------------------------------------------------------------------
// SPLITTING THE ENTRY (2026-09-09 wiring).
//
// The risk check sizes ONE quantity. Per-lot brackets spend it across two
// bracketed entries, because an OTOCO's exits are children of its own entry and
// cannot be split from it — so "two brackets" necessarily means "two entries".
//
// WHICH LOT GOES FIRST, and why it matters more than it looks. Lot 2 is placed
// on a later tick, so between the two the position is UNDER-SIZED, and if lot 2
// never fills it stays that way permanently. The first lot is therefore the
// LARGER one: the failure mode becomes "most of the intended size, capped at
// the near target" rather than "a third of the intended size". Both failures
// are fully protected — each OTOCO is atomic — so this is a choice about
// P&L, not about safety.
//
// On a tie (a 50% split) the RUNNER goes first, because an uncapped small trade
// beats a capped one of the same size.
// ---------------------------------------------------------------------------

export interface EntrySplit {
  /** Placed WITH the entry, at its own target. The larger lot. */
  first: BracketLot;
  /** Placed on a later tick as a bracketed ADD-ON that merges into the same
   *  position (autotrade_live_orders.addon_of_position_id). */
  second: BracketLot;
}

/**
 * Split a sized entry into the two lots that will carry it, or null when the
 * plan does not split — in which case the caller places one ordinary bracketed
 * entry, which is today's behaviour.
 */
export function splitEntryForPerLot(input: LotPlanInput): EntrySplit | null {
  const lots = planLotBrackets(input);
  if (lots.length !== 2) return null;
  const [partial, runner] = lots as [BracketLot, BracketLot];
  // Larger first; the runner wins a tie.
  const first = runner.quantity >= partial.quantity ? runner : partial;
  const second = first === runner ? partial : runner;
  return { first, second };
}

/**
 * The price this lot takes profit at, `targetR` R from entry.
 *
 * Derived from the SIGNAL's own entry and stop, which is where every other R in
 * this path comes from — `signal.target` is exactly this function at
 * `cfg.targetRMultiple`, so the near target and the full one cannot drift onto
 * two different definitions of R.
 */
export function lotTargetPrice(entry: number, stop: number, side: 'buy' | 'sell', targetR: number): number | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Number.isFinite(entry) || !Number.isFinite(targetR)) return null;
  const raw = side === 'buy' ? entry + targetR * risk : entry - targetR * risk;
  // The broker rejects any bracket leg that is not an exact cent (see
  // providers/webull/orders.ts's tick note), so round HERE rather than leaving
  // each call site to remember.
  const cents = Math.round(raw * 100) / 100;
  return cents > 0 ? cents : null;
}

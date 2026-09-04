// ---------------------------------------------------------------------------
// Per-lot bracket tracking (2026-09-04) — which resting legs belong to WHICH lot
//
// `restingExitOrders` matches on symbol and exit side alone. That is fine while
// a position rests exactly one bracket, and wrong the moment it rests two:
// nothing downstream can say which legs protect which shares. Three mechanisms
// currently paper over that by assuming a single bracket —
//
//   - the scale-out REFUSES outright when it sees more than two legs, because
//     applying one whole-position keepQty to two brackets would leave each
//     protecting keepQty and a stop fill would sell 2x the holding (an
//     accidental short, the exact thing the reduce-first ordering exists to
//     prevent);
//   - the close path cancels EVERY resting exit leg on the symbol;
//   - bracket protection reads "any leg resting" as "protected", which is true
//     for the symbol and says nothing about whether a given lot is covered.
//
// Two brackets on one symbol are not hypothetical. On 2026-07-09 a cross-tick
// double-open placed a second real entry and the account carried two OCO
// bracket pairs; `placeLiveScaleInAddOn` gives added shares their own bracket
// by design; and the two-lot entry now under consideration for the scale-out
// would create them deliberately.
//
// WHAT THIS MODULE DOES, and what it deliberately does NOT do yet.
//
// It groups resting legs by the broker's `combo_order_id` — the group id off
// the ENVELOPE, which two legs of one bracket share and two legs of different
// brackets do not. That much is a pure function of data already parsed.
//
// Attribution to a POSITION rests on an unverified assumption, and this module
// keeps it explicit rather than burying it: a bracket is several envelopes
// sharing one combo_order_id, and webullPlaceOrder returns that same envelope
// combo_order_id as the placed order's brokerOrderId — so the entry order's
// stored brokerOrderId SHOULD equal its exit legs' comboOrderId. "Should" is
// doing real work in that sentence. Four payload shapes were refused this week
// on reasoning that was equally sound on paper, so attributeByEntryOrder
// returns a match ONLY on a positive equality and never guesses, and nothing in
// the live path is switched over to it until the observer has shown the ids
// actually line up on a real account.
//
// FAIL-CLOSED, everywhere. A leg whose group id cannot be read is
// `unattributable`, never quietly folded into the nearest group: mis-attributing
// a stop leg is how a bracket gets resized or cancelled against the wrong lot.
// ---------------------------------------------------------------------------

import { WebullOpenOrder } from '../../providers/webull/orders';

export interface BracketGroup {
  /** The broker's combo group id shared by this group's legs. */
  comboOrderId: string;
  legs: WebullOpenOrder[];
}

export interface GroupedExitLegs {
  /** One entry per distinct readable combo group, in first-seen order. */
  groups: BracketGroup[];
  /** Legs with no readable group id. NEVER folded into a group. */
  unattributable: WebullOpenOrder[];
}

/**
 * Split resting exit legs into their combo groups.
 *
 * Input is expected to be already filtered to one symbol and the exit side —
 * this adds the grouping that filter cannot express, it does not repeat it.
 */
export function groupExitLegsByCombo(legs: WebullOpenOrder[]): GroupedExitLegs {
  const groups: BracketGroup[] = [];
  const byId = new Map<string, BracketGroup>();
  const unattributable: WebullOpenOrder[] = [];
  for (const leg of legs) {
    const id = leg.comboOrderId;
    if (!id) {
      unattributable.push(leg);
      continue;
    }
    let g = byId.get(id);
    if (!g) {
      g = { comboOrderId: id, legs: [] };
      byId.set(id, g);
      groups.push(g);
    }
    g.legs.push(leg);
  }
  return { groups, unattributable };
}

/**
 * The group belonging to the entry order with `entryBrokerOrderId`, or null.
 *
 * Null on ANY ambiguity — no id to match on, no group carrying it, or (which
 * would mean the id is not the group key we believe it is) more than one group
 * carrying it. A null here means "cannot attribute", which every caller must
 * treat as a reason to do nothing, never as "no bracket exists".
 */
export function attributeByEntryOrder(
  grouped: GroupedExitLegs,
  entryBrokerOrderId: string | null | undefined,
): BracketGroup | null {
  if (!entryBrokerOrderId) return null;
  const hits = grouped.groups.filter((g) => g.comboOrderId === entryBrokerOrderId);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Is this book simple enough for the single-bracket assumptions still in the
 * live path?
 *
 * Exactly one group, no unreadable legs. Anything else — two lots, a leftover
 * resting order, a parse miss — is where those assumptions stop holding, and
 * the caller should refuse rather than proceed on the old shape.
 */
export function isSingleBracket(grouped: GroupedExitLegs): boolean {
  return grouped.groups.length === 1 && grouped.unattributable.length === 0;
}

/** Compact shape for the journal — ids and leg counts, no nested leg dumps. */
export function summarizeGroups(grouped: GroupedExitLegs): {
  groupCount: number;
  unattributableCount: number;
  groups: { comboOrderId: string; legs: number }[];
} {
  return {
    groupCount: grouped.groups.length,
    unattributableCount: grouped.unattributable.length,
    groups: grouped.groups.map((g) => ({ comboOrderId: g.comboOrderId, legs: g.legs.length })),
  };
}

import { WebullOpenOrder, exitLegKind } from '../../providers/webull/orders';

// ---------------------------------------------------------------------------
// Cancel-and-replace scale-out — the LAST-RESORT route (2026-09-04)
//
// Across four payload shapes and 100+ refusals the broker will not modify the
// QUANTITY of a resting combo leg. Confirmed on 2026-09-04: IOT's attempt
// carried per-leg combo_type AND a real client_combo_order_id and drew the
// byte-identical rejection. In-place resize is closed.
//
// This module supports the only other way to reduce a bracket: cancel the
// resting legs, sell the partial, place a fresh bracket for the remainder.
//
// IT INVERTS THE FAILURE MODE, WHICH IS WHY IT IS BEHIND ITS OWN FLAG.
//
//   today            a scale-out that cannot reduce the bracket ABANDONS
//                    itself; worst case is a missed partial (+0.183R on IOT).
//   cancel-replace   between the cancel and the new bracket the position is
//                    NAKED. checkLiveBracketProtection only REPORTS that.
//
// So the ordering rule is stricter than the in-place path's, not looser:
//
//   1. cancel BOTH legs
//   2. RE-READ the broker and confirm both are actually gone — a cancel is an
//      accepted REQUEST, not a completed action, and selling against a leg
//      that is still resting is the accidental-short bug the whole scale-out
//      design exists to avoid
//   3. re-bracket the REMAINDER (keepQty), before anything sells
//   4. only then sell the partial
//
// REORDERED 2026-09-05, and the old shape is worth recording because it was
// live-but-unreachable behind the flag for a day. It read: sell the partial,
// then re-bracket, and force-close the remainder if that re-bracket failed.
// Only steps 1 and 2 were ever implemented — the function journalled
// "unprotected … re-arm by hand" and RETURNED OK, and the caller then sold.
// Turning the flag on would therefore have cancelled the bracket, sold the
// partial, and left the remainder with no stop and no target indefinitely.
//
// Bracketing before selling removes the bad state rather than recovering from
// it. If the re-bracket fails, nothing has been sold, so the rollback is to
// place a bracket for the FULL position and abandon the scale-out — back to a
// protected position and a missed partial, exactly where we started.
// Sell-first has no such rollback: the shares are gone and the only move left
// is a forced close, which is a worse outcome chosen under time pressure.
//
// Step 2 is the one that cannot be skipped for latency. If the confirmation
// read fails or is ambiguous, the correct move is to RE-PLACE the bracket we
// just cancelled and abandon the scale-out.
//
// One asymmetry that matters in step 3's failure handling: a KNOWN rejection
// means no bracket exists, so restoring a full-size one is safe. An UNANSWERED
// placement may well be resting, and stacking a second bracket on top of it
// would leave two stops against one position — the accidental short again. So
// an unanswered re-bracket is journalled and left to the next tick's
// checkLiveBracketProtection read, never "fixed" by placing more orders.
//
// The PREFERRED route is not this one. Two brackets placed at entry (67% at a
// 0.25R target, 33% at the full target) needs no modification and never leaves
// the position naked; it waits only on whether the broker accepts two
// simultaneous OTOCO groups on one symbol. This exists for the case where that
// answer is no.
// ---------------------------------------------------------------------------

export type CancelVerdict =
  | { ok: true }
  | { ok: false; reason: string; /** True when the bracket must be restored before abandoning. */ restore: boolean };

/**
 * Are the legs we cancelled actually gone from the broker's open orders?
 *
 * `orders` must be a FRESH read taken after the cancels. Anything other than a
 * clean "none of them are resting any more" is a refusal:
 *
 *   - a leg still resting  -> the cancel has not taken effect yet. Selling now
 *                             is the accidental short. Restore and abandon.
 *   - the read failed      -> unknown, treated exactly like still-resting.
 *                             Never "probably fine".
 *
 * A leg that has FILLED rather than cancelled is also a refusal, and a louder
 * one: the position size just changed underneath us, so the partial quantity
 * we computed is stale.
 */
export function verifyLegsGone(
  freshOrders: WebullOpenOrder[] | null,
  cancelledClientOrderIds: string[],
): CancelVerdict {
  if (freshOrders === null) {
    return { ok: false, reason: 'could not re-read open orders after the cancel', restore: true };
  }
  const stillThere = freshOrders.filter(
    (o) => o.clientOrderId !== undefined && cancelledClientOrderIds.includes(o.clientOrderId),
  );
  if (stillThere.length > 0) {
    const ids = stillThere.map((o) => o.clientOrderId).join(', ');
    return { ok: false, reason: `leg(s) still resting after cancel: ${ids}`, restore: true };
  }
  return { ok: true };
}

/**
 * The quantity to sell, re-derived from what the broker says we hold NOW.
 *
 * Deliberately not the number computed before the cancel: the cancel window is
 * exactly when a racing fill would change the holding, and selling a stale
 * quantity is how a partial becomes an oversell. Returns null when the numbers
 * cannot support a safe partial, which the caller must treat as "abandon".
 */
export function safePartialQuantity(brokerQuantity: number, intendedKeepQty: number): number | null {
  if (!Number.isFinite(brokerQuantity) || !Number.isFinite(intendedKeepQty)) return null;
  if (brokerQuantity <= 0 || intendedKeepQty < 0) return null;
  // The holding shrank to at or below what we meant to keep — there is nothing
  // left to scale out of, and selling anyway would go short.
  if (brokerQuantity <= intendedKeepQty) return null;
  const sell = Math.floor(brokerQuantity - intendedKeepQty);
  return sell > 0 ? sell : null;
}

/**
 * The order to cancel a bracket's resting legs in: TAKE-PROFIT first, STOP last.
 *
 * cancelReplaceBracket cancels one leg at a time and returns on the first
 * failure, so a bracket can be left HALF cancelled. Which half decides whether
 * that is a nuisance or a naked position:
 *
 *   stop cancelled first, target cancel fails  -> the position runs with a
 *                                                 take-profit and NO STOP. Real
 *                                                 money, unbounded downside,
 *                                                 and nothing sells to reveal
 *                                                 it — checkLiveBracketProtection
 *                                                 only reports it (once per ET
 *                                                 day) and tells a human to
 *                                                 re-arm by hand.
 *   target cancelled first, stop cancel fails  -> the position keeps its STOP
 *                                                 and loses only its target.
 *                                                 Protected; the worst case is
 *                                                 an exit that has to come from
 *                                                 the stop or a time exit.
 *
 * Both outcomes abandon the scale-out. The difference is entirely in what the
 * position is left holding, and until now it was decided by whatever order the
 * broker happened to list the legs in.
 *
 * Legs whose role cannot be read sort BETWEEN the two — never last, because
 * "unclassifiable" must not be allowed to displace the stop from the safest
 * slot. The sort is stable, so legs of equal rank keep the broker's own order.
 *
 * This does not make the cancel succeed. It makes its FAILURE survivable.
 */
export function cancelOrderForLegs(legs: WebullOpenOrder[]): WebullOpenOrder[] {
  const rank = (l: WebullOpenOrder): number => {
    const kind = exitLegKind(l);
    if (kind === 'tp') return 0;
    if (kind === 'sl') return 2;
    return 1;
  };
  return [...legs].sort((a, b) => rank(a) - rank(b));
}

/**
 * Did the legs we managed to cancel include the STOP?
 *
 * The question the mid-cancel journal has to answer, because it decides whether
 * a human needs to act right now or merely knows a target is gone. Takes the
 * legs in the order they were ATTEMPTED and how many of them succeeded.
 */
export function stopWasCancelled(attempted: WebullOpenOrder[], cancelledCount: number): boolean {
  return attempted.slice(0, cancelledCount).some((l) => exitLegKind(l) === 'sl');
}

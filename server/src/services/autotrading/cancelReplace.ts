import { WebullOpenOrder } from '../../providers/webull/orders';

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
//   3. only then sell the partial
//   4. immediately re-bracket the remainder
//   5. if 4 fails, the remainder is NAKED — force-close it rather than leave
//      unhedged exposure nobody chose
//
// Step 2 is the one that cannot be skipped for latency. If the confirmation
// read fails or is ambiguous, the correct move is to RE-PLACE the bracket we
// just cancelled and abandon the scale-out — back to a fully protected
// position and a missed partial, which is exactly where we started.
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

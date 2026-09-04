import { ReplaceOrderPatch } from '../../providers/webull/orders';

// ---------------------------------------------------------------------------
// Bracket-resize retry latch (2026-09-04)
//
// checkLiveEquityScaleOuts runs every loop tick, so a position that has
// triggered its scale-out re-attempts the bracket resize roughly every two
// minutes for the rest of its life. When the broker ACCEPTS the resize that is
// exactly right: one attempt, done. When it REFUSES, it refuses deterministic-
// ally — the same legs and the same keepQty produce the same request and the
// same rejection — so every retry after the first buys nothing and costs a
// broker round-trip plus a journal row.
//
// The measured cost: SMCI produced 6 identical refusals in 12 minutes on
// 2026-09-04 and DELL produced 31 across 2026-09-03, all carrying byte-for-byte
// the same `sent` array and the same message. Reading those journals, the
// repeats actively mislead — a count of 101 refusals sounds like 101 pieces of
// evidence when it is really three distinct requests retried in a loop.
//
// WHAT THE LATCH KEYS ON, and why it is not simply "stop trying".
//
// The signature is the REQUEST we would send: the patches (leg ids, quantities,
// and each leg's defining price and combo type) plus the combo group id. So:
//
//   - an identical request is skipped, without calling the broker at all;
//   - a request that DIFFERS in any way is always attempted.
//
// That second half is the point. A blanket per-position latch would suppress
// the next payload experiment — precisely the thing these refusals exist to
// inform. When the stop ratchets, when keepQty changes, or when a deploy starts
// sending a field it did not send before (client_combo_order_id is the open
// question as of this writing), the signature changes and the attempt happens.
// The latch removes repetition, never a new piece of evidence.
//
// State is in-memory and per-process, so a deploy clears it: every position
// gets one fresh attempt against the newly deployed payload. That is the
// behaviour we want from a restart, not an accident of storage choice.
// ---------------------------------------------------------------------------

interface LatchEntry {
  signature: string;
  /** Refusals recorded for THIS signature, including suppressed retries. */
  refusals: number;
}

const latches = new Map<number, LatchEntry>();

/**
 * The request we are about to send, reduced to a comparable string.
 *
 * Built from the patches themselves rather than from a hand-picked subset of
 * fields: a patch that grows a field must change the signature, or the first
 * attempt carrying that new field would be skipped as a duplicate — the exact
 * failure this module exists to avoid.
 */
export function resizeAttemptSignature(patches: ReplaceOrderPatch[], comboId: string | undefined): string {
  return JSON.stringify({ comboId: comboId ?? null, patches });
}

/**
 * Whether this exact request has already been refused for this position.
 *
 * `priorRefusals` is the running count including the retries this latch has
 * suppressed, so a caller can report how many ticks have hit it even though
 * only the first was journaled.
 */
export function shouldSkipResize(positionId: number, signature: string): { skip: boolean; priorRefusals: number } {
  const cur = latches.get(positionId);
  if (!cur || cur.signature !== signature) return { skip: false, priorRefusals: 0 };
  cur.refusals += 1;
  return { skip: true, priorRefusals: cur.refusals };
}

/** Record a refusal. Returns the attempt number for this signature (1 = first). */
export function recordResizeRefusal(positionId: number, signature: string): number {
  const cur = latches.get(positionId);
  if (cur && cur.signature === signature) {
    cur.refusals += 1;
    return cur.refusals;
  }
  latches.set(positionId, { signature, refusals: 1 });
  return 1;
}

/**
 * Forget a position's latch — call after a resize SUCCEEDS, so a later
 * scale-out on the same position (a second partial, or a re-entry reusing the
 * id) is never skipped because an older request happened to match.
 */
export function clearResizeLatch(positionId: number): void {
  latches.delete(positionId);
}

/** Drop latches for positions that are no longer open, so the map cannot grow without bound. */
export function pruneResizeLatches(openPositionIds: Iterable<number>): void {
  const keep = new Set(openPositionIds);
  for (const id of [...latches.keys()]) if (!keep.has(id)) latches.delete(id);
}

/** Test seam: drop all state. */
export function resetResizeLatches(): void {
  latches.clear();
}

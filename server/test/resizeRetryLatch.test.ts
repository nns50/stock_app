import { beforeEach, describe, expect, it } from 'vitest';
import { ReplaceOrderPatch } from '../src/providers/webull/orders';
import {
  clearResizeLatch,
  pruneResizeLatches,
  recordResizeRefusal,
  resetResizeLatches,
  resizeAttemptSignature,
  shouldSkipResize,
} from '../src/services/autotrading/resizeRetryLatch';

const tp = (qty: number): ReplaceOrderPatch => ({
  clientOrderId: 'df80304c9c4a4638849db796da030cc9',
  quantity: qty,
  limitPrice: 41.56,
  comboType: 'STOP_PROFIT',
});
const sl = (qty: number, stop = 39.48): ReplaceOrderPatch => ({
  clientOrderId: 'c8e31a036d2448b68f49da647a2cd905',
  quantity: qty,
  stopPrice: stop,
  comboType: 'STOP_LOSS',
});
const patches = (qty = 15, stop = 39.48): ReplaceOrderPatch[] => [tp(qty), sl(qty, stop)];

/** The refusal loop this exists to stop: SMCI, 2026-09-04, same request every ~2 min. */
describe('resize retry latch', () => {
  beforeEach(() => resetResizeLatches());

  it('lets the first attempt through', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    expect(shouldSkipResize(589, sig)).toEqual({ skip: false, priorRefusals: 0 });
  });

  it('skips an identical repeat once the first has been refused', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    expect(recordResizeRefusal(589, sig)).toBe(1);
    expect(shouldSkipResize(589, sig).skip).toBe(true);
  });

  it('counts the suppressed retries so the caller can report them', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    recordResizeRefusal(589, sig);
    expect(shouldSkipResize(589, sig).priorRefusals).toBe(2);
    expect(shouldSkipResize(589, sig).priorRefusals).toBe(3);
    expect(shouldSkipResize(589, sig).priorRefusals).toBe(4);
  });

  // The whole reason this is a signature latch and not a per-position one.
  it('ALWAYS attempts a request that gained a combo group id', () => {
    const without = resizeAttemptSignature(patches(), undefined);
    recordResizeRefusal(589, without);
    expect(shouldSkipResize(589, without).skip).toBe(true);

    const withId = resizeAttemptSignature(patches(), 'a1b2c3d4e5f6');
    expect(shouldSkipResize(589, withId).skip).toBe(false);
  });

  // CORRECTED 2026-09-04. This case originally asserted the opposite — that a
  // ratcheted stop must re-attempt — and a full session showed that made the
  // latch useless: SMCI's stop moved 39.51 -> 39.53 -> 39.55 -> 39.75 -> 39.97
  // -> 40.10 -> 40.11 and produced 24 refusals, every one attempt=1. The price
  // is an echo the request restates for identification; it is not what the
  // broker is refusing.
  it('SUPPRESSES a repeat whose only difference is a ratcheted stop price', () => {
    const before = resizeAttemptSignature(patches(15, 38.59), undefined);
    recordResizeRefusal(589, before);
    const after = resizeAttemptSignature(patches(15, 39.48), undefined);
    expect(shouldSkipResize(589, after).skip).toBe(true);
  });

  it('SUPPRESSES a repeat whose only difference is a re-read take-profit price', () => {
    const a = resizeAttemptSignature([tp(15), sl(15)], undefined);
    recordResizeRefusal(589, a);
    const moved: ReplaceOrderPatch[] = [{ ...tp(15), limitPrice: 41.99 }, sl(15)];
    expect(shouldSkipResize(589, resizeAttemptSignature(moved, undefined)).skip).toBe(true);
  });

  // The real-world sequence that made this correction necessary, end to end.
  it('suppresses a whole ratcheting session but still attempts the new payload', () => {
    let sig = resizeAttemptSignature(patches(15, 39.51), undefined);
    recordResizeRefusal(589, sig);
    for (const stop of [39.53, 39.55, 39.75, 39.97, 40.1, 40.11]) {
      sig = resizeAttemptSignature(patches(15, stop), undefined);
      expect(shouldSkipResize(589, sig).skip).toBe(true);
    }
    // ...and the moment a real combo group id is carried, it goes through.
    expect(shouldSkipResize(589, resizeAttemptSignature(patches(15, 40.11), 'GRP-1')).skip).toBe(false);
  });

  it('ALWAYS attempts when keepQty changes', () => {
    const a = resizeAttemptSignature(patches(15), undefined);
    recordResizeRefusal(589, a);
    const b = resizeAttemptSignature(patches(14), undefined);
    expect(shouldSkipResize(589, b).skip).toBe(false);
  });

  // A patch that grows a field must change the signature, or the first request
  // carrying it would be skipped as a duplicate.
  it('ALWAYS attempts when a patch gains a new field', () => {
    const bare = resizeAttemptSignature([{ clientOrderId: 'x', quantity: 15 }], undefined);
    recordResizeRefusal(589, bare);
    const richer = resizeAttemptSignature([{ clientOrderId: 'x', quantity: 15, comboType: 'STOP_PROFIT' }], undefined);
    expect(shouldSkipResize(589, richer).skip).toBe(false);
  });

  // `keys` must be in the signature. comboType happens to be named individually,
  // so the test above passes with or without it — deleting `keys` left all 13
  // green. A future patch field the signature does NOT name would then be
  // invisible, and the first request carrying it would be skipped as a
  // duplicate: precisely the failure this module exists to prevent, and exactly
  // how #478's comboType would have been suppressed had it not been named.
  it('ALWAYS attempts when a patch gains a field the signature does not name', () => {
    const bare = resizeAttemptSignature([{ clientOrderId: 'x', quantity: 15, stopPrice: 39.5 }], undefined);
    recordResizeRefusal(589, bare);
    const richer = resizeAttemptSignature(
      [{ clientOrderId: 'x', quantity: 15, stopPrice: 39.5, timeInForce: 'GTC' } as unknown as ReplaceOrderPatch],
      undefined,
    );
    expect(shouldSkipResize(589, richer).skip).toBe(false);
  });

  it('restarts the count when the signature changes', () => {
    const a = resizeAttemptSignature(patches(15), undefined);
    recordResizeRefusal(589, a);
    recordResizeRefusal(589, a);
    const b = resizeAttemptSignature(patches(14), undefined);
    expect(recordResizeRefusal(589, b)).toBe(1);
  });

  it('latches per position, not globally', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    recordResizeRefusal(589, sig);
    expect(shouldSkipResize(589, sig).skip).toBe(true);
    expect(shouldSkipResize(590, sig).skip).toBe(false);
  });

  it('clears on success so a later partial on the same position is attempted', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    recordResizeRefusal(589, sig);
    expect(shouldSkipResize(589, sig).skip).toBe(true);
    clearResizeLatch(589);
    expect(shouldSkipResize(589, sig).skip).toBe(false);
  });

  it('prunes closed positions and keeps open ones', () => {
    const sig = resizeAttemptSignature(patches(), undefined);
    recordResizeRefusal(589, sig);
    recordResizeRefusal(590, sig);
    pruneResizeLatches([590]);
    expect(shouldSkipResize(589, sig).skip).toBe(false); // pruned -> fresh attempt
    expect(shouldSkipResize(590, sig).skip).toBe(true); // still open -> still latched
  });
});

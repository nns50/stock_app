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

  it('ALWAYS attempts after the stop ratchets the leg price', () => {
    const before = resizeAttemptSignature(patches(15, 38.59), undefined);
    recordResizeRefusal(589, before);
    const after = resizeAttemptSignature(patches(15, 39.48), undefined);
    expect(shouldSkipResize(589, after).skip).toBe(false);
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

import { describe, expect, it } from 'vitest';
import { WebullOpenOrder } from '../src/providers/webull/orders';
import {
  cancelOrderForLegs,
  safePartialQuantity,
  stopWasCancelled,
  verifyLegsGone,
} from '../src/services/autotrading/cancelReplace';

const leg = (clientOrderId: string, status = 'OPEN'): WebullOpenOrder => ({
  clientOrderId,
  symbol: 'IOT',
  side: 'sell',
  status,
});

describe('verifyLegsGone', () => {
  it('passes when neither cancelled leg is resting any more', () => {
    expect(verifyLegsGone([leg('other')], ['tp', 'sl'])).toEqual({ ok: true });
  });

  it('passes on an empty book', () => {
    expect(verifyLegsGone([], ['tp', 'sl'])).toEqual({ ok: true });
  });

  // The accidental short this whole design exists to prevent: a cancel is an
  // accepted REQUEST, so a leg can still be working when the POST returns.
  it('REFUSES while a cancelled leg is still resting, and asks to restore', () => {
    const v = verifyLegsGone([leg('sl')], ['tp', 'sl']);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.restore).toBe(true);
      expect(v.reason).toContain('still resting');
    }
  });

  // An unreadable book is UNKNOWN, and unknown is never "probably fine" here —
  // selling against a bracket that might still be live is the unsafe direction.
  it('REFUSES when the confirmation read failed', () => {
    const v = verifyLegsGone(null, ['tp', 'sl']);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.restore).toBe(true);
      expect(v.reason).toContain('could not re-read');
    }
  });

  it('ignores a leg with no readable client order id rather than matching it', () => {
    const anon: WebullOpenOrder = { symbol: 'IOT', side: 'sell', status: 'OPEN' };
    expect(verifyLegsGone([anon], ['tp', 'sl'])).toEqual({ ok: true });
  });
});

describe('safePartialQuantity', () => {
  it('sells the difference between what is held and what we keep', () => {
    expect(safePartialQuantity(43, 15)).toBe(28);
  });

  // The cancel window is exactly when a racing fill changes the holding.
  it('refuses when the holding shrank to the keep quantity', () => {
    expect(safePartialQuantity(15, 15)).toBeNull();
  });

  it('refuses when the holding shrank BELOW the keep quantity', () => {
    expect(safePartialQuantity(10, 15)).toBeNull();
  });

  it('refuses a holding that is gone', () => {
    expect(safePartialQuantity(0, 15)).toBeNull();
  });

  it('refuses nonsense rather than trading on it', () => {
    expect(safePartialQuantity(NaN, 15)).toBeNull();
    expect(safePartialQuantity(43, NaN)).toBeNull();
    expect(safePartialQuantity(-5, 15)).toBeNull();
    expect(safePartialQuantity(43, -1)).toBeNull();
  });

  it('floors a fractional holding rather than selling a fraction', () => {
    expect(safePartialQuantity(43.9, 15)).toBe(28);
  });

  it('refuses when flooring would leave nothing to sell', () => {
    expect(safePartialQuantity(15.4, 15)).toBeNull();
  });
});

describe('cancelOrderForLegs', () => {
  const tp = (id: string): WebullOpenOrder => ({ ...leg(id), comboType: 'STOP_PROFIT', orderType: 'LIMIT' });
  const sl = (id: string): WebullOpenOrder => ({ ...leg(id), comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' });
  const ids = (legs: WebullOpenOrder[]) => cancelOrderForLegs(legs).map((l) => l.clientOrderId);

  it('cancels the take-profit before the stop', () => {
    expect(ids([sl('S'), tp('T')])).toEqual(['T', 'S']);
  });

  it('keeps that order when the broker already listed them that way', () => {
    expect(ids([tp('T'), sl('S')])).toEqual(['T', 'S']);
  });

  it('never lets an unreadable leg push the stop off last place', () => {
    // "I cannot tell what this is" must not outrank "this is the protection".
    expect(ids([sl('S'), leg('?'), tp('T')])).toEqual(['T', '?', 'S']);
  });

  it('is stable for legs of the same rank', () => {
    expect(ids([leg('a'), leg('b'), leg('c')])).toEqual(['a', 'b', 'c']);
  });

  it("does not mutate the caller's array", () => {
    const legs = [sl('S'), tp('T')];
    cancelOrderForLegs(legs);
    expect(legs.map((l) => l.clientOrderId)).toEqual(['S', 'T']);
  });

  it('passes a single leg through', () => {
    expect(ids([sl('S')])).toEqual(['S']);
  });
});

describe('stopWasCancelled', () => {
  const tp = (id: string): WebullOpenOrder => ({ ...leg(id), comboType: 'STOP_PROFIT', orderType: 'LIMIT' });
  const sl = (id: string): WebullOpenOrder => ({ ...leg(id), comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' });

  it('is false when only the target went', () => {
    expect(stopWasCancelled([tp('T'), sl('S')], 1)).toBe(false);
  });

  it('is true once the stop has gone', () => {
    expect(stopWasCancelled([tp('T'), sl('S')], 2)).toBe(true);
  });

  it('is false before anything was cancelled', () => {
    expect(stopWasCancelled([sl('S'), tp('T')], 0)).toBe(false);
  });

  it('reads the ATTEMPTED order, so a stop-first sequence reports honestly', () => {
    // The defence the liveExecute branch relies on: if the ordering rule were
    // ever removed, this must say the protection is gone rather than stay quiet.
    expect(stopWasCancelled([sl('S'), tp('T')], 1)).toBe(true);
  });
});

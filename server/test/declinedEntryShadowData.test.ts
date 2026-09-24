import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { recordLiveAddOnOrder, recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { createIntent } from '../src/db/orders';
import { createPosition } from '../src/db/positions';
import { liveEntryConcessionPct, shadowFillInputs } from '../src/services/autotrading/declinedEntryShadowData';
import { MARKETABLE_LIMIT_BUFFER_PCT } from '../src/services/autotrading/marketableLimit';

// ---------------------------------------------------------------------------
// The replay's entry concession, over real rows (2026-09-24, on review). It is
// read against the STOCK marketable-limit buffer (0.5%), and an option's entry
// limit is a different buffer: an option filled at its ask reads about -4.8%
// against a limit at the ask x 1.05. An option reaches these rows as a hand
// order placed through the Trade page, which the reconcile links by
// source_intent_id (the adopted link is stock-only, and the live options
// sleeve keeps its own table). None had on 2026-09-24 (0 of 142 entry rows),
// so this guards the path rather than moving today's number.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders; DELETE FROM order_intents; DELETE FROM autotrade_events;',
  );
});

/** A live entry: the order's limit, and the fill the position booked. A stock
 *  entry is the loop's (adopted, linked from its entry order); an option is a
 *  hand order from the Trade page (linked by source_intent_id). */
function entry(asset: 'stock' | 'option', symbol: string, limit: number, fill: number): void {
  const intent = createIntent(
    { symbol, assetKind: asset, side: 'buy', openClose: 'open', quantity: 1, orderType: 'limit', limitPrice: limit },
    `${symbol}-${asset}`,
  );
  const p = createPosition({
    assetType: asset,
    symbol,
    side: 'long',
    quantity: 1,
    entryPrice: fill,
    entryDate: '2026-09-22',
    entryTime: '10:00',
    ...(asset === 'option'
      ? {
          optionType: 'call',
          strike: 100,
          expiration: '2026-09-25',
          multiplier: 100,
          tags: ['live'],
          sourceIntentId: intent.id,
        }
      : { tags: ['live', 'autotrade'] }),
  });
  if (asset === 'stock') {
    recordLiveOrder({
      intentId: intent.id,
      symbol,
      stopPrice: fill * 0.95,
      targetPrice: fill * 1.1,
      riskAmount: 5,
      riskProfile: 'MODERATE',
    });
    setLiveOrderPositionId(intent.id, p.id);
  }
}

describe('liveEntryConcessionPct', () => {
  it('reads stock entries only: an option filled at its ask is not a stock concession', () => {
    // A stock buy limited at 100.5 (0.5% over 100) filled at 100.2: it paid
    // 0.2% of its 0.5% buffer.
    entry('stock', 'AAPL', 100.5, 100.2);
    expect(liveEntryConcessionPct()).toBeCloseTo(0.2, 2);
    // A hand-placed call limited at 1.05 filled at 1.00: -4.76% against its
    // own limit. Pooled, the mean goes below zero and the concession clamps to
    // nothing.
    entry('option', 'AAPL', 1.05, 1.0);
    expect(liveEntryConcessionPct()).toBeCloseTo(0.2, 2);
  });

  it('charges the whole buffer when no stock entry has been measured', () => {
    entry('option', 'AAPL', 1.05, 1.0);
    expect(liveEntryConcessionPct()).toBe(MARKETABLE_LIMIT_BUFFER_PCT);
  });

  it("reads the loop's own first entries only: not a scaled-in position, not a hand order (2026-09-25, on the second review)", () => {
    // Nine entries that paid 0.1% of the buffer: limit 100.5, filled 100.1.
    for (let i = 0; i < 9; i += 1) entry('stock', `S${i}`, 100.5, 100.1);
    expect(liveEntryConcessionPct()).toBeCloseTo(0.1, 2);

    // A scaled-in position: the loop's entry at 100.5, an add-on limited at
    // 102.51, and the blended entry price the ledger now holds, 100.67. The
    // entry-order lookup returns the add-on's row, so the pair read -1.8%.
    const first = createIntent(
      {
        symbol: 'KLAC',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 100.5,
      },
      'KLAC-first',
    );
    const p = createPosition({
      assetType: 'stock',
      symbol: 'KLAC',
      side: 'long',
      quantity: 2,
      entryPrice: 100.67,
      entryDate: '2026-09-22',
      entryTime: '10:00',
      tags: ['live', 'autotrade'],
    });
    recordLiveOrder({
      intentId: first.id,
      symbol: 'KLAC',
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 5,
      riskProfile: 'MODERATE',
    });
    setLiveOrderPositionId(first.id, p.id);
    const add = createIntent(
      {
        symbol: 'KLAC',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 102.51,
      },
      'KLAC-add',
    );
    recordLiveAddOnOrder({
      intentId: add.id,
      symbol: 'KLAC',
      stopPrice: 97,
      targetPrice: 110,
      riskAmount: 5,
      riskProfile: 'MODERATE',
      addonOfPositionId: p.id,
    });
    setLiveOrderPositionId(add.id, p.id);
    db.prepare('UPDATE autotrade_live_orders SET created_at = created_at + 1000 WHERE intent_id = ?').run(add.id);

    // A hand order from the Trade page: a limit the user typed, linked by
    // source_intent_id, never an autotrade order.
    const hand = createIntent(
      {
        symbol: 'SIRI',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 30,
      },
      'SIRI-hand',
    );
    createPosition({
      assetType: 'stock',
      symbol: 'SIRI',
      side: 'long',
      quantity: 1,
      entryPrice: 28.5,
      entryDate: '2026-09-22',
      entryTime: '10:00',
      tags: ['live'],
      sourceIntentId: hand.id,
    });

    expect(liveEntryConcessionPct()).toBeCloseTo(0.1, 2);
  });
});

describe('shadowFillInputs', () => {
  it("reads the market's direction from the ET midnight of the window's first day (2026-09-25, on the second review)", () => {
    // The window starts at 12:00 ET; the day's red was journaled at 09:35. A
    // replay of a refusal at 12:30 must see it.
    const readAt = Date.parse('2026-09-24T13:35:00Z'); // 09:35 ET
    const since = Date.parse('2026-09-24T16:00:00Z'); // 12:00 ET
    logAutotradeEvent({ symbol: null, stage: 'screen', action: 'market_direction_read', detail: { direction: 'red' } });
    db.prepare("UPDATE autotrade_events SET created_at = ? WHERE action = 'market_direction_read'").run(readAt);
    expect(shadowFillInputs(since).directionAt?.(since + 30 * 60_000)).toBe('red');
  });
});

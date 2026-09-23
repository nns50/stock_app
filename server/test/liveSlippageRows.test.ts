import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition } from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import { recordLiveOrder, setLiveOrderPositionId } from '../src/db/autotradeLiveOrders';
import { buildLiveSlippageRows } from '../src/services/autotrading/autoTune';

// The leak scan's entry slippage (meanEntrySlippagePct, and the
// execution:entry_slippage finding) is built from these rows. Until 2026-09-23
// they read positions.source_intent_id only, which an ADOPTED position never
// carries, and nearly every live position has been adopted since 2026-09-01. So
// the scan measured the materialized minority alone.

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_orders; DELETE FROM order_intents;',
  );
});

function entryOrder(key: string, limitPrice: number) {
  const intent = createIntent(
    {
      symbol: 'COIN',
      assetKind: 'stock',
      side: 'buy',
      openClose: 'open',
      quantity: 161,
      orderType: 'limit',
      limitPrice,
      bracket: { takeProfitPrice: 209.74, stopLossPrice: 199.5 },
    },
    key,
  );
  recordLiveOrder({
    intentId: intent.id,
    symbol: 'COIN',
    stopPrice: 199.5,
    targetPrice: 209.74,
    riskAmount: 790,
    riskProfile: 'MODERATE',
    accountId: 'ACC1',
  });
  return intent;
}

function coin(opts: { sourceIntentId?: number | null; tags?: string[] } = {}) {
  return createPosition({
    assetType: 'stock',
    symbol: 'COIN',
    side: 'long',
    quantity: 161,
    entryPrice: 204.39,
    entryDate: '2026-09-21',
    tags: opts.tags ?? ['webull', 'live', 'autotrade'],
    accountId: 'ACC1',
    sourceIntentId: opts.sourceIntentId ?? null,
  });
}

describe('buildLiveSlippageRows reads the entry order by either link', () => {
  it('measures an ADOPTED position, linked only from its entry order', () => {
    const intent = entryOrder('cid-adopted', 205.43);
    const pos = coin();
    setLiveOrderPositionId(intent.id, pos.id);

    const entry = buildLiveSlippageRows().filter((r) => r.kind === 'entry');
    expect(entry).toHaveLength(1);
    // Filled at 204.39 against a 205.43 limit: 1.04 inside it, the negative
    // number a marketable limit produces by construction.
    expect(entry[0]).toMatchObject({ positionId: pos.id, limitPrice: 205.43, fillPrice: 204.39, perUnit: -1.04 });
  });

  it('still measures a position materialized with its own source_intent_id', () => {
    const intent = entryOrder('cid-materialized', 205.43);
    const pos = coin({ sourceIntentId: intent.id });
    expect(buildLiveSlippageRows().filter((r) => r.kind === 'entry' && r.positionId === pos.id)).toHaveLength(1);
  });

  it('has nothing to measure for a position the operator opened (no entry order at all)', () => {
    coin({ tags: ['webull'] });
    expect(buildLiveSlippageRows()).toHaveLength(0);
  });
});

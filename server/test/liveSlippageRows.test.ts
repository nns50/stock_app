import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { addExit, createPosition } from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import {
  entryIntentIdForPosition,
  getLiveEntryOrderForPosition,
  recordLiveOrder,
  setLiveOrderPositionId,
} from '../src/db/autotradeLiveOrders';
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

// 2026-09-23: the MRNA stock entry order was linked to the MRNA CALL's row
// (fixed at the write by #658; the hand correction of the ledger left the link),
// and the leak scan measured the call's $2.84 fill against the shares' $187
// limit: -98.5%, enough on its own to read 40 sessions of entries as filling
// 0.85% better than the quote and to hold the slippage alarm off for all of them.
describe('a fill is only measured against an order it could have come from', () => {
  function mrnaCall(opts: { sourceIntentId?: number | null } = {}) {
    return createPosition({
      assetType: 'option',
      symbol: 'MRNA',
      side: 'long',
      quantity: 3,
      entryPrice: 2.84,
      entryDate: '2026-09-23',
      tags: ['webull'],
      accountId: 'ACC1',
      optionType: 'call',
      strike: 190,
      expiration: '2026-09-26',
      sourceIntentId: opts.sourceIntentId ?? null,
    });
  }

  it('does not read a stock entry order through a link to an OPTION row, in any reader', () => {
    const intent = entryOrder('cid-cross', 187.15);
    const call = mrnaCall();
    setLiveOrderPositionId(intent.id, call.id);

    // The link-level guard: the stock sleeve's order table cannot answer for an
    // option position, so every reader (bracket ownership, the Auto-page close,
    // the exit correction) is covered, not only this one.
    expect(getLiveEntryOrderForPosition(call.id)).toBeUndefined();
    expect(entryIntentIdForPosition(call)).toBeNull();
    expect(buildLiveSlippageRows()).toHaveLength(0);
  });

  it('still reads the same link for a STOCK row', () => {
    const intent = entryOrder('cid-stock', 205.43);
    const pos = coin();
    setLiveOrderPositionId(intent.id, pos.id);
    expect(getLiveEntryOrderForPosition(pos.id)?.intentId).toBe(intent.id);
  });

  it('does not measure an option fill against a stock order carried on its own source_intent_id either', () => {
    const intent = entryOrder('cid-source', 187.15);
    mrnaCall({ sourceIntentId: intent.id });
    expect(buildLiveSlippageRows()).toHaveLength(0);
  });

  it('leaves a bracket-leg exit out, and keeps an exit the app priced itself', () => {
    const entry = entryOrder('cid-legs', 205.43);
    const pos = coin({ sourceIntentId: entry.id });
    // The stop leg filled: booked against the BRACKET's own order, which is the
    // entry. Measured against the entry's 205.43 limit, a stop at 199.50 would
    // read as 5.93 of "slippage" in the trader's favour, and a target at 209.74
    // as 4.31 of cost — the trade's own move, not its execution.
    addExit(pos.id, {
      quantity: 80,
      exitPrice: 199.5,
      exitDate: '2026-09-21',
      sourceIntentId: entry.id,
      exitReason: 'stop',
    });
    // A time exit: its own closing order, a marketable limit the app priced.
    const close = createIntent(
      {
        symbol: 'COIN',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 81,
        orderType: 'limit',
        limitPrice: 201,
      },
      'cid-time-exit',
    );
    addExit(pos.id, {
      quantity: 81,
      exitPrice: 201.1,
      exitDate: '2026-09-21',
      sourceIntentId: close.id,
      exitReason: 'time_exit',
    });

    const exits = buildLiveSlippageRows().filter((r) => r.kind === 'exit');
    expect(exits).toHaveLength(1);
    // Sold 0.10 ABOVE a 201 sell limit: 0.10 in the trader's favour.
    expect(exits[0]).toMatchObject({ positionId: pos.id, limitPrice: 201, fillPrice: 201.1, perUnit: -0.1 });
  });
});

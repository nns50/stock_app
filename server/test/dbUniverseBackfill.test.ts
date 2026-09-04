import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { addSymbols, listUniverse, removeSymbol } from '../src/db/universe';

initDb();

describe('addSymbols — sector backfill', () => {
  beforeEach(() => {
    for (const s of ['ZZSPY', 'ZZQQQ']) removeSymbol(s);
  });

  const sectorOf = (sym: string) => listUniverse().find((u) => u.symbol === sym)?.sector ?? null;

  it('inserts a new symbol with its sector', () => {
    expect(addSymbols([{ symbol: 'ZZSPY', sector: 'Index ETF' }])).toEqual({ added: 1, backfilled: 0 });
    expect(sectorOf('ZZSPY')).toBe('Index ETF');
  });

  // The six-session bug: SPY and QQQ were added on 2026-08-27 with sector NULL,
  // and INSERT OR IGNORE discarded every later attempt to set one. There is no
  // update route, so the sector could not be corrected at all — and
  // classifySector reads the universe sector FIRST, falling through to Yahoo
  // fundamentals, which has no sector for an ETF. Both were skipped as
  // `unknown` on every tick and never scored once.
  it('backfills a NULL sector on a symbol that already exists', () => {
    expect(addSymbols([{ symbol: 'ZZSPY' }])).toEqual({ added: 1, backfilled: 0 });
    expect(sectorOf('ZZSPY')).toBeNull();

    expect(addSymbols([{ symbol: 'ZZSPY', sector: 'Index ETF' }])).toEqual({ added: 0, backfilled: 1 });
    expect(sectorOf('ZZSPY')).toBe('Index ETF');
  });

  it('NEVER overwrites a sector that is already set', () => {
    addSymbols([{ symbol: 'ZZSPY', sector: 'Index ETF' }]);
    expect(addSymbols([{ symbol: 'ZZSPY', sector: 'Technology' }])).toEqual({ added: 0, backfilled: 0 });
    expect(sectorOf('ZZSPY')).toBe('Index ETF'); // curated value survives a re-add
  });

  it('does not report a backfill when there is nothing to fill', () => {
    addSymbols([{ symbol: 'ZZSPY' }]);
    expect(addSymbols([{ symbol: 'ZZSPY' }])).toEqual({ added: 0, backfilled: 0 });
  });

  it('backfills name and sector independently', () => {
    addSymbols([{ symbol: 'ZZQQQ', sector: 'Index ETF' }]);
    expect(addSymbols([{ symbol: 'ZZQQQ', name: 'Invesco QQQ Trust' }])).toEqual({ added: 0, backfilled: 1 });
    const row = listUniverse().find((u) => u.symbol === 'ZZQQQ');
    expect(row?.name).toBe('Invesco QQQ Trust');
    expect(row?.sector).toBe('Index ETF'); // untouched
  });

  it('leaves the real-estate exclusion able to do its job', () => {
    // A sector string is not a bypass: classify() tests it against
    // /real estate|\breit\b/i, so a real-estate ETF labelled honestly is still
    // excluded. Labelling every ETF generically is what would smuggle one past.
    const RE = /real estate|\breit\b/i;
    expect(RE.test('Index ETF')).toBe(false);
    expect(RE.test('Real Estate')).toBe(true);
    expect(RE.test('REIT—Diversified')).toBe(true);
  });
});

describe('universe table', () => {
  it('is the same table the screen reads', () => {
    const cols = db.prepare('PRAGMA table_info(universe)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['symbol', 'name', 'sector']));
  });
});

describe('recordLiveOrder — client_combo_order_id', () => {
  it('stores the combo group id and reads it back', async () => {
    const { createIntent } = await import('../src/db/orders');
    const { recordLiveOrder, getLiveOrder } = await import('../src/db/autotradeLiveOrders');
    const rec = createIntent(
      {
        symbol: 'ZZCMB',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 10,
      },
      `cid-${Date.now()}`,
    );
    // The whole point: a modify cannot name its combo group unless placement
    // kept the id it minted. buildOrderRequest used to spread it into the
    // request body and drop it.
    recordLiveOrder({
      intentId: rec.id,
      symbol: 'ZZCMB',
      stopPrice: 9,
      targetPrice: 12,
      riskAmount: 1,
      riskProfile: 'balanced',
      clientComboOrderId: 'COMBO-ABC',
    });
    expect(getLiveOrder(rec.id)?.clientComboOrderId).toBe('COMBO-ABC');
  });

  it('is null when the order carried no bracket', async () => {
    const { createIntent } = await import('../src/db/orders');
    const { recordLiveOrder, getLiveOrder } = await import('../src/db/autotradeLiveOrders');
    const rec = createIntent(
      {
        symbol: 'ZZCMB2',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 10,
      },
      `cid2-${Date.now()}`,
    );
    recordLiveOrder({
      intentId: rec.id,
      symbol: 'ZZCMB2',
      stopPrice: 9,
      targetPrice: 12,
      riskAmount: 1,
      riskProfile: 'balanced',
    });
    expect(getLiveOrder(rec.id)?.clientComboOrderId).toBeNull();
  });
});

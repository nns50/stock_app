import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { listPositions, createPosition, getPosition } from '../src/db/positions';
import { config } from '../src/config';
import {
  extractPositions,
  mapWebullPosition,
  importWebullPositions,
  syncClosedWebullPositions,
  runWebullPositionsSync,
} from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';

vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM position_exits; DELETE FROM positions;');
  vi.mocked(priceMap).mockReset();
  // Default: price every probed position at $10 unless a test overrides it.
  vi.mocked(priceMap).mockImplementation(
    async (positions) => new Map(positions.map((p) => [p.id, { price: 10, stale: false, asOf: 0 }])),
  );
});

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
  vi.mocked(priceMap).mockReset();
});

function mockPositions(rows: unknown) {
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  } as Response);
}

describe('webull positions mapping', () => {
  it('extracts the list from common payload wrappers', () => {
    expect(extractPositions([{ symbol: 'AAPL' }])).toHaveLength(1);
    expect(extractPositions({ positions: [{ symbol: 'AAPL' }] })).toHaveLength(1);
    expect(extractPositions({ holdings: [{ symbol: 'A' }, { symbol: 'B' }] })).toHaveLength(2);
    expect(extractPositions({ nope: 1 })).toEqual([]);
  });

  it('maps a stock position (string fields, long)', () => {
    const p = mapWebullPosition({ symbol: 'aapl', asset_type: 'STOCK', quantity: '100', cost_price: '187.50' });
    expect(p).toMatchObject({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 100, entryPrice: 187.5 });
    expect(p?.tags).toContain('webull');
  });

  it('maps an option position with strike/expiration/type', () => {
    const p = mapWebullPosition({
      symbol: 'TSLA',
      instrument_type: 'OPTION',
      quantity: '2',
      cost_price: '5.40',
      option_type: 'CALL',
      strike_price: '400',
      option_expire_date: '2026-12-18',
    });
    expect(p).toMatchObject({
      assetType: 'option',
      symbol: 'TSLA',
      quantity: 2,
      entryPrice: 5.4,
      optionType: 'call',
      strike: 400,
      expiration: '2026-12-18',
      multiplier: 100,
    });
  });

  it('infers short from a negative quantity and drops unusable rows', () => {
    expect(mapWebullPosition({ symbol: 'NVDA', quantity: '-50', cost_price: '100' })?.side).toBe('short');
    expect(mapWebullPosition({ symbol: '', quantity: '1' })).toBeNull(); // no symbol
    expect(mapWebullPosition({ symbol: 'X', quantity: '0' })).toBeNull(); // flat
    expect(mapWebullPosition({ symbol: 'Y', instrument_type: 'OPTION', quantity: '1', cost_price: '1' })).toBeNull(); // option missing legs
  });
});

describe('importWebullPositions', () => {
  it('adds new open positions and skips ones already in the journal', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
    });
    mockPositions([
      { symbol: 'AAPL', asset_type: 'STOCK', quantity: '100', cost_price: '150' }, // dup -> skip
      { symbol: 'MSFT', asset_type: 'STOCK', quantity: '20', cost_price: '410' }, // new -> import
      { symbol: '', quantity: '1' }, // unmapped
    ]);

    const r = await importWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, imported: 1, skipped: 1, unmapped: 1 });
    const open = listPositions({ status: 'open' });
    expect(open.map((p) => p.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('surfaces a Webull error without writing', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'INVALID_TOKEN' }),
    } as Response);
    const r = await importWebullPositions('ACC1');
    expect(r.ok).toBe(false);
    expect(r.imported).toBe(0);
    expect(listPositions()).toHaveLength(0);
  });
});

describe('syncClosedWebullPositions', () => {
  it('closes a Webull-tracked position no longer held at the broker', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    mockPositions([]); // Webull shows nothing held anymore

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 1, closedSymbols: ['VRAX'] });

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exits).toHaveLength(1);
    expect(closed.exits[0]).toMatchObject({ quantity: 50, exitPrice: 10 });
    expect(closed.exits[0].notes).toMatch(/Auto-closed via Webull sync/);
  });

  it('never closes a plain manually-logged position with no Webull provenance', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'WRAP',
      side: 'long',
      quantity: 10,
      entryPrice: 5,
      entryDate: '2026-01-02',
      // No 'webull'/'live' tag and no sourceIntentId — e.g. tracked at another broker.
    });
    mockPositions([]); // not in Webull's list either, but that's expected — it's not Webull's

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('records a partial exit when Webull now shows fewer shares than the journal', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'KC',
      side: 'long',
      quantity: 100,
      entryPrice: 15,
      entryDate: '2026-01-02',
      tags: ['live'],
    });
    mockPositions([{ symbol: 'KC', asset_type: 'STOCK', quantity: '40', cost_price: '15' }]);

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 1, closedSymbols: ['KC'] });
    const after = getPosition(p.id)!;
    expect(after.status).toBe('open'); // still holding 40
    expect(after.remainingQuantity).toBe(40);
  });

  it('closes the oldest lot first (FIFO) across two open lots of the same contract', async () => {
    const older = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 50,
      entryPrice: 150,
      entryDate: '2026-01-01',
      tags: ['webull'],
    });
    const newer = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 50,
      entryPrice: 160,
      entryDate: '2026-01-05',
      tags: ['webull'],
    });
    // Journal shows 100 total; broker now shows only 30 -> 70-share gap.
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '30', cost_price: '155' }]);

    await syncClosedWebullPositions('ACC1');
    expect(getPosition(older.id)!.status).toBe('closed'); // fully closed first
    expect(getPosition(older.id)!.remainingQuantity).toBe(0);
    const afterNewer = getPosition(newer.id)!;
    expect(afterNewer.status).toBe('open');
    expect(afterNewer.remainingQuantity).toBe(30); // 50 - 20 taken to cover the rest of the gap
  });

  it('leaves the position open when a price cannot be resolved', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'ILLQ',
      side: 'long',
      quantity: 10,
      entryPrice: 3,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    vi.mocked(priceMap).mockResolvedValueOnce(new Map([[p.id, { price: null, stale: false, asOf: null }]]));
    mockPositions([]);

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('surfaces a Webull error without writing', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'INVALID_TOKEN' }),
    } as Response);
    const r = await syncClosedWebullPositions('ACC1');
    expect(r.ok).toBe(false);
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });
});

describe('runWebullPositionsSync', () => {
  it('closes and imports in the same pass off a single live-positions fetch', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    // VRAX no longer held; MSFT is new.
    mockPositions([{ symbol: 'MSFT', asset_type: 'STOCK', quantity: '20', cost_price: '410' }]);

    const r = await runWebullPositionsSync('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 1, closedSymbols: ['VRAX'], imported: 1, skipped: 0 });
    expect(getPosition(p.id)!.status).toBe('closed');
    expect(listPositions({ status: 'open' }).map((x) => x.symbol)).toEqual(['MSFT']);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // one shared preview fetch, not two
  });

  it('reports nothing to do when the journal already matches the broker', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 150,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '150' }]);

    const r = await runWebullPositionsSync('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, imported: 0, skipped: 1 });
  });
});

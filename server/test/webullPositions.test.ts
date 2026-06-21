import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { listPositions, createPosition } from '../src/db/positions';
import { config } from '../src/config';
import { extractPositions, mapWebullPosition, importWebullPositions } from '../src/providers/webull/positions';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM position_exits; DELETE FROM positions;'));

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

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
  function mockPositions(rows: unknown) {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows),
    } as Response);
  }

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

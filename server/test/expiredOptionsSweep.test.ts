import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, getPosition, listPositions } from '../src/db/positions';
import { etToday, sweepExpiredOptions } from '../src/services/expiredOptionsSweep';

// The write half of the expired-option sweep. The classification rules are
// covered in expiredOptions.test.ts; these pin what actually reaches the ledger
// — in particular that only an unambiguously worthless contract is ever closed
// automatically, since a fabricated exit writes a realized P&L number that never
// happened into the journal AND the tax export.

const mockGetCandles = vi.fn();
vi.mock('../src/providers', () => ({
  getProvider: () => ({ getCandles: mockGetCandles }),
}));

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM position_exits; DELETE FROM positions;');
  mockGetCandles.mockReset();
});
afterEach(() => vi.restoreAllMocks());

/** Daily bars ending on `date` at `close`. */
const barsEndingAt = (date: string, close: number) => [
  { time: Date.parse(`${date}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1 },
];

function openOption(over: Partial<Parameters<typeof createPosition>[0]> = {}) {
  return createPosition({
    assetType: 'option',
    symbol: 'AAPL',
    side: 'long',
    quantity: 2,
    entryPrice: 3,
    entryDate: '2026-06-01',
    optionType: 'call',
    strike: 200,
    expiration: '2026-07-17',
    multiplier: 100,
    ...over,
  });
}

describe('etToday', () => {
  it('reports the US market date, not the server-local one', () => {
    // 03:30 UTC on the 18th is still the 17th in New York. A UTC-deployed box
    // using local "today" would sweep a position on its own expiration day.
    expect(etToday(Date.parse('2026-07-18T03:30:00Z'))).toBe('2026-07-17');
  });
});

describe('sweepExpiredOptions', () => {
  const now = Date.parse('2026-07-20T15:00:00Z');

  it('closes an expired worthless option at $0, dated on the expiry itself', async () => {
    const pos = openOption();
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 150));

    const r = await sweepExpiredOptions({ now });

    expect(r.examined).toBe(1);
    expect(r.closed).toHaveLength(1);
    expect(r.needsReview).toHaveLength(0);

    const after = getPosition(pos.id)!;
    expect(after.status).toBe('closed');
    expect(after.exits[0].exitPrice).toBe(0);
    // Dated when the position actually ceased to exist, so realized P&L lands
    // in the period it belongs to rather than whenever the sweep happened to run.
    expect(after.exits[0].exitDate).toBe('2026-07-17');
    expect(after.exits[0].notes).toMatch(/expired worthless/i);
  });

  it('leaves an in-the-money option OPEN and flags it', async () => {
    // It was exercised/assigned into a stock position this app doesn't model —
    // inventing a cash exit would misstate both the P&L and the holding.
    const pos = openOption();
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 250));

    const r = await sweepExpiredOptions({ now });

    expect(r.closed).toHaveLength(0);
    expect(r.needsReview).toHaveLength(1);
    expect(r.needsReview[0].disposition).toBe('in_the_money');
    expect(getPosition(pos.id)!.status).toBe('open');
  });

  it('leaves a position open when the price cannot be resolved', async () => {
    const pos = openOption();
    mockGetCandles.mockResolvedValue([]); // no bars at all

    const r = await sweepExpiredOptions({ now });

    expect(r.needsReview[0].disposition).toBe('unknown');
    expect(getPosition(pos.id)!.status).toBe('open');
  });

  it('leaves a position open when the price fetch throws', async () => {
    const pos = openOption();
    mockGetCandles.mockRejectedValue(new Error('provider down'));

    const r = await sweepExpiredOptions({ now });

    expect(r.needsReview[0].disposition).toBe('unknown');
    expect(getPosition(pos.id)!.status).toBe('open');
  });

  it('falls back to an earlier session when the expiry date itself has no bar', async () => {
    // A Saturday-dated expiry, or a market holiday — the Friday close is the
    // right reference, not a reason to give up and flag it.
    const pos = openOption({ expiration: '2026-07-18' }); // a Saturday
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 150));

    const r = await sweepExpiredOptions({ now });

    expect(r.closed).toHaveLength(1);
    expect(getPosition(pos.id)!.status).toBe('closed');
  });

  it('does not touch a position on its own expiration day', async () => {
    const pos = openOption({ expiration: '2026-07-20' });
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-20', 150));

    const r = await sweepExpiredOptions({ now });

    expect(r.examined).toBe(0);
    expect(getPosition(pos.id)!.status).toBe('open');
  });

  it('does not touch stock positions, however old', async () => {
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2020-01-01',
    });
    const r = await sweepExpiredOptions({ now });
    expect(r.examined).toBe(0);
    expect(getPosition(pos.id)!.status).toBe('open');
    expect(mockGetCandles).not.toHaveBeenCalled();
  });

  it('dryRun classifies without writing anything', async () => {
    const pos = openOption();
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 150));

    const r = await sweepExpiredOptions({ now, dryRun: true });

    expect(r.closed).toHaveLength(1); // reported as WOULD close
    expect(getPosition(pos.id)!.status).toBe('open'); // but untouched
  });

  it('is safe to run twice — the second pass finds nothing left', async () => {
    openOption();
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 150));

    await sweepExpiredOptions({ now });
    const second = await sweepExpiredOptions({ now });

    expect(second.examined).toBe(0);
    expect(listPositions({ status: 'closed' })).toHaveLength(1);
  });

  it('closes only the worthless ones in a mixed batch, and leaves the rest', async () => {
    const worthless = openOption({ strike: 200 });
    const itm = openOption({ symbol: 'MSFT', strike: 100 });
    mockGetCandles.mockImplementation(async (symbol: string) =>
      symbol === 'AAPL' ? barsEndingAt('2026-07-17', 150) : barsEndingAt('2026-07-17', 150),
    );

    const r = await sweepExpiredOptions({ now });

    expect(r.examined).toBe(2);
    expect(r.closed.map((c) => c.symbol)).toEqual(['AAPL']);
    expect(r.needsReview.map((c) => c.symbol)).toEqual(['MSFT']);
    expect(getPosition(worthless.id)!.status).toBe('closed');
    expect(getPosition(itm.id)!.status).toBe('open');
  });

  it('closes only the REMAINING quantity of a partly-exited position', async () => {
    const pos = openOption({ quantity: 5 });
    // Two of the five were already sold before expiry.
    const { addExit } = await import('../src/db/positions');
    addExit(pos.id, { quantity: 2, exitPrice: 4, exitDate: '2026-07-10' });
    mockGetCandles.mockResolvedValue(barsEndingAt('2026-07-17', 150));

    const r = await sweepExpiredOptions({ now });

    expect(r.closed[0].remainingQuantity).toBe(3);
    const after = getPosition(pos.id)!;
    expect(after.status).toBe('closed');
    expect(after.exits.find((e) => e.exitPrice === 0)!.quantity).toBe(3);
  });
});

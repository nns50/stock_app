import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { initDb } from '../src/db';
import { resolveOptionMarks } from '../src/services/quotes';
import { Position } from '../src/db/positions';
import { etToday } from '../src/util/marketDate';

// resolveOptionMarks and already-expired contracts. Asking a provider for a
// chain on a PAST expiration does not return "expired": Yahoo silently falls
// back to the NEAREST live expiration, where the same strike usually still
// matches — so a dead contract got priced with a live contract's mark. That
// fed a fabricated "current price" to the Positions page and a fabricated
// exit price to the Webull close-sync. An expired contract has no live mark,
// and the resolver must say so rather than guess.

const mockGetOptionsChain = vi.fn();
vi.mock('../src/providers', () => ({
  getProvider: () => ({ capabilities: { options: true }, getOptionsChain: mockGetOptionsChain }),
}));

beforeAll(() => initDb());
beforeEach(() => mockGetOptionsChain.mockReset());

function optionPos(over: Partial<Position>): Position {
  return {
    id: 1,
    assetType: 'option',
    symbol: 'QS',
    side: 'long',
    quantity: 1,
    entryPrice: 1,
    entryDate: '2026-01-02',
    entryTime: null,
    fees: 0,
    optionType: 'call',
    strike: 6.5,
    expiration: '2030-01-18',
    multiplier: 100,
    status: 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
    createdAt: 0,
    updatedAt: 0,
    exits: [],
    remainingQuantity: 1,
    ...over,
  };
}

const yesterdayEt = () => {
  const d = new Date(`${etToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

describe('resolveOptionMarks — expired contracts', () => {
  it('never prices an expired contract off a live chain, even when the same strike would match', async () => {
    const expired = optionPos({ id: 1, expiration: yesterdayEt() });
    const live = optionPos({ id: 2, expiration: '2030-01-18' });
    // What Yahoo actually does for an unknown/past date: hands back the
    // nearest LIVE chain — same strike present, live mark attached.
    mockGetOptionsChain.mockResolvedValue({
      underlying: 'QS',
      expiration: '2030-01-18',
      underlyingPrice: 8,
      calls: [{ symbol: 'QS300118C00006500', strike: 6.5, mark: 1.55, last: 1.5 }],
      puts: [],
    });

    const marks = await resolveOptionMarks([expired, live]);

    expect(marks.get(1)).toEqual({ mark: null, delta: null }); // expired: no live mark exists
    expect(marks.get(2)?.mark).toBe(1.55); // the live contract still prices normally
    // ...and no chain fetch was spent on the expired one's (symbol, expiration) group.
    expect(mockGetOptionsChain).toHaveBeenCalledTimes(1);
    expect(mockGetOptionsChain).toHaveBeenCalledWith('QS', '2030-01-18');
  });

  it('still prices a contract expiring TODAY — it trades all session', async () => {
    const sameDay = optionPos({ id: 3, expiration: etToday() });
    mockGetOptionsChain.mockResolvedValue({ calls: [{ strike: 6.5, mark: 0.4 }], puts: [] });

    const marks = await resolveOptionMarks([sameDay]);

    expect(marks.get(3)?.mark).toBe(0.4);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/services/notifier', () => ({ dispatchNotifications: vi.fn(async () => undefined) }));

import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { setAutotradeConfig, defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import {
  createLiveOptionsPosition,
  listOpenLiveOptionsPositions,
  listLiveOptionsPositions,
} from '../src/db/autotradeLiveOptionsPositions';
import { hasExpiredLiveOptions, sweepExpiredLiveOptions } from '../src/services/autotrading/liveOptionsExpiry';
import { dispatchNotifications } from '../src/services/notifier';

const mockGetProvider = vi.mocked(getProvider);
const mockDispatch = vi.mocked(dispatchNotifications);

// 2026-03-20 was a Friday; the sweep only acts on expirations strictly BEFORE
// "today", so every fixture below expires on that date and is swept as of the
// following week.
const EXPIRY = '2026-03-20';
const AFTER_EXPIRY = Date.parse('2026-03-25T15:00:00Z');

/** Daily closes for the underlying around the expiry. */
function candlesClosing(at: number): ReturnType<typeof getProvider> {
  // Deliberately partial — only the members these tests exercise.
  return {
    getCandles: vi.fn(async () => [
      { time: Date.parse(`${EXPIRY}T00:00:00Z`) - 86_400_000, open: at, high: at, low: at, close: at, volume: 1 },
      { time: Date.parse(`${EXPIRY}T00:00:00Z`), open: at, high: at, low: at, close: at, volume: 1 },
    ]),
  } as unknown as ReturnType<typeof getProvider>;
}

function openPosition(over: Partial<Parameters<typeof createLiveOptionsPosition>[0]> = {}) {
  return createLiveOptionsPosition({
    symbol: 'AAPL',
    side: 'call',
    contractSymbol: 'AAPL-C-100',
    strike: 100,
    expiration: EXPIRY,
    quantity: 1,
    entryPrice: 2,
    riskAmount: 200,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    ...over,
  });
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_live_options_positions;');
  setAutotradeConfig({ ...defaultAutotradeConfig(), liveAccountId: 'ACC1' });
  mockGetProvider.mockReset();
  mockDispatch.mockClear();
});
afterEach(() => vi.restoreAllMocks());

const reviewFlags = () => listAutotradeEvents({ stage: 'execution', actions: ['live_options_expired_needs_review'] });

describe('sweepExpiredLiveOptions', () => {
  it('closes a clearly out-of-the-money expiry at $0', async () => {
    // An option held through expiry never produces a closing order, and the
    // broker-truth sync can't price a chain that no longer exists — so without
    // this the row stays open forever, consuming shared risk budget.
    const pos = openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(80) as ReturnType<typeof getProvider>);

    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(r.examined).toBe(1);
    expect(r.closed).toHaveLength(1);
    expect(r.needsReview).toHaveLength(0);
    expect(listOpenLiveOptionsPositions()).toHaveLength(0);
    const closed = listLiveOptionsPositions({ status: 'closed' })[0];
    expect(closed.id).toBe(pos.id);
    expect(closed.exitPrice).toBe(0);
  });

  it('never auto-closes an in-the-money expiry — it was exercised into stock', async () => {
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(130) as ReturnType<typeof getProvider>);

    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(r.closed).toHaveLength(0);
    expect(r.needsReview[0]).toMatchObject({ disposition: 'in_the_money' });
    expect(listOpenLiveOptionsPositions()).toHaveLength(1); // left for a human
    expect(reviewFlags()).toHaveLength(1);
  });

  it('never guesses when the underlying price cannot be resolved', async () => {
    openPosition();
    mockGetProvider.mockReturnValue({
      getCandles: vi.fn().mockRejectedValue(new Error('provider down')),
    } as never);

    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(r.closed).toHaveLength(0);
    expect(r.needsReview[0]).toMatchObject({ disposition: 'unknown' });
    expect(listOpenLiveOptionsPositions()).toHaveLength(1);
  });

  it('treats a near-the-strike settle as too close to call (pin risk)', async () => {
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(99.9) as ReturnType<typeof getProvider>); // inside the band
    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });
    expect(r.closed).toHaveLength(0);
    expect(r.needsReview[0]).toMatchObject({ disposition: 'unknown' });
  });

  it('ignores a position expiring TODAY — it is still tradeable', async () => {
    openPosition();
    const onExpiry = Date.parse(`${EXPIRY}T15:00:00Z`);
    expect(await sweepExpiredLiveOptions({ now: onExpiry })).toMatchObject({ examined: 0 });
    expect(listOpenLiveOptionsPositions()).toHaveLength(1);
  });

  describe('debit spreads', () => {
    const spread = (over = {}) =>
      openPosition({
        kind: 'debit_spread',
        strike: 100,
        shortStrike: 110,
        shortContractSymbol: 'AAPL-C-110',
        shortEntryPrice: 1,
        ...over,
      });

    it('closes at $0 only when BOTH legs finished out of the money', async () => {
      spread();
      mockGetProvider.mockReturnValue(candlesClosing(80) as ReturnType<typeof getProvider>);

      const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

      expect(r.closed).toHaveLength(1);
      expect(listOpenLiveOptionsPositions()).toHaveLength(0);
      const closed = listLiveOptionsPositions({ status: 'closed' })[0];
      expect(closed.exitPrice).toBe(0);
      expect(closed.shortExitPrice).toBe(0);
    });

    it('flags a spread whose LONG leg finished in the money', async () => {
      // 105: long 100C is ITM, short 110C is not. The long is exercised into
      // stock — a human's problem, not a $0 exit.
      spread();
      mockGetProvider.mockReturnValue(candlesClosing(105) as ReturnType<typeof getProvider>);

      const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

      expect(r.closed).toHaveLength(0);
      expect(r.needsReview[0]).toMatchObject({ disposition: 'in_the_money' });
      expect(listOpenLiveOptionsPositions()).toHaveLength(1);
    });

    it('flags a spread whose SHORT leg finished in the money (assignment)', async () => {
      // 130: both legs ITM. The written leg is assigned — the case that most
      // needs a human, and the one a long-leg-only check would have missed.
      spread();
      mockGetProvider.mockReturnValue(candlesClosing(130) as ReturnType<typeof getProvider>);

      const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

      expect(r.closed).toHaveLength(0);
      expect(r.needsReview[0]).toMatchObject({ disposition: 'in_the_money' });
    });
  });

  it('journals a review flag once per day, not once per tick', async () => {
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(130) as ReturnType<typeof getProvider>);

    await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });
    await sweepExpiredLiveOptions({ now: AFTER_EXPIRY + 60_000 });
    await sweepExpiredLiveOptions({ now: AFTER_EXPIRY + 120_000 });
    expect(reviewFlags()).toHaveLength(1);
  });

  it('is idempotent — a second sweep finds nothing left to close', async () => {
    openPosition();
    mockGetProvider.mockReturnValue(candlesClosing(80) as ReturnType<typeof getProvider>);
    await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });
    expect(await sweepExpiredLiveOptions({ now: AFTER_EXPIRY })).toMatchObject({ examined: 0, closed: [] });
  });
});

describe('hasExpiredLiveOptions', () => {
  it('is false with nothing expired, true once something is', () => {
    openPosition();
    expect(hasExpiredLiveOptions(Date.parse(`${EXPIRY}T15:00:00Z`))).toBe(false);
    expect(hasExpiredLiveOptions(AFTER_EXPIRY)).toBe(true);
  });

  it('is false without a live account configured', () => {
    openPosition();
    setAutotradeConfig({ liveAccountId: null });
    expect(hasExpiredLiveOptions(AFTER_EXPIRY)).toBe(false);
  });
});

describe('sweepExpiredLiveOptions — the needs-review push', () => {
  // The sweep's only outcome a human must ACT on, and until 2026-09-05 the one
  // thing here that never left the journal. An in-the-money expiry is exercised
  // or assigned, so the account now holds stock this app does not model —
  // while a far smaller event, an auto-tuned risk-% nudge, already pushes.
  it('notifies once when a position first needs review', async () => {
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(130) as ReturnType<typeof getProvider>); // above the strike

    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(r.needsReview).toHaveLength(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [events] = mockDispatch.mock.calls[0];
    expect(events[0].title).toMatch(/need review/i);
    expect(events[0].message).toMatch(/exercised or assigned/i);
  });

  it('does NOT re-push on later ticks — the row is never auto-closed', async () => {
    // hasExpiredLiveOptions stays true for as long as the row sits there, so
    // the sweep runs every tick. Notifying off needsReview itself would push
    // on every one of them.
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(130) as ReturnType<typeof getProvider>);

    await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });
    mockDispatch.mockClear();
    const again = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(again.needsReview).toHaveLength(1); // still flagged...
    expect(mockDispatch).not.toHaveBeenCalled(); // ...but silent
  });

  it('says nothing when everything expired worthless', async () => {
    openPosition({ strike: 100 });
    mockGetProvider.mockReturnValue(candlesClosing(50) as ReturnType<typeof getProvider>); // far below the strike

    const r = await sweepExpiredLiveOptions({ now: AFTER_EXPIRY });

    expect(r.closed).toHaveLength(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

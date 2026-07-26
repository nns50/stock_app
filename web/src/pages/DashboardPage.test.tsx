import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from './DashboardPage';
import { client } from '../api/client';
import type { Position, PositionWithPnl, SymbolEvents } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();

  // Sibling dashboard cards this page also mounts — safe, minimal defaults so
  // they render quietly without erroring; none of these are what these tests
  // assert on.
  vi.spyOn(client, 'alerts').mockResolvedValue({ alerts: [] } as never);
  vi.spyOn(client, 'runScreener').mockResolvedValue({ results: [], asOf: 0, filtersApplied: {} } as never);
  vi.spyOn(client, 'webullMovers').mockResolvedValue({ gainers: [], losers: [], mostActive: [] } as never);

  // This page's own primary data sources — overridden per test as needed.
  vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
    positions: [],
    aggregate: {
      total: 0,
      unrealized: 0,
      realized: 0,
      openMarketValue: 0,
      openCount: 0,
      closedCount: 0,
    },
    exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
  });
  vi.spyOn(client, 'alertsState').mockResolvedValue({
    alerts: [],
    positionAlerts: [],
    checkedAt: 0,
  });
  vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: [] });
  vi.spyOn(client, 'quotes').mockResolvedValue({ quotes: [], asOf: 0 });
  vi.spyOn(client, 'listSnapshots').mockResolvedValue({ snapshots: [] });
  vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
});

function positionFixture(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 10,
    entryPrice: 100,
    entryDate: '2026-04-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    createdAt: 0,
    updatedAt: 0,
    exits: [],
    remainingQuantity: 10,
    ...overrides,
  };
}

function positionWithPnlFixture(overrides: Partial<PositionWithPnl> = {}): PositionWithPnl {
  const position = overrides.position ?? positionFixture();
  return {
    position,
    price: null,
    stale: false,
    asOf: null,
    pnl: {
      positionId: position.id,
      currentPrice: null,
      costBasis: 1000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      returnPct: 0,
      rMultiple: null,
      marketValue: null,
      remainingQuantity: position.remainingQuantity,
      closedQuantity: 0,
    },
    washSale: null,
    ...overrides,
  };
}

function renderPage() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  it('mounts without crashing when every data source is empty', async () => {
    renderPage();
    expect(await screen.findByText('Today')).toBeInTheDocument();
  });

  describe('Upcoming catalysts', () => {
    it('shows an empty state with no catalysts in range', async () => {
      renderPage();
      expect(await screen.findByText(/No earnings or ex-dividend dates in the next 14 days/)).toBeInTheDocument();
    });

    it('lists earnings and ex-dividend catalysts for both positions and watchlist symbols, soonest first', async () => {
      vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
        positions: [positionWithPnlFixture({ position: positionFixture({ id: 1, symbol: 'AAPL' }) })],
        aggregate: { total: 0, unrealized: 0, realized: 0, openMarketValue: 0, openCount: 1, closedCount: 0 },
        exposure: { gross: 1000, net: 1000, long: 1000, short: 0, bySector: [], largest: null },
      });
      vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: ['MSFT'] });
      const events: SymbolEvents[] = [
        { symbol: 'AAPL', earningsDate: futureIso(10), earningsEstimated: false },
        { symbol: 'MSFT', exDividendDate: futureIso(3) },
      ];
      const eventsSpy = vi.spyOn(client, 'events').mockResolvedValue({ events });

      renderPage();

      // Wait for the catalysts card's OWN render specifically — 'MSFT' alone
      // would resolve as soon as the (faster, independent) Watchlist card
      // renders, well before this slower combined fetch settles.
      expect(await screen.findByText(/Ex-div/)).toBeInTheDocument();
      expect(screen.getByText(/Earnings/)).toBeInTheDocument();
      expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
      expect(screen.getAllByText('MSFT').length).toBeGreaterThan(0);
      // Requested once both position and watchlist symbols were known.
      expect(eventsSpy).toHaveBeenCalledWith(['AAPL', 'MSFT']);
    });

    it('excludes a catalyst more than 14 days out', async () => {
      vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: ['MSFT'] });
      vi.spyOn(client, 'events').mockResolvedValue({
        events: [{ symbol: 'MSFT', earningsDate: futureIso(30) }],
      });
      renderPage();
      expect(await screen.findByText(/No earnings or ex-dividend dates in the next 14 days/)).toBeInTheDocument();
      // MSFT still renders once, in the Watchlist card — just not duplicated into Catalysts.
      expect(screen.getAllByText('MSFT')).toHaveLength(1);
    });
  });

  describe('Upcoming expirations — assignment risk', () => {
    it('shows an assignment-risk badge on a deep-ITM short option nearing expiry', async () => {
      const shortCall = positionWithPnlFixture({
        position: positionFixture({
          id: 2,
          assetType: 'option',
          symbol: 'TSLA',
          side: 'short',
          optionType: 'call',
          strike: 100,
          expiration: futureIso(5),
          multiplier: 100,
        }),
        price: 20, // mark barely above intrinsic (120 - 100 = 20) -> ~$0 extrinsic
      });
      vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
        positions: [shortCall],
        aggregate: { total: 0, unrealized: 0, realized: 0, openMarketValue: 0, openCount: 1, closedCount: 0 },
        exposure: { gross: 1000, net: 1000, long: 1000, short: 0, bySector: [], largest: null },
      });
      vi.spyOn(client, 'quotes').mockResolvedValue({ quotes: [{ symbol: 'TSLA', last: 120, timestamp: 0 }], asOf: 0 });

      renderPage();

      expect(await screen.findByText('TSLA')).toBeInTheDocument();
      expect(await screen.findByText('Assignment risk')).toBeInTheDocument();
    });

    it('shows no assignment-risk badge on a LONG option position', async () => {
      const longCall = positionWithPnlFixture({
        position: positionFixture({
          id: 3,
          assetType: 'option',
          symbol: 'NVDA',
          side: 'long',
          optionType: 'call',
          strike: 100,
          expiration: futureIso(5),
          multiplier: 100,
        }),
        price: 20,
      });
      vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
        positions: [longCall],
        aggregate: { total: 0, unrealized: 0, realized: 0, openMarketValue: 0, openCount: 1, closedCount: 0 },
        exposure: { gross: 1000, net: 1000, long: 1000, short: 0, bySector: [], largest: null },
      });
      vi.spyOn(client, 'quotes').mockResolvedValue({ quotes: [{ symbol: 'NVDA', last: 120, timestamp: 0 }], asOf: 0 });

      renderPage();

      expect(await screen.findByText('NVDA')).toBeInTheDocument();
      expect(screen.queryByText('Assignment risk')).toBeNull();
    });
  });
});

/** ISO date `days` from now — for fixtures that need to always be "upcoming". */
function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('DashboardPage — a failed check must never read as an all-clear', () => {
  const boom = () => Promise.reject(new Error('alerts service down'));

  it('does not say "All clear" when the alerts request failed', async () => {
    // The worst instance of this in the app. attentionCount fell back to 0 on
    // failure, so the panel affirmed that nothing was hitting a stop or a rule
    // without having checked, and the tile above it read 0.
    vi.spyOn(client, 'alertsState').mockImplementation(boom as never);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/this is not an all-clear/i)).toBeInTheDocument();
    expect(screen.getByText(/alerts service down/)).toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
  });

  it('shows "?" rather than 0 on the Needs attention tile when it could not check', async () => {
    vi.spyOn(client, 'alertsState').mockImplementation(boom as never);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    await screen.findByText(/this is not an all-clear/i);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('does not claim "No open option positions" when the positions request failed', async () => {
    vi.spyOn(client, 'positionsWithPnl').mockImplementation((() =>
      Promise.reject(new Error('positions unavailable'))) as never);
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/expirations aren.t shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/No open option positions/)).not.toBeInTheDocument();
  });

  it('still gives the real all-clear when the check genuinely came back empty', async () => {
    // The reassurance has to survive — it's only a lie when nothing was checked.
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/All clear/)).toBeInTheDocument();
  });
});

describe('DashboardPage — capped lists say what they are hiding', () => {
  const optionAt = (id: number, expiration: string): PositionWithPnl =>
    positionWithPnlFixture({
      position: positionFixture({
        id,
        symbol: `OPT${id}`,
        assetType: 'option',
        optionType: 'call',
        strike: 100,
        expiration,
      }),
    });

  it('reports how many expiring options it left out', async () => {
    // Seven open options, five slots. On a page whose job is "what needs your
    // attention today", the two it drops are exactly the ones you'd want named.
    const positions = [1, 2, 3, 4, 5, 6, 7].map((i) => optionAt(i, `2026-08-${String(10 + i).padStart(2, '0')}`));
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
      positions,
      aggregate: { total: 0, unrealized: 0, realized: 0, openMarketValue: 0, openCount: 7, closedCount: 0 },
      exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/\+ 2 more expiring options not shown/)).toBeInTheDocument();
  });

  it('stays quiet when everything fits', async () => {
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
      positions: [optionAt(1, '2026-08-21')],
      aggregate: { total: 0, unrealized: 0, realized: 0, openMarketValue: 0, openCount: 1, closedCount: 0 },
      exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    await screen.findByText('OPT1');
    expect(screen.queryByText(/more expiring options not shown/)).not.toBeInTheDocument();
  });
});

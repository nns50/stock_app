import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PositionsPage from './PositionsPage';
import { client } from '../api/client';
import type { Position, PositionWithPnl } from '../api/types';

function positionFixture(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 100,
    entryPrice: 90,
    entryDate: '2026-07-01',
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    exits: [],
    remainingQuantity: 100,
    ...overrides,
  };
}

function rowFixture(position: Position): PositionWithPnl {
  return {
    position,
    price: 100,
    stale: false,
    asOf: Date.now(),
    pnl: {
      positionId: position.id,
      currentPrice: 100,
      costBasis: position.entryPrice * position.quantity,
      realizedPnl: 0,
      unrealizedPnl: (100 - position.entryPrice) * position.quantity,
      totalPnl: (100 - position.entryPrice) * position.quantity,
      returnPct: 10,
      rMultiple: null,
      marketValue: 100 * position.quantity,
      remainingQuantity: position.remainingQuantity,
      closedQuantity: 0,
    },
  };
}

function renderWithRows(rows: PositionWithPnl[]) {
  vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
    positions: rows,
    aggregate: { realized: 0, unrealized: 0, total: 0, openMarketValue: 0, openCount: rows.length, closedCount: 0 },
    exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
  });
  vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
  return render(
    <MemoryRouter>
      <PositionsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PositionsPage — close vs exit action gating', () => {
  it('shows BOTH "exit" (record a manual exit) and "close" (real order) for a broker-tracked (live) open position', async () => {
    // A live position you already sold OUTSIDE the app needs a way to just
    // record the exit, not only place a redundant real order — so it offers
    // both, unlike before when it only offered "close".
    const pos = positionFixture({ id: 1, tags: ['live'] });
    renderWithRows([rowFixture(pos)]);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('exit')).toBeInTheDocument();
    expect(screen.getByText('close')).toBeInTheDocument();
  });

  it('shows "close" for a position with a sourceIntentId even without a "live" tag', async () => {
    const pos = positionFixture({ id: 2, tags: [], sourceIntentId: 42 });
    renderWithRows([rowFixture(pos)]);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('close')).toBeInTheDocument();
    expect(screen.getByText('exit')).toBeInTheDocument(); // manual-exit path is available too
  });

  it('shows "exit" (not "close") for a plain manually-logged position', async () => {
    const pos = positionFixture({ id: 3, tags: [], sourceIntentId: null });
    renderWithRows([rowFixture(pos)]);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('exit')).toBeInTheDocument();
    expect(screen.queryByText('close')).toBeNull();
  });

  it('never shows close/exit for an already-closed position', async () => {
    const pos = positionFixture({ id: 4, status: 'closed', tags: ['live'], remainingQuantity: 0 });
    renderWithRows([rowFixture(pos)]);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText('close')).toBeNull();
    expect(screen.queryByText('exit')).toBeNull();
  });

  it('opens the Close modal (real-order copy) when "close" is clicked', async () => {
    const pos = positionFixture({ id: 5, tags: ['live'] });
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWithRows([rowFixture(pos)]);

    await screen.findByText('AAPL');
    await userEvent.click(screen.getByText('close'));

    expect(await screen.findByText(/Close AAPL — real order/)).toBeInTheDocument();
  });

  it('opens the (journal-only) Exit modal — not the real-order Close modal — when "exit" is clicked on a live position', async () => {
    const pos = positionFixture({ id: 6, tags: ['live'] });
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWithRows([rowFixture(pos)]);

    await screen.findByText('AAPL');
    await userEvent.click(screen.getByText('exit'));

    // The Exit modal opened (records a journal exit); the real-order Close copy did NOT.
    expect(await screen.findByRole('button', { name: /Record exit/i })).toBeInTheDocument();
    expect(screen.queryByText(/Close AAPL — real order/)).toBeNull();
  });
});

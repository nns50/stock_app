import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
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
    washSale: null,
  };
}

function payload(rows: PositionWithPnl[]) {
  return {
    positions: rows,
    aggregate: { realized: 0, unrealized: 0, total: 0, openMarketValue: 0, openCount: rows.length, closedCount: 0 },
    exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
  };
}

function renderWithRows(rows: PositionWithPnl[]) {
  vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(payload(rows));
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
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWithRows([rowFixture(pos)]);

    // The page defaults to the "Open" tab and now filters rows client-side, so
    // a closed position only appears under "All"/"Closed" — select "All".
    await userEvent.click(await screen.findByText('All'));

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

describe('PositionsPage — portfolio-wide tiles vs filtered list', () => {
  it('requests the whole book unscoped (so headline tiles include closed/realized) and filters rows client-side', async () => {
    const open = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'open' }));
    const closed = rowFixture(positionFixture({ id: 2, symbol: 'MSFT', status: 'closed', remainingQuantity: 0 }));
    renderWithRows([open, closed]);

    // The default 'Open' tab must still fetch the FULL book, unscoped — the
    // aggregate tiles describe the whole portfolio, not just the active tab.
    await screen.findByText('AAPL');
    expect(client.positionsWithPnl).toHaveBeenCalledWith({});
    expect(
      (client.positionsWithPnl as unknown as { mock: { calls: unknown[][] } }).mock.calls.every(
        (c) => JSON.stringify(c[0]) === '{}',
      ),
    ).toBe(true);

    // ...but the closed position is filtered OUT of the list on the Open tab.
    expect(screen.queryByText('MSFT')).toBeNull();
  });

  it('reveals closed positions on the All tab without a refetch (client-side filter)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const open = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'open' }));
    const closed = rowFixture(positionFixture({ id: 2, symbol: 'MSFT', status: 'closed', remainingQuantity: 0 }));
    renderWithRows([open, closed]);

    await screen.findByText('AAPL');
    expect(screen.queryByText('MSFT')).toBeNull();
    const callsBefore = (client.positionsWithPnl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await userEvent.click(screen.getByText('All'));

    expect(await screen.findByText('MSFT')).toBeInTheDocument();
    // Switching tabs filters in memory — it does not trigger another fetch.
    expect((client.positionsWithPnl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
  });

  it('only asks for earnings on the OPEN symbols, and not again when the tab changes', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const open = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'open' }));
    const closed = rowFixture(positionFixture({ id: 2, symbol: 'MSFT', status: 'closed', remainingQuantity: 0 }));
    renderWithRows([open, closed]);

    await screen.findByText('AAPL');
    // Only open rows can render an earnings badge, so MSFT is not worth asking
    // about — and the key must not move with the tab, or every tab switch
    // refetches and blanks every badge while it reloads.
    await waitFor(() => expect(client.events).toHaveBeenCalledWith(['AAPL']));
    const callsBefore = (client.events as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await userEvent.click(screen.getByText('All'));
    await screen.findByText('MSFT');
    expect((client.events as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
  });
});

describe('PositionsPage — empty states', () => {
  it('offers the first-run "log your first trade" pitch only when the book is genuinely empty', async () => {
    renderWithRows([]);

    expect(await screen.findByText('No positions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log trade/ })).toBeInTheDocument();
  });

  it('says the TAB is empty (not the book) when a filter hides every row', async () => {
    // A book of only closed trades, viewed on the default Open tab. Showing
    // "No positions yet" + "log your first trade" here told the user they had
    // no positions at all, which is plainly wrong with rows one tab away.
    const closed = rowFixture(positionFixture({ id: 1, symbol: 'MSFT', status: 'closed', remainingQuantity: 0 }));
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWithRows([closed]);

    expect(await screen.findByText('No open positions')).toBeInTheDocument();
    expect(screen.queryByText('No positions yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Log trade/ })).toBeNull();

    // ...and its "Show all" action actually reveals them.
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByText('MSFT')).toBeInTheDocument();
  });
});

describe('PositionsPage — panels follow the book, not the price poll', () => {
  it('re-checks the expired-options banner after an exit is recorded', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const pos = positionFixture({ id: 1, symbol: 'AAPL', status: 'open' });
    renderWithRows([rowFixture(pos)]);
    const expired = vi.spyOn(client, 'expiredOptions').mockResolvedValue({ examined: 0, closed: [], needsReview: [] });
    vi.spyOn(client, 'addExit').mockResolvedValue(pos);

    await screen.findByText('AAPL');
    const before = expired.mock.calls.length;

    // Record an exit through the modal — the book has changed, so anything
    // derived from its composition has to be recomputed. Keyed on nothing,
    // this banner kept listing a contract you had just exited.
    await userEvent.click(screen.getByText('exit'));
    fireEvent.change(screen.getByLabelText('Exit price'), { target: { value: '120' } });
    await userEvent.click(screen.getByRole('button', { name: /Record exit/i }));

    await waitFor(() => expect(expired.mock.calls.length).toBeGreaterThan(before));
  });

  it('does NOT recompute them on an ordinary price refresh', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWithRows([rowFixture(positionFixture({ id: 1, symbol: 'AAPL' }))]);
    const expired = vi.spyOn(client, 'expiredOptions').mockResolvedValue({ examined: 0, closed: [], needsReview: [] });

    await screen.findByText('AAPL');
    const before = expired.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // Each of these panels costs a per-symbol provider call, and prices moving
    // doesn't change what's in the book.
    await waitFor(() => expect(client.positionsWithPnl).toHaveBeenCalledTimes(2));
    expect(expired.mock.calls.length).toBe(before);
  });
});

describe('PositionsPage — panels follow SERVER-side book changes too', () => {
  it('re-checks the expired-options banner when a poll returns a changed book (e.g. the background sync closed a position)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const open = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'open' }));
    const closedBySync = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'closed', remainingQuantity: 0 }));
    vi.spyOn(client, 'positionsWithPnl')
      .mockResolvedValueOnce(payload([open]))
      .mockResolvedValue(payload([closedBySync]));
    vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
    const expired = vi.spyOn(client, 'expiredOptions').mockResolvedValue({ examined: 0, closed: [], needsReview: [] });
    render(
      <MemoryRouter>
        <PositionsPage />
      </MemoryRouter>,
    );

    await screen.findByText('AAPL');
    await waitFor(() => expect(expired).toHaveBeenCalled());
    const before = expired.mock.calls.length;

    // The next price poll hands back a book the background Webull sync has
    // changed underneath the page. Keyed only on page-initiated changes, the
    // banner (and the stress/correlation panels) kept describing the old book
    // until the user touched something — the change must propagate with no
    // user action beyond the refresh itself.
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    await waitFor(() => expect(expired.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('PositionsPage — open dialogs track the live book', () => {
  it('follows a remaining-quantity change instead of acting on the size it opened with', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const open = positionFixture({ id: 1, symbol: 'AAPL', quantity: 100, remainingQuantity: 100 });
    const partiallyExited = { ...open, remainingQuantity: 40 };
    vi.spyOn(client, 'positionsWithPnl')
      .mockResolvedValueOnce(payload([rowFixture(open)]))
      .mockResolvedValue(payload([rowFixture(partiallyExited)]));
    vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
    render(
      <MemoryRouter>
        <PositionsPage />
      </MemoryRouter>,
    );

    await screen.findByText('AAPL');
    await userEvent.click(screen.getByText('exit'));
    expect(await screen.findByText(/Remaining open:/)).toHaveTextContent('100');

    // The background sync (or the poll) sells part of it underneath the open
    // dialog. Holding the row object it opened with, the dialog kept offering
    // to exit 100 shares of a position that now has 40.
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByText(/Remaining open:/)).toHaveTextContent('40'));
  });
});

describe('PositionsPage — a failed refresh must not throw away the numbers on screen', () => {
  it('keeps the table and flags the staleness instead of replacing it with an error card', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const row = rowFixture(positionFixture({ id: 1, symbol: 'AAPL', status: 'open' }));
    vi.spyOn(client, 'positionsWithPnl')
      .mockResolvedValueOnce(payload([row]))
      .mockRejectedValue(new Error('network down'));
    vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
    render(
      <MemoryRouter>
        <PositionsPage />
      </MemoryRouter>,
    );

    await screen.findByText('AAPL');
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // The page polls every 60s, so one transient failure used to blank the
    // whole book — the last-known P&L is exactly what you still want to see.
    const banner = await screen.findByText(/Couldn't refresh/);
    expect(banner).toHaveTextContent('network down');
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });

  it('still shows the full error state when the FIRST load fails (nothing to keep)', async () => {
    vi.spyOn(client, 'positionsWithPnl').mockRejectedValue(new Error('network down'));
    vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
    render(
      <MemoryRouter>
        <PositionsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't refresh/)).toBeNull();
  });
});

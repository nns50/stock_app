import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WatchlistPage from './WatchlistPage';
import { client } from '../api/client';
import type { Quote } from '../api/types';

function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: 'AAPL',
    last: 210.5,
    bid: 210.4,
    ask: 210.6,
    open: 208,
    high: 212,
    low: 207,
    prevClose: 209,
    change: 1.5,
    changePct: 0.72,
    volume: 1_000_000,
    avgVolume: 900_000,
    timestamp: 1_753_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('WatchlistPage', () => {
  it('renders watched symbols with their quotes', async () => {
    vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: ['AAPL'] });
    vi.spyOn(client, 'quotes').mockResolvedValue({ quotes: [quoteFixture()], asOf: 1_753_000_000_000 });
    render(
      <MemoryRouter>
        <WatchlistPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
  });

  it('surfaces a failed load instead of sitting silently empty', async () => {
    // Before 2026-07-28 this rejection escaped the mount effect (an unhandled
    // rejection) and the page showed nothing at all — no rows, no error.
    vi.spyOn(client, 'watchlist').mockRejectedValue(new Error('network down'));
    render(
      <MemoryRouter>
        <WatchlistPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it('recovers: a later successful reload clears the error', async () => {
    const watchlist = vi
      .spyOn(client, 'watchlist')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ symbols: ['AAPL'] });
    vi.spyOn(client, 'quotes').mockResolvedValue({ quotes: [quoteFixture()], asOf: 1_753_000_000_000 });
    render(
      <MemoryRouter>
        <WatchlistPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/network down/)).toBeInTheDocument();

    // The RefreshBar's refresh button drives the same reload() path the mount does.
    fireEvent.click(await screen.findByRole('button', { name: /refresh/i }));
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    expect(watchlist).toHaveBeenCalledTimes(2);
  });
});

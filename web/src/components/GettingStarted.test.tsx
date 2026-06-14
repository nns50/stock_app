import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from './GettingStarted';
import { client } from '../api/client';

function mockState(counts: { watch: number; positions: number; snaps: number; alerts: number }) {
  vi.spyOn(client, 'watchlist').mockResolvedValue({ symbols: Array(counts.watch).fill('AAPL') } as never);
  vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({ positions: Array(counts.positions).fill({}) } as never);
  vi.spyOn(client, 'listSnapshots').mockResolvedValue({ snapshots: Array(counts.snaps).fill({}) } as never);
  vi.spyOn(client, 'alerts').mockResolvedValue({ alerts: Array(counts.alerts).fill({}) } as never);
}

function renderCard() {
  return render(
    <MemoryRouter>
      <GettingStarted />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('GettingStarted', () => {
  it('shows the incomplete steps for a brand-new user', async () => {
    mockState({ watch: 0, positions: 0, snaps: 0, alerts: 0 });
    renderCard();
    expect(await screen.findByText('Getting started')).toBeInTheDocument();
    expect(screen.getByText('Build a watchlist')).toBeInTheDocument();
    expect(screen.getByText('Log your first trade')).toBeInTheDocument();
    expect(screen.getByText('0/4')).toBeInTheDocument();
  });

  it('renders nothing once every step is done', async () => {
    mockState({ watch: 1, positions: 1, snaps: 1, alerts: 1 });
    renderCard();
    await waitFor(() => expect(client.alerts).toHaveBeenCalled());
    expect(screen.queryByText('Getting started')).toBeNull();
  });

  it('stays hidden when previously dismissed', async () => {
    localStorage.setItem('onboarding.dismissed', 'true');
    mockState({ watch: 0, positions: 0, snaps: 0, alerts: 0 });
    renderCard();
    await waitFor(() => expect(screen.queryByText('Getting started')).toBeNull());
    expect(client.watchlist).not.toHaveBeenCalled();
  });
});

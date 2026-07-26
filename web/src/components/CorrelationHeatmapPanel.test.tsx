import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CorrelationHeatmapPanel } from './CorrelationHeatmapPanel';
import { client } from '../api/client';
import type { PortfolioCorrelation } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(overrides: Partial<PortfolioCorrelation> = {}): PortfolioCorrelation {
  return {
    symbols: ['AAPL', 'MSFT'],
    matrix: [
      [1, 0.82],
      [0.82, 1],
    ],
    topPair: { a: 'AAPL', b: 'MSFT', r: 0.82 },
    unresolved: [],
    omitted: [],
    lookbackDays: 30,
    ...overrides,
  };
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'Correlation heatmap' }));
}

describe('CorrelationHeatmapPanel', () => {
  it('fetches nothing while collapsed (its default state)', () => {
    const spy = vi.spyOn(client, 'portfolioCorrelation');
    render(<CorrelationHeatmapPanel />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders the most-correlated pair and grid once expanded', async () => {
    vi.spyOn(client, 'portfolioCorrelation').mockResolvedValue(fixture());
    render(<CorrelationHeatmapPanel />);
    expand();
    expect(await screen.findByText('AAPL / MSFT')).toBeInTheDocument();
    expect(screen.getByText('+0.82')).toBeInTheDocument();
    expect(screen.getByText(/effectively one bet/)).toBeInTheDocument(); // r >= 0.7
  });

  it('shows an empty state when there are no open positions', async () => {
    vi.spyOn(client, 'portfolioCorrelation').mockResolvedValue(fixture({ symbols: [], matrix: [], topPair: null }));
    render(<CorrelationHeatmapPanel />);
    expand();
    expect(await screen.findByText('No open positions to correlate')).toBeInTheDocument();
  });

  it('asks for more history when fewer than two names resolve', async () => {
    vi.spyOn(client, 'portfolioCorrelation').mockResolvedValue(
      fixture({
        symbols: ['AAPL', 'GONE'],
        matrix: [
          [1, null],
          [null, null],
        ],
        topPair: null,
        unresolved: ['GONE'],
        omitted: [],
      }),
    );
    render(<CorrelationHeatmapPanel />);
    expand();
    expect(await screen.findByText('Not enough price history to correlate')).toBeInTheDocument();
  });

  it('lists symbols excluded for lack of history', async () => {
    vi.spyOn(client, 'portfolioCorrelation').mockResolvedValue(
      fixture({
        symbols: ['AAPL', 'MSFT', 'GONE'],
        matrix: [
          [1, 0.82, null],
          [0.82, 1, null],
          [null, null, null],
        ],
        unresolved: ['GONE'],
        omitted: [],
      }),
    );
    render(<CorrelationHeatmapPanel />);
    expand();
    expect(await screen.findByText(/Excluded \(no fetchable history\): GONE/)).toBeInTheDocument();
  });

  it('shows an error state with a retry that re-fetches', async () => {
    const spy = vi
      .spyOn(client, 'portfolioCorrelation')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fixture());
    render(<CorrelationHeatmapPanel />);
    expand();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('AAPL / MSFT')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

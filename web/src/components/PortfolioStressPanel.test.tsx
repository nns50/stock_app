import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PortfolioStressPanel } from './PortfolioStressPanel';
import { client } from '../api/client';
import type { StressResult } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function stressFixture(overrides: Partial<StressResult> = {}): StressResult {
  return {
    scenarios: [-10, -5, -2, 0, 2, 5, 10].map((pct) => ({ pct, estimatedPnl: pct * 15 })),
    netDollarDeltaPerPct: 15,
    unresolved: [],
    resolvedCount: 1,
    totalCount: 1,
    ...overrides,
  };
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'Market stress test' }));
}

describe('PortfolioStressPanel', () => {
  it('fetches nothing while collapsed (its default state)', () => {
    const spy = vi.spyOn(client, 'portfolioStress');
    render(<PortfolioStressPanel />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches and renders scenario P&L once expanded', async () => {
    vi.spyOn(client, 'portfolioStress').mockResolvedValue(stressFixture());
    render(<PortfolioStressPanel />);
    expand();
    expect(await screen.findByText('+$150')).toBeInTheDocument(); // +10% scenario: 15 * 10
    expect(screen.getByText('-$150')).toBeInTheDocument(); // -10% scenario
    expect(screen.getByText('+$0')).toBeInTheDocument(); // 0% scenario
  });

  it('shows an empty state when there are no open positions', async () => {
    vi.spyOn(client, 'portfolioStress').mockResolvedValue(
      stressFixture({ scenarios: [], netDollarDeltaPerPct: 0, resolvedCount: 0, totalCount: 0 }),
    );
    render(<PortfolioStressPanel />);
    expand();
    expect(await screen.findByText('No open positions to stress test')).toBeInTheDocument();
  });

  it('surfaces excluded positions and why, without hiding the resolved ones', async () => {
    vi.spyOn(client, 'portfolioStress').mockResolvedValue(
      stressFixture({
        resolvedCount: 1,
        totalCount: 2,
        unresolved: [{ positionId: 2, symbol: 'ZZZZ', reason: 'no-beta' }],
      }),
    );
    render(<PortfolioStressPanel />);
    expand();
    expect(await screen.findByText(/1 of 2 open positions included/)).toBeInTheDocument();
    expect(screen.getByText(/ZZZZ/)).toBeInTheDocument();
    expect(screen.getByText(/no beta data/)).toBeInTheDocument();
  });

  it('shows an error state with a retry that re-fetches', async () => {
    const spy = vi
      .spyOn(client, 'portfolioStress')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(stressFixture());
    render(<PortfolioStressPanel />);
    expand();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('+$150')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

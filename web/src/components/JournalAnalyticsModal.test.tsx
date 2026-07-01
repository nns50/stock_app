import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JournalAnalyticsModal } from './JournalAnalyticsModal';
import { client } from '../api/client';

beforeEach(() => vi.restoreAllMocks());

// Excursions, Execution quality, and Risk of ruin used to be three separate
// modals; they're now tabs of one. Pin the tab switch, that each tab lazily
// fetches only once selected, and that closing fetches nothing.
describe('JournalAnalyticsModal', () => {
  it('shows Excursions by default and fetches nothing else', async () => {
    const excSpy = vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 1,
      avgMfeR: 1.2,
      avgMaeR: -0.4,
      avgRealizedR: 0.8,
      capturePct: 60,
      rows: [
        {
          positionId: 1,
          symbol: 'AAPL',
          side: 'long',
          entryDate: '2026-06-01',
          mfePct: 5,
          maePct: -2,
          mfeR: 1.2,
          maeR: -0.4,
          realizedR: 0.8,
          capturedPct: 60,
        },
      ],
    });
    const slipSpy = vi.spyOn(client, 'journalSlippage');
    const statsSpy = vi.spyOn(client, 'journalStats');

    render(<JournalAnalyticsModal open onClose={() => {}} />);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(excSpy).toHaveBeenCalled();
    expect(slipSpy).not.toHaveBeenCalled();
    expect(statsSpy).not.toHaveBeenCalled();
  });

  it('fetches nothing while closed', () => {
    const excSpy = vi.spyOn(client, 'journalExcursions');
    render(<JournalAnalyticsModal open={false} onClose={() => {}} />);
    expect(excSpy).not.toHaveBeenCalled();
  });

  it('switches to Execution quality and fetches slippage data', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
    });
    const slipSpy = vi.spyOn(client, 'journalSlippage').mockResolvedValue({
      trades: 1,
      totalUsd: 0.5,
      avgPct: 5,
      rows: [
        {
          positionId: 1,
          symbol: 'AMC',
          kind: 'entry',
          side: 'buy',
          date: '2026-06-01',
          limitPrice: 2,
          fillPrice: 2.1,
          quantity: 5,
          multiplier: 1,
          perUnit: 0.1,
          totalUsd: 0.5,
          pct: 5,
        },
      ],
    });

    render(<JournalAnalyticsModal open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Execution quality' }));

    expect(await screen.findByText('AMC')).toBeInTheDocument();
    expect(slipSpy).toHaveBeenCalled();
  });

  it('switches to Risk of ruin, seeds from journal stats, and runs a simulation', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
    });
    vi.spyOn(client, 'journalStats').mockResolvedValue({ winRate: 55, kelly: { suggestedRiskPct: 2 } } as never);
    const ruinSpy = vi.spyOn(client, 'riskOfRuin').mockResolvedValue({
      params: {} as never,
      result: {
        riskOfRuinPct: 3,
        medianReturnPct: 12,
        p5ReturnPct: -10,
        p95ReturnPct: 40,
        medianMaxDrawdownPct: 8,
      },
    });

    render(<JournalAnalyticsModal open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Risk of ruin' }));
    await screen.findByDisplayValue('55'); // win rate seeded from stats (default is 50)

    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    expect(await screen.findByText('3.0%')).toBeInTheDocument();
    expect(ruinSpy).toHaveBeenCalled();
  });
});

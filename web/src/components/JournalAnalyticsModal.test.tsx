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
          resolution: 'daily',
        },
      ],
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 1, undated: 0, overCap: 0, unavailable: 0 },
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
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 0, undated: 0, overCap: 0, unavailable: 0 },
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

  it('switches to Stop overrun and fetches the report', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 0, undated: 0, overCap: 0, unavailable: 0 },
    });
    const overrunSpy = vi.spyOn(client, 'journalStopOverrun').mockResolvedValue({
      trades: 1,
      recorded: 0,
      inferred: 1,
      beyondCount: 1,
      beyondPct: 100,
      avgOverrunPct: 2.22,
      medianOverrunPct: 2.22,
      totalUsd: 20,
      avgOverrunR: 0.2,
      bands: [
        { label: '<$5', trades: 0, beyondPct: null, avgOverrunR: null, totalUsd: 0 },
        { label: '$5–15', trades: 1, beyondPct: 100, avgOverrunR: 0.2, totalUsd: 20 },
        { label: '$15–50', trades: 0, beyondPct: null, avgOverrunR: null, totalUsd: 0 },
        { label: '≥$50', trades: 0, beyondPct: null, avgOverrunR: null, totalUsd: 0 },
      ],
      rows: [
        {
          positionId: 1,
          symbol: 'GME',
          side: 'long',
          date: '2026-06-01',
          entryPrice: 10,
          stopPrice: 9,
          exitPrice: 8.8,
          quantity: 100,
          basis: 'inferred',
          overrunPerShare: 0.2,
          overrunPct: 2.22,
          overrunR: 0.2,
          totalUsd: 20,
        },
      ],
    });

    render(<JournalAnalyticsModal open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Stop overrun' }));

    expect(await screen.findByText('GME')).toBeInTheDocument();
    expect(await screen.findByText(/inferred from a\s+reasonless exit/i)).toBeInTheDocument();
    expect(overrunSpy).toHaveBeenCalled();
  });

  it('switches to Risk of ruin, seeds from journal stats, and runs a simulation', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 0, undated: 0, overCap: 0, unavailable: 0 },
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

// The excursion panel fetches candles per trade, so it caps the work and can miss
// data. Both used to be invisible: `trades` counts only successes, so averages
// over a fraction of the book were indistinguishable from complete ones.
describe('JournalAnalyticsModal — excursion coverage', () => {
  const row = {
    positionId: 1,
    symbol: 'AAPL',
    side: 'long' as const,
    entryDate: '2026-06-01',
    mfePct: 5,
    maePct: -2,
    mfeR: 1.2,
    maeR: -0.4,
    realizedR: 0.8,
    capturedPct: 60,
    resolution: 'daily' as const,
  };

  it('says the averages are a sample when trades were excluded', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 1,
      avgMfeR: 1.2,
      avgMaeR: -0.4,
      avgRealizedR: 0.8,
      capturePct: 60,
      rows: [row],
      resolutionMix: { intraday: 0, daily: 1 },
      coverage: { closedStockTrades: 70, undated: 4, overCap: 16, unavailable: 49 },
    });
    render(<JournalAnalyticsModal open onClose={() => {}} />);
    expect(await screen.findByText(/Averages over 1 of 70 closed stock trades/)).toBeInTheDocument();
    expect(screen.getByText(/4 have no entry date/)).toBeInTheDocument();
    expect(screen.getByText(/49 had no candle data/)).toBeInTheDocument();
    expect(screen.getByText(/16 beyond this request's cap/)).toBeInTheDocument();
  });

  it('stays quiet when it covered everything', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 1,
      avgMfeR: 1.2,
      avgMaeR: -0.4,
      avgRealizedR: 0.8,
      capturePct: 60,
      rows: [row],
      resolutionMix: { intraday: 0, daily: 1 },
      coverage: { closedStockTrades: 1, undated: 0, overCap: 0, unavailable: 0 },
    });
    render(<JournalAnalyticsModal open onClose={() => {}} />);
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText(/Averages over/)).not.toBeInTheDocument();
  });

  it('does not claim you have no closed stock trades when it just could not measure them', async () => {
    // The empty-state version of the same lie: trades exist, none was analysable.
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 12, undated: 3, overCap: 0, unavailable: 9 },
    });
    render(<JournalAnalyticsModal open onClose={() => {}} />);
    expect(await screen.findByText(/Nothing could be measured/)).toBeInTheDocument();
    expect(screen.getByText(/3 without an entry date/)).toBeInTheDocument();
    expect(screen.getByText(/9 with no candle data available/)).toBeInTheDocument();
    expect(screen.queryByText(/No closed stock trades to analyze/)).not.toBeInTheDocument();
  });

  it('still says "no closed stock trades" when there genuinely are none', async () => {
    vi.spyOn(client, 'journalExcursions').mockResolvedValue({
      trades: 0,
      avgMfeR: null,
      avgMaeR: null,
      avgRealizedR: null,
      capturePct: null,
      rows: [],
      resolutionMix: { intraday: 0, daily: 0 },
      coverage: { closedStockTrades: 0, undated: 0, overCap: 0, unavailable: 0 },
    });
    render(<JournalAnalyticsModal open onClose={() => {}} />);
    expect(await screen.findByText(/No closed stock trades to analyze/)).toBeInTheDocument();
  });
});

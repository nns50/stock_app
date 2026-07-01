import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SlippageModal } from './SlippageModal';
import { client } from '../api/client';

beforeEach(() => vi.restoreAllMocks());

describe('SlippageModal', () => {
  it('shows total slippage and a worst-first row table', async () => {
    vi.spyOn(client, 'journalSlippage').mockResolvedValue({
      trades: 2,
      totalUsd: 0.6,
      avgPct: 3,
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
        {
          positionId: 2,
          symbol: 'NVDA',
          kind: 'exit',
          side: 'sell',
          date: '2026-06-05',
          limitPrice: 100,
          fillPrice: 99,
          quantity: 1,
          multiplier: 1,
          perUnit: 1,
          totalUsd: 0.1,
          pct: 1,
        },
      ],
    });

    render(<SlippageModal open onClose={() => {}} />);

    expect(await screen.findByText('Execution quality (slippage)')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // fills with data
    expect(screen.getByText('AMC')).toBeInTheDocument();
    expect(screen.getByText('NVDA')).toBeInTheDocument();
  });

  it('shows an empty state explaining the scope when there is no data', async () => {
    vi.spyOn(client, 'journalSlippage').mockResolvedValue({ trades: 0, totalUsd: 0, avgPct: null, rows: [] });
    render(<SlippageModal open onClose={() => {}} />);
    expect(await screen.findByText('No live fills to analyze yet')).toBeInTheDocument();
    expect(screen.getByText(/limit/i)).toBeInTheDocument();
  });

  it('fetches nothing while closed', () => {
    const spy = vi.spyOn(client, 'journalSlippage');
    render(<SlippageModal open={false} onClose={() => {}} />);
    expect(spy).not.toHaveBeenCalled();
  });
});

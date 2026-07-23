import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RollAnalyzer } from './RollAnalyzer';
import { client } from '../api/client';
import type { RollAnalysis } from '../api/types';

beforeEach(() => vi.restoreAllMocks());

function rollFixture(overrides: Partial<RollAnalysis> = {}): RollAnalysis {
  return {
    netCost: -100,
    current: {
      breakevens: [103],
      maxProfit: null,
      maxLoss: -300,
      probabilityOfProfit: 0.4,
      expectedValue: -20,
      delta: 0.5,
    },
    target: {
      breakevens: [109],
      maxProfit: null,
      maxLoss: -400,
      probabilityOfProfit: 0.45,
      expectedValue: -5,
      delta: 0.55,
    },
    breakevenShift: 6,
    probabilityOfProfitShift: 0.05,
    expectedValueShift: 15,
    ...overrides,
  };
}

describe('RollAnalyzer', () => {
  it('prompts to fill in the form before any result exists', () => {
    render(<RollAnalyzer />);
    expect(screen.getByText(/Fill in the position you hold/)).toBeInTheDocument();
  });

  it('sends the form as analyzeRoll and renders the comparison', async () => {
    const spy = vi.spyOn(client, 'analyzeRoll').mockResolvedValue(rollFixture());
    render(<RollAnalyzer />);

    fireEvent.change(screen.getByLabelText('Side'), { target: { value: 'long' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Underlying $'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze roll' }));

    expect(await screen.findByText('Net debit to roll')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('After the roll')).toBeInTheDocument(); // only the results panel uses this title
    expect(screen.getByText('$103.00')).toBeInTheDocument(); // current breakeven
    expect(screen.getByText('$109.00')).toBeInTheDocument(); // target breakeven

    expect(spy).toHaveBeenCalledWith({
      side: 'long',
      quantity: 1,
      underlyingPrice: 100,
      current: { optionType: 'call', strike: 100, dte: 10, premium: 3 },
      target: { optionType: 'call', strike: 105, dte: 40, premium: 4 },
    });
  });

  it('shows a credit (not debit) when netCost is positive', async () => {
    vi.spyOn(client, 'analyzeRoll').mockResolvedValue(rollFixture({ netCost: 60 }));
    render(<RollAnalyzer />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze roll' }));
    expect(await screen.findByText('Net credit to roll')).toBeInTheDocument();
  });

  it('shows an error state with a retry that re-fetches', async () => {
    const spy = vi
      .spyOn(client, 'analyzeRoll')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(rollFixture());
    render(<RollAnalyzer />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze roll' }));
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Net debit to roll')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('renders null probability/expected-value fields as em-dashes, not crashes', async () => {
    vi.spyOn(client, 'analyzeRoll').mockResolvedValue(
      rollFixture({
        breakevenShift: null,
        probabilityOfProfitShift: null,
        expectedValueShift: null,
        current: { ...rollFixture().current, probabilityOfProfit: null, expectedValue: null },
      }),
    );
    render(<RollAnalyzer />);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze roll' }));
    await screen.findByText('Net debit to roll');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

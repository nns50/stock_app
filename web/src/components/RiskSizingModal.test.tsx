import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskSizingModal } from './RiskSizingModal';
import { client } from '../api/client';

beforeEach(() => vi.restoreAllMocks());

// The calculator gained a "Vertical spread" mode that sizes by capped max loss
// (no price stop) via /tools/spread-size. Pin the mode switch + the call shape.
describe('RiskSizingModal — defined-risk spread mode', () => {
  it('switches to spread inputs and sizes by max loss', async () => {
    const spy = vi.spyOn(client, 'spreadSize').mockResolvedValue({
      maxRiskDollars: 500,
      maxLossPerSpread: 200,
      maxProfitPerSpread: 300,
      suggestedContracts: 2,
      totalMaxLoss: 400,
      totalMaxProfit: 600,
      positionPctOfAccount: 4,
      rewardRiskRatio: 1.5,
      warnings: [],
    });

    render(<RiskSizingModal open onClose={() => {}} />);

    // Stop-based fields are shown for a stock; switching to a spread replaces them.
    expect(screen.getByLabelText('Entry')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'spread' } });
    expect(screen.queryByLabelText('Entry')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Width (strike gap)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Net debit'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));

    // The spread result panel renders (defaults: $25k account, 1% risk).
    expect(await screen.findByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('spreads')).toBeInTheDocument();
    expect(screen.getByText('Reward : risk')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({
      accountSize: 25000,
      riskPct: 1,
      width: 5,
      netPremium: 2,
      direction: 'debit',
    });
  });
});

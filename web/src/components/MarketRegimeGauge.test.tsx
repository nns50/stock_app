import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketRegimeGauge } from './MarketRegimeGauge';
import { client } from '../api/client';
import type { MarketRegime } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(overrides: Partial<MarketRegime> = {}): MarketRegime {
  return {
    proxySymbol: 'SPY',
    label: 'risk-on',
    score: 3,
    resolvedComponents: 4,
    components: [
      {
        key: 'trend200',
        label: 'Primary trend (200-day)',
        signal: 'risk-on',
        value: 4.2,
        detail: 'SPY is 4.2% above its 200-day average',
      },
      {
        key: 'trend50',
        label: 'Intermediate trend (50-day)',
        signal: 'risk-on',
        value: 2.1,
        detail: 'SPY is 2.1% above its 50-day average',
      },
      {
        key: 'breadth',
        label: 'Breadth (% above 50-day)',
        signal: 'neutral',
        value: 52,
        detail: '52% of 100 names are above their own 50-day average',
      },
      {
        key: 'volatility',
        label: 'Volatility (proxy ATR%)',
        signal: 'risk-on',
        value: 1.4,
        detail: 'SPY ATR is 1.4% of price',
      },
    ],
    breadthPct: 52,
    breadthSampleSize: 100,
    marketAtrPct: 1.4,
    asOf: 1_700_000_000_000,
    ...overrides,
  };
}

describe('MarketRegimeGauge', () => {
  it('renders the overall regime label and each component read', async () => {
    vi.spyOn(client, 'marketRegime').mockResolvedValue(fixture());
    render(<MarketRegimeGauge />);
    expect(await screen.findByText('Risk-on')).toBeInTheDocument();
    expect(screen.getByText('Primary trend (200-day)')).toBeInTheDocument();
    expect(screen.getByText(/4.2% above its 200-day average/)).toBeInTheDocument();
    expect(screen.getByText(/52% of 100 names/)).toBeInTheDocument();
    expect(screen.getByText(/4 of 4 signals resolved/)).toBeInTheDocument();
  });

  it('labels an unresolved component as "no data" rather than inventing a read', async () => {
    vi.spyOn(client, 'marketRegime').mockResolvedValue(
      fixture({
        label: 'neutral',
        score: 0,
        resolvedComponents: 3,
        components: [
          {
            key: 'trend200',
            label: 'Primary trend (200-day)',
            signal: 'neutral',
            value: 0.2,
            detail: 'SPY is 0.2% above its 200-day average',
          },
          {
            key: 'trend50',
            label: 'Intermediate trend (50-day)',
            signal: 'neutral',
            value: -0.1,
            detail: 'SPY is 0.1% below its 50-day average',
          },
          {
            key: 'breadth',
            label: 'Breadth (% above 50-day)',
            signal: 'unknown',
            value: null,
            detail: 'No universe history available for a breadth read',
          },
          {
            key: 'volatility',
            label: 'Volatility (proxy ATR%)',
            signal: 'neutral',
            value: 3,
            detail: 'SPY ATR is 3.0% of price',
          },
        ],
        breadthPct: null,
        breadthSampleSize: 0,
      }),
    );
    render(<MarketRegimeGauge />);
    expect(await screen.findByText('Neutral')).toBeInTheDocument();
    expect(screen.getByText('no data')).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 signals resolved/)).toBeInTheDocument();
  });

  it('makes clear it is context, not a trade signal', async () => {
    vi.spyOn(client, 'marketRegime').mockResolvedValue(fixture());
    render(<MarketRegimeGauge />);
    expect(await screen.findByText(/Context, not a signal/)).toBeInTheDocument();
  });

  it('shows an error state with a retry that re-fetches', async () => {
    const spy = vi
      .spyOn(client, 'marketRegime')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fixture());
    render(<MarketRegimeGauge />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Risk-on')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

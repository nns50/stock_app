import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketRegimeGauge } from './MarketRegimeGauge';
import { client } from '../api/client';
import type { MarketRegime, MlRegimeReading } from '../api/types';

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

function mlFixture(overrides: Partial<MlRegimeReading> = {}): MlRegimeReading {
  return {
    regime: 'low_vol_bullish',
    label: 'Low Volatility/Bullish',
    candidate: 'low_vol_bullish',
    probabilities: { high_vol_bearish: 0.01, low_vol_bullish: 0.83, sideways: 0.16 },
    predictedNext: { high_vol_bearish: 0.02, low_vol_bullish: 0.81, sideways: 0.17 },
    asOf: '2026-09-03',
    etDate: '2026-09-04',
    features: { ret: 0.0105, vix: 14.3, rv20: 0.0053 },
    source: 'fred',
    stale: false,
    drift: false,
    driftScore: -1.4,
    driftP5: -4.7,
    modelVersion: '2026.09.1',
    switched: false,
    heldBelowThreshold: false,
    threshold: 0.6,
    previous: 'low_vol_bullish',
    rows: 250,
    logLikelihood: -71.4,
    computedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// Every test renders both blocks; the ML call is stubbed by default so the
// existing assertions (one retry button, one error) stay about the gauge.
beforeEach(() => {
  vi.spyOn(client, 'marketRegimeMl').mockResolvedValue(mlFixture());
});

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

describe('MarketRegimeGauge — the ML regime block', () => {
  beforeEach(() => {
    vi.spyOn(client, 'marketRegime').mockResolvedValue(fixture());
  });

  it('renders the label in the operator’s words, the probability and the data date', async () => {
    render(<MarketRegimeGauge />);
    expect(await screen.findByText('Low Volatility/Bullish')).toBeInTheDocument();
    expect(screen.getByText('p=0.83')).toBeInTheDocument();
    expect(screen.getByText(/as of 2026-09-03 · fred/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing acts on this reading yet/)).toBeInTheDocument();
  });

  it('a stale reading says so and names what the model would read', async () => {
    vi.spyOn(client, 'marketRegimeMl').mockResolvedValue(
      mlFixture({
        regime: 'unknown',
        label: 'Unknown',
        candidate: 'high_vol_bearish',
        stale: true,
        reason: 'stale',
        asOf: '2026-08-28',
      }),
    );
    render(<MarketRegimeGauge />);
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText(/Stale — data through 2026-08-28/)).toBeInTheDocument();
    expect(screen.getByText(/the model would read High Volatility\/Bearish/)).toBeInTheDocument();
  });

  it('a held reading names the candidate and the threshold', async () => {
    vi.spyOn(client, 'marketRegimeMl').mockResolvedValue(
      mlFixture({
        regime: 'sideways',
        label: 'Sideways',
        candidate: 'high_vol_bearish',
        probabilities: { high_vol_bearish: 0.55, low_vol_bullish: 0.05, sideways: 0.4 },
        heldBelowThreshold: true,
      }),
    );
    render(<MarketRegimeGauge />);
    expect(await screen.findByText('Sideways')).toBeInTheDocument();
    expect(screen.getByText(/Held below 0.6 — the model prefers High Volatility\/Bearish at 0.55/)).toBeInTheDocument();
  });

  it('an unknown reading names its reason, and drift asks for a retrain', async () => {
    vi.spyOn(client, 'marketRegimeMl').mockResolvedValue(
      mlFixture({
        regime: 'unknown',
        label: 'Unknown',
        candidate: 'unknown',
        probabilities: null,
        asOf: null,
        source: 'none',
        reason: 'no_model',
      }),
    );
    const { unmount } = render(<MarketRegimeGauge />);
    expect(await screen.findByText(/Unknown — no model file is shipped/)).toBeInTheDocument();
    expect(screen.queryByText(/^p=/)).not.toBeInTheDocument();
    unmount();
    vi.spyOn(client, 'marketRegimeMl').mockResolvedValue(mlFixture({ drift: true, driftScore: -6.1 }));
    render(<MarketRegimeGauge />);
    expect(await screen.findByText(/Model drift — the tape has left/)).toBeInTheDocument();
  });
});

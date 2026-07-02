import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AutoTradePage from './AutoTradePage';
import { ToastProvider } from '../components/ToastContext';
import { ConfirmProvider } from '../components/ConfirmContext';
import { client } from '../api/client';
import type { AutotradeDecideResponse } from '../api/types';

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AutoTradePage />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'autotradeConfig').mockResolvedValue({ enabled: false, riskProfile: 'MODERATE' });
  vi.spyOn(client, 'autotradeExclusions').mockResolvedValue({
    exclusions: [{ symbol: 'VNQ', reason: 'Real estate ETF', source: 'default', createdAt: Date.now() }],
  });
  vi.spyOn(client, 'autotradeEvents').mockResolvedValue({ events: [] });
});

describe('AutoTradePage', () => {
  it('renders the fetched config and exclusion list', async () => {
    renderPage();
    expect(await screen.findByText('VNQ')).toBeInTheDocument();
    expect(screen.getByText('Real estate ETF')).toBeInTheDocument();
    const checkbox = screen.getByLabelText('Auto-trading enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole('combobox')).toHaveValue('MODERATE');
  });

  it('requires confirmation before switching to AGGRESSIVE, and does not save on cancel', async () => {
    const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({
      enabled: false,
      riskProfile: 'AGGRESSIVE',
    });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AGGRESSIVE' } });
    expect(await screen.findByText('Switch to AGGRESSIVE?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Switch to AGGRESSIVE?')).toBeNull());
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('saves with confirmAggressive: true once the switch is confirmed', async () => {
    const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({
      enabled: false,
      riskProfile: 'AGGRESSIVE',
    });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AGGRESSIVE' } });
    fireEvent.click(await screen.findByText('Switch to Aggressive'));

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ riskProfile: 'AGGRESSIVE', confirmAggressive: true }));
  });

  it('toggling enabled does not prompt for confirmation', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: true, riskProfile: 'MODERATE' });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByLabelText('Auto-trading enabled'));
    expect(screen.queryByText('Switch to AGGRESSIVE?')).toBeNull();
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ enabled: true, confirmAggressive: undefined }));
  });

  it('runs a screen+decide and renders candidates (with signals), exclusions, and skipped symbols', async () => {
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'AAPL',
            price: 210.5,
            total: 82.4,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 210.5,
              changePct: 3.2,
              maShort: 200,
              maLong: 190,
              distShortPct: 5,
              distLongPct: 10,
              rsi: 65,
              atr: 3,
              atrPct: 1.4,
              relVolume: 2.1,
              avgVolume: 1_000_000,
              volume: 2_100_000,
              gapPct: 4.5,
            },
            discoverySource: 'movers',
          },
        ],
        excluded: [{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }],
        skipped: [{ symbol: 'XYZ', reason: 'sector/industry could not be determined this cycle' }],
        errors: [],
        discovery: { universeCount: 124, moversCount: 5, scannedCount: 129 },
      },
      decision: {
        signals: [
          {
            symbol: 'AAPL',
            side: 'buy',
            entry: 210.5,
            stop: 206,
            target: 219.5,
            rMultiple: 2,
            rationale:
              'Long breakout: score 82.4, gap +4.50%, rel vol 2.10×, RSI 65.0 — entry 210.50, stop 206.00 (1.5× ATR), target 219.50 (2R)',
            score: 82.4,
          },
        ],
        skipped: [],
      },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('Candidates (1)')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Excluded — real estate (1)')).toBeInTheDocument();
    expect(screen.getByText('Skipped — unverified sector (1)')).toBeInTheDocument();
    expect(screen.getByText('$206.00')).toBeInTheDocument(); // stop
    expect(screen.getByText('$219.50')).toBeInTheDocument(); // target
    expect(screen.getByText('2R')).toBeInTheDocument();
  });

  it('shows a "no signal" section for decision-skipped candidates', async () => {
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'MU',
            price: 40,
            total: 55,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 40,
              changePct: 1,
              maShort: 39,
              maLong: 38,
              distShortPct: 1,
              distLongPct: 2,
              rsi: 55,
              atr: null,
              atrPct: null,
              relVolume: 1.6,
              avgVolume: 500_000,
              volume: 800_000,
              gapPct: 1,
            },
            discoverySource: 'universe',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 124, moversCount: 0, scannedCount: 124 },
      },
      decision: { signals: [], skipped: [{ symbol: 'MU', reason: 'insufficient volatility history (ATR)' }] },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText(/No signal — insufficient volatility history \(1\)/)).toBeInTheDocument();
  });
});

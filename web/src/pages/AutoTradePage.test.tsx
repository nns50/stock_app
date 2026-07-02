import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AutoTradePage from './AutoTradePage';
import { ToastProvider } from '../components/ToastContext';
import { ConfirmProvider } from '../components/ConfirmContext';
import { client } from '../api/client';
import type { AutotradeScreenResult } from '../api/types';

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

  it('runs a screen and renders candidates, exclusions, and skipped symbols', async () => {
    const result: AutotradeScreenResult = {
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
    };
    vi.spyOn(client, 'runAutotradeScreen').mockResolvedValue(result);
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('Candidates (1)')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Excluded — real estate (1)')).toBeInTheDocument();
    expect(screen.getByText('Skipped — unverified sector (1)')).toBeInTheDocument();
  });
});

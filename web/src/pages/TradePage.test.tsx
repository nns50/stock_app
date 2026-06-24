import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TradePage from './TradePage';
import { client } from '../api/client';

const config = {
  enabled: false,
  killSwitch: false,
  maxOrderUsd: 500,
  maxSymbolPositionQty: 100,
  maxExposureUsd: 2000,
  maxOrdersPerDay: 10,
  maxDailyLossUsd: 200,
  fatFingerPct: 20,
  allowNakedShort: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'tradeConfig').mockResolvedValue(config as never);
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TradePage />
    </MemoryRouter>,
  );

describe('TradePage', () => {
  it('renders the dry-run workspace, sandbox banner, and config panel', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Trade (dry-run)' })).toBeInTheDocument();
    expect(screen.getByText(/Dry-run sandbox/)).toBeInTheDocument();
    expect(await screen.findByText('Guardrail config')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dry-run order/ })).toBeInTheDocument();
  });

  it('runs a dry-run and shows the would-submit result with the guardrail breakdown', async () => {
    const dry = vi.spyOn(client, 'dryRunOrder').mockResolvedValue({
      intent: { id: 1, state: 'validated', symbol: 'AAPL' },
      guardrails: {
        ok: true,
        checks: [{ rule: 'trading_enabled', passed: true, severity: 'block', detail: 'enabled' }],
      },
      wouldSubmit: true,
      notional: 1000,
      summary: 'DRY RUN — would submit BUY 10 AAPL limit 100 ($1,000)',
    } as never);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Dry-run order/ }));

    expect(await screen.findByText('would submit')).toBeInTheDocument();
    expect(dry).toHaveBeenCalled();
    expect(screen.getByText(/trading_enabled/)).toBeInTheDocument();
  });
});

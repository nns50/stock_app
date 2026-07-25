import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from './SettingsPage';
import { ToastProvider } from '../components/ToastContext';
import { ProviderProvider } from '../components/ProviderContext';
import { AlertsProvider } from '../components/AlertsContext';
import { client } from '../api/client';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(client, 'provider').mockResolvedValue({
    name: 'Mock',
    synthetic: true,
    configured: true,
    capabilities: { quotes: true, candles: true, options: false, fundamentals: false },
  } as never);
  vi.spyOn(client, 'settings').mockResolvedValue({} as never);
  vi.spyOn(client, 'alerts').mockResolvedValue({ alerts: [] } as never);
  vi.spyOn(client, 'notifications').mockResolvedValue({
    channels: [],
    configured: false,
    scheduler: { enabled: false, intervalSeconds: 60 },
  } as never);
  vi.spyOn(client, 'webullStatus').mockResolvedValue({
    configured: false,
    region: 'us',
    hasAccessToken: false,
  } as never);
  vi.spyOn(client, 'webullSyncSchedulerStatus').mockResolvedValue({
    enabled: true,
    intervalSeconds: 300,
    accountIds: [],
  } as never);
});

function renderPage() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ProviderProvider>
          <AlertsProvider>
            <SettingsPage />
          </AlertsProvider>
        </ProviderProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  it('renders the consolidated settings sections', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Market data provider')).toBeInTheDocument();
    expect(screen.getByText('Benchmark')).toBeInTheDocument();
    expect(screen.getByText('Pre-trade checklist')).toBeInTheDocument();
    // Benchmark defaults to SPY when unset.
    expect(screen.getByDisplayValue('SPY')).toBeInTheDocument();
  });

  it('loads the saved checklist rules into the editor', async () => {
    vi.spyOn(client, 'settings').mockResolvedValue({ pretradeChecklist: ['Rule one', 'Rule two'] } as never);
    renderPage();
    const editor = await screen.findByPlaceholderText('One rule per line');
    expect(editor).toHaveValue('Rule one\nRule two');
  });

  it('renders the server-side watching (background poller) section', async () => {
    renderPage();
    expect(await screen.findByText('Server-side watching')).toBeInTheDocument();
    expect(screen.getByText('Enable the background alert poller')).toBeInTheDocument();
    // No webhook configured in the mock → the test button is disabled.
    expect(screen.getByRole('button', { name: 'Send test notification' })).toBeDisabled();
  });

  it('loads the persisted Webull sync schedule (multiple accounts) into the controls', async () => {
    vi.spyOn(client, 'webullSyncSchedulerStatus').mockResolvedValue({
      enabled: false,
      intervalSeconds: 900,
      accountIds: ['CASH42', 'MARGIN99'],
    } as never);
    renderPage();
    // Both accounts land in the comma-separated auto-sync field (findByDisplayValue
    // waits for the async scheduler load to populate it).
    await screen.findByDisplayValue('CASH42, MARGIN99');
    expect(screen.getByRole('checkbox', { name: /Sync automatically in the background/ })).not.toBeChecked();
    expect(screen.getByLabelText('Sync interval')).toHaveValue('900');
  });

  it('saves the account list when the auto-sync accounts field is edited', async () => {
    // Seed values distinct from the field's own initial empty state, so waiting for
    // the joined pair below proves the async scheduler load actually landed — the
    // default mock (enabled: true, accountIds: []) is indistinguishable from the
    // pre-load state, so a checkbox-checked or empty-field wait would be a no-op
    // guard. A single seed account won't do either: the first account also seeds
    // the separate manual "Account ID" field, so its display value would be
    // ambiguous between the two inputs — two accounts makes the auto-sync field's
    // comma-joined value distinct from the manual field's single-account value.
    vi.spyOn(client, 'webullSyncSchedulerStatus').mockResolvedValue({
      enabled: true,
      intervalSeconds: 300,
      accountIds: ['SEED1', 'SEED2'],
    } as never);
    const setScheduler = vi
      .spyOn(client, 'setWebullSyncScheduler')
      .mockResolvedValue({ enabled: true, intervalSeconds: 300, accountIds: ['CASH', 'MARGIN'] } as never);
    renderPage();
    const field = await screen.findByDisplayValue('SEED1, SEED2');
    fireEvent.change(field, { target: { value: 'CASH, MARGIN , CASH' } });
    fireEvent.blur(field);
    // Trimmed + de-duplicated before saving.
    expect(setScheduler).toHaveBeenCalledWith({ accountIds: ['CASH', 'MARGIN'] });
  });

  it('saves a scheduler patch when the automatic-sync checkbox is toggled', async () => {
    const setScheduler = vi
      .spyOn(client, 'setWebullSyncScheduler')
      .mockResolvedValue({ enabled: false, intervalSeconds: 300, accountIds: [] } as never);
    renderPage();
    const checkbox = await screen.findByRole('checkbox', { name: /Sync automatically in the background/ });
    expect(checkbox).toBeChecked(); // default mock: enabled true
    fireEvent.click(checkbox);
    expect(setScheduler).toHaveBeenCalledWith({ enabled: false });
  });

  it('"Sync now" reports what changed, including reconciled orders and closed positions', async () => {
    vi.spyOn(client, 'webullStatus').mockResolvedValue({
      configured: true,
      region: 'us',
      hasAccessToken: false,
    } as never);
    const sync = vi.spyOn(client, 'webullPositionsSync').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      ordersReconciled: 3,
      ordersChanged: 1,
      closed: 2,
      closedSymbols: ['VRAX', 'WRAP'],
      imported: 1,
      skipped: 0,
      unmapped: 0,
    } as never);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('account_id'), { target: { value: 'ACC1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText(/1 order updated/)).toBeInTheDocument();
    expect(screen.getByText(/closed 2 \(VRAX, WRAP\)/)).toBeInTheDocument();
    expect(screen.getByText(/imported 1/)).toBeInTheDocument();
    expect(sync).toHaveBeenCalledWith('ACC1');
  });

  it('"Compare against broker" shows a read-only match/mismatch table without writing anything', async () => {
    vi.spyOn(client, 'webullStatus').mockResolvedValue({
      configured: true,
      region: 'us',
      hasAccessToken: false,
    } as never);
    const compare = vi.spyOn(client, 'webullPositionsCompare').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      rows: [
        {
          symbol: 'AAPL',
          assetType: 'stock',
          optionType: null,
          strike: null,
          expiration: null,
          brokerQty: 10,
          journalQty: 10,
          matches: true,
        },
        {
          symbol: 'CJMB',
          assetType: 'stock',
          optionType: null,
          strike: null,
          expiration: null,
          brokerQty: 356,
          journalQty: 427,
          matches: false,
        },
      ],
    } as never);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('account_id'), { target: { value: 'ACC1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare against broker' }));

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('CJMB')).toBeInTheDocument();
    expect(screen.getByText('match')).toBeInTheDocument();
    expect(screen.getByText('mismatch')).toBeInTheDocument();
    expect(compare).toHaveBeenCalledWith('ACC1');
  });

  it('"Compare against broker" surfaces an error without a table', async () => {
    vi.spyOn(client, 'webullStatus').mockResolvedValue({
      configured: true,
      region: 'us',
      hasAccessToken: false,
    } as never);
    vi.spyOn(client, 'webullPositionsCompare').mockResolvedValue({
      ok: false,
      accountId: 'ACC1',
      rows: [],
      error: 'Webull is not configured.',
    } as never);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('account_id'), { target: { value: 'ACC1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare against broker' }));

    expect(await screen.findByText(/Webull is not configured/)).toBeInTheDocument();
  });

  it('Preview surfaces how many unmapped rows looked like options, with their field names', async () => {
    vi.spyOn(client, 'webullStatus').mockResolvedValue({
      configured: true,
      region: 'us',
      hasAccessToken: false,
    } as never);
    vi.spyOn(client, 'webullPositionsPreview').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      positions: [],
      raw: [{ symbol: 'TSLA', asset_type: 'OPTION', option_type: 'CALL', strike: '400' }],
      unmapped: 1,
      unmappedOptions: 1,
      unmappedSample: [{ keys: ['symbol', 'asset_type', 'option_type', 'strike'], looksLikeOption: true }],
    } as never);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('account_id'), { target: { value: 'ACC1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/1 of them option-like/)).toBeInTheDocument();
  });
});

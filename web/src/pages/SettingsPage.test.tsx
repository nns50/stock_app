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
    accountId: null,
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

  it('loads the persisted Webull sync schedule into the controls', async () => {
    vi.spyOn(client, 'webullSyncSchedulerStatus').mockResolvedValue({
      enabled: false,
      intervalSeconds: 900,
      accountId: 'ACC42',
    } as never);
    renderPage();
    expect(await screen.findByDisplayValue('ACC42')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Sync automatically in the background/ })).not.toBeChecked();
    expect(screen.getByLabelText('Sync interval')).toHaveValue('900');
  });

  it('saves a scheduler patch when the automatic-sync checkbox is toggled', async () => {
    const setScheduler = vi
      .spyOn(client, 'setWebullSyncScheduler')
      .mockResolvedValue({ enabled: false, intervalSeconds: 300, accountId: null } as never);
    renderPage();
    const checkbox = await screen.findByRole('checkbox', { name: /Sync automatically in the background/ });
    expect(checkbox).toBeChecked(); // default mock: enabled true
    fireEvent.click(checkbox);
    expect(setScheduler).toHaveBeenCalledWith({ enabled: false, accountId: undefined });
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
});

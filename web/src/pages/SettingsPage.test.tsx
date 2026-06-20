import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});

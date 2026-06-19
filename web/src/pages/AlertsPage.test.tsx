import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AlertsPage from './AlertsPage';
import { ToastProvider } from '../components/ToastContext';
import { AlertsProvider } from '../components/AlertsContext';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'alerts').mockResolvedValue({ alerts: [] } as never);
});

function renderPage(entries?: object[]) {
  return render(
    <MemoryRouter initialEntries={entries as never}>
      <ToastProvider>
        <AlertsProvider>
          <AlertsPage />
        </AlertsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('AlertsPage', () => {
  it('renders the New alert form in stock mode by default', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'New alert' })).toBeInTheDocument();
    // Option-only fields are hidden until you switch modes.
    expect(screen.queryByText('Entry plan')).toBeNull();
  });

  it('reveals option-contract fields and a trade plan in option mode', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'New alert' });
    fireEvent.click(screen.getByRole('tab', { name: 'Option' }));
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByText('Expiration')).toBeInTheDocument();
    expect(screen.getByText('Entry plan')).toBeInTheDocument();
    expect(screen.getByText('Exit plan')).toBeInTheDocument();
  });

  it('posts an option entry alert with the contract + plan', async () => {
    const createAlert = vi.spyOn(client, 'createAlert').mockResolvedValue({} as never);
    renderPage();
    await screen.findByRole('heading', { name: 'New alert' });
    fireEvent.click(screen.getByRole('tab', { name: 'Option' }));

    fireEvent.change(screen.getByPlaceholderText('AAPL'), { target: { value: 'aapl' } });
    fireEvent.change(screen.getByPlaceholderText('150'), { target: { value: '150' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. break & hold over 150 on rising rel-vol'), {
      target: { value: 'breakout' },
    });
    // Expiration is a date input; set it directly.
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-07-17' } });
    // Threshold (the only step=0.01 number input).
    const threshold = document.querySelector('input[type="number"][step="0.01"]') as HTMLInputElement;
    fireEvent.change(threshold, { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add alert' }));

    await waitFor(() => expect(createAlert).toHaveBeenCalledTimes(1));
    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'AAPL',
        assetType: 'option',
        optionType: 'call',
        strike: 150,
        expiration: '2026-07-17',
        role: 'entry',
        plan: expect.objectContaining({ entry: 'breakout' }),
      }),
    );
  });

  it('prefills the option form from an Entry-scan preset in router state', async () => {
    const preset = {
      symbol: 'TSLA',
      optionType: 'put',
      strike: 250,
      expiration: '2026-08-21',
      role: 'entry',
      kind: 'price',
      operator: 'below',
      threshold: 248.5,
      entryPlan: 'Long put 250 (30d) · |Δ| 0.45',
    };
    renderPage([{ pathname: '/alerts', state: { presetAlert: preset } }]);
    await screen.findByRole('heading', { name: 'New alert' });
    // Switched into option mode and prefilled the contract + plan.
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('AAPL')).toHaveValue('TSLA');
    expect((document.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-08-21');
    expect(screen.getByPlaceholderText('e.g. break & hold over 150 on rising rel-vol')).toHaveValue(
      'Long put 250 (30d) · |Δ| 0.45',
    );
  });
});

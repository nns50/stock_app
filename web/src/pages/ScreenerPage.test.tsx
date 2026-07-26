import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScreenerPage from './ScreenerPage';
import { client } from '../api/client';
import type { ScreenerConfig, ScreenerResult } from '../api/types';

beforeEach(() => {
  vi.restoreAllMocks();
  // Pending promises keep the page in its initial loading state — enough to
  // prove it mounts and renders without throwing.
  const pending = () => new Promise(() => {}) as never;
  vi.spyOn(client, 'screenerDefault').mockImplementation(pending);
  vi.spyOn(client, 'settings').mockImplementation(pending);
  vi.spyOn(client, 'presets').mockImplementation(pending);
  vi.spyOn(client, 'universe').mockImplementation(pending);
});

describe('ScreenerPage', () => {
  it('mounts and shows its loading state without crashing', () => {
    render(
      <MemoryRouter>
        <ScreenerPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Loading screener/)).toBeInTheDocument();
  });

  describe('weekly trend alignment filter (2026-07-16)', () => {
    function defaultConfigFixture(overrides: Partial<ScreenerConfig> = {}): ScreenerConfig {
      return {
        direction: 'long',
        weights: { momentum: 30, relativeVolume: 20, rsi: 15, volatility: 10, gap: 10, trend: 15 },
        maShort: 20,
        maLong: 50,
        rsiPeriod: 14,
        atrPeriod: 14,
        momentumScale: 5,
        relVolTarget: 2,
        rsiSweetSpot: 60,
        rsiWidth: 25,
        atrPctScale: 5,
        gapScale: 3,
        filters: { minPrice: 1, minAvgVolume: 200_000 },
        ...overrides,
      };
    }

    // Overrides this file's own pending-forever defaults (above) with
    // actually-resolved data, scoped to just this describe block — the page
    // gates its whole form behind `defaults.loading || settings.loading ||
    // !cfg` (ScreenerPage.tsx), so reaching the filter checkbox at all needs
    // both of those to resolve.
    function renderLoaded() {
      vi.spyOn(client, 'screenerDefault').mockResolvedValue(defaultConfigFixture());
      vi.spyOn(client, 'settings').mockResolvedValue({});
      vi.spyOn(client, 'presets').mockResolvedValue({ presets: [] });
      vi.spyOn(client, 'universe').mockResolvedValue({ symbols: [] });
      return render(
        <MemoryRouter>
          <ScreenerPage />
        </MemoryRouter>,
      );
    }

    function screenResultFixture(config: ScreenerConfig): ScreenerResult {
      return {
        generatedAt: Date.now(),
        provider: { name: 'mock', synthetic: true },
        config,
        universeCount: 0,
        scannedCount: 0,
        quoteWarmup: false,
        results: [],
        filteredOut: [],
        errors: [],
      };
    }

    it('renders unchecked by default (matches the server default of no filter)', async () => {
      renderLoaded();
      const checkbox = (await screen.findByLabelText('Require weekly trend alignment')) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it('toggling it on includes requireWeeklyTrendAlignment: true in the next screen run', async () => {
      const runScreener = vi
        .spyOn(client, 'runScreener')
        .mockImplementation(async (body) =>
          screenResultFixture({ ...defaultConfigFixture(), ...body.config } as ScreenerConfig),
        );
      renderLoaded();

      const checkbox = (await screen.findByLabelText('Require weekly trend alignment')) as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);

      fireEvent.click(screen.getAllByRole('button', { name: 'Run screener' })[0]);

      await waitFor(() => expect(runScreener).toHaveBeenCalled());
      const payload = runScreener.mock.calls[0][0];
      expect(payload.config?.filters?.requireWeeklyTrendAlignment).toBe(true);
    });

    it('leaving it off does NOT include the filter in the screen run (isolates the toggle above)', async () => {
      const runScreener = vi
        .spyOn(client, 'runScreener')
        .mockImplementation(async (body) =>
          screenResultFixture({ ...defaultConfigFixture(), ...body.config } as ScreenerConfig),
        );
      renderLoaded();

      await screen.findByLabelText('Require weekly trend alignment');
      fireEvent.click(screen.getAllByRole('button', { name: 'Run screener' })[0]);

      await waitFor(() => expect(runScreener).toHaveBeenCalled());
      const payload = runScreener.mock.calls[0][0];
      expect(payload.config?.filters?.requireWeeklyTrendAlignment).toBeFalsy();
    });
  });
});

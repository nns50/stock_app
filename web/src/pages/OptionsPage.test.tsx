import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OptionsPage from './OptionsPage';
import { ProviderProvider } from '../components/ProviderContext';
import { client } from '../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'provider').mockResolvedValue({
    name: 'Mock',
    synthetic: true,
    configured: true,
    capabilities: { quotes: true, candles: true, options: true, fundamentals: false },
  } as never);
  vi.spyOn(client, 'expirations').mockResolvedValue({ expirations: [] } as never);
  vi.spyOn(client, 'settings').mockResolvedValue({} as never);
  // Default: Webull not wired up, so the live-quote overlay stays dormant.
  vi.spyOn(client, 'webullStatus').mockResolvedValue({
    configured: false,
    region: 'us',
    hasAccessToken: false,
  } as never);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ProviderProvider>
        <OptionsPage />
      </ProviderProvider>
    </MemoryRouter>,
  );
}

describe('OptionsPage', () => {
  it('renders the options workspace once the provider loads', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Options' })).toBeInTheDocument();
    // The four workspace tabs are present.
    expect(screen.getByText('Entry scan')).toBeInTheDocument();
    expect(screen.getByText('Exit rules')).toBeInTheDocument();
  });

  it('overlays a live Webull quote on a clicked contract when Webull is configured', async () => {
    vi.spyOn(client, 'expirations').mockResolvedValue({ expirations: ['2026-06-22'] } as never);
    vi.spyOn(client, 'webullStatus').mockResolvedValue({
      configured: true,
      region: 'us',
      hasAccessToken: false,
    } as never);
    vi.spyOn(client, 'chain').mockResolvedValue({
      underlying: 'AAPL',
      expiration: '2026-06-22',
      underlyingPrice: 305,
      atmIv: 0.2,
      calls: [
        {
          symbol: 'AAPL260622C00300000',
          underlying: 'AAPL',
          type: 'call',
          strike: 300,
          expiration: '2026-06-22',
          bid: 0.9,
          ask: 1.2,
          mark: 1.05,
          last: 1.0,
          volume: 1000,
          openInterest: 4000,
          greeks: { iv: 0.15, delta: 0.32, theta: -0.25, gamma: 0.09, vega: 0.1 },
        },
      ],
      puts: [],
    } as never);
    const quotes = vi.spyOn(client, 'webullOptionQuotes').mockResolvedValue({
      ok: true,
      quotes: [
        {
          symbol: 'AAPL260622C00300000',
          bid: 0.98,
          ask: 1.08,
          bidSize: 1,
          askSize: 45,
          last: 1.03,
          mark: 1.03,
          volume: 30882,
          openInterest: 4413,
          iv: 0.147,
          delta: 0.3152,
          changePct: -24.26,
          quoteTime: 1781812799000,
        },
      ],
    } as never);

    renderPage();

    // Wait for the chain row, then click it to open the live overlay.
    const strike = await screen.findByText('300.00');
    fireEvent.click(strike);

    expect(await screen.findByText('live · OPRA')).toBeInTheDocument();
    expect(quotes).toHaveBeenCalledWith(['AAPL260622C00300000']);
    // Live values render (bid 0.98, volume 30,882), distinct from the chain's
    // delayed values shown beneath each stat (`chain …`).
    expect(screen.getByText('0.98')).toBeInTheDocument();
    expect(screen.getByText('30,882')).toBeInTheDocument();
    expect(screen.getByText('-24.26%')).toBeInTheDocument();
    expect(screen.getAllByText(/^chain/).length).toBeGreaterThan(0);
  });
});

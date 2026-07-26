import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OptionsPage, { optionsTimingRead } from './OptionsPage';
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

    // Wait for BOTH the chain row AND live-quote availability before clicking.
    // The row's click handler is only wired once `webullStatus` resolves
    // (configured) — its hint renders then. The chain (client.chain) and the
    // status (client.webullStatus) are independent fetches, so clicking on just
    // the chain row races the status and intermittently no-ops (the flake).
    await screen.findByText(/click a contract for a live quote/i);
    const strike = await screen.findByText('300.00');
    fireEvent.click(strike);

    expect(quotes).toHaveBeenCalledWith(['AAPL260622C00300000']);
    // The "live · OPRA" badge renders during the loading state, so wait on a
    // value that only appears once the async quote resolves (the live bid),
    // otherwise the synchronous getByText below races the fetch.
    expect(await screen.findByText('0.98')).toBeInTheDocument(); // live bid
    expect(screen.getByText('live · OPRA')).toBeInTheDocument();
    expect(screen.getByText('30,882')).toBeInTheDocument(); // live volume
    expect(screen.getByText('-24.26%')).toBeInTheDocument(); // live change
    expect(screen.getAllByText(/^chain/).length).toBeGreaterThan(0);
  });
});

describe('optionsTimingRead — an unanswered earnings question is not an all-clear', () => {
  const base = { symbol: 'AAPL', expiration: '2026-08-21', earningsUnknown: false };

  it('warns when earnings fall before expiry', () => {
    const r = optionsTimingRead({ ...base, ivRank: 80, earningsDate: '2026-08-05', earningsDte: 10 });
    expect(r.kind).toBe('warn');
    expect(r.text).toMatch(/Earnings 2026-08-05 fall before this expiry/);
  });

  it('warns instead of recommending a premium sale when earnings could not be checked', () => {
    // The bug: earningsDate was undefined on a failed lookup, so
    // earningsBeforeExpiry went false and this fell through to the rich-IV
    // branch — which asserts "and no earnings fall before expiry" and then
    // recommends selling premium. That is the exact trade an unflagged earnings
    // event destroys through IV crush.
    const r = optionsTimingRead({ ...base, ivRank: 80, earningsUnknown: true });
    expect(r.kind).toBe('warn');
    expect(r.text).toMatch(/Couldn't check earnings for AAPL/);
    expect(r.text).not.toMatch(/no earnings fall before expiry/);
    expect(r.text).not.toMatch(/favor selling premium/);
  });

  it('takes precedence over every IV-rank branch, not just the rich one', () => {
    for (const ivRank of [80, 10, 35, null]) {
      expect(optionsTimingRead({ ...base, ivRank, earningsUnknown: true }).kind).toBe('warn');
    }
  });

  it('still recommends selling premium when earnings genuinely were checked and are clear', () => {
    // The advice has to survive — it's only wrong when nothing was checked.
    const r = optionsTimingRead({ ...base, ivRank: 80, earningsDate: '2026-09-30', earningsDte: 66 });
    expect(r.kind).toBe('sell');
    expect(r.text).toMatch(/no earnings fall before expiry/);
  });

  it('reads cheap IV as buy and middling as neutral', () => {
    expect(optionsTimingRead({ ...base, ivRank: 10 }).kind).toBe('buy');
    expect(optionsTimingRead({ ...base, ivRank: 35 }).kind).toBe('neutral');
    expect(optionsTimingRead({ ...base, ivRank: null }).kind).toBe('neutral');
  });

  it('ignores an earnings date that already passed or falls after expiry', () => {
    expect(optionsTimingRead({ ...base, ivRank: 80, earningsDate: '2026-07-01', earningsDte: -25 }).kind).toBe('sell');
    expect(optionsTimingRead({ ...base, ivRank: 80, earningsDate: '2026-09-01', earningsDte: 37 }).kind).toBe('sell');
  });
});

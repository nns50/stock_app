import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodaysSetups } from './TodaysSetups';
import { OPEN_LOG_TRADE_EVENT } from './GlobalLogTrade';
import { client } from '../api/client';

const mk = (symbol: string, total: number, gapPct: number, relVolume: number) => ({
  symbol,
  price: 100,
  total,
  passedFilters: true,
  filterReasons: [],
  components: [],
  indicators: {
    price: 100,
    changePct: 0,
    maShort: null,
    maLong: null,
    distShortPct: null,
    distLongPct: null,
    rsi: 60,
    atr: 1,
    atrPct: 1.2,
    relVolume,
    avgVolume: 1,
    volume: 1,
    gapPct,
  },
});

function mockResult() {
  return {
    generatedAt: Date.now(),
    provider: { name: 'mock', synthetic: true },
    config: {},
    universeCount: 3,
    scannedCount: 3,
    quoteWarmup: false,
    results: [mk('AAPL', 80, 1, 1.2), mk('TSLA', 60, 5, 3.0), mk('NVDA', 70, 2, 2.0)],
    filteredOut: [],
    errors: [],
  };
}

const symbolOrder = () =>
  screen
    .getAllByRole('link')
    .map((l) => l.textContent)
    .filter((t) => t && ['AAPL', 'TSLA', 'NVDA'].includes(t));

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(client, 'runScreener').mockResolvedValue(mockResult() as never);
});

function renderCard() {
  render(
    <MemoryRouter>
      <TodaysSetups />
    </MemoryRouter>,
  );
}

describe('TodaysSetups', () => {
  it('auto-scans on first session mount and ranks by score', async () => {
    renderCard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument(); // appeared without a click
    expect(symbolOrder()).toEqual(['AAPL', 'NVDA', 'TSLA']); // 80, 70, 60
  });

  it('does not auto-scan again later in the same session', () => {
    sessionStorage.setItem('todaysSetups.autoScanned', '1');
    renderCard();
    expect(screen.getByRole('button', { name: /Scan today/ })).toBeInTheDocument();
    expect(client.runScreener).not.toHaveBeenCalled();
  });

  it('re-ranks by the biggest gap when sorting by Gap', async () => {
    renderCard();
    await screen.findByText('AAPL');
    fireEvent.click(screen.getByRole('tab', { name: 'Gap' }));
    expect(symbolOrder()[0]).toBe('TSLA'); // 5% gap
  });

  it('logs a trade in a setup from its row, prefilling the symbol', async () => {
    let detail: { symbol?: string } | undefined;
    const handler = (e: Event) => {
      detail = (e as CustomEvent<{ symbol?: string }>).detail;
    };
    window.addEventListener(OPEN_LOG_TRADE_EVENT, handler);
    renderCard();
    await screen.findByText('AAPL');
    fireEvent.click(screen.getByRole('button', { name: 'Log a trade in AAPL' }));
    window.removeEventListener(OPEN_LOG_TRADE_EVENT, handler);
    expect(detail).toEqual({ symbol: 'AAPL' });
  });
});

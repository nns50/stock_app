import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodaysSetups } from './TodaysSetups';
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
  it('scans on demand and ranks by score by default', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Scan today/ }));
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(symbolOrder()).toEqual(['AAPL', 'NVDA', 'TSLA']); // 80, 70, 60
  });

  it('re-ranks by the biggest gap when sorting by Gap', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Scan today/ }));
    await screen.findByText('AAPL');
    fireEvent.click(screen.getByRole('tab', { name: 'Gap' }));
    expect(symbolOrder()[0]).toBe('TSLA'); // 5% gap
  });
});

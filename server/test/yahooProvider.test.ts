import { describe, it, expect, vi } from 'vitest';

// Mock the library so we test our mapping logic without any network.
vi.mock('yahoo-finance2', () => ({
  default: class FakeYahoo {
    constructor(_opts?: unknown) {}
    async quote(symbol: string | string[]) {
      const one = (s: string) => ({
        symbol: s,
        regularMarketPrice: 100,
        bid: 99.9,
        ask: 100.1,
        regularMarketOpen: 98,
        regularMarketDayHigh: 101,
        regularMarketDayLow: 97,
        regularMarketPreviousClose: 99,
        regularMarketChange: 1,
        regularMarketChangePercent: 1.01,
        regularMarketVolume: 1_000_000,
        averageDailyVolume3Month: 900_000,
        regularMarketTime: new Date('2026-06-11T16:00:00Z'),
      });
      return Array.isArray(symbol) ? symbol.map(one) : one(symbol);
    }
    async chart() {
      return {
        quotes: [
          { date: new Date('2026-06-10T00:00:00Z'), open: 101, high: 103, low: 100, close: 102, volume: 1100 },
          { date: new Date('2026-06-09T00:00:00Z'), open: 100, high: 102, low: 99, close: 101, volume: 1000 },
          { date: new Date('2026-06-11T00:00:00Z'), open: null, close: null }, // filtered out
        ],
      };
    }
    async options(_symbol: string, opts?: { date?: Date }) {
      if (!opts?.date) {
        return { expirationDates: [new Date('2026-06-19T00:00:00Z'), new Date('2026-07-17T00:00:00Z')] };
      }
      return {
        quote: { regularMarketPrice: 100 },
        options: [
          {
            calls: [
              {
                contractSymbol: 'C1',
                strike: 100,
                bid: 4.9,
                ask: 5.1,
                lastPrice: 5.0,
                volume: 500,
                openInterest: 1000,
                impliedVolatility: 0.3,
              },
            ],
            puts: [
              {
                contractSymbol: 'P1',
                strike: 100,
                bid: 4.5,
                ask: 4.7,
                lastPrice: 4.6,
                volume: 300,
                openInterest: 800,
                impliedVolatility: 0.32,
              },
            ],
          },
        ],
      };
    }
    async quoteSummary() {
      return {
        price: { longName: 'Test Co', shortName: 'TST', marketCap: 1e12 },
        summaryDetail: {
          trailingPE: 25,
          dividendYield: 0.005,
          beta: 1.1,
          fiftyTwoWeekHigh: 120,
          fiftyTwoWeekLow: 80,
          averageVolume: 950_000,
        },
        defaultKeyStatistics: { trailingEps: 4 },
        assetProfile: { sector: 'Tech', industry: 'Software' },
      };
    }
  },
}));

import { YahooProvider } from '../src/providers/YahooProvider';

const p = new YahooProvider();

describe('YahooProvider mapping', () => {
  it('maps a quote', async () => {
    const q = await p.getQuote('aapl');
    expect(q.symbol).toBe('AAPL');
    expect(q.last).toBe(100);
    expect(q.changePct).toBe(1.01);
    expect(q.avgVolume).toBe(900_000);
  });

  it('maps batch quotes', async () => {
    const qs = await p.getQuotes(['AAPL', 'MSFT']);
    expect(qs.map((q) => q.symbol)).toEqual(['AAPL', 'MSFT']);
  });

  it('maps candles, drops null bars, and sorts ascending', async () => {
    const c = await p.getCandles('AAPL', 'daily', { limit: 10 });
    expect(c).toHaveLength(2);
    expect(c[0].time).toBeLessThan(c[1].time);
    expect(c[1].close).toBe(102);
  });

  it('lists expirations as YYYY-MM-DD', async () => {
    expect(await p.getOptionsExpirations('AAPL')).toEqual(['2026-06-19', '2026-07-17']);
  });

  it('maps a chain and computes Greeks from IV', async () => {
    const ch = await p.getOptionsChain('AAPL', '2030-01-18'); // far out so T>0 regardless of run date
    expect(ch.underlyingPrice).toBe(100);
    expect(ch.calls).toHaveLength(1);
    const call = ch.calls[0];
    expect(call.mark).toBe(5); // (4.9+5.1)/2
    expect(call.openInterest).toBe(1000);
    expect(call.greeks?.computed).toBe(true);
    expect(call.greeks?.iv).toBeCloseTo(0.3, 4);
    expect(call.greeks?.delta).toBeGreaterThan(0);
    expect(call.greeks?.delta).toBeLessThan(1);
  });

  it('maps fundamentals', async () => {
    const f = await p.getFundamentals('AAPL');
    expect(f.name).toBe('Test Co');
    expect(f.peRatio).toBe(25);
    expect(f.sector).toBe('Tech');
    expect(f.high52).toBe(120);
  });
});

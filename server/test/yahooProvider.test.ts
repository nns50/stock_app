import { describe, it, expect, vi } from 'vitest';

// Mock the library so we test our mapping logic without any network.
vi.mock('yahoo-finance2', () => {
  // Simulate Yahoo: the dotted class-share form (BRK.B) returns no data; only
  // the hyphen form (BRK-B) resolves. Lets us prove symbol normalization.
  const reject = (s?: string) => {
    if (s && /\.[A-Za-z]$/.test(s)) throw new Error('No data found, symbol may be delisted');
  };
  return {
    default: class FakeYahoo {
      constructor(_opts?: unknown) {}
      async quote(symbol: string | string[]) {
        const one = (s: string) => {
          reject(s);
          return {
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
          };
        };
        return Array.isArray(symbol) ? symbol.map(one) : one(symbol);
      }
      async chart(symbol?: string) {
        reject(symbol);
        if (symbol === 'SPLIT') {
          // A 2:1 split on the second (later) day: adjclose is HALF of the
          // raw close, same ratio a real Yahoo response carries for every
          // bar before the split once one has happened.
          return {
            quotes: [
              {
                date: new Date('2026-06-09T00:00:00Z'),
                open: 100,
                high: 102,
                low: 99,
                close: 101,
                adjclose: 50.5,
                volume: 1000,
              },
              {
                date: new Date('2026-06-10T00:00:00Z'),
                open: 51,
                high: 51.5,
                low: 50,
                close: 51,
                adjclose: 51,
                volume: 2200,
              },
            ],
          };
        }
        return {
          quotes: [
            { date: new Date('2026-06-10T00:00:00Z'), open: 101, high: 103, low: 100, close: 102, volume: 1100 },
            { date: new Date('2026-06-09T00:00:00Z'), open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { date: new Date('2026-06-11T00:00:00Z'), open: null, close: null }, // filtered out
          ],
        };
      }
      async options(symbol: string, opts?: { date?: Date }) {
        reject(symbol);
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
      async quoteSummary(symbol?: string) {
        reject(symbol);
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
  };
});

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

  it('split/dividend-adjusts the WHOLE bar (open/high/low too, not just close) using adjclose', async () => {
    const c = await p.getCandles('SPLIT', 'daily', { limit: 10 });
    expect(c).toHaveLength(2);
    // Pre-split day: adjclose (50.5) is half of the raw close (101) -> factor 0.5.
    expect(c[0].close).toBe(50.5);
    expect(c[0].open).toBe(50); // 100 * 0.5
    expect(c[0].high).toBe(51); // 102 * 0.5
    expect(c[0].low).toBe(49.5); // 99 * 0.5
    // Post-split day: adjclose equals the raw close already -> factor 1 (unchanged).
    expect(c[1]).toMatchObject({ open: 51, high: 51.5, low: 50, close: 51 });
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

  it('normalizes class-share tickers to Yahoo hyphen form (BRK.B → BRK-B)', async () => {
    // The mock rejects the dotted form, so these only resolve when normalized —
    // and the canonical (dotted) symbol is preserved on the way out.
    const q = await p.getQuote('BRK.B');
    expect(q.symbol).toBe('BRK.B');
    expect(q.last).toBe(100);

    const c = await p.getCandles('BRK.B', 'daily', { limit: 5 });
    expect(c.length).toBeGreaterThan(0);

    const qs = await p.getQuotes(['BRK.B']);
    expect(qs.map((x) => x.symbol)).toEqual(['BRK.B']);

    expect(await p.getOptionsExpirations('BRK.B')).toHaveLength(2);
    expect((await p.getFundamentals('BRK.B')).symbol).toBe('BRK.B');
  });
});

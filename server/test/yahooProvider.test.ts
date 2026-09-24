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
      async chart(symbol?: string, opts?: { includePrePost?: boolean }) {
        reject(symbol);
        (globalThis as { __yahooChartOpts?: unknown }).__yahooChartOpts = opts;
        // Yahoo's real intraday shape, read 2026-09-24: with includePrePost on
        // (its default) one day on 2026-09-01 runs 04:00–19:55 ET; with it off,
        // 09:30–15:55 PLUS a zero-volume marker bar at the latest close — a
        // LATER day, at 16:00 ET. PREPOST ignores the flag, as a vendor might.
        if (symbol === 'INTRA5' || symbol === 'INTRA1' || symbol === 'PREPOST' || symbol === 'INSESSION') {
          const step = symbol === 'INTRA1' ? 1 : 5;
          const prePost = symbol === 'PREPOST' || opts?.includePrePost !== false;
          const midnight = Date.parse('2026-09-01T00:00:00-04:00');
          const quotes: Array<Record<string, unknown>> = [];
          for (let m = prePost ? 4 * 60 : 9 * 60 + 30; m < (prePost ? 20 * 60 : 16 * 60); m += step) {
            quotes.push({
              date: new Date(midnight + m * 60_000),
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 10,
            });
          }
          if (!prePost) {
            // Asked during a session, the marker is stamped at the latest TRADE:
            // inside that session's hours, on that later day.
            const marker = Date.parse(
              symbol === 'INSESSION' ? '2026-09-24T11:37:00-04:00' : '2026-09-23T16:00:00-04:00',
            );
            quotes.push({ date: new Date(marker), open: 474.38, high: 474.38, low: 474.38, close: 474.38, volume: 0 });
          }
          return { quotes };
        }
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

// ---------------------------------------------------------------------------
// Intraday windows (2026-09-24). Production reads past-day 5-minute bars from
// here once a day is older than Webull's ~15-session reach. Yahoo's pre/post
// default made that day 04:00–19:55 ET, and the 120-bar default kept the newest
// 120 — 10:00–19:55 — so every replay of an older day lost its open and walked
// four hours of after-hours prints.
// ---------------------------------------------------------------------------
describe('YahooProvider intraday windows', () => {
  const etTime = (ms: number) =>
    new Date(ms).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const etDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  it('serves a past 5-minute day as its regular session, whole', async () => {
    const c = await p.getCandles('INTRA5', '5min', { start: '2026-09-01', end: '2026-09-01' });
    expect((globalThis as { __yahooChartOpts?: { includePrePost?: boolean } }).__yahooChartOpts?.includePrePost).toBe(
      false,
    );
    expect(c).toHaveLength(78);
    expect(etTime(c[0].time)).toBe('09:30');
    expect(etTime(c[c.length - 1].time)).toBe('15:55');
  });

  it('drops the zero-volume marker bar Yahoo appends at the latest close', async () => {
    const c = await p.getCandles('INTRA5', '5min', { start: '2026-09-01', end: '2026-09-01' });
    expect(c.every((b) => etDay(b.time) === '2026-09-01')).toBe(true);
    expect(c.some((b) => b.close === 474.38)).toBe(false);
  });

  it('drops the marker when it is stamped inside a LATER session (a request made while the market is open)', async () => {
    const c = await p.getCandles('INSESSION', '5min', { start: '2026-09-01', end: '2026-09-01' });
    expect(c).toHaveLength(78);
    expect(c.some((b) => b.close === 474.38)).toBe(false);
  });

  it('keeps only the regular session even when pre- and post-market bars come back', async () => {
    const c = await p.getCandles('PREPOST', '5min', { start: '2026-09-01', end: '2026-09-01' });
    expect(c).toHaveLength(78);
    expect(etTime(c[0].time)).toBe('09:30');
    expect(etTime(c[c.length - 1].time)).toBe('15:55');
  });

  it('returns an explicit window whole: a 1-minute session is 390 bars, past the old default of 120', async () => {
    const c = await p.getCandles('INTRA1', '1min', { start: '2026-09-01', end: '2026-09-01' });
    expect(c).toHaveLength(390);
    // A limit, when one IS asked for, still keeps the most recent bars.
    const capped = await p.getCandles('INTRA1', '1min', { start: '2026-09-01', end: '2026-09-01', limit: 50 });
    expect(capped).toHaveLength(50);
    expect(etTime(capped[49].time)).toBe('15:59');
  });
});

import { MarketDataProvider, ProviderCapabilities } from './MarketDataProvider';
import {
  Candle,
  CandleQuery,
  Fundamentals,
  OptionContract,
  OptionsChain,
  Quote,
  Timeframe,
} from './types';
import { bsGreeks, yearsToExpiration } from '../options/blackScholes';

// ---------------------------------------------------------------------------
// Keyless, deterministic synthetic provider. Lets the whole app run, demo, and
// be tested with zero configuration. Data is seeded by symbol so it's stable
// across calls. It is clearly flagged `synthetic: true` so the UI never presents
// it as real market data.
// ---------------------------------------------------------------------------

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TF_STEP_MS: Record<Timeframe, number> = {
  '1min': 60_000,
  '5min': 5 * 60_000,
  '15min': 15 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

const RISK_FREE = 0.04;

export class MockProvider implements MarketDataProvider {
  readonly name = 'mock';
  readonly synthetic = true;
  readonly capabilities: ProviderCapabilities = {
    quotes: true,
    candles: true,
    options: true,
    fundamentals: true,
  };

  private basePrice(symbol: string): number {
    return 20 + (hashStr(symbol) % 380); // $20..$400
  }

  private baseVolume(symbol: string): number {
    return 300_000 + (hashStr(symbol + 'vol') % 9_700_000);
  }

  // Generate a canonical series of CANON bars from the seed, then return the
  // most recent `count` of them. Because the tail is identical regardless of how
  // many bars are requested, getQuote() and getCandles() agree on the latest
  // price (no drift between endpoints).
  private buildCandles(symbol: string, count: number, stepMs: number, endTime: number): Candle[] {
    const CANON = 520;
    const take = Math.min(Math.max(2, count), CANON);
    const rng = mulberry32(hashStr(symbol));
    const baseVol = this.baseVolume(symbol);
    let prevClose = this.basePrice(symbol);
    const all: Omit<Candle, 'time'>[] = [];
    for (let i = 0; i < CANON; i++) {
      const ret = (rng() - 0.48) * 0.03; // slight upward drift + noise
      const open = prevClose;
      const close = Math.max(1, open * (1 + ret));
      const high = Math.max(open, close) * (1 + rng() * 0.012);
      const low = Math.min(open, close) * (1 - rng() * 0.012);
      const volume = Math.round(baseVol * (0.6 + rng() * 1.2));
      all.push({ open: round2(open), high: round2(high), low: round2(low), close: round2(close), volume });
      prevClose = close;
    }
    const tail = all.slice(CANON - take);
    return tail.map((c, i) => ({ ...c, time: endTime - (take - 1 - i) * stepMs }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const candles = this.buildCandles(symbol, 60, TF_STEP_MS.daily, Date.now());
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const change = round2(last.close - prev.close);
    const spread = Math.max(0.01, last.close * 0.0005);
    const avgVol = Math.round(candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20);
    return {
      symbol: symbol.toUpperCase(),
      last: last.close,
      bid: round2(last.close - spread),
      ask: round2(last.close + spread),
      open: last.open,
      high: last.high,
      low: last.low,
      prevClose: prev.close,
      change,
      changePct: round2((change / prev.close) * 100),
      volume: last.volume,
      avgVolume: avgVol,
      timestamp: Date.now(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  async getCandles(symbol: string, timeframe: Timeframe, query?: CandleQuery): Promise<Candle[]> {
    const step = TF_STEP_MS[timeframe] ?? TF_STEP_MS.daily;
    const count = Math.min(query?.limit ?? 120, 500);
    return this.buildCandles(symbol, count, step, Date.now());
  }

  async getOptionsExpirations(symbol: string): Promise<string[]> {
    // Next ~6 monthly third-Fridays plus the nearest two Fridays (weeklies).
    void symbol;
    const out: string[] = [];
    const now = new Date();
    for (let w = 0; w < 2; w++) out.push(toISO(nextFriday(now, w)));
    for (let m = 1; m <= 6; m++) out.push(toISO(thirdFriday(now.getFullYear(), now.getMonth() + m)));
    return Array.from(new Set(out)).sort();
  }

  async getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
    const quote = await this.getQuote(symbol);
    const S = quote.last;
    const T = yearsToExpiration(expiration);
    const step = S < 50 ? 2.5 : S < 200 ? 5 : 10;
    const atm = Math.round(S / step) * step;
    const rng = mulberry32(hashStr(symbol + expiration));
    const baseIv = 0.25 + (hashStr(symbol) % 30) / 100; // 0.25..0.55

    const calls: OptionContract[] = [];
    const puts: OptionContract[] = [];
    for (let i = -8; i <= 8; i++) {
      const strike = round2(atm + i * step);
      if (strike <= 0) continue;
      const moneyness = strike / S - 1;
      const iv = Math.max(0.05, baseIv + 0.6 * moneyness * moneyness); // simple smile
      for (const type of ['call', 'put'] as const) {
        const g = bsGreeks({ type, S, K: strike, T, r: RISK_FREE, sigma: iv });
        const mark = Math.max(0.01, round2(g.price));
        const half = Math.max(0.01, round2(mark * 0.03));
        const contract: OptionContract = {
          symbol: occSymbol(symbol, expiration, type, strike),
          underlying: symbol.toUpperCase(),
          type,
          strike,
          expiration,
          bid: Math.max(0, round2(mark - half)),
          ask: round2(mark + half),
          last: mark,
          mark,
          volume: Math.round(rng() * 5000),
          openInterest: Math.round(rng() * 20000),
          greeks: {
            delta: round4(g.delta),
            gamma: round4(g.gamma),
            theta: round4(g.theta),
            vega: round4(g.vega),
            rho: round4(g.rho),
            iv: round4(iv),
            computed: true,
          },
        };
        (type === 'call' ? calls : puts).push(contract);
      }
    }
    return { underlying: symbol.toUpperCase(), expiration, underlyingPrice: S, calls, puts };
  }

  async getFundamentals(symbol: string): Promise<Fundamentals> {
    const rng = mulberry32(hashStr(symbol + 'fund'));
    const price = this.basePrice(symbol);
    const eps = round2(0.5 + rng() * 12);
    return {
      symbol: symbol.toUpperCase(),
      name: `${symbol.toUpperCase()} (synthetic)`,
      description: 'Synthetic fundamentals from the mock provider.',
      marketCap: Math.round(price * (5e7 + rng() * 2e9)),
      peRatio: round2(price / eps),
      eps,
      dividendYield: round4(rng() * 0.04),
      beta: round2(0.5 + rng() * 1.5),
      high52: round2(price * (1.1 + rng() * 0.3)),
      low52: round2(price * (0.6 + rng() * 0.3)),
      averageVolume: this.baseVolume(symbol),
      sector: 'Synthetic',
      industry: 'Demo',
    };
  }
}

// --- small date / formatting helpers ---------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function nextFriday(from: Date, weeksAhead: number): Date {
  const d = new Date(from);
  const day = d.getDay();
  const add = ((5 - day + 7) % 7) + weeksAhead * 7;
  d.setDate(d.getDate() + (add === 0 ? 7 : add));
  return d;
}
function thirdFriday(year: number, monthIndex: number): Date {
  const d = new Date(year, monthIndex, 1);
  const firstFriday = 1 + ((5 - d.getDay() + 7) % 7);
  return new Date(year, monthIndex, firstFriday + 14);
}
function occSymbol(underlying: string, expiration: string, type: 'call' | 'put', strike: number): string {
  const yymmdd = expiration.replace(/-/g, '').slice(2);
  const cp = type === 'call' ? 'C' : 'P';
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying.toUpperCase()}${yymmdd}${cp}${strikeStr}`;
}

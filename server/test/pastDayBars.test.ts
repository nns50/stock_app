import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Past-day intraday bars, read by the things that CONSUME them (2026-09-24).
//
// Production's candle source is Webull, with Yahoo as its range fallback. Two
// defects cut the bars a replay walks, and both stayed invisible in the
// providers' own tests because nothing downstream was looking:
//
//   - Yahoo served a 5-minute day as 04:00–19:55 ET (pre/post-market is
//     yahoo-finance2's default) and the 120-bar default kept the newest 120,
//     10:00–19:55. A day old enough to be served from Yahoo lost its open and
//     gained four hours of after-hours prints.
//   - Webull's 1,200-bar reach ends partway through one day, and that day was
//     passed on as whole: 09-01 read 13:30–15:55 on 2026-09-24.
//
// So these tests build the production composition — cache → Webull → Yahoo,
// with only the network faked — and read the answers the shadow replay and the
// excursion report give, not the bars.
// ---------------------------------------------------------------------------

type YahooBar = { date: Date; open: number; high: number; low: number; close: number; volume: number };

/** One ET day's bars as Yahoo serves them with pre/post on: 04:00–19:55 ET. */
function yahooDay(day: string, priceAt: (minute: number) => { high: number; low: number }): YahooBar[] {
  const midnight = Date.parse(`${day}T00:00:00-04:00`);
  const out: YahooBar[] = [];
  for (let m = 4 * 60; m < 20 * 60; m += 5) {
    const { high, low } = priceAt(m);
    const mid = (high + low) / 2;
    out.push({ date: new Date(midnight + m * 60_000), open: mid, high, low, close: mid, volume: 100 });
  }
  return out;
}

const at = (hh: number, mm: number) => hh * 60 + mm;

/** Target at 09:45, then a collapse through the stop from 10:00 — the move a
 *  replay that starts at 10:00 misreads as a loss. */
const spikeThenCollapse = (m: number) => {
  if (m < at(9, 40)) return { high: 100.3, low: 99.8 };
  if (m < at(9, 45)) return { high: 101, low: 100 };
  if (m < at(9, 50)) return { high: 102.6, low: 100.7 };
  if (m < at(10, 0)) return { high: 102.5, low: 101.5 };
  if (m < at(10, 5)) return { high: 101, low: 97.5 };
  return { high: 98, low: 97 };
};

/** Quiet all session, then through the stop after the close. */
const quietThenAfterHoursDrop = (m: number) => (m < at(16, 0) ? { high: 100.4, low: 99.6 } : { high: 97.5, low: 96 });

const YAHOO_DAYS: Record<string, YahooBar[]> = {
  OLD: yahooDay('2026-09-01', spikeThenCollapse),
  LATE: yahooDay('2026-09-01', quietThenAfterHoursDrop),
  EDGE: yahooDay('2026-09-02', spikeThenCollapse),
};

vi.mock('yahoo-finance2', () => ({
  default: class FakeYahoo {
    constructor(_opts?: unknown) {}
    async chart(symbol: string, opts: { period1: Date; period2: Date; includePrePost?: boolean }) {
      const inRange = (YAHOO_DAYS[symbol] ?? []).filter(
        (b) => b.date.getTime() >= opts.period1.getTime() && b.date.getTime() <= opts.period2.getTime(),
      );
      if (opts.includePrePost !== false) return { quotes: inRange };
      // Pre/post off: the regular session, plus the zero-volume marker bar
      // Yahoo appends at the latest close — a later day, at a later price.
      const regular = inRange.filter((b) => {
        const m = (b.date.getTime() - Date.parse('2026-01-01T00:00:00-04:00')) / 60_000;
        const minuteOfDay = ((m % 1440) + 1440) % 1440;
        return minuteOfDay >= at(9, 30) && minuteOfDay < at(16, 0);
      });
      const marker = { date: new Date('2026-09-23T20:00:00Z'), open: 474, high: 474, low: 474, close: 474, volume: 0 };
      return { quotes: [...regular, marker] };
    }
  },
}));

import { YahooProvider } from '../src/providers/YahooProvider';
import { WebullProvider } from '../src/providers/WebullProvider';
import { CachingProvider } from '../src/providers/CachingProvider';
import { WebullClient } from '../src/providers/webull/client';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { buildDeclinedEntryShadow } from '../src/services/autotrading/declinedEntryShadow';
import type { DeclinedEntry } from '../src/services/autotrading/declinedEntry';
import { excursionForTrade } from '../src/services/excursion';

afterEach(() => vi.restoreAllMocks());

/** Webull's side: RTH 5-minute bars, most recent sessions only. */
function webullRth(day: string, fromMinute: number, price: { high: number; low: number }) {
  const midnight = Date.parse(`${day}T00:00:00-04:00`);
  const out = [];
  for (let m = fromMinute; m < at(16, 0); m += 5) {
    const mid = String((price.high + price.low) / 2);
    out.push({
      time: new Date(midnight + m * 60_000).toISOString(),
      open: mid,
      high: String(price.high),
      low: String(price.low),
      close: mid,
      volume: '100',
    });
  }
  return out;
}

const WEBULL_BARS: Record<string, unknown[]> = {
  // Both far behind Webull's reach: its oldest bar is a later day.
  OLD: webullRth('2026-09-10', at(9, 30), { high: 101, low: 100 }),
  LATE: webullRth('2026-09-10', at(9, 30), { high: 101, low: 100 }),
  // The reach ends at 13:30 ON the day asked for — its afternoon, where the
  // name sat through the stop, is all Webull holds of it.
  EDGE: [
    ...webullRth('2026-09-02', at(13, 30), { high: 98, low: 97 }),
    ...webullRth('2026-09-03', at(9, 30), { high: 98, low: 97 }),
  ],
};

function productionSource() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const symbol = new URL(String(input)).searchParams.get('symbol') ?? '';
    return { ok: true, status: 200, text: async () => JSON.stringify(WEBULL_BARS[symbol] ?? []) } as Response;
  });
  const webull = new WebullProvider(
    WebullClient.fromEnv({ appKey: 'k', appSecret: 's', region: 'us' }),
    new YahooProvider(),
  );
  return new CachingProvider(webull, { quoteTtlMs: 60_000, candleTtlMs: 60_000 });
}

const cfg = {
  ...defaultAutotradeConfig(),
  liveMinSignalScore: 72,
  targetRMultiple: 1,
  breakevenTriggerRMultiple: 0,
  trailStartRMultiple: 0,
  trailStopRMultiple: 0,
  liveScaleOutEnabled: false,
  stagnationExitMinutes: 0,
};

/** A long at 100, stop 98: 1R is $2 and the 1R target is 102. */
const declined = (symbol: string, etDateTime: string): DeclinedEntry => ({
  symbol,
  at: Date.parse(`${etDateTime}:00-04:00`),
  score: 80,
  entry: 100,
  stop: 98,
  side: 'long',
});

describe('the declined-entry shadow on past-day bars', () => {
  it('replays a signal on a day served by the fallback from the signal, not from 10:00', async () => {
    const out = await buildDeclinedEntryShadow(productionSource(), [declined('OLD', '2026-09-01T09:37')], cfg, {
      entryConcessionPct: 0,
    });
    expect(out.n).toBe(1);
    expect(out.trades[0].reason).toBe('target');
    expect(out.trades[0].exitR).toBeCloseTo(1, 5);
  });

  it('ends the session at the close, not on after-hours prints', async () => {
    const out = await buildDeclinedEntryShadow(productionSource(), [declined('LATE', '2026-09-01T15:37')], cfg, {
      entryConcessionPct: 0,
    });
    expect(out.n).toBe(1);
    expect(out.trades[0].reason).toBe('time_exit');
    expect(out.trades[0].exitR).toBeCloseTo(0, 5);
  });

  it("reads the whole session on the day Webull's reach runs out partway through", async () => {
    const out = await buildDeclinedEntryShadow(productionSource(), [declined('EDGE', '2026-09-02T09:37')], cfg, {
      entryConcessionPct: 0,
    });
    expect(out.n).toBe(1);
    expect(out.trades[0].reason).toBe('target');
    expect(out.trades[0].exitR).toBeCloseTo(1, 5);
  });
});

describe('the excursion report on past-day bars', () => {
  it('measures a trade entered before 10:00 on the minutes it was held', async () => {
    const row = await excursionForTrade(productionSource(), {
      positionId: 1,
      symbol: 'OLD',
      side: 'long',
      entryPrice: 100,
      quantity: 10,
      multiplier: 1,
      stopPrice: 98,
      realizedPnl: -20,
      entryDate: '2026-09-01',
      exitDate: '2026-09-01',
      entryTime: '09:36',
      exitAt: Date.parse('2026-09-01T10:02:00-04:00'),
    });
    expect(row?.resolution).toBe('intraday');
    // The 09:45 high of 102.6 is 1.3R; a window starting at 10:00 saw 101 (0.5R).
    expect(row?.mfeR).toBeCloseTo(1.3, 5);
  });
});

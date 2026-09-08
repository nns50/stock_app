import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';

vi.mock('../src/providers', () => ({
  getProvider: vi.fn(),
  getProviderStatus: vi.fn(() => ({ synthetic: true })),
}));

import { getProvider, getProviderStatus } from '../src/providers';
import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { getDailySeries, upsertDailySeries } from '../src/db/dailySeries';
import { getMlRegimeReading, saveMlRegimeReading } from '../src/db/mlRegimeReadings';
import { REGIME_FIXTURE_FILE, RegimeModel, loadRegimeModel } from '../src/services/regimeModel';
import { FRED_SP500, FRED_VIX } from '../src/services/fredSeries';
import { buildFeatures } from '../src/services/hmmForward';
import {
  ML_REGIME_CHANGED_ACTION,
  ML_REGIME_DRIFT_ACTION,
  ML_REGIME_FETCH_FAILED_ACTION,
  ML_REGIME_OVERRIDE_ACTION,
  ML_REGIME_READ_ACTION,
  getMarketRegime,
  isReadingStale,
  peekMarketRegime,
  resetMlRegimeCache,
  stickySwitch,
  summarizeMlRegime,
} from '../src/services/mlRegime';

// ---------------------------------------------------------------------------
// The reading, driven end to end through a stubbed FRED: the parity fixture's
// real closes go in as CSV, the shipped model classifies them, the rows and
// the reading are persisted, the journal gets its one line — and every
// fallback (cache, provider, mock provider, no model, source off, override)
// reads the way docs/MARKET_REGIME_MODEL.md says it does.
// ---------------------------------------------------------------------------

interface Fixture {
  sp500: { date: string; value: number }[];
  vix: { date: string; value: number }[];
  labels: string[];
  hmmlearnPredictProbaLast: number[];
}
const fixture = JSON.parse(fs.readFileSync(REGIME_FIXTURE_FILE, 'utf8')) as Fixture;
const model = loadRegimeModel()!;
const argmaxLabel = fixture.labels[
  fixture.hmmlearnPredictProbaLast.indexOf(Math.max(...fixture.hmmlearnPredictProbaLast))
] as 'high_vol_bearish' | 'low_vol_bullish' | 'sideways';

/** Weekdays strictly before `date`, oldest first. */
function weekdaysBefore(date: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = date.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  while (out.length < n) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const wd = cursor.getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(cursor.toISOString().slice(0, 10));
  }
  return out;
}

/** The fixture's 61 closes make 40 feature rows — below the 60-row floor the
 *  filter needs — so 30 calm synthetic sessions are prepended. */
function warmedSeries() {
  const first = fixture.sp500[0];
  const firstVix = fixture.vix[0];
  const dates = weekdaysBefore(first.date, 30);
  const sp500 = [...dates.map((date, i) => ({ date, value: first.value * (1 - 0.0004 * (30 - i)) })), ...fixture.sp500];
  const vix = [...dates.map((date) => ({ date, value: firstVix.value })), ...fixture.vix];
  return { sp500, vix };
}

const csv = (id: string, rows: { date: string; value: number }[]) =>
  `observation_date,${id}\n${rows.map((r) => `${r.date},${r.value}`).join('\n')}\n2026-09-07,.\n`;

function fredStub(opts: { fail?: boolean } = {}) {
  const { sp500, vix } = warmedSeries();
  const fn = vi.fn(async (url: string) => {
    if (opts.fail) return new Response('down', { status: 503 });
    const id = url.includes('id=SP500') ? FRED_SP500 : FRED_VIX;
    return new Response(csv(id, id === FRED_SP500 ? sp500 : vix), { status: 200 });
  });
  return fn as unknown as typeof fetch & typeof fn;
}

/** Fri 2026-09-04, 14:00 ET — the fixture's VIX runs through Thu 09-03, the
 *  previous session, so both series are "complete" for the day. */
const FRIDAY = Date.parse('2026-09-04T18:00:00Z');
const events = (action: string) => listAutotradeEvents({ stage: 'config', actions: [action], limit: 50 });
const read = (over: Parameters<typeof getMarketRegime>[0] = {}) =>
  getMarketRegime({ now: FRIDAY, source: 'fred', devOverride: '', ...over });

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM daily_series; DELETE FROM ml_regime_readings; DELETE FROM autotrade_events;');
  resetMlRegimeCache();
  vi.mocked(getProviderStatus).mockReturnValue({ synthetic: true } as never);
  vi.mocked(getProvider).mockReset();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('stickySwitch — pure', () => {
  const labels = ['high_vol_bearish', 'low_vol_bullish', 'sideways'] as const;
  it('accepts the argmax with no previous or an unknown previous', () => {
    expect(stickySwitch(null, [0.2, 0.7, 0.1], labels, 0.6)).toEqual({
      regime: 'low_vol_bullish',
      candidate: 'low_vol_bullish',
      switched: false,
      heldBelowThreshold: false,
    });
    expect(stickySwitch('unknown', [0.2, 0.7, 0.1], labels, 0.6).regime).toBe('low_vol_bullish');
  });
  it('holds the same regime, switches at or above the threshold, holds below it', () => {
    expect(stickySwitch('low_vol_bullish', [0.3, 0.55, 0.15], labels, 0.6)).toMatchObject({
      regime: 'low_vol_bullish',
      switched: false,
      heldBelowThreshold: false,
    });
    expect(stickySwitch('sideways', [0.7, 0.2, 0.1], labels, 0.6)).toMatchObject({
      regime: 'high_vol_bearish',
      switched: true,
    });
    expect(stickySwitch('sideways', [0.55, 0.3, 0.15], labels, 0.6)).toMatchObject({
      regime: 'sideways',
      candidate: 'high_vol_bearish',
      switched: false,
      heldBelowThreshold: true,
    });
  });
});

describe('isReadingStale — pure', () => {
  it('tolerates the third most recent session across a holiday weekend', () => {
    // Labor Day 2026-09-07: Tuesday's three most recent sessions are 09-03, 09-04, 09-08.
    expect(isReadingStale('2026-09-03', '2026-09-08')).toBe(false);
    expect(isReadingStale('2026-09-03', '2026-09-09')).toBe(true);
    expect(isReadingStale(null, '2026-09-09')).toBe(true);
  });
});

describe('getMarketRegime', () => {
  it('reads FRED, persists the rows and the reading, journals once, and caches for the day', async () => {
    const fetchImpl = fredStub();
    const r = await read({ fetchImpl });
    expect(r.source).toBe('fred');
    expect(r.regime).toBe(argmaxLabel);
    expect(r.label).not.toBe('Unknown');
    expect(r.asOf).toBe('2026-09-03');
    expect(r.etDate).toBe('2026-09-04');
    expect(r.stale).toBe(false);
    expect(r.previous).toBeNull();
    expect(r.switched).toBe(false);
    expect(r.probabilities![argmaxLabel]).toBeCloseTo(Math.max(...fixture.hmmlearnPredictProbaLast), 3);
    const { sp500, vix } = warmedSeries();
    expect(r.rows).toBe(buildFeatures(sp500, vix).length);
    expect(r.features?.vix).toBeCloseTo(fixture.vix[fixture.vix.length - 1].value, 6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getDailySeries(FRED_SP500)).toHaveLength(sp500.length);
    expect(getDailySeries(FRED_VIX)).toHaveLength(vix.length);
    expect(getMlRegimeReading('2026-09-04')?.regime).toBe(argmaxLabel);
    expect(events(ML_REGIME_READ_ACTION)).toHaveLength(1);

    const again = await read({ now: FRIDAY + 60_000, fetchImpl });
    expect(again).toBe(r);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(peekMarketRegime(FRIDAY)).toBe(r);

    const forced = await read({ now: FRIDAY + 120_000, fetchImpl, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(forced.regime).toBe(argmaxLabel);
    expect(events(ML_REGIME_READ_ACTION)).toHaveLength(1);
  });

  it('survives a restart: the persisted row is reused once both series are complete', async () => {
    await read({ fetchImpl: fredStub() });
    resetMlRegimeCache();
    const fetchImpl = fredStub();
    const r = await read({ now: FRIDAY + 60_000, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.regime).toBe(argmaxLabel);
    expect(peekMarketRegime(FRIDAY + 60_000)?.regime).toBe(argmaxLabel);
  });

  it('a data date older than the third most recent session reads unknown/stale, posterior still visible', async () => {
    const wednesday = Date.parse('2026-09-09T18:00:00Z');
    const r = await read({ now: wednesday, fetchImpl: fredStub() });
    expect(r.regime).toBe('unknown');
    expect(r.reason).toBe('stale');
    expect(r.stale).toBe(true);
    expect(r.candidate).toBe(argmaxLabel);
    expect(r.probabilities).not.toBeNull();
    expect(r.asOf).toBe('2026-09-03');
    expect(events(ML_REGIME_READ_ACTION)).toHaveLength(0);
    expect(getMlRegimeReading('2026-09-09')?.regime).toBe('unknown');

    // The Tuesday after Labor Day with the same data is still fresh.
    resetMlRegimeCache();
    db.exec('DELETE FROM ml_regime_readings');
    const tuesday = Date.parse('2026-09-08T18:00:00Z');
    const fresh = await read({ now: tuesday, fetchImpl: fredStub() });
    expect(fresh.regime).toBe(argmaxLabel);
    expect(fresh.stale).toBe(false);
  });

  it('falls back to the cached FRED rows when the fetch fails, journaling the failure once', async () => {
    const { sp500, vix } = warmedSeries();
    upsertDailySeries(FRED_SP500, sp500);
    upsertDailySeries(FRED_VIX, vix);
    const r = await read({ fetchImpl: fredStub({ fail: true }) });
    expect(r.source).toBe('cache');
    expect(r.regime).toBe(argmaxLabel);
    expect(events(ML_REGIME_FETCH_FAILED_ACTION)).toHaveLength(1);
  });

  it('with nothing cached and only the Mock provider, reads unknown/synthetic_provider', async () => {
    const r = await read({ fetchImpl: fredStub({ fail: true }) });
    expect(r.regime).toBe('unknown');
    expect(r.reason).toBe('synthetic_provider');
    expect(r.source).toBe('none');
    expect(r.probabilities).toBeNull();
  });

  it('with nothing cached and a real provider, reads its candles and writes nothing to daily_series', async () => {
    vi.mocked(getProviderStatus).mockReturnValue({ synthetic: false } as never);
    const { sp500, vix } = warmedSeries();
    const toCandles = (rows: { date: string; value: number }[]) =>
      rows.map((p) => ({
        time: Date.parse(`${p.date}T13:30:00Z`),
        open: p.value,
        high: p.value,
        low: p.value,
        close: p.value,
        volume: 0,
      }));
    const getCandles = vi.fn(async (symbol: string) => toCandles(symbol === '^GSPC' ? sp500 : vix));
    vi.mocked(getProvider).mockReturnValue({ getCandles } as never);
    const r = await read({ fetchImpl: fredStub({ fail: true }) });
    expect(r.source).toBe('provider');
    expect(r.regime).toBe(argmaxLabel);
    expect(getDailySeries(FRED_SP500)).toHaveLength(0);
    expect(getCandles).toHaveBeenCalledWith('^GSPC', 'daily', { limit: 400 });
    expect(getCandles).toHaveBeenCalledWith('^VIX', 'daily', { limit: 400 });

    // source=provider goes straight there, never touching FRED.
    resetMlRegimeCache();
    db.exec('DELETE FROM ml_regime_readings');
    const fetchImpl = fredStub();
    const direct = await read({ source: 'provider', fetchImpl });
    expect(direct.source).toBe('provider');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no model reads unknown/no_model with no I/O', async () => {
    const fetchImpl = fredStub();
    const r = await read({ model: null, fetchImpl });
    expect(r.regime).toBe('unknown');
    expect(r.reason).toBe('no_model');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('source off reads unknown/source_off and persists nothing', async () => {
    const r = await read({ source: 'off' });
    expect(r.regime).toBe('unknown');
    expect(r.reason).toBe('source_off');
    expect(r.source).toBe('off');
    expect(getMlRegimeReading('2026-09-04')).toBeNull();
  });

  it('drift is flagged and journaled, but the label stands', async () => {
    const drifting: RegimeModel = { ...model, drift: { ...model.drift, p5: 1e9 } };
    const r = await read({ model: drifting, fetchImpl: fredStub() });
    expect(r.drift).toBe(true);
    expect(r.regime).toBe(argmaxLabel);
    expect(events(ML_REGIME_DRIFT_ACTION)).toHaveLength(1);
    expect(events(ML_REGIME_READ_ACTION)).toHaveLength(1);
  });

  it('the sticky switch reads the previous KNOWN day and journals the change', async () => {
    saveMlRegimeReading({
      etDate: '2026-09-02',
      regime: 'unknown',
      asOf: null,
      reading: {},
      modelVersion: model.version,
    });
    saveMlRegimeReading({
      etDate: '2026-09-03',
      regime: 'sideways',
      asOf: '2026-09-02',
      reading: {},
      modelVersion: model.version,
    });
    const r = await read({ fetchImpl: fredStub() });
    expect(r.previous).toBe('sideways');
    expect(r.switched).toBe(true);
    expect(r.regime).toBe(argmaxLabel);
    expect(events(ML_REGIME_CHANGED_ACTION)).toHaveLength(1);
  });

  it('a dev override forces the regime without touching the data, journaled once', async () => {
    const fetchImpl = fredStub();
    const r = await read({ devOverride: 'high_vol_bearish', fetchImpl });
    expect(r.regime).toBe('high_vol_bearish');
    expect(r.label).toBe('High Volatility/Bearish');
    expect(r.source).toBe('override');
    expect(fetchImpl).not.toHaveBeenCalled();
    await read({ now: FRIDAY + 1000, devOverride: 'high_vol_bearish', fetchImpl });
    expect(events(ML_REGIME_OVERRIDE_ACTION)).toHaveLength(1);
    expect(events(ML_REGIME_READ_ACTION)).toHaveLength(0);
  });

  it('an unrecognised override is ignored', async () => {
    const r = await read({ devOverride: 'bananas', fetchImpl: fredStub() });
    expect(r.source).toBe('fred');
    expect(r.regime).toBe(argmaxLabel);
  });

  it('summarizeMlRegime carries the acted-on probability for the tick summary', async () => {
    const r = await read({ fetchImpl: fredStub() });
    expect(summarizeMlRegime(r)).toEqual({
      regime: argmaxLabel,
      label: r.label,
      source: 'fred',
      asOf: '2026-09-03',
      stale: false,
      drift: false,
      probability: r.probabilities![argmaxLabel],
    });
  });

  it('the dev override is refused in production (config.ts)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ML_REGIME_DEV_OVERRIDE', 'sideways');
    vi.resetModules();
    const prod = await import('../src/config');
    expect(prod.config.mlRegime.devOverride).toBe('');
    vi.stubEnv('NODE_ENV', 'test');
    vi.resetModules();
    const dev = await import('../src/config');
    expect(dev.config.mlRegime.devOverride).toBe('sideways');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

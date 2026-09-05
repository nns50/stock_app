import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Wrap evaluateRiskCheck to RECORD the context liveExecute builds, while still
// running the real thing — the point is what gets passed, not what it decides.
const seenContexts: { finishLineFactor?: number; finishLineDetail?: string }[] = [];
vi.mock('../src/services/autotrading/riskCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/riskCheck')>();
  return {
    ...actual,
    evaluateRiskCheck: vi.fn((signal: never, ctx: never) => {
      seenContexts.push(ctx);
      return actual.evaluateRiskCheck(signal, ctx);
    }),
  };
});
vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/webull/orders')>()),
  webullPlaceOrder: vi.fn(async () => ({ ok: false, error: 'not placing in this test' })),
  listWebullOpenOrders: vi.fn(async () => ({ ok: false, orders: [], error: 'Webull is not configured.' })),
}));
vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn(async () => new Map()) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider } from '../src/providers';
import { webullAccountState } from '../src/providers/webull/accountState';
import { initDb, db } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { setTradingConfig } from '../src/db/trading';
import { saveDailyBaseline } from '../src/db/dailyBaseline';
import { config } from '../src/config';
import { runLiveExecution } from '../src/services/autotrading/liveExecute';
import { etToday } from '../src/util/marketDate';

// ---------------------------------------------------------------------------
// THE WIRING, not the arithmetic (2026-09-05).
//
// finishLine.test.ts proves computeFinishLineFactor does the right thing given
// the effective risk %. It cannot prove liveExecute HANDS it the effective risk
// % — and for a while liveExecute handed it the raw cfg.riskPerTradePct, so the
// trim double-counted every other cut already in force. Reverting that one line
// left the entire 137-case liveExecute suite green, which is exactly the
// "assert at the CONSUMER, not the producer" gap CLAUDE.md is about.
//
// So this file drives the real runLiveExecution and reads the finishLineFactor
// it actually put in the risk-check context.
// ---------------------------------------------------------------------------

const EQUITY = 5_161;
const BASELINE = EQUITY - 80; // day is up $80; the bank line is another $80 away

const cfgFields = {
  accountEquityUsd: EQUITY,
  riskProfile: 'MODERATE' as const,
  liveAccountId: 'ACC1',
  liveTradingEnabled: true,
  liveEnabledAt: Date.now(),
  liveMaxOrderUsd: 50_000,
  liveMaxDailyLossUsd: 5_000,
  liveMaxOrdersPerDay: 20,
  killSwitch: false,
  // The live shape this was found under.
  riskPerTradePct: 1.25,
  targetRMultiple: 2,
  targetDailyGainPct: 3.1, // baseline * 1.031 ≈ EQUITY + 80 -> an $80 gap
  finishLineSizingEnabled: true,
  finishLineMinSignalScore: 0,
  stepDownAfterLosses: 2,
  stepDownSizeCutPct: 50,
  regimeAtrThresholdPct: 3,
  regimeSizeCutPct: 0,
  equityCurveDeriskEnabled: false,
  expectancyWeightingEnabled: false,
  methodWeightingEnabled: false,
  symbolReentryCooldownMinutes: 0,
};

const okAccountState = {
  ok: true,
  accountId: 'ACC1',
  netLiquidationUsd: EQUITY,
  state: { buyingPowerUsd: 1_000_000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty: 0 },
};

const signal = () => ({
  symbol: 'ZFLW',
  side: 'buy' as const,
  entry: 100,
  stop: 95,
  target: 110,
  rMultiple: 2,
  rationale: 'fixture',
  score: 70,
});

const origPlaceEnabled = config.trading.placeEnabled;

beforeAll(() => initDb());

beforeEach(() => {
  seenContexts.length = 0;
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM autotrade_live_options_positions; DELETE FROM position_exits; DELETE FROM positions;',
  );
  setTradingConfig({ enabled: true, killSwitch: false });
  config.trading.placeEnabled = true;
  vi.mocked(getProvider).mockReturnValue({
    getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 100, timestamp: Date.now() })),
    getCandles: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getProvider>);
  vi.mocked(webullAccountState).mockResolvedValue(okAccountState as Awaited<ReturnType<typeof webullAccountState>>);
  saveDailyBaseline(etToday(Date.now()), BASELINE);
});

afterEach(() => {
  config.trading.placeEnabled = origPlaceEnabled;
});

const factorAfterRun = async (): Promise<number> => {
  await runLiveExecution([{ signal: signal() }]);
  expect(seenContexts.length).toBeGreaterThan(0);
  return seenContexts[0].finishLineFactor ?? 1;
};

/** The step-down cut, without needing a losing streak in the database:
 *  "step down after 0 losses" is active from the first trade. It exercises the
 *  same thing the streak would — a pre-finish-line factor below 1. */
const STEP_DOWN_ON = { stepDownAfterLosses: 0, stepDownSizeCutPct: 50 };
const STEP_DOWN_OFF = { stepDownAfterLosses: 99, stepDownSizeCutPct: 50 };

describe('liveExecute hands the finish line the risk the trade will really take', () => {
  it('trims when nothing else has cut the size — the baseline behaviour still works', async () => {
    // Full size: 1.25% of 5161 = $64.51 risk, and a 2R win pays $129.03, which
    // overshoots the $80 gap. So it trims, to roughly 80/129.
    setAutotradeConfig({ ...cfgFields, ...STEP_DOWN_OFF });
    const factor = await factorAfterRun();
    expect(factor).toBeLessThan(1);
    expect(factor).toBeCloseTo(80 / 129.03, 1);
  });

  it('does NOT trim once a step-down has put the real payoff below the gap', async () => {
    // The step-down halves the risk to $32.26, so the win pays $64.51 — under
    // the $80 gap. Nothing can overshoot, so there is nothing to trim.
    //
    // THIS is the case that was wrong. On the raw cfg.riskPerTradePct the trim
    // still fired, taking an already-halved entry down again to a ~$40 win it
    // could no longer reach the line with. Reverting the liveExecute line that
    // derives the effective basis must fail here — and nothing else in the
    // suite catches it, which is why this file exists.
    setAutotradeConfig({ ...cfgFields, ...STEP_DOWN_ON });
    expect(await factorAfterRun()).toBe(1);
  });

  it('leaves the trim off entirely when the feature is disabled', async () => {
    setAutotradeConfig({ ...cfgFields, ...STEP_DOWN_OFF, finishLineSizingEnabled: false });
    expect(await factorAfterRun()).toBe(1);
  });

  it('never sizes UP, whichever cuts are in force', async () => {
    for (const stepDown of [STEP_DOWN_OFF, STEP_DOWN_ON]) {
      seenContexts.length = 0;
      setAutotradeConfig({ ...cfgFields, ...stepDown });
      expect(await factorAfterRun()).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The options live path takes the same basis and has the same failure mode,
// but driving runLiveOptionsExecution end-to-end needs a chain, contract
// quotes and an expiry ladder — and that book is currently disabled
// (liveOptionsEnabled false). So it is guarded by a source scan rather than
// behaviourally, which is weaker and worth saying plainly: this catches the
// line being reverted, not every way the basis could go wrong.
//
// The equity path above is the real consumer test. Both mutations — reverting
// either executor to cfg.riskPerTradePct — now fail something.
// ---------------------------------------------------------------------------
describe('neither live executor feeds the trim the raw config risk %', () => {
  const EXECUTORS = ['liveExecute.ts', 'liveOptionsExecute.ts'] as const;

  it.each(EXECUTORS)('%s derives the basis through preFinishLineRiskPct', (name) => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', name), 'utf8');
    const call = src.slice(src.indexOf('computeFinishLineFactor({'));
    const args = call.slice(0, call.indexOf('});') + 3);
    expect(args).toMatch(/riskPerTradePct:\s*preFinishLineRiskPct\(/);
    expect(args).not.toMatch(/riskPerTradePct:\s*cfg\.riskPerTradePct/);
  });
});

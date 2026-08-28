import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));
vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));

import { initDb, db } from '../src/db';
import { createPosition, addExit } from '../src/db/positions';
import { createIntent } from '../src/db/orders';
import { getAutotradeConfig, setAutotradeConfig, defaultAutotradeConfig } from '../src/db/autotradeConfig';
import { isExcluded, listExclusions } from '../src/db/autotradeExclusions';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { kellySuggestion } from '../src/services/pnl';
import { dispatchNotifications } from '../src/services/notifier';
import { getProvider } from '../src/providers';
import { maybeAutoTune } from '../src/services/autotrading/autoTune';

const mockDispatch = vi.mocked(dispatchNotifications);
const mockGetProvider = vi.mocked(getProvider);

/** A provider whose getCandles returns one bar with the given high/low — enough
 *  for computeExcursion to read MFE (high) and MAE (low) for the exit-tune.
 *
 *  The bar is dated to the START of the requested window, as a range-supporting
 *  provider would return. It carried `time: 0` (1970) until 2026-08-25, which
 *  only worked because computeExcursion ignored timestamps entirely — the very
 *  defect that let MAE/MFE be measured over six months of unrelated bars. Now
 *  that the holding period is enforced, an undated bar correctly measures
 *  nothing, and this fixture has to be honest about when its bar happened. */
function candleReturning(high: number, low: number) {
  return {
    getCandles: vi.fn(async (_symbol: string, _timeframe: string, q?: { start?: string }) => [
      { time: Date.parse(`${q?.start ?? '2026-08-01'}T16:00:00Z`), open: 100, high, low, close: 100, volume: 1000 },
    ]),
  };
}

/** A closed WINNING autotrade stock trade: tagged so buildAutotradeExcursionReport
 *  picks it up, with a stop (for the R denominator) and a profitable exit. */
function closedAutotradeWinner(symbol: string, day: string) {
  const p = createPosition({
    assetType: 'stock',
    symbol,
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    entryDate: day,
    stopPrice: 95, // initial risk = 5/share
    tags: ['autotrade'],
  });
  addExit(p.id, { quantity: 1, exitPrice: 110, exitDate: day }); // +10 => realizedR +2 (winner)
  return p;
}

const ET_DAY_1 = Date.parse('2026-08-03T15:00:00Z'); // a Monday, well inside market hours ET
const ET_DAY_2 = Date.parse('2026-08-04T15:00:00Z'); // the next day

let intentSeq = 0;
function nextIdempotencyKey(): string {
  intentSeq += 1;
  return `autotune-test-${intentSeq}`;
}

/** A closed LOOP trade with a real P&L (no source order — never contributes
 *  to the slippage pool, so risk-tuning tests can use these without also
 *  tripping the slippage-exclusion side). Tagged 'autotrade' because since
 *  2026-08-21 the risk tuner only reads the loop's own trades — an untagged
 *  (manual) trade is invisible to it, which manual-trade tests below assert. */
function closedTrade(pnl: number, day: string) {
  const p = createPosition({
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    entryDate: day,
    tags: ['autotrade'],
  });
  addExit(p.id, { quantity: 1, exitPrice: 100 + pnl, exitDate: day });
  return p;
}

/** A closed MANUAL trade — no autotrade tag. The human's trading, which the
 *  risk tuner must never be judged by. */
function closedManualTrade(pnl: number, day: string) {
  const p = createPosition({
    assetType: 'stock',
    symbol: 'MSFT',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    entryDate: day,
  });
  addExit(p.id, { quantity: 1, exitPrice: 100 + pnl, exitDate: day });
  return p;
}

/** One live-traded fill (a fresh symbol+order each time) with a fixed
 *  slippage %, for the slippage-exclusion tests. */
function slippageFill(symbol: string, limitPrice: number, fillPrice: number, day: string) {
  const intent = createIntent(
    { symbol, assetKind: 'stock', side: 'buy', openClose: 'open', quantity: 1, orderType: 'limit', limitPrice },
    nextIdempotencyKey(),
  );
  createPosition({
    assetType: 'stock',
    symbol,
    side: 'long',
    quantity: 1,
    entryPrice: fillPrice,
    entryDate: day,
    sourceIntentId: intent.id,
  });
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM order_intents; ' +
      'DELETE FROM autotrade_events; DELETE FROM autotrade_exclusions;',
  );
  setAutotradeConfig(defaultAutotradeConfig());
  mockDispatch.mockClear();
  mockGetProvider.mockReset();
});

describe('maybeAutoTune', () => {
  it('does nothing when disabled (the default)', async () => {
    closedTrade(100, '2026-08-01');
    closedTrade(-50, '2026-08-02');
    const before = getAutotradeConfig().riskPerTradePct;
    const result = await maybeAutoTune(ET_DAY_1);
    expect(result).toEqual({ ran: false, riskAdjusted: false, symbolsExcluded: [], exitsAdjusted: false });
    expect(getAutotradeConfig().riskPerTradePct).toBe(before);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('runs at most once per (ET) trading day', async () => {
    setAutotradeConfig({ autoTuneEnabled: true });
    const r1 = await maybeAutoTune(ET_DAY_1);
    expect(r1.ran).toBe(true);
    const r2 = await maybeAutoTune(ET_DAY_1 + 60 * 60_000); // later, same day
    expect(r2).toEqual({ ran: false, riskAdjusted: false, symbolsExcluded: [], exitsAdjusted: false });
  });

  it('re-runs the next (ET) day', async () => {
    setAutotradeConfig({ autoTuneEnabled: true });
    await maybeAutoTune(ET_DAY_1);
    const r2 = await maybeAutoTune(ET_DAY_2);
    expect(r2.ran).toBe(true);
  });

  describe('risk-% tuning', () => {
    it("is judged by the LOOP's trades only — manual trades are invisible to it", async () => {
      // The operator's own diagnosis (2026-08-21): manual winners held past
      // their targets out of psychology were dragging the loop's Kelly and the
      // OOS guard's verdict. A pile of losing MANUAL trades must neither meet
      // the sample-size bar nor move the loop's risk %.
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 5, riskPerTradePct: 1 });
      for (let i = 0; i < 8; i++) closedManualTrade(-60, '2026-08-0' + ((i % 4) + 1));
      await maybeAutoTune(ET_DAY_1);
      // 8 closed manual trades, 0 autotrade ones: below the loop's OWN sample
      // bar, so nothing adjusts — a pre-filter tuner would have cut risk hard.
      expect(getAutotradeConfig().riskPerTradePct).toBe(1);
    });

    it('does not adjust below the configured minimum sample size', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 5, riskPerTradePct: 1 });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02'); // only 2 decisive trades, need 5
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBe(1);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('nudges risk-per-trade UP toward the Kelly suggestion, clamped to the max daily step', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneMaxStepPct: 0.3,
        riskPerTradePct: 1,
        autoTuneRequireOosConfirmation: false, // guard tested separately; isolate the increase mechanics
      });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02');
      const target = kellySuggestion(50, 100, -50, 2)!.suggestedRiskPct;
      expect(target).toBeGreaterThan(1); // sanity: this fixture's edge suggests raising risk
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.riskAdjusted).toBe(true);
      expect(getAutotradeConfig().riskPerTradePct).toBeCloseTo(1 + 0.3, 5); // clamped, not the full jump to `target`
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const events = mockDispatch.mock.calls[0][0];
      expect(events[0].title).toMatch(/risk-per-trade adjusted/);
      expect(events[0].message).toMatch(/riskPerTradePct 1% → 1\.3% \(Kelly suggests/);
    });

    it('nudges risk-per-trade DOWN toward the Kelly suggestion, clamped to the max daily step', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneMaxStepPct: 0.3, riskPerTradePct: 2 });
      closedTrade(50, '2026-08-01');
      closedTrade(-100, '2026-08-02'); // poor payoff ratio -> Kelly suggests cutting risk
      const target = kellySuggestion(50, 50, -100, 2)!.suggestedRiskPct;
      expect(target).toBeLessThan(2);
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBeCloseTo(2 - 0.3, 5);
    });

    it('applies the suggestion directly when it is within the max step (no clamping needed)', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneMaxStepPct: 5,
        riskPerTradePct: 1,
        autoTuneRequireOosConfirmation: false, // guard tested separately; isolate the increase mechanics
      });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02');
      const target = kellySuggestion(50, 100, -50, 2)!.suggestedRiskPct;
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBeCloseTo(target, 5);
    });

    it('logs auto_tune_risk_adjusted with the before/after/suggested values', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneMaxStepPct: 0.3,
        riskPerTradePct: 1,
        autoTuneRequireOosConfirmation: false, // guard tested separately; isolate the increase mechanics
      });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      const events = listAutotradeEvents({ actions: ['auto_tune_risk_adjusted'] });
      expect(events).toHaveLength(1);
      const detail = JSON.parse(events[0].detail!);
      expect(detail).toMatchObject({ from: 1, sampleSize: 2 });
      expect(detail.to).toBeCloseTo(1.3, 5);
    });

    it('does not adjust (or log) when the suggestion already matches the current setting', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, riskPerTradePct: 3 });
      // This fixture's Kelly suggestion hits the hardcoded 3% ceiling.
      closedTrade(1000, '2026-08-01');
      closedTrade(-1, '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBe(3);
      expect(listAutotradeEvents({ actions: ['auto_tune_risk_adjusted'] })).toHaveLength(0);
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });

  describe('walk-forward OOS guard on risk-% increases (default on)', () => {
    it('BLOCKS a risk-% increase when the out-of-sample edge is not confirmed, and journals it', async () => {
      // Default config leaves the guard ON. Two decisive trades suggest raising
      // risk, but the OOS window is far too thin to confirm — so the increase
      // is held, not applied.
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneMaxStepPct: 0.3, riskPerTradePct: 1 });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02');
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.riskAdjusted).toBe(false);
      expect(getAutotradeConfig().riskPerTradePct).toBe(1); // unchanged
      const blocked = listAutotradeEvents({ actions: ['auto_tune_risk_increase_blocked'] });
      expect(blocked).toHaveLength(1);
      expect(JSON.parse(blocked[0].detail!)).toMatchObject({ from: 1, wouldRaiseTo: 1.3 });
      expect(listAutotradeEvents({ actions: ['auto_tune_risk_adjusted'] })).toHaveLength(0);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('ALWAYS applies a risk-% DECREASE, even with the guard on', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneMaxStepPct: 0.3, riskPerTradePct: 2 });
      closedTrade(50, '2026-08-01');
      closedTrade(-100, '2026-08-02'); // poor payoff -> Kelly suggests cutting risk
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBeCloseTo(2 - 0.3, 5);
      expect(listAutotradeEvents({ actions: ['auto_tune_risk_increase_blocked'] })).toHaveLength(0);
    });

    it('APPLIES a risk-% increase when the out-of-sample edge IS confirmed', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneMaxStepPct: 0.3, riskPerTradePct: 1 });
      // In-sample (older) half: mixed, so overall Kelly still suggests raising.
      // Out-of-sample (recent) half: 22 identical winners — a constant, reliable,
      // entirely-positive sample, so it confirms regardless of the bootstrap rng.
      for (let i = 0; i < 22; i++) closedTrade(i % 2 === 0 ? 100 : -40, `2026-07-${String(i + 1).padStart(2, '0')}`);
      for (let i = 0; i < 22; i++) closedTrade(100, `2026-08-${String(i + 1).padStart(2, '0')}`);
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.riskAdjusted).toBe(true);
      expect(getAutotradeConfig().riskPerTradePct).toBeGreaterThan(1);
      expect(listAutotradeEvents({ actions: ['auto_tune_risk_increase_blocked'] })).toHaveLength(0);
    });

    it('does NOT guard an increase when the confirmation flag is off (opt-out honored)', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneMaxStepPct: 0.3,
        riskPerTradePct: 1,
        autoTuneRequireOosConfirmation: false,
      });
      closedTrade(100, '2026-08-01');
      closedTrade(-50, '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().riskPerTradePct).toBeCloseTo(1.3, 5); // applied — no guard
    });
  });

  describe('slippage-based exclusion', () => {
    it('does not exclude a symbol below the configured minimum fill count', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 3, autoTuneSlippageExcludePct: 1 });
      slippageFill('CJMB', 1.2, 1.23, '2026-08-01'); // 2.5% slippage, but only 1 fill (need 3)
      await maybeAutoTune(ET_DAY_1);
      expect(isExcluded('CJMB')).toBe(false);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('does not exclude a symbol whose average slippage is below the threshold', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneSlippageExcludePct: 5 });
      slippageFill('CJMB', 1.2, 1.21, '2026-08-01'); // ~0.83%
      slippageFill('CJMB', 1.2, 1.21, '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      expect(isExcluded('CJMB')).toBe(false);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('excludes a symbol at/above the threshold with enough fills, and journals it', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneSlippageExcludePct: 2 });
      slippageFill('CJMB', 1.2, 1.23, '2026-08-01'); // 2.5%
      slippageFill('CJMB', 1.2, 1.23, '2026-08-02'); // 2.5%
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.symbolsExcluded).toEqual(['CJMB']);
      expect(isExcluded('CJMB')).toBe(true);
      expect(listExclusions().find((e) => e.symbol === 'CJMB')?.reason).toMatch(/avg slippage 2\.5% over 2 fills/);
      const events = listAutotradeEvents({ actions: ['auto_tune_symbol_excluded'] });
      expect(events).toHaveLength(1);
      expect(events[0].symbol).toBe('CJMB');
      expect(JSON.parse(events[0].detail!)).toMatchObject({ avgPct: 2.5, trades: 2, thresholdPct: 2 });
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const dispatched = mockDispatch.mock.calls[0][0];
      expect(dispatched[0].title).toBe('Autotrade auto-tune: CJMB excluded');
      expect(dispatched[0].message).toMatch(/Avg slippage 2\.5% over 2 fills/);
    });

    it('does not re-exclude (or re-journal) a symbol that is already excluded', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneSlippageExcludePct: 2 });
      slippageFill('CJMB', 1.2, 1.23, '2026-08-01');
      slippageFill('CJMB', 1.2, 1.23, '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      mockDispatch.mockClear();
      const result2 = await maybeAutoTune(ET_DAY_2); // a fresh day, so the once-per-day gate doesn't block it
      expect(result2.symbolsExcluded).toEqual([]);
      expect(listAutotradeEvents({ actions: ['auto_tune_symbol_excluded'] })).toHaveLength(1); // still just the first
      expect(mockDispatch).not.toHaveBeenCalled(); // no re-exclusion -> no repeat notification either
    });

    it('excludes multiple qualifying symbols independently in the same run', async () => {
      setAutotradeConfig({ autoTuneEnabled: true, autoTuneMinTrades: 2, autoTuneSlippageExcludePct: 2 });
      slippageFill('CJMB', 1.2, 1.23, '2026-08-01');
      slippageFill('CJMB', 1.2, 1.23, '2026-08-02');
      slippageFill('SLND', 1.0, 1.03, '2026-08-01');
      slippageFill('SLND', 1.0, 1.03, '2026-08-02');
      slippageFill('AAPL', 150, 150.05, '2026-08-01'); // well under threshold
      slippageFill('AAPL', 150, 150.05, '2026-08-02');
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.symbolsExcluded.sort()).toEqual(['CJMB', 'SLND']);
      expect(isExcluded('AAPL')).toBe(false);
      expect(mockDispatch).toHaveBeenCalledTimes(2); // one dispatch per excluded symbol, none for AAPL
      const titles = mockDispatch.mock.calls.map((c) => c[0][0].title).sort();
      expect(titles).toEqual(['Autotrade auto-tune: CJMB excluded', 'Autotrade auto-tune: SLND excluded']);
    });
  });

  describe('exit-geometry tuning', () => {
    it('leaves exits untouched when the exit-tune flag is off (even with the master tune on)', async () => {
      setAutotradeConfig({ autoTuneEnabled: true }); // autoTuneExitsEnabled stays false (default)
      closedAutotradeWinner('AAA', '2026-08-01');
      closedAutotradeWinner('BBB', '2026-08-02');
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.exitsAdjusted).toBe(false);
      expect(getAutotradeConfig().stopAtrMultiple).toBe(1.5); // untouched defaults
      expect(getAutotradeConfig().targetRMultiple).toBe(2);
      expect(mockGetProvider).not.toHaveBeenCalled(); // no excursion fetch when disabled
    });

    it('tunes the stop/target from winner MAE/MFE, journals it, and pushes a notification', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneExitsEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneExitMaxStep: 5,
      });
      mockGetProvider.mockReturnValue(candleReturning(120, 98) as never); // winner: MFE 4R, MAE −0.4R
      closedAutotradeWinner('AAA', '2026-08-01');
      closedAutotradeWinner('BBB', '2026-08-02');
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.exitsAdjusted).toBe(true);
      // stop: p90 of {0.4, 0.4} = 0.4R heat × 1.1 allowance × 1.5 = 0.66×ATR
      // (both winners take identical heat, so the percentile IS 0.4 here);
      // target: 4R MFE × 0.8 = 3.2R
      expect(getAutotradeConfig().stopAtrMultiple).toBeCloseTo(0.66, 5);
      expect(getAutotradeConfig().targetRMultiple).toBeCloseTo(3.2, 5);
      const events = listAutotradeEvents({ actions: ['auto_tune_exits_adjusted'] });
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].detail!)).toMatchObject({
        from: { stopAtrMultiple: 1.5, targetRMultiple: 2 },
        winners: 2,
      });
      const dispatched = mockDispatch.mock.calls.map((c) => c[0][0].title);
      expect(dispatched).toContain('Autotrade auto-tune: exit geometry adjusted');
    });

    it('clamps the exit change to autoTuneExitMaxStep', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneExitsEnabled: true,
        autoTuneMinTrades: 2,
        autoTuneExitMaxStep: 0.25,
      });
      mockGetProvider.mockReturnValue(candleReturning(120, 98) as never);
      closedAutotradeWinner('AAA', '2026-08-01');
      closedAutotradeWinner('BBB', '2026-08-02');
      await maybeAutoTune(ET_DAY_1);
      expect(getAutotradeConfig().stopAtrMultiple).toBeCloseTo(1.25, 5); // 1.5 − 0.25, not the full drop to 0.78
      expect(getAutotradeConfig().targetRMultiple).toBeCloseTo(2.25, 5); // 2 + 0.25, not the full jump to 3.2
    });

    it('does not tune below the winner sample floor', async () => {
      setAutotradeConfig({
        autoTuneEnabled: true,
        autoTuneExitsEnabled: true,
        autoTuneMinTrades: 5,
        autoTuneExitMaxStep: 5,
      });
      mockGetProvider.mockReturnValue(candleReturning(120, 98) as never);
      closedAutotradeWinner('AAA', '2026-08-01');
      closedAutotradeWinner('BBB', '2026-08-02'); // only 2 winners, need 5
      const result = await maybeAutoTune(ET_DAY_1);
      expect(result.exitsAdjusted).toBe(false);
      expect(getAutotradeConfig().stopAtrMultiple).toBe(1.5);
    });
  });
});

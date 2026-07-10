import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  defaultAutotradeConfig,
  getAutotradeConfig,
  setAutotradeConfig,
  setAutotradeKillSwitch,
} from '../src/db/autotradeConfig';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_config'));

describe('autotrade config persistence', () => {
  it('returns defaults (off, MODERATE) when unset', () => {
    expect(getAutotradeConfig()).toEqual(defaultAutotradeConfig());
  });

  it('persists a partial patch over defaults and round-trips', () => {
    const cfg = setAutotradeConfig({ enabled: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.riskProfile).toBe('MODERATE'); // untouched
    expect(getAutotradeConfig()).toEqual(cfg);
  });

  it('merges successive patches in a single row', () => {
    setAutotradeConfig({ enabled: true });
    const cfg = setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
    expect(cfg.enabled).toBe(true); // preserved across patches
    expect(cfg.riskProfile).toBe('AGGRESSIVE');
    expect((db.prepare('SELECT COUNT(*) AS n FROM autotrade_config').get() as { n: number }).n).toBe(1);
  });

  it('rejects an invalid riskProfile value, failing closed to the conservative default', () => {
    setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
    // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
    const cfg = setAutotradeConfig({ riskProfile: 'YOLO' });
    expect(cfg.riskProfile).toBe('MODERATE');
  });

  it('falls back to defaults on a corrupt stored blob', () => {
    db.prepare('INSERT INTO autotrade_config (id, config, updated_at) VALUES (1, ?, ?)').run('not json', Date.now());
    expect(getAutotradeConfig()).toEqual(defaultAutotradeConfig());
  });

  it('accountEquityUsd defaults to null', () => {
    expect(getAutotradeConfig().accountEquityUsd).toBeNull();
  });

  it('persists a positive accountEquityUsd', () => {
    const cfg = setAutotradeConfig({ accountEquityUsd: 100_000 });
    expect(cfg.accountEquityUsd).toBe(100_000);
    expect(getAutotradeConfig().accountEquityUsd).toBe(100_000);
  });

  it('can be explicitly cleared back to null', () => {
    setAutotradeConfig({ accountEquityUsd: 50_000 });
    const cfg = setAutotradeConfig({ accountEquityUsd: null });
    expect(cfg.accountEquityUsd).toBeNull();
  });

  it('rejects a non-positive equity, failing closed to null', () => {
    setAutotradeConfig({ accountEquityUsd: 50_000 });
    // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
    const cfg = setAutotradeConfig({ accountEquityUsd: -10 });
    expect(cfg.accountEquityUsd).toBeNull();
  });

  it('killSwitch defaults to false', () => {
    expect(getAutotradeConfig().killSwitch).toBe(false);
  });

  it('setAutotradeKillSwitch engages and releases independently of other fields', () => {
    setAutotradeConfig({ enabled: true, riskProfile: 'AGGRESSIVE' });
    expect(setAutotradeKillSwitch(true).killSwitch).toBe(true);
    expect(getAutotradeConfig()).toMatchObject({ killSwitch: true, enabled: true, riskProfile: 'AGGRESSIVE' });
    expect(setAutotradeKillSwitch(false).killSwitch).toBe(false);
    // Releasing it doesn't touch `enabled` — a loop already armed resumes on its own.
    expect(getAutotradeConfig()).toMatchObject({ killSwitch: false, enabled: true, riskProfile: 'AGGRESSIVE' });
  });

  describe('Phase 8: live-trading fields', () => {
    it('default to off/unset, with conservative starting caps', () => {
      const d = defaultAutotradeConfig();
      expect(d.liveTradingEnabled).toBe(false);
      expect(d.liveEnabledAt).toBeNull();
      expect(d.liveAccountId).toBeNull();
      expect(d.liveMaxOrderUsd).toBeGreaterThan(0);
      expect(d.liveMaxDailyLossUsd).toBeGreaterThan(0);
      expect(d.liveMaxOrdersPerDay).toBeGreaterThan(0);
      expect(d.liveAllowNakedShort).toBe(false);
      expect(d.liveProbationTrades).toBeGreaterThan(0);
      expect(d.liveProbationSizeMultiplier).toBeGreaterThan(0);
      expect(d.liveProbationSizeMultiplier).toBeLessThanOrEqual(1);
    });

    it('persists liveAccountId and the live cap fields, independent of other fields', () => {
      const cfg = setAutotradeConfig({
        liveAccountId: 'ABC123_INDIVIDUAL_CASH',
        liveMaxOrderUsd: 2_000,
        liveMaxDailyLossUsd: 800,
        liveMaxOrdersPerDay: 4,
        liveFatFingerPct: 8,
        liveProbationTrades: 15,
        liveProbationSizeMultiplier: 0.4,
      });
      expect(cfg).toMatchObject({
        liveAccountId: 'ABC123_INDIVIDUAL_CASH',
        liveMaxOrderUsd: 2_000,
        liveMaxDailyLossUsd: 800,
        liveMaxOrdersPerDay: 4,
        liveFatFingerPct: 8,
        liveProbationTrades: 15,
        liveProbationSizeMultiplier: 0.4,
      });
      expect(getAutotradeConfig()).toEqual(cfg);
    });

    it('can explicitly clear liveAccountId back to null', () => {
      setAutotradeConfig({ liveAccountId: 'SOME_ACCOUNT' });
      const cleared = setAutotradeConfig({ liveAccountId: null });
      expect(cleared.liveAccountId).toBeNull();
    });

    it('rejects a blank liveAccountId, failing closed to null rather than storing whitespace', () => {
      setAutotradeConfig({ liveAccountId: 'REAL_ACCOUNT' });
      // Matches accountEquityUsd's own established convention (see "rejects a
      // non-positive equity, failing closed to null" above): invalid input
      // resets to the safe default rather than silently preserving whatever
      // was there before, which the caller may be actively trying to change.
      // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
      const cfg = setAutotradeConfig({ liveAccountId: '   ' });
      expect(cfg.liveAccountId).toBeNull();
    });

    it('rejects a probation multiplier outside (0, 1], failing closed to the default', () => {
      // @ts-expect-error deliberately invalid input
      const tooHigh = setAutotradeConfig({ liveProbationSizeMultiplier: 1.5 });
      expect(tooHigh.liveProbationSizeMultiplier).toBe(defaultAutotradeConfig().liveProbationSizeMultiplier);
      // @ts-expect-error deliberately invalid input
      const zero = setAutotradeConfig({ liveProbationSizeMultiplier: 0 });
      expect(zero.liveProbationSizeMultiplier).toBe(defaultAutotradeConfig().liveProbationSizeMultiplier);
    });

    it('liveTradingEnabled and liveEnabledAt round-trip independently of unrelated patches', () => {
      const enabledAt = Date.now();
      setAutotradeConfig({ liveTradingEnabled: true, liveEnabledAt: enabledAt });
      const cfg = setAutotradeConfig({ liveMaxOrderUsd: 1_234 });
      expect(cfg.liveTradingEnabled).toBe(true);
      expect(cfg.liveEnabledAt).toBe(enabledAt);
      expect(cfg.liveMaxOrderUsd).toBe(1_234);
    });
  });

  describe('Task #70: live options trading fields', () => {
    it('default to off/unset, with conservative starting caps, mirroring the equity live fields', () => {
      const d = defaultAutotradeConfig();
      expect(d.liveOptionsEnabled).toBe(false);
      expect(d.liveOptionsEnabledAt).toBeNull();
      expect(d.liveOptionsMaxOrderUsd).toBeGreaterThan(0);
      expect(d.liveOptionsMaxDailyLossUsd).toBeGreaterThan(0);
      expect(d.liveOptionsMaxOrdersPerDay).toBeGreaterThan(0);
      expect(d.liveOptionsProbationTrades).toBeGreaterThan(0);
      expect(d.liveOptionsProbationSizeMultiplier).toBeGreaterThan(0);
      expect(d.liveOptionsProbationSizeMultiplier).toBeLessThanOrEqual(1);
    });

    it('persists the live options cap fields, independent of the equity live caps', () => {
      const cfg = setAutotradeConfig({
        liveMaxOrderUsd: 2_000, // equity's own — must stay untouched
        liveOptionsMaxOrderUsd: 750,
        liveOptionsMaxDailyLossUsd: 300,
        liveOptionsMaxOrdersPerDay: 3,
        liveOptionsFatFingerPct: 12,
        liveOptionsProbationTrades: 10,
        liveOptionsProbationSizeMultiplier: 0.25,
      });
      expect(cfg).toMatchObject({
        liveMaxOrderUsd: 2_000,
        liveOptionsMaxOrderUsd: 750,
        liveOptionsMaxDailyLossUsd: 300,
        liveOptionsMaxOrdersPerDay: 3,
        liveOptionsFatFingerPct: 12,
        liveOptionsProbationTrades: 10,
        liveOptionsProbationSizeMultiplier: 0.25,
      });
      expect(getAutotradeConfig()).toEqual(cfg);
    });

    it('rejects a live options probation multiplier outside (0, 1], failing closed to the default', () => {
      // @ts-expect-error deliberately invalid input
      const tooHigh = setAutotradeConfig({ liveOptionsProbationSizeMultiplier: 2 });
      expect(tooHigh.liveOptionsProbationSizeMultiplier).toBe(
        defaultAutotradeConfig().liveOptionsProbationSizeMultiplier,
      );
      // @ts-expect-error deliberately invalid input
      const zero = setAutotradeConfig({ liveOptionsProbationSizeMultiplier: 0 });
      expect(zero.liveOptionsProbationSizeMultiplier).toBe(defaultAutotradeConfig().liveOptionsProbationSizeMultiplier);
    });

    it('liveOptionsEnabled and liveOptionsEnabledAt round-trip independently of unrelated patches, including equity live-trading fields', () => {
      const enabledAt = Date.now();
      setAutotradeConfig({ liveTradingEnabled: true, liveEnabledAt: enabledAt - 1000 });
      const optionsEnabledAt = Date.now();
      setAutotradeConfig({ liveOptionsEnabled: true, liveOptionsEnabledAt: optionsEnabledAt });
      const cfg = setAutotradeConfig({ liveOptionsMaxOrderUsd: 999 });
      expect(cfg.liveOptionsEnabled).toBe(true);
      expect(cfg.liveOptionsEnabledAt).toBe(optionsEnabledAt);
      expect(cfg.liveOptionsMaxOrderUsd).toBe(999);
      // The two enable timestamps are genuinely independent of each other.
      expect(cfg.liveEnabledAt).toBe(enabledAt - 1000);
      expect(cfg.liveEnabledAt).not.toBe(cfg.liveOptionsEnabledAt);
    });
  });

  describe('options strategy type', () => {
    it("defaults to 'single_leg'", () => {
      expect(defaultAutotradeConfig().optionsStrategyType).toBe('single_leg');
      expect(getAutotradeConfig().optionsStrategyType).toBe('single_leg');
    });

    it("persists 'debit_spread' and round-trips", () => {
      const cfg = setAutotradeConfig({ optionsStrategyType: 'debit_spread' });
      expect(cfg.optionsStrategyType).toBe('debit_spread');
      expect(getAutotradeConfig().optionsStrategyType).toBe('debit_spread');
    });

    it('rejects an invalid value, failing closed to single_leg', () => {
      setAutotradeConfig({ optionsStrategyType: 'debit_spread' });
      // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
      const cfg = setAutotradeConfig({ optionsStrategyType: 'iron_condor' });
      expect(cfg.optionsStrategyType).toBe('single_leg');
    });

    it('round-trips independently of unrelated patches', () => {
      setAutotradeConfig({ optionsStrategyType: 'debit_spread' });
      const cfg = setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
      expect(cfg.optionsStrategyType).toBe('debit_spread');
      expect(cfg.riskProfile).toBe('AGGRESSIVE');
    });
  });

  describe("risk-check parameters (formerly riskProfiles.ts's MODERATE/AGGRESSIVE preset table)", () => {
    it('defaults to the old MODERATE preset exactly', () => {
      const d = defaultAutotradeConfig();
      expect(d.riskPerTradePct).toBe(1);
      expect(d.maxDailyDrawdownPct).toBe(3);
      expect(d.stepDownAfterLosses).toBe(2);
      expect(d.stepDownSizeCutPct).toBe(50);
      expect(d.maxAggregateOpenRiskPct).toBe(2);
      expect(d.maxCorrelatedExposurePct).toBe(6);
      expect(d.maxTradesPerDay).toBe(6);
    });

    it('persists a patch and round-trips', () => {
      const cfg = setAutotradeConfig({
        riskPerTradePct: 1.5,
        maxDailyDrawdownPct: 5,
        stepDownAfterLosses: 3,
        stepDownSizeCutPct: 25,
        maxAggregateOpenRiskPct: 4.5,
        maxCorrelatedExposurePct: 10,
        maxTradesPerDay: 10,
      });
      expect(cfg).toMatchObject({
        riskPerTradePct: 1.5,
        maxDailyDrawdownPct: 5,
        stepDownAfterLosses: 3,
        stepDownSizeCutPct: 25,
        maxAggregateOpenRiskPct: 4.5,
        maxCorrelatedExposurePct: 10,
        maxTradesPerDay: 10,
      });
      expect(getAutotradeConfig()).toMatchObject({
        riskPerTradePct: 1.5,
        maxDailyDrawdownPct: 5,
        maxAggregateOpenRiskPct: 4.5,
      });
    });

    it('switching riskProfile no longer touches any of these — they are fully independent now', () => {
      setAutotradeConfig({ riskPerTradePct: 1.5, maxAggregateOpenRiskPct: 4.5, maxTradesPerDay: 10 });
      const cfg = setAutotradeConfig({ riskProfile: 'MODERATE' });
      expect(cfg.riskPerTradePct).toBe(1.5);
      expect(cfg.maxAggregateOpenRiskPct).toBe(4.5);
      expect(cfg.maxTradesPerDay).toBe(10);
    });

    it("clamps a negative pct field to 0 (matches the pct() helper's existing clamp-not-reject behavior)", () => {
      const cfg = setAutotradeConfig({ maxAggregateOpenRiskPct: -1 });
      expect(cfg.maxAggregateOpenRiskPct).toBe(0);
    });

    it('clamps a pct field above 100 down to 100', () => {
      const cfg = setAutotradeConfig({ maxCorrelatedExposurePct: 500 });
      expect(cfg.maxCorrelatedExposurePct).toBe(100);
    });

    it('allows stepDownAfterLosses/maxTradesPerDay of exactly 0 (always-on step-down / no trades today)', () => {
      const cfg = setAutotradeConfig({ stepDownAfterLosses: 0, maxTradesPerDay: 0 });
      expect(cfg.stepDownAfterLosses).toBe(0);
      expect(cfg.maxTradesPerDay).toBe(0);
    });

    it('rejects a negative stepDownAfterLosses/maxTradesPerDay, failing closed to the default', () => {
      setAutotradeConfig({ stepDownAfterLosses: 3, maxTradesPerDay: 10 });
      // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
      const cfg = setAutotradeConfig({ stepDownAfterLosses: -1, maxTradesPerDay: -1 });
      expect(cfg.stepDownAfterLosses).toBe(defaultAutotradeConfig().stepDownAfterLosses);
      expect(cfg.maxTradesPerDay).toBe(defaultAutotradeConfig().maxTradesPerDay);
    });
  });

  describe('movers auto-promotion', () => {
    it('defaults to enabled, 3 within 10 days, cap 50', () => {
      const d = defaultAutotradeConfig();
      expect(d.autoPromoteMoversEnabled).toBe(true);
      expect(d.autoPromoteThreshold).toBe(3);
      expect(d.autoPromoteWindowDays).toBe(10);
      expect(d.autoPromoteMaxSymbols).toBe(50);
    });

    it('persists a patch and round-trips', () => {
      const cfg = setAutotradeConfig({
        autoPromoteMoversEnabled: false,
        autoPromoteThreshold: 5,
        autoPromoteWindowDays: 20,
        autoPromoteMaxSymbols: 10,
      });
      expect(cfg).toMatchObject({
        autoPromoteMoversEnabled: false,
        autoPromoteThreshold: 5,
        autoPromoteWindowDays: 20,
        autoPromoteMaxSymbols: 10,
      });
      expect(getAutotradeConfig()).toMatchObject({
        autoPromoteMoversEnabled: false,
        autoPromoteThreshold: 5,
        autoPromoteWindowDays: 20,
        autoPromoteMaxSymbols: 10,
      });
    });

    it('rejects a threshold/window below 1, failing closed to the default (matches accountEquityUsd/riskProfile precedent above)', () => {
      setAutotradeConfig({ autoPromoteThreshold: 4, autoPromoteWindowDays: 15 });
      // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
      const cfg = setAutotradeConfig({ autoPromoteThreshold: 0, autoPromoteWindowDays: -1 });
      expect(cfg.autoPromoteThreshold).toBe(defaultAutotradeConfig().autoPromoteThreshold);
      expect(cfg.autoPromoteWindowDays).toBe(defaultAutotradeConfig().autoPromoteWindowDays);
    });

    it('allows a max-symbols cap of exactly 0 (no more auto-promotion slots)', () => {
      const cfg = setAutotradeConfig({ autoPromoteMaxSymbols: 0 });
      expect(cfg.autoPromoteMaxSymbols).toBe(0);
    });

    it('rejects a negative max-symbols cap, failing closed to the default', () => {
      setAutotradeConfig({ autoPromoteMaxSymbols: 25 });
      // @ts-expect-error deliberately invalid input, to exercise the sanitize fallback
      const cfg = setAutotradeConfig({ autoPromoteMaxSymbols: -5 });
      expect(cfg.autoPromoteMaxSymbols).toBe(defaultAutotradeConfig().autoPromoteMaxSymbols);
    });

    it('round-trips independently of unrelated patches', () => {
      setAutotradeConfig({ autoPromoteMoversEnabled: false, autoPromoteThreshold: 7 });
      const cfg = setAutotradeConfig({ riskProfile: 'AGGRESSIVE' });
      expect(cfg.autoPromoteMoversEnabled).toBe(false);
      expect(cfg.autoPromoteThreshold).toBe(7);
      expect(cfg.riskProfile).toBe('AGGRESSIVE');
    });
  });
});

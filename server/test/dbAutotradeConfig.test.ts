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
});

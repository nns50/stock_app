import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { getTradingConfig, setTradingConfig, setKillSwitch } from '../src/db/trading';
import { defaultTradingConfig } from '../src/services/trading/guardrails';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM trading_config'));

describe('trading config persistence', () => {
  it('returns conservative defaults when unset', () => {
    expect(getTradingConfig()).toEqual(defaultTradingConfig());
  });

  it('persists a partial patch over defaults and round-trips', () => {
    const cfg = setTradingConfig({ maxOrderUsd: 1000, enabled: true });
    expect(cfg.maxOrderUsd).toBe(1000);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxDailyLossUsd).toBe(defaultTradingConfig().maxDailyLossUsd); // untouched
    expect(getTradingConfig()).toEqual(cfg); // survives a fresh read
  });

  it('merges successive patches in a single row', () => {
    setTradingConfig({ maxOrderUsd: 1000 });
    const cfg = setTradingConfig({ maxDailyLossUsd: 500 });
    expect(cfg.maxOrderUsd).toBe(1000); // preserved across patches
    expect(cfg.maxDailyLossUsd).toBe(500);
    expect((db.prepare('SELECT COUNT(*) AS n FROM trading_config').get() as { n: number }).n).toBe(1);
  });

  it('toggles and persists the kill switch', () => {
    expect(getTradingConfig().killSwitch).toBe(false);
    expect(setKillSwitch(true).killSwitch).toBe(true);
    expect(getTradingConfig().killSwitch).toBe(true);
    expect(setKillSwitch(false).killSwitch).toBe(false);
    expect(getTradingConfig().killSwitch).toBe(false);
  });

  it('clamps unsafe values (no negative caps, fat-finger 0..100)', () => {
    const cfg = setTradingConfig({ maxOrderUsd: -5, fatFingerPct: 250 });
    expect(cfg.maxOrderUsd).toBe(defaultTradingConfig().maxOrderUsd); // negative rejected
    expect(cfg.fatFingerPct).toBe(100); // clamped to the ceiling
  });

  it('falls back to defaults on a corrupt stored blob', () => {
    db.prepare('INSERT INTO trading_config (id, config, updated_at) VALUES (1, ?, ?)').run('not json', Date.now());
    expect(getTradingConfig()).toEqual(defaultTradingConfig());
  });
});

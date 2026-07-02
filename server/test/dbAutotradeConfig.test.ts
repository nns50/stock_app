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
});

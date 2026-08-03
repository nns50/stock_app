import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb } from '../src/db';
import {
  defaultAutotradeConfig,
  getAutotradeConfig,
  setAutotradeConfig,
  AutotradeConfig,
} from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { db } from '../src/db';
import { computeTargetTune } from '../src/services/autotrading/targetTune';
import {
  REANCHOR_THRESHOLD_PCT,
  decideLiveCapsReanchor,
  deriveDollarCaps,
  reanchorLiveCapsIfDrifted,
} from '../src/services/autotrading/liveCapsReanchor';

/** A config whose four $ caps are exactly what a tune at `equity` derives —
 *  i.e. the state right after a tune apply, which is what arms re-anchoring. */
function tunedConfig(equity: number, over: Partial<AutotradeConfig> = {}): AutotradeConfig {
  const base = { ...defaultAutotradeConfig(), maxDailyDrawdownPct: 13.05, riskProfile: 'AGGRESSIVE' as const };
  const caps = deriveDollarCaps(base, equity);
  return { ...base, ...caps, liveCapsAnchorEquityUsd: equity, accountEquityUsd: equity, ...over };
}

describe('deriveDollarCaps', () => {
  it('matches the tune generator exactly — one formula, not two', () => {
    // If shapeToPatch and deriveDollarCaps ever disagree, a freshly-applied
    // tune would immediately look "hand-edited" and re-anchoring would never
    // run. Tie them together on a real tune result.
    const equity = 6917.07;
    const tune = computeTargetTune({
      equityUsd: equity,
      targetDailyGainPct: 10,
      basis: 'expected',
      config: { autoTuneEnabled: false, autoTuneExitsEnabled: false },
    });
    const derived = deriveDollarCaps(
      { maxDailyDrawdownPct: tune.patch.maxDailyDrawdownPct, riskProfile: tune.patch.riskProfile },
      equity,
    );
    expect(tune.patch.liveMaxOrderUsd).toBe(derived.liveMaxOrderUsd);
    expect(tune.patch.liveMaxDailyLossUsd).toBe(derived.liveMaxDailyLossUsd);
    expect(tune.patch.liveOptionsMaxOrderUsd).toBe(derived.liveOptionsMaxOrderUsd);
    expect(tune.patch.liveOptionsMaxDailyLossUsd).toBe(derived.liveOptionsMaxDailyLossUsd);
    // …and the tune arms the anchor with the same equity it derived from.
    expect(tune.patch.liveCapsAnchorEquityUsd).toBe(equity);
  });
});

describe('decideLiveCapsReanchor', () => {
  it('is a no-op until a tune has armed the anchor', () => {
    const cfg = { ...defaultAutotradeConfig(), accountEquityUsd: 50_000 };
    expect(cfg.liveCapsAnchorEquityUsd).toBeNull();
    expect(decideLiveCapsReanchor(cfg, 50_000)).toMatchObject({
      action: 'skip',
      reason: expect.stringMatching(/not armed/),
    });
  });

  it('skips without usable equity — never re-derives caps from nothing', () => {
    const cfg = tunedConfig(10_000);
    for (const equity of [null, undefined, 0, -5]) {
      expect(decideLiveCapsReanchor(cfg, equity)).toMatchObject({
        action: 'skip',
        reason: expect.stringMatching(/equity/),
      });
    }
  });

  it('holds while drift is inside the threshold, in both directions', () => {
    const cfg = tunedConfig(10_000);
    for (const equity of [10_000, 11_499, 8_501]) {
      expect(decideLiveCapsReanchor(cfg, equity).action).toBe('skip');
    }
  });

  it('re-derives all four caps and moves the anchor once drift reaches the threshold', () => {
    const cfg = tunedConfig(10_000);
    const grown = 10_000 * (1 + REANCHOR_THRESHOLD_PCT / 100); // exactly at threshold
    const d = decideLiveCapsReanchor(cfg, grown);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') return;
    const expected = deriveDollarCaps(cfg, grown);
    expect(d.patch).toEqual({ liveCapsAnchorEquityUsd: grown, ...expected });
    expect(d.handEdited).toEqual([]);
    // The caps actually moved — this is not a rounding no-op.
    expect(expected.liveMaxDailyLossUsd).toBeGreaterThan(cfg.liveMaxDailyLossUsd);
  });

  it('tightens on the way DOWN — the direction that matters most', () => {
    // A shrinking account with frozen dollar caps is the dangerous case: the
    // caps grow as a fraction of what's left, loosening exactly when losses
    // are compounding.
    const cfg = tunedConfig(10_000);
    const d = decideLiveCapsReanchor(cfg, 6_000);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') return;
    expect(d.patch.liveMaxDailyLossUsd).toBeLessThan(cfg.liveMaxDailyLossUsd);
    expect(d.patch.liveMaxOrderUsd).toBeLessThan(cfg.liveMaxOrderUsd);
  });

  it('never touches a hand-edited cap, but still moves the others and the anchor', () => {
    // The user deliberately set a tighter daily-loss cap than the tune's.
    const cfg = tunedConfig(10_000, { liveMaxDailyLossUsd: 500 });
    const d = decideLiveCapsReanchor(cfg, 13_000);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') return;
    expect(d.handEdited).toEqual(['liveMaxDailyLossUsd']);
    expect(d.patch.liveMaxDailyLossUsd).toBeUndefined();
    expect(d.patch.liveMaxOrderUsd).toBe(deriveDollarCaps(cfg, 13_000).liveMaxOrderUsd);
    expect(d.patch.liveCapsAnchorEquityUsd).toBe(13_000);
  });

  it('with every cap hand-edited it only moves the anchor — and so cannot churn', () => {
    const cfg = tunedConfig(10_000, {
      liveMaxOrderUsd: 111,
      liveMaxDailyLossUsd: 222,
      liveOptionsMaxOrderUsd: 333,
      liveOptionsMaxDailyLossUsd: 444,
    });
    const d = decideLiveCapsReanchor(cfg, 20_000);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') return;
    expect(Object.keys(d.patch)).toEqual(['liveCapsAnchorEquityUsd']);
    expect(d.handEdited).toHaveLength(4);
    // Anchor moved, so the same equity won't re-trip next tick.
    const after = { ...cfg, ...d.patch } as AutotradeConfig;
    expect(decideLiveCapsReanchor(after, 20_000).action).toBe('skip');
  });

  it('converges: immediately after a re-anchor, the same equity is a skip', () => {
    const cfg = tunedConfig(10_000);
    const d = decideLiveCapsReanchor(cfg, 12_000);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') return;
    const after = { ...cfg, ...d.patch } as AutotradeConfig;
    expect(decideLiveCapsReanchor(after, 12_000).action).toBe('skip');
    // …and a freshly re-anchored config's caps read as "ours", not hand-edited.
    const dd = decideLiveCapsReanchor(after, 15_000);
    expect(dd.action).toBe('reanchor');
    if (dd.action === 'reanchor') expect(dd.handEdited).toEqual([]);
  });
});

describe('reanchorLiveCapsIfDrifted (DB + journal)', () => {
  beforeAll(() => initDb());
  beforeEach(() => db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events;'));

  it('writes the re-derived caps and journals one config event', () => {
    const cfg = tunedConfig(10_000);
    setAutotradeConfig(cfg);
    // Simulate the per-tick equity sync having moved equity 20% up.
    setAutotradeConfig({ accountEquityUsd: 12_000 });

    const d = reanchorLiveCapsIfDrifted();
    expect(d.action).toBe('reanchor');

    const after = getAutotradeConfig();
    expect(after.liveCapsAnchorEquityUsd).toBe(12_000);
    expect(after.liveMaxDailyLossUsd).toBe(deriveDollarCaps(after, 12_000).liveMaxDailyLossUsd);

    const events = listAutotradeEvents({ stage: 'config' });
    const mine = events.filter((e) => e.action === 'live_caps_reanchored');
    expect(mine).toHaveLength(1);
    const detail = JSON.parse(mine[0].detail!) as {
      anchorEquityUsd: number;
      currentEquityUsd: number;
      changes: Record<string, { from: number; to: number }>;
      skippedHandEdited: string[];
    };
    expect(detail.anchorEquityUsd).toBe(10_000);
    expect(detail.currentEquityUsd).toBe(12_000);
    expect(Object.keys(detail.changes)).toHaveLength(4);
    expect(detail.skippedHandEdited).toEqual([]);
  });

  it('unarmed config: writes nothing, journals nothing', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 50_000 });
    const before = getAutotradeConfig();

    expect(reanchorLiveCapsIfDrifted().action).toBe('skip');

    expect(getAutotradeConfig()).toEqual(before);
    expect(listAutotradeEvents({ stage: 'config' }).filter((e) => e.action === 'live_caps_reanchored')).toHaveLength(0);
  });
});

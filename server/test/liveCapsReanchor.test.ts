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
import { computeTargetTune, sizerFloorUsd } from '../src/services/autotrading/targetTune';
import {
  REANCHOR_THRESHOLD_PCT,
  decideLiveCapsReanchor,
  deriveDollarCaps,
  handEditedDollarCaps,
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
  // If shapeToPatch and deriveDollarCaps ever disagree, a freshly-applied tune
  // immediately looks "hand-edited": re-anchoring never runs on that cap, and
  // (since 2026-08-25) the next tune preserves a value it wrote itself.
  //
  // This used to be checked on ONE band, and the CONSERVATIVE band was quietly
  // failing it the whole time — it derived 0.2 × equity while everything that
  // reads the cap back derived 0.25, because the config stores only
  // MODERATE/AGGRESSIVE and a conservative tune journals as MODERATE. Every
  // band is checked now, which is what caught it.
  it.each([1, 3, 5, 8, 10, 12])(
    'matches the tune generator exactly at a %i pct/day target — one formula, not two',
    (target) => {
      const equity = 6917.07;
      const tune = computeTargetTune({
        equityUsd: equity,
        targetDailyGainPct: target,
        basis: 'expected',
        config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
      });
      const derived = deriveDollarCaps(
        {
          maxDailyDrawdownPct: tune.patch.maxDailyDrawdownPct,
          riskProfile: tune.patch.riskProfile,
          riskPerTradePct: tune.patch.riskPerTradePct,
          maxStopDistancePct: defaultAutotradeConfig().maxStopDistancePct,
        },
        equity,
      );
      expect(tune.patch.liveMaxOrderUsd).toBe(derived.liveMaxOrderUsd);
      expect(tune.patch.liveMaxDailyLossUsd).toBe(derived.liveMaxDailyLossUsd);
      expect(tune.patch.liveOptionsMaxOrderUsd).toBe(derived.liveOptionsMaxOrderUsd);
      expect(tune.patch.liveOptionsMaxDailyLossUsd).toBe(derived.liveOptionsMaxDailyLossUsd);
      // …and the tune arms the anchor with the same equity it derived from.
      expect(tune.patch.liveCapsAnchorEquityUsd).toBe(equity);
    },
  );

  it('leaves a fresh tune with NOTHING looking hand-edited, on any band', () => {
    for (const target of [1, 3, 5, 8, 10, 12]) {
      const equity = 6917.07;
      const tune = computeTargetTune({
        equityUsd: equity,
        targetDailyGainPct: target,
        basis: 'expected',
        config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
      });
      const applied = { ...defaultAutotradeConfig(), ...tune.patch } as AutotradeConfig;
      expect(handEditedDollarCaps(applied)).toEqual([]);
    }
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

// ---------------------------------------------------------------------------
// The order cap must never sit below the sizer's own floor (2026-08-27).
//
// The cap formula allowed a band fraction of equity (25% moderate) while the
// sizer produces riskPerTradePct/maxStopDistancePct of it — 50% at 1.25/2.5.
// A correctly-sized position could never fit its own cap, and re-anchoring
// would have made it WORSE, rewriting $1,600 down to $1,290. It surfaced
// twice in one day: once at $2,283 of equity, and again after a $5,000
// deposit doubled the sizer's output while the stored cap stayed put.
// ---------------------------------------------------------------------------
describe('the per-order cap and the position sizer cannot contradict each other', () => {
  const sizing = { riskPerTradePct: 1.25, maxStopDistancePct: 2.5 }; // sizer makes 50% of equity

  it('derives a cap at or above the smallest order the sizer can produce', () => {
    const cfg = { ...defaultAutotradeConfig(), ...sizing, riskProfile: 'MODERATE' as const };
    for (const equity of [2_283, 2_450, 5_142, 20_000]) {
      const cap = deriveDollarCaps(cfg, equity).liveMaxOrderUsd;
      const floor = sizerFloorUsd(cfg, equity);
      expect(cap).toBeGreaterThanOrEqual(floor);
    }
  });

  it('takes the band fraction when IT is the larger — the fat-finger intent is not lost', () => {
    // A wide stop ceiling makes the sizer's floor small, and then the original
    // 25%-of-equity backstop is what should bind.
    const cfg = {
      ...defaultAutotradeConfig(),
      riskPerTradePct: 1,
      maxStopDistancePct: 20, // floor is only 5% of equity
      riskProfile: 'MODERATE' as const,
    };
    const cap = deriveDollarCaps(cfg, 10_000).liveMaxOrderUsd;
    expect(cap).toBe(2_500); // 25% of equity, not the 750 the sizer floor would give
  });

  it('is bounded by buying power when the caller knows it', () => {
    // A cap above what the account can fund is not a cap worth having — the
    // broker refuses the order anyway and the cap only hides the refusal.
    const cfg = { ...defaultAutotradeConfig(), ...sizing, riskProfile: 'MODERATE' as const };
    const unbounded = deriveDollarCaps(cfg, 10_000).liveMaxOrderUsd;
    const bounded = deriveDollarCaps(cfg, 10_000, 3_000).liveMaxOrderUsd;
    expect(bounded).toBe(3_000);
    expect(bounded).toBeLessThan(unbounded);
    // 0/undefined leaves it unbounded.
    expect(deriveDollarCaps(cfg, 10_000, 0).liveMaxOrderUsd).toBe(unbounded);
  });

  it('re-anchors on a BLOCKING cap even when drift is far inside the threshold', () => {
    // The 2026-08-27 shape exactly: cap $1,600, sizer floor $2,581, drift 4%.
    // Drift alone would have waited for another 11% move while the loop placed
    // nothing at all.
    const cfg: AutotradeConfig = {
      ...defaultAutotradeConfig(),
      ...sizing,
      riskProfile: 'MODERATE',
      liveMaxOrderUsd: 1_600,
      liveCapsAnchorEquityUsd: 5_352,
      accountEquityUsd: 5_161,
    };
    expect(sizerFloorUsd(cfg, 5_161)).toBeGreaterThan(cfg.liveMaxOrderUsd);

    const d = decideLiveCapsReanchor(cfg, 5_161);

    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') throw new Error('unreachable');
    expect(d.driftPct).toBeLessThan(REANCHOR_THRESHOLD_PCT);
    // The $1,600 was hand-set, so "only move what you own" would normally
    // leave it. Correctness overrides that: a cap that blocks every order is
    // not a preference being honoured.
    expect(d.handEdited).not.toContain('liveMaxOrderUsd');
    expect(d.patch.liveMaxOrderUsd!).toBeGreaterThanOrEqual(sizerFloorUsd(cfg, 5_161));
  });

  it('still holds when the cap is NOT blocking and drift is small — no churn', () => {
    // The pair to the case above: same small drift, but a cap that clears the
    // floor. Without this, the new trigger would re-anchor on every tick.
    const cfg: AutotradeConfig = {
      ...defaultAutotradeConfig(),
      ...sizing,
      riskProfile: 'MODERATE',
      liveMaxOrderUsd: 9_000,
      liveCapsAnchorEquityUsd: 5_352,
      accountEquityUsd: 5_161,
    };
    expect(decideLiveCapsReanchor(cfg, 5_161).action).toBe('skip');
  });
});

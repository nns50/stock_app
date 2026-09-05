import { describe, it, expect } from 'vitest';
import {
  computeTargetTune,
  resetToModerate,
  bandForTarget,
  ASSUMED_WIN_RATE,
  MAX_SUGGESTED_RISK_PER_TRADE_PCT,
  NEVER_TUNED_KEYS,
  TuneBasis,
  deriveDollarCaps,
  handEditedDollarCaps,
} from '../src/services/autotrading/targetTune';
// The consumer of the caps a tune stores. Imported here on purpose: the
// freeze-out this file guards against is a disagreement BETWEEN these two
// modules, so a test that only ever exercises one of them cannot see it.
import { decideLiveCapsReanchor } from '../src/services/autotrading/liveCapsReanchor';
import { defaultAutotradeConfig, AutotradeConfig } from '../src/db/autotradeConfig';

const base = (over: {
  targetDailyGainPct: number;
  basis?: TuneBasis;
  equityUsd?: number;
  autoTuneEnabled?: boolean;
  autoTuneExitsEnabled?: boolean;
  /** Dollar caps / anchor, for the hand-edit preservation cases. Defaults leave
   *  the anchor null — not armed, so nothing is treated as hand-edited. */
  config?: Partial<AutotradeConfig>;
}) =>
  computeTargetTune({
    equityUsd: over.equityUsd ?? 1000,
    targetDailyGainPct: over.targetDailyGainPct,
    basis: over.basis ?? 'expected',
    config: {
      ...defaultAutotradeConfig(),
      autoTuneEnabled: over.autoTuneEnabled ?? false,
      autoTuneExitsEnabled: over.autoTuneExitsEnabled ?? false,
      ...over.config,
    },
  });

describe('bandForTarget', () => {
  it('maps target gain % to a band by fixed thresholds', () => {
    expect(bandForTarget(1)).toBe('conservative');
    expect(bandForTarget(3)).toBe('conservative');
    expect(bandForTarget(3.01)).toBe('moderate');
    expect(bandForTarget(8)).toBe('moderate');
    expect(bandForTarget(8.01)).toBe('aggressive');
    expect(bandForTarget(50)).toBe('aggressive');
  });
});

describe('computeTargetTune — sizing solve', () => {
  it('matches the worked example: 5%/day, $1000, expected basis -> ~2.4% risk', () => {
    const r = base({ targetDailyGainPct: 5, basis: 'expected' });
    expect(r.band).toBe('moderate');
    // edgeR = 0.45*2 - 0.55 = 0.35; risk = 5 / (6 * 0.35) = 2.38
    expect(r.edgeR).toBeCloseTo(ASSUMED_WIN_RATE * 2 - 0.55, 5);
    expect(r.patch.riskPerTradePct).toBeCloseTo(2.38, 1);
  });

  it('perfect-day basis sizes DOWN vs expected for the same target', () => {
    const expected = base({ targetDailyGainPct: 5, basis: 'expected' });
    const perfect = base({ targetDailyGainPct: 5, basis: 'perfectDay' });
    // perfect-day edgeR = R = 2, so risk = 5/(6*2) = 0.42 — much smaller
    expect(perfect.patch.riskPerTradePct).toBeCloseTo(0.42, 1);
    expect(perfect.patch.riskPerTradePct).toBeLessThan(expected.patch.riskPerTradePct);
  });

  it('derives the dependent caps from the solved risk %', () => {
    const r = base({ targetDailyGainPct: 5, basis: 'expected', equityUsd: 1000 });
    const risk = r.patch.riskPerTradePct;
    // aggregate = risk * maxConcurrentPositions (moderate band = 2)
    expect(r.patch.maxAggregateOpenRiskPct).toBeCloseTo(risk * 2, 2);
    // drawdown = maxTradesPerDay(6) * risk * 0.75
    expect(r.patch.maxDailyDrawdownPct).toBeCloseTo(6 * risk * 0.75, 1);
    // dollar caps scale with equity
    expect(r.patch.liveMaxOrderUsd).toBe(250); // 1000 * 0.25 moderate fraction
    expect(r.patch.liveMaxDailyLossUsd).toBe(Math.round(1000 * (r.patch.maxDailyDrawdownPct / 100)));
    // entries (6) + one exit each — NOT maxTradesPerDay itself; see liveOrderCapForTrades
    expect(r.patch.liveMaxOrdersPerDay).toBe(12);
    // options dollar caps mirror the equity ones
    expect(r.patch.liveOptionsMaxOrderUsd).toBe(r.patch.liveMaxOrderUsd);
    expect(r.patch.liveOptionsMaxDailyLossUsd).toBe(r.patch.liveMaxDailyLossUsd);
  });

  it('scales dollar caps with equity', () => {
    const r = base({ targetDailyGainPct: 5, equityUsd: 50000 });
    expect(r.patch.liveMaxOrderUsd).toBe(Math.round(50000 * 0.25));
  });
});

describe('computeTargetTune — band shapes', () => {
  it('a conservative target sets tighter filters and the MODERATE label', () => {
    const r = base({ targetDailyGainPct: 2 });
    expect(r.band).toBe('conservative');
    expect(r.patch.riskProfile).toBe('MODERATE');
    expect(r.patch.minRelVol).toBe(2);
    expect(r.patch.maxConcurrentPositions).toBe(2);
    expect(r.patch.optionsDeltaMax).toBe(0.5);
    // screening floors are at their strictest: B-grade-or-better conviction
    // (convictionGradeBMinScore's default), no sub-$5 names, 1M shares/day
    expect(r.patch.minSignalScore).toBe(60);
    expect(r.patch.minPrice).toBe(5);
    expect(r.patch.minAvgVolume).toBe(1_000_000);
    // options cheapness gate at its tightest: implied no richer than realized
    expect(r.patch.optionsMaxIvRvRatio).toBe(1);
  });

  it('an aggressive target loosens everything and sets the AGGRESSIVE label', () => {
    const r = base({ targetDailyGainPct: 20 });
    expect(r.band).toBe('aggressive');
    expect(r.patch.riskProfile).toBe('AGGRESSIVE');
    expect(r.patch.maxConcurrentPositions).toBe(5);
    expect(r.patch.maxTradesPerDay).toBe(10);
    expect(r.patch.maxSectorExposurePct).toBe(35);
    expect(r.patch.optionsDeltaMax).toBe(0.7);
    expect(r.patch.optionsIvRankMax).toBe(85);
    // screening floors loosen to the engine's old constants but never disable
    expect(r.patch.minSignalScore).toBe(40);
    expect(r.patch.minPrice).toBe(1);
    expect(r.patch.minAvgVolume).toBe(200_000);
    // the fail-closed IV/RV cheapness gate goes OFF — this band needs the flow
    expect(r.patch.optionsMaxIvRvRatio).toBe(0);
  });

  it('keeps the options IV-rank floor OFF in every band (long-premium selection)', () => {
    for (const target of [2, 5, 20]) {
      expect(base({ targetDailyGainPct: target }).patch.optionsIvRankMin).toBe(0);
    }
  });
});

describe('computeTargetTune — clamps and warnings', () => {
  it('clamps the suggested risk % and warns when the target is unreachable safely', () => {
    const r = base({ targetDailyGainPct: 100, basis: 'expected' });
    expect(r.rawRiskPerTradePct).toBeGreaterThan(MAX_SUGGESTED_RISK_PER_TRADE_PCT);
    expect(r.patch.riskPerTradePct).toBe(MAX_SUGGESTED_RISK_PER_TRADE_PCT);
    expect(r.warnings.some((w) => /capped/i.test(w))).toBe(true);
  });

  it('warns when suggested risk is aggressive (>=3%)', () => {
    const r = base({ targetDailyGainPct: 20, basis: 'expected' });
    expect(r.patch.riskPerTradePct).toBeGreaterThanOrEqual(3);
    expect(r.warnings.some((w) => /aggressive/i.test(w))).toBe(true);
  });

  it('warns when auto-tune is enabled (it will re-move the risk %)', () => {
    const r = base({ targetDailyGainPct: 5, autoTuneEnabled: true });
    expect(r.warnings.some((w) => /auto-tune/i.test(w))).toBe(true);
  });

  it('warns when the EXIT tuner is on — it moves the R multiple the risk % was solved from', () => {
    // targetRMultiple is an input to edgeRFor, so once excursionTune moves it the
    // risk % no longer corresponds to the target asked for, and nothing re-derives
    // it. The old warning named only risk-per-trade, so this overlap was silent.
    const r = base({ targetDailyGainPct: 5, autoTuneExitsEnabled: true });
    expect(r.warnings.some((w) => /exit geometry/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /no longer matches 5%\/day/i.test(w))).toBe(true);
  });

  it('does not warn about exit geometry when that tuner is off', () => {
    const r = base({ targetDailyGainPct: 5 });
    expect(r.warnings.some((w) => /exit geometry/i.test(w))).toBe(false);
  });

  it('caps the daily-loss halt at 40% and floors it at 2%', () => {
    const high = base({ targetDailyGainPct: 60, basis: 'expected' });
    expect(high.patch.maxDailyDrawdownPct).toBeLessThanOrEqual(40);
    const low = base({ targetDailyGainPct: 5, basis: 'perfectDay' }); // tiny risk -> floored
    expect(low.patch.maxDailyDrawdownPct).toBeGreaterThanOrEqual(2);
  });
});

describe('resetToModerate', () => {
  it('matches the published moderate band row, which is NOT defaultAutotradeConfig()', () => {
    // "Reset to moderate" means the moderate row of the band table in
    // docs/TUNE_FROM_TARGET.md §5 — not the shipped defaults. These fields are
    // where the two legitimately differ, so pin them: the daily-loss halt is
    // DERIVED from the sizing (6 trades x 1% x 0.75); the options exits, the
    // conviction floor, and the IV/RV gate come from the band (all ship at 0 =
    // disabled so untouched configs don't change behavior, but a preset the
    // user asks for takes a stance); the liquidity floors sit a notch above
    // the shipped engine constants.
    const p = resetToModerate(10000, defaultAutotradeConfig().maxStopDistancePct);
    expect(p.maxDailyDrawdownPct).toBe(4.5);
    expect(p.optionsStopLossPct).toBe(50);
    expect(p.optionsTakeProfitPct).toBe(80);
    expect(p.minSignalScore).toBe(50);
    expect(p.optionsMaxIvRvRatio).toBe(1.2);
    expect(p.minPrice).toBe(2);
    expect(p.minAvgVolume).toBe(500_000);
    const d = defaultAutotradeConfig();
    expect(d.maxDailyDrawdownPct).toBe(3);
    expect(d.optionsStopLossPct).toBe(0);
    expect(d.optionsTakeProfitPct).toBe(0);
    expect(d.minSignalScore).toBe(0);
    expect(d.optionsMaxIvRvRatio).toBe(0);
    expect(d.minPrice).toBe(1);
    expect(d.minAvgVolume).toBe(200_000);
  });

  it('reproduces the default MODERATE shape at 1% risk, equity-scaled', () => {
    const p = resetToModerate(10000, defaultAutotradeConfig().maxStopDistancePct);
    expect(p.riskProfile).toBe('MODERATE');
    expect(p.riskPerTradePct).toBe(1);
    expect(p.maxConcurrentPositions).toBe(2);
    expect(p.maxTradesPerDay).toBe(6);
    expect(p.minRelVol).toBe(1.5);
    expect(p.targetRMultiple).toBe(2);
    // dollar caps scale with the passed equity
    expect(p.liveMaxOrderUsd).toBe(2500); // 10000 * 0.25
    // aggregate = 1% * 2 positions
    expect(p.maxAggregateOpenRiskPct).toBeCloseTo(2, 5);
  });

  it('never emits the safety/identity fields (only the tunable allowlist)', () => {
    const p = resetToModerate(1000, defaultAutotradeConfig().maxStopDistancePct) as Record<string, unknown>;
    for (const forbidden of [
      'enabled',
      'killSwitch',
      'liveTradingEnabled',
      'liveOptionsEnabled',
      'liveAccountId',
      'accountEquityUsd',
      'liveProbationTrades',
      'autoTuneEnabled',
      'tradeDirection',
      'moversDiscoveryEnabled',
    ]) {
      expect(p[forbidden]).toBeUndefined();
    }
  });
});

describe('tunable/never-tuned classification', () => {
  // The positive direction the old allowlist test lacked: EVERY config field
  // must be either written by the tuner or deliberately listed in
  // NEVER_TUNED_KEYS. This is how minPrice/minAvgVolume/minSignalScore/
  // moversDiscoveryEnabled/optionsIvRankMin/optionsMaxIvRvRatio slipped past
  // the tuner unnoticed when they were added — nothing failed. Now adding a
  // config field without classifying it fails here (and fails typecheck via
  // targetTune.ts's UnclassifiedAutotradeConfigKey assertion).
  it('classifies every AutotradeConfig field as tuned or deliberately untouched', () => {
    const tuned = new Set(Object.keys(resetToModerate(1000, defaultAutotradeConfig().maxStopDistancePct)));
    const excluded = new Set<string>(NEVER_TUNED_KEYS);
    for (const key of Object.keys(defaultAutotradeConfig())) {
      const classified = tuned.has(key) || excluded.has(key);
      expect(classified, `config field "${key}" is neither tuned nor in NEVER_TUNED_KEYS`).toBe(true);
      const both = tuned.has(key) && excluded.has(key);
      expect(both, `config field "${key}" is on BOTH lists`).toBe(false);
    }
  });

  it('emits every allowlisted key, so a tune fully overwrites a stale shape', () => {
    // If a key is in TunablePatch but shapeToPatch forgets to write it, the
    // patch silently leaves that field at whatever it was — the classification
    // above can't see it (it reads the emitted patch), so pin the count too.
    const emitted = Object.keys(resetToModerate(1000, defaultAutotradeConfig().maxStopDistancePct)).length;
    expect(emitted + NEVER_TUNED_KEYS.length).toBe(Object.keys(defaultAutotradeConfig()).length);
  });
});

// ---------------------------------------------------------------------------
// Hand-edited dollar caps (2026-08-25). liveCapsReanchor has always refused to
// move a cap a human set — and its header called that "the same rule that keeps
// the tune itself from stomping deliberate config". The tune did not actually
// enforce it, so applying one silently reverted a hand-raised cap while the
// re-anchor carefully preserved it. Live consequence: liveMaxOrderUsd had been
// raised from the derived $439 to $1,600 because the derived value sat BELOW
// what correct sizing produces on a small account and blocked every entry
// ("order_notional: $1,236.06 vs cap $439.00"); a retune would have restored
// exactly that state.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Funding must NOT reach a stored cap (2026-09-05). deriveDollarCaps briefly
// bounded its per-order caps by buying power. The premise was reasonable -- an
// order the account cannot fund is not a cap worth having -- but it made the
// function's output depend on a number only ONE of its three call sites can
// observe. The tune apply has a broker call; handEditedDollarCaps and
// liveCapsReanchor work from config alone, by design. So on any day funding
// actually bound the cap, the tune STORED the smaller figure while the anchor
// check re-derived the larger one, the two disagreed, and the cap was flagged
// hand-edited and skipped by every future re-anchor -- frozen for good by one
// afternoon's buying power. That is the exact trap the options twin's own
// comment already described.
//
// The bound lives at decision time now (fundableMaxQuantity, PR #492), where
// the live figure is genuinely in hand. Buying power still reaches the tune,
// but only to WARN.
// ---------------------------------------------------------------------------
describe('deriveDollarCaps — funding never binds a stored cap', () => {
  const cfg = {
    maxDailyDrawdownPct: 6.42,
    riskProfile: 'MODERATE' as const,
    riskPerTradePct: 1.25,
    maxStopDistancePct: 2.5,
  };
  // The real 2026-08-27 account: sizer floor is 1.25/2.5 = 50% of equity, so
  // bySizer (x1.5) = 75% wins over the moderate band's 25%.
  const EQUITY = 5_161.18;
  const DERIVED = Math.round(EQUITY * 0.5 * 1.5); // 3871

  it('derives from equity and the percentages alone', () => {
    const caps = deriveDollarCaps(cfg, EQUITY);
    expect(caps.liveMaxOrderUsd).toBe(DERIVED);
    expect(caps.liveOptionsMaxOrderUsd).toBe(DERIVED);
  });

  it('takes exactly two arguments — there is no funding input to pass', () => {
    // Pinned as a signature, because the freeze-out below is invisible to any
    // test that only ever calls this function one way. Restoring a third
    // parameter must break something here rather than in production a month on.
    expect(deriveDollarCaps.length).toBe(2);
  });

  it('keeps the options twin equal to the equity cap, on purpose', () => {
    // Option BP is a much smaller pool ($322-471 that day against a day BP of
    // $8,644), but these are STORED caps and liveCapsReanchor re-derives them
    // from config alone, with no broker call. Same reasoning that removed the
    // equity-side bound; the options side never grew one.
    const caps = deriveDollarCaps(cfg, EQUITY);
    expect(caps.liveOptionsMaxOrderUsd).toBe(caps.liveMaxOrderUsd);
  });

  it('leaves the daily-loss caps tracking the tuned drawdown %', () => {
    const caps = deriveDollarCaps(cfg, EQUITY);
    expect(caps.liveMaxDailyLossUsd).toBe(Math.round(EQUITY * 0.0642));
    expect(caps.liveOptionsMaxDailyLossUsd).toBe(caps.liveMaxDailyLossUsd);
  });
});

// The consumer-level assertion, which is the one that actually mattered: what
// a tune STORES must still read as derived to the re-anchor. Asserting the
// arithmetic of deriveDollarCaps proved nothing about this -- the bug lived in
// the disagreement between two callers, not inside either one.
describe('a tune run under tight funding does not freeze its caps', () => {
  const EQUITY = 5_161.18;
  const STARVED_BP = 900; // well below the ~$3.9k the shape derives

  const applied = (): AutotradeConfig => {
    const { patch } = computeTargetTune({
      equityUsd: EQUITY,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...defaultAutotradeConfig(), liveCapsAnchorEquityUsd: null },
      buyingPowerUsd: STARVED_BP,
    });
    // What applying the patch leaves in the database: the tuned fields, plus
    // the anchor every apply stamps.
    return { ...defaultAutotradeConfig(), ...patch, liveCapsAnchorEquityUsd: EQUITY };
  };

  it('stores caps the re-anchor still recognises as its own', () => {
    expect(handEditedDollarCaps(applied())).toEqual([]);
  });

  it('so a later re-anchor moves them instead of skipping them', () => {
    // 20% growth, past REANCHOR_THRESHOLD_PCT. Before the fix the per-order
    // caps sat at $900 while the anchor derived ~$3.9k, so both were named in
    // skippedHandEdited and stayed at $900 through every future re-anchor.
    const grown = EQUITY * 1.2;
    const d = decideLiveCapsReanchor({ ...applied(), accountEquityUsd: grown }, grown);
    expect(d.action).toBe('reanchor');
    if (d.action !== 'reanchor') throw new Error('unreachable');
    expect(d.handEdited).toEqual([]);
    expect(d.patch.liveMaxOrderUsd).toBe(deriveDollarCaps(applied(), grown).liveMaxOrderUsd);
  });

  it('warns about the funding gap rather than silently shrinking the cap', () => {
    const { patch, warnings } = computeTargetTune({
      equityUsd: EQUITY,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...defaultAutotradeConfig(), liveCapsAnchorEquityUsd: null },
      buyingPowerUsd: STARVED_BP,
    });
    expect(patch.liveMaxOrderUsd).toBeGreaterThan(STARVED_BP);
    expect(warnings.some((w) => w.includes('buying power'))).toBe(true);
  });

  it('says nothing about funding when the cap fits inside it', () => {
    const { warnings } = computeTargetTune({
      equityUsd: EQUITY,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...defaultAutotradeConfig(), liveCapsAnchorEquityUsd: null },
      buyingPowerUsd: 1_000_000,
    });
    expect(warnings.some((w) => w.includes('buying power'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The patch must carry deriveDollarCaps's OWN options figures. shapeToPatch
// used to assign the equity cap to the options twin, so anything
// deriveDollarCaps decided for options was silently discarded -- and every
// unit test on deriveDollarCaps still passed, because none of them looked at
// the patch it feeds (found 2026-08-27).
// ---------------------------------------------------------------------------
describe('computeTargetTune — the patch carries the caps it derived', () => {
  it('takes every dollar cap from deriveDollarCaps, options twins included', () => {
    const equityUsd = 5_161.18;
    const r = base({ targetDailyGainPct: 3, equityUsd });
    const expected = deriveDollarCaps(
      {
        maxDailyDrawdownPct: r.patch.maxDailyDrawdownPct,
        riskProfile: r.patch.riskProfile,
        riskPerTradePct: r.patch.riskPerTradePct,
        maxStopDistancePct: defaultAutotradeConfig().maxStopDistancePct,
      },
      equityUsd,
    );
    expect(r.patch.liveMaxOrderUsd).toBe(expected.liveMaxOrderUsd);
    expect(r.patch.liveMaxDailyLossUsd).toBe(expected.liveMaxDailyLossUsd);
    expect(r.patch.liveOptionsMaxOrderUsd).toBe(expected.liveOptionsMaxOrderUsd);
    expect(r.patch.liveOptionsMaxDailyLossUsd).toBe(expected.liveOptionsMaxDailyLossUsd);
  });
});

describe('computeTargetTune — hand-edited dollar caps', () => {
  /** A config whose caps match what `anchor` derives — i.e. nothing hand-set. */
  const derivedAt = (anchor: number, over: Partial<AutotradeConfig> = {}): Partial<AutotradeConfig> => {
    const cfg = { ...defaultAutotradeConfig(), ...over };
    return { ...cfg, ...deriveDollarCaps(cfg, anchor), liveCapsAnchorEquityUsd: anchor };
  };

  it('keeps a hand-raised per-order cap instead of reverting it', () => {
    const r = base({
      targetDailyGainPct: 3,
      equityUsd: 2137,
      config: { ...derivedAt(2137), liveMaxOrderUsd: 1600 },
    });
    expect(r.patch.liveMaxOrderUsd).toBe(1600);
    expect(r.warnings.join(' ')).toMatch(/liveMaxOrderUsd/);
    // Untouched caps are still sized by the tune.
    expect(r.patch.liveMaxDailyLossUsd).not.toBe(1600);
  });

  it('still sizes every cap the human did NOT touch', () => {
    const r = base({ targetDailyGainPct: 3, equityUsd: 2137, config: derivedAt(2137) });
    const expected = deriveDollarCaps(
      {
        maxDailyDrawdownPct: r.patch.maxDailyDrawdownPct,
        riskProfile: r.patch.riskProfile,
        riskPerTradePct: r.patch.riskPerTradePct,
        maxStopDistancePct: defaultAutotradeConfig().maxStopDistancePct,
      },
      2137,
    );
    expect(r.patch.liveMaxOrderUsd).toBe(expected.liveMaxOrderUsd);
    expect(r.warnings.join(' ')).not.toMatch(/set by hand/);
  });

  it('preserves each cap independently, naming them all', () => {
    const r = base({
      targetDailyGainPct: 3,
      equityUsd: 2137,
      config: { ...derivedAt(2137), liveMaxOrderUsd: 1600, liveOptionsMaxDailyLossUsd: 77 },
    });
    expect(r.patch.liveMaxOrderUsd).toBe(1600);
    expect(r.patch.liveOptionsMaxDailyLossUsd).toBe(77);
    expect(r.warnings.join(' ')).toMatch(/liveMaxOrderUsd/);
    expect(r.warnings.join(' ')).toMatch(/liveOptionsMaxDailyLossUsd/);
  });

  it('is NOT armed without an anchor — a first tune sizes everything', () => {
    // No anchor equity means there is no way to tell a deliberate value from a
    // derived one, so nothing is preserved. Same posture as the re-anchor's no-op.
    const r = base({
      targetDailyGainPct: 3,
      equityUsd: 2137,
      config: { liveMaxOrderUsd: 1600, liveCapsAnchorEquityUsd: null },
    });
    expect(r.patch.liveMaxOrderUsd).not.toBe(1600);
    expect(r.warnings.join(' ')).not.toMatch(/set by hand/);
  });

  it('agrees with liveCapsReanchor on what counts as hand-edited', () => {
    // The two must use the SAME test, or a tune and a re-anchor would disagree
    // about which caps are the user's.
    const cfg = { ...defaultAutotradeConfig(), ...derivedAt(2137), liveMaxOrderUsd: 1600 } as AutotradeConfig;
    expect(handEditedDollarCaps(cfg)).toEqual(['liveMaxOrderUsd']);
    expect(handEditedDollarCaps({ ...cfg, liveMaxOrderUsd: deriveDollarCaps(cfg, 2137).liveMaxOrderUsd })).toEqual([]);
  });
});

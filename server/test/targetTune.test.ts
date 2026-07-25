import { describe, it, expect } from 'vitest';
import {
  computeTargetTune,
  resetToModerate,
  bandForTarget,
  ASSUMED_WIN_RATE,
  MAX_SUGGESTED_RISK_PER_TRADE_PCT,
  TuneBasis,
} from '../src/services/autotrading/targetTune';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';

const base = (over: {
  targetDailyGainPct: number;
  basis?: TuneBasis;
  equityUsd?: number;
  autoTuneEnabled?: boolean;
  autoTuneExitsEnabled?: boolean;
}) =>
  computeTargetTune({
    equityUsd: over.equityUsd ?? 1000,
    targetDailyGainPct: over.targetDailyGainPct,
    basis: over.basis ?? 'expected',
    config: {
      autoTuneEnabled: over.autoTuneEnabled ?? false,
      autoTuneExitsEnabled: over.autoTuneExitsEnabled ?? false,
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
    expect(r.patch.liveMaxOrdersPerDay).toBe(6);
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
    // docs/TUNE_FROM_TARGET.md §5 — not the shipped defaults. These three fields
    // are where the two legitimately differ, so pin them: the daily-loss halt is
    // DERIVED from the sizing (6 trades x 1% x 0.75), and the options exits come
    // from the band (both ship at 0 = disabled).
    const p = resetToModerate(10000);
    expect(p.maxDailyDrawdownPct).toBe(4.5);
    expect(p.optionsStopLossPct).toBe(50);
    expect(p.optionsTakeProfitPct).toBe(80);
    expect(defaultAutotradeConfig().maxDailyDrawdownPct).toBe(3);
    expect(defaultAutotradeConfig().optionsStopLossPct).toBe(0);
    expect(defaultAutotradeConfig().optionsTakeProfitPct).toBe(0);
  });

  it('reproduces the default MODERATE shape at 1% risk, equity-scaled', () => {
    const p = resetToModerate(10000);
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
    const p = resetToModerate(1000) as Record<string, unknown>;
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
    ]) {
      expect(p[forbidden]).toBeUndefined();
    }
  });
});

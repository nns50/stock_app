import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getDailyBaseline, saveDailyBaseline } from '../src/db/dailyBaseline';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { computeTargetTune, resetToModerate } from '../src/services/autotrading/targetTune';
import { evaluateDailyTarget, updateDailyTarget } from '../src/services/autotrading/dailyTarget';
import { etToday } from '../src/util/marketDate';

// A fixed instant: 2026-08-21 14:00 UTC = 10:00 ET (during the session).
const NOW = Date.parse('2026-08-21T14:00:00Z');
const TODAY = etToday(NOW);

describe('evaluateDailyTarget (pure)', () => {
  const cfg = (target: number | null, equity: number | null) => ({
    targetDailyGainPct: target,
    accountEquityUsd: equity,
  });
  const baseline = (equity: number, reachedAt: number | null = null) => ({
    etDate: TODAY,
    equityUsd: equity,
    reachedAt,
  });

  it('is inactive with no target set — the calibration-only tune never halts anything', () => {
    const s = evaluateDailyTarget(cfg(null, 10_000), baseline(10_000));
    expect(s).toMatchObject({ active: false, reached: false });
    expect(s.inactiveReason).toMatch(/no daily-gain target/);
  });

  it('is inactive without usable equity or a baseline — an unmeasurable goal never halts entries', () => {
    expect(evaluateDailyTarget(cfg(3, null), baseline(10_000))).toMatchObject({ active: false, reached: false });
    expect(evaluateDailyTarget(cfg(3, 10_000), null)).toMatchObject({ active: false, reached: false });
    expect(evaluateDailyTarget(cfg(3, 10_000), baseline(0))).toMatchObject({ active: false, reached: false });
  });

  it('measures the day: 3% of the day-start value, reached exactly at the line', () => {
    // Day started at 10,000 → the 3% goal banks at 10,300.
    expect(evaluateDailyTarget(cfg(3, 10_299.99), baseline(10_000))).toMatchObject({ active: true, reached: false });
    const s = evaluateDailyTarget(cfg(3, 10_300), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: true, targetEquityUsd: 10_300, gainPct: 3 });
  });

  it('reports negative progress honestly — behind is behind, never a halt', () => {
    const s = evaluateDailyTarget(cfg(3, 9_500), baseline(10_000));
    expect(s).toMatchObject({ active: true, reached: false, gainPct: -5 });
  });

  it('a recorded reach is STICKY: equity slipping back under the line stays banked', () => {
    // Reached earlier today at some point; equity has since faded to +1%.
    const s = evaluateDailyTarget(cfg(3, 10_100), baseline(10_000, NOW - 60_000));
    expect(s).toMatchObject({ active: true, reached: true, reachedAt: NOW - 60_000 });
  });
});

describe('updateDailyTarget (DB + journal)', () => {
  beforeAll(() => initDb());
  beforeEach(() =>
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM autotrade_daily_baseline;'),
  );

  it('captures the day-start baseline on the first tick of an ET day', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 12_345, targetDailyGainPct: 3 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: true, reached: false, baselineEquityUsd: 12_345 });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, equityUsd: 12_345, reachedAt: null });
  });

  it('rolls the baseline to the NEW day and clears the reach — the goal compounds daily', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_300, targetDailyGainPct: 3 });
    // Yesterday: started at 10,000 and banked.
    saveDailyBaseline('2026-08-20', 10_000);
    db.prepare('UPDATE autotrade_daily_baseline SET reached_at = ?').run(NOW - 86_400_000);

    const s = updateDailyTarget(NOW);
    // Today's goal is measured off TODAY's start (10,300), not yesterday's:
    // equity == baseline → 0% progress, not still-banked.
    expect(s).toMatchObject({ active: true, reached: false, baselineEquityUsd: 10_300, gainPct: 0 });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, reachedAt: null });
  });

  it('keeps the same-day baseline across ticks — a mid-day gain never re-baselines', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
    updateDailyTarget(NOW);
    setAutotradeConfig({ accountEquityUsd: 10_200 }); // equity moved intraday
    const s = updateDailyTarget(NOW + 60_000);
    expect(s).toMatchObject({ baselineEquityUsd: 10_000, gainPct: 2, reached: false });
  });

  it('journals daily_target_reached exactly ONCE per day, then halts stick', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000, targetDailyGainPct: 3 });
    updateDailyTarget(NOW); // baseline 10,000
    setAutotradeConfig({ accountEquityUsd: 10_400 }); // +4% — past the goal

    const first = updateDailyTarget(NOW + 60_000);
    expect(first.reached).toBe(true);
    // Later ticks, including a fade back UNDER the line: still reached, no new event.
    setAutotradeConfig({ accountEquityUsd: 10_100 });
    const later = updateDailyTarget(NOW + 120_000);
    expect(later.reached).toBe(true);

    const events = listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached');
    expect(events).toHaveLength(1);
    const detail = JSON.parse(events[0].detail!) as { targetPct: number; baselineEquityUsd: number; gainPct: number };
    expect(detail).toMatchObject({ targetPct: 3, baselineEquityUsd: 10_000, gainPct: 4 });
  });

  it('with no target set it still maintains the baseline but never journals or halts', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: 10_000 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: false, reached: false });
    expect(getDailyBaseline()).toMatchObject({ etDate: TODAY, equityUsd: 10_000 });
    expect(listAutotradeEvents({}).filter((e) => e.action === 'daily_target_reached')).toHaveLength(0);
  });

  it('with no usable equity on a new day it declines to baseline, and never halts', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), accountEquityUsd: null, targetDailyGainPct: 3 });
    const s = updateDailyTarget(NOW);
    expect(s).toMatchObject({ active: false, reached: false });
    expect(getDailyBaseline()).toBeNull();
  });
});

describe('tune integration', () => {
  it('a tune apply carries the target into config — applying IS arming', () => {
    const t = computeTargetTune({
      equityUsd: 10_000,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { autoTuneEnabled: false, autoTuneExitsEnabled: false },
    });
    expect(t.patch.targetDailyGainPct).toBe(3);
  });

  it('reset-to-moderate declares NO goal and disarms the tracker', () => {
    expect(resetToModerate(10_000).targetDailyGainPct).toBeNull();
  });
});

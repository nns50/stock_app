import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveEntryScoreGate, type EntryScoreGateConfig } from '../src/services/autotrading/entryScoreGate';
import type { DailyTargetStatus } from '../src/services/autotrading/dailyTarget';

// ---------------------------------------------------------------------------
// The live conviction floor (2026-09-06). The screener's ranking predicts
// outcome — rho(entryScore, realized R) = +0.320 over 57 closed live trades,
// past the 5% line at that n — and the book was taking trades far below where
// that edge starts:
//
//   scores 56-69   n=19   meanR -0.073    -$59.08
//   scores 70-75   n=19   meanR -0.055   -$153.18
//   scores 76-94   n=19   meanR +0.501   +$411.26
//
// Separate from minSignalScore on purpose: that one gates signal GENERATION for
// both books, so raising it would starve the paper control group every other
// open question depends on.
// ---------------------------------------------------------------------------

const target = (over: Partial<DailyTargetStatus> = {}): DailyTargetStatus =>
  ({ active: true, giveBackArmed: false, giveBackArmPct: 2, ...over }) as DailyTargetStatus;

const cfg = (over: Partial<EntryScoreGateConfig> = {}): EntryScoreGateConfig => ({
  liveMinSignalScore: 72,
  finishLineMinSignalScore: 0,
  mlRegimeEnabled: false,
  mlRegimeHighVolMinSignalScore: 0,
  ...over,
});

describe('the everyday live floor', () => {
  it('refuses a signal below the bar and names the rule', () => {
    const g = liveEntryScoreGate(65, target(), cfg());
    expect(g.skip).toBe(true);
    expect(g.bar).toBe(72);
    expect(g.source).toBe('live_floor');
    expect(g.action).toBe('live_score_floor_skipped');
  });

  it('passes a signal at the bar — the boundary is inclusive', () => {
    expect(liveEntryScoreGate(72, target(), cfg()).skip).toBe(false);
    expect(liveEntryScoreGate(71.9, target(), cfg()).skip).toBe(true);
  });

  it('is OFF at 0, matching every other "0 disables" field in this config', () => {
    const g = liveEntryScoreGate(1, target(), cfg({ liveMinSignalScore: 0 }));
    expect(g.skip).toBe(false);
    expect(g.source).toBe('none');
    expect(g.action).toBeNull();
  });

  it('applies on an ordinary day, not only an armed one', () => {
    // The whole difference from finishLineMinSignalScore: that bar rides the
    // give-back guard, this one is every session.
    expect(liveEntryScoreGate(65, target({ giveBackArmed: false }), cfg()).skip).toBe(true);
    expect(liveEntryScoreGate(65, target({ active: false }), cfg()).skip).toBe(true);
  });
});

describe('the two bars compose — the stricter one binds', () => {
  it('lets the armed-day bar decide when it is higher, keeping its journal action', () => {
    // finish_line_skipped is already counted in the tuning plan; a skip that
    // was really the armed-day rule must keep reporting as that rule, or the
    // existing history stops being comparable across this change.
    const g = liveEntryScoreGate(
      70,
      target({ giveBackArmed: true }),
      cfg({ liveMinSignalScore: 60, finishLineMinSignalScore: 80 }),
    );
    expect(g.skip).toBe(true);
    expect(g.bar).toBe(80);
    expect(g.source).toBe('armed_day');
    expect(g.action).toBe('finish_line_skipped');
  });

  it('lets the live floor decide when the armed bar is LOWER', () => {
    // Production today: finishLineMinSignalScore 65, live floor 72. On an armed
    // day the armed rule would wave through a 68 the everyday floor refuses —
    // two independent gates would have let it in.
    const g = liveEntryScoreGate(68, target({ giveBackArmed: true }), cfg({ finishLineMinSignalScore: 65 }));
    expect(g.skip).toBe(true);
    expect(g.bar).toBe(72);
    expect(g.source).toBe('live_floor');
  });

  it('passes only what clears BOTH', () => {
    const c = cfg({ liveMinSignalScore: 72, finishLineMinSignalScore: 80 });
    const armed = target({ giveBackArmed: true });
    expect(liveEntryScoreGate(85, armed, c).skip).toBe(false);
    expect(liveEntryScoreGate(75, armed, c).skip).toBe(true); // clears the floor, not the ramp
    expect(liveEntryScoreGate(70, target(), c).skip).toBe(true); // unarmed: the floor still bites
  });

  it('is inactive only when neither bar is set', () => {
    const g = liveEntryScoreGate(
      10,
      target({ giveBackArmed: true }),
      cfg({ liveMinSignalScore: 0, finishLineMinSignalScore: 0 }),
    );
    expect(g.skip).toBe(false);
    expect(g.source).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The High-Vol conviction bar (2026-09-08): a third source, composed the same
// way. Floor 72 / High-Vol bar 78 / armed-day bar 80 in every combination —
// the strictest wins and `source` names it.
// ---------------------------------------------------------------------------
describe('the High-Vol conviction bar composes as the third source', () => {
  const on = cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 78 });

  it('binds above the floor in High Vol: 75 passes the floor and is refused by the bar, 78 passes', () => {
    const g = liveEntryScoreGate(75, target(), on, 'high_vol_bearish');
    expect(g).toMatchObject({ skip: true, bar: 78, source: 'high_vol_regime', action: 'regime_score_floor_skipped' });
    expect(g.detail).toMatch(/below the High Volatility\/Bearish conviction bar 78 \(everyday floor 72\)/);
    expect(liveEntryScoreGate(78, target(), on, 'high_vol_bearish')).toMatchObject({
      skip: false,
      bar: 78,
      source: 'high_vol_regime',
    });
  });

  it('is 0 when the overlay is off, the regime is not High Vol, the field is 0, or no regime was handed in', () => {
    for (const [c, regime] of [
      [cfg({ mlRegimeEnabled: false, mlRegimeHighVolMinSignalScore: 78 }), 'high_vol_bearish'],
      [on, 'sideways'],
      [on, 'low_vol_bullish'],
      [on, 'unknown'],
      [on, null],
      [on, undefined],
      [cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 0 }), 'high_vol_bearish'],
    ] as const) {
      const g = liveEntryScoreGate(75, target(), c, regime);
      expect(g.skip, `${JSON.stringify(c)} ${String(regime)}`).toBe(false);
      expect(g.source).toBe('live_floor');
      expect(g.bar).toBe(72);
    }
  });

  it('a bar at or below the everyday floor changes nothing — the floor keeps its action', () => {
    const low = cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 70 });
    expect(liveEntryScoreGate(71, target(), low, 'high_vol_bearish')).toMatchObject({
      skip: true,
      bar: 72,
      source: 'live_floor',
      action: 'live_score_floor_skipped',
    });
    const tie = cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 72 });
    expect(liveEntryScoreGate(71, target(), tie, 'high_vol_bearish').source).toBe('live_floor');
  });

  it('the armed-day bar still wins when it is the strictest, keeping its journal action', () => {
    const armed = cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 78, finishLineMinSignalScore: 80 });
    const g = liveEntryScoreGate(79, target({ giveBackArmed: true }), armed, 'high_vol_bearish');
    expect(g).toMatchObject({ skip: true, bar: 80, source: 'armed_day', action: 'finish_line_skipped' });
    // Unarmed, the High-Vol bar is the strictest in force.
    expect(liveEntryScoreGate(79, target(), armed, 'high_vol_bearish')).toMatchObject({ skip: false, bar: 78 });
    // Armed but with a LOWER armed bar, the High-Vol bar binds.
    const lowArmed = cfg({ mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 78, finishLineMinSignalScore: 75 });
    expect(liveEntryScoreGate(76, target({ giveBackArmed: true }), lowArmed, 'high_vol_bearish')).toMatchObject({
      skip: true,
      bar: 78,
      source: 'high_vol_regime',
    });
  });

  it('with no everyday floor, the High-Vol bar stands alone', () => {
    const alone = cfg({ liveMinSignalScore: 0, mlRegimeEnabled: true, mlRegimeHighVolMinSignalScore: 78 });
    expect(liveEntryScoreGate(70, target(), alone, 'high_vol_bearish')).toMatchObject({ skip: true, bar: 78 });
    expect(liveEntryScoreGate(70, target(), alone, 'sideways')).toMatchObject({ skip: false, source: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Assert at the CONSUMER. The pure function proves nothing about whether the
// live entry path calls it — the exact gap that let a finish-line trim size
// against the wrong risk % for weeks with 137 green tests.
// ---------------------------------------------------------------------------
describe('the live entry path routes through this gate and nothing else', () => {
  const src = () => readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'liveExecute.ts'), 'utf8');
  const code = () =>
    src()
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  it('calls liveEntryScoreGate', () => {
    expect(code()).toMatch(/liveEntryScoreGate\(/);
  });

  it('no longer calls finishLineScoreGate directly — that would be a second bar', () => {
    // Two gates deciding "the minimum score for a live entry" is the shape
    // CLAUDE.md's agree-by-construction rule exists to prevent.
    expect(code()).not.toMatch(/finishLineScoreGate\(/);
  });

  it('journals the gate’s own action rather than a hardcoded one', () => {
    expect(code()).toMatch(/scoreGate\.action/);
  });

  it('hands the gate the tick’s EFFECTIVE regime — the one that cut the size — never a second reading', () => {
    expect(code()).toMatch(/liveEntryScoreGate\(candidateSignal\.score, dailyTarget, cfg, regime\.effectiveRegime\)/);
  });

  it('is live-only — the paper path must keep taking these signals', () => {
    // If paper adopted the floor, the control group would stop being a control.
    const paper = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'execute.ts'), 'utf8');
    expect(paper).not.toContain('liveEntryScoreGate');
    expect(paper).not.toContain('liveMinSignalScore');
  });
});

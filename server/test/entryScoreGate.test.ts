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

  it('is live-only — the paper path must keep taking these signals', () => {
    // If paper adopted the floor, the control group would stop being a control.
    const paper = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'execute.ts'), 'utf8');
    expect(paper).not.toContain('liveEntryScoreGate');
    expect(paper).not.toContain('liveMinSignalScore');
  });
});

import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useToast } from '../components/ToastContext';
import { CollapsibleCard, Field, NumberInput } from '../components/ui';
import { fmtNum } from '../lib/format';
import type { AutotradeConfig } from '../api/types';

// ---------------------------------------------------------------------------
// The daily goal, set directly (2026-09-07).
//
// Until now targetDailyGainPct / giveBackArmPct / giveBackFloorPct could only
// be written by applying a whole "tune from target" — ~38 fields, which also
// resets max trades/day, the conviction floor, every exposure cap and the
// options selection to the band's values. Moving the goal by a point meant
// re-stamping all of that, so in practice the goal was set once and left where
// ambition put it. These three fields are the goal itself, editable alone.
//
// The route, not this component, is the authority on coherence: it validates
// the MERGED triple (arm > floor >= 0, and arm < target) and answers 400
// rather than storing an inverted pair — an inverted pair does not fail
// anywhere at runtime, the guard simply reads it as "unconfigured" and the day
// runs with no give-back protection while the config says it has one. The
// hints below only echo that rule.
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The tune's own stamping ratio for the guard levels: arm at 2/3 of the goal,
 *  floor at 1/3 (targetTune.ts shapeToPatch). Used by "Stamp levels from goal"
 *  so a hand-set goal can carry the same guard shape a tune would give it. */
export function guardLevelsFor(targetPct: number): { armPct: number; floorPct: number } {
  return { armPct: round2((targetPct * 2) / 3), floorPct: round2(targetPct / 3) };
}

export function DailyGoalSection({ config, onSaved }: { config: AutotradeConfig; onSaved: () => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<number | undefined>(config.targetDailyGainPct ?? undefined);
  const [arm, setArm] = useState<number | undefined>(config.giveBackArmPct ?? undefined);
  const [floor, setFloor] = useState<number | undefined>(config.giveBackFloorPct ?? undefined);
  const [saving, setSaving] = useState(false);

  // Re-seed from the stored config whenever it changes: a tune apply stamps
  // all three, and this card must show what the loop is actually running.
  useEffect(() => {
    setTarget(config.targetDailyGainPct ?? undefined);
    setArm(config.giveBackArmPct ?? undefined);
    setFloor(config.giveBackFloorPct ?? undefined);
  }, [config.targetDailyGainPct, config.giveBackArmPct, config.giveBackFloorPct]);

  const toNull = (v: number | undefined): number | null => (v === undefined ? null : v);
  const dirty =
    toNull(target) !== config.targetDailyGainPct ||
    toNull(arm) !== config.giveBackArmPct ||
    toNull(floor) !== config.giveBackFloorPct;
  const stored =
    config.targetDailyGainPct !== null || config.giveBackArmPct !== null || config.giveBackFloorPct !== null;

  const write = async (
    body: { targetDailyGainPct: number | null; giveBackArmPct: number | null; giveBackFloorPct: number | null },
    done: string,
  ) => {
    setSaving(true);
    try {
      await client.setAutotradeConfig(body);
      toast(done, { type: 'success' });
      onSaved();
    } catch (e) {
      toast((e as Error).message || 'Could not save the daily goal', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    write(
      { targetDailyGainPct: toNull(target), giveBackArmPct: toNull(arm), giveBackFloorPct: toNull(floor) },
      'Daily goal saved',
    );
  const clearAll = () =>
    write(
      { targetDailyGainPct: null, giveBackArmPct: null, giveBackFloorPct: null },
      'Daily goal cleared — tracker disarmed',
    );
  const stampLevels = () => {
    if (target === undefined || !(target > 0)) return;
    const levels = guardLevelsFor(target);
    setArm(levels.armPct);
    setFloor(levels.floorPct);
  };

  const guardNeedsGoal = target === undefined && (arm !== undefined || floor !== undefined);

  return (
    <CollapsibleCard id="autotrade.config.dailyGoal" title="Daily goal" defaultCollapsed>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          The live daily-gain goal the loop tracks each ET day: once the account is up the goal % on the day's starting
          value it <span className="text-slate-300">banks the day</span> — new live entries and scale-ins halt until the
          next session while exits and paper keep running. The give-back guard{' '}
          <span className="text-slate-300">arms</span> once the day has been up the arm %, and halts new live entries if
          an armed day then fades back to the floor %. Applying a tune stamps all three (arm at 2/3 of the goal, floor
          at 1/3); here they are editable on their own, without re-applying the whole band. Blank = off. Not a promise
          of any gain — a stopping rule.
        </p>

        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <Field label="Daily gain goal %" hint="Blank disarms the tracker and the guard.">
            <NumberInput value={target} onChange={setTarget} min={0} placeholder="e.g. 1.5" />
          </Field>
          <Field label="Give-back arm %" hint="Must be above the floor and below the goal.">
            <NumberInput value={arm} onChange={setArm} min={0} placeholder="e.g. 1" />
          </Field>
          <Field label="Give-back floor %" hint="0 or more; an armed day fading here halts new live entries.">
            <NumberInput value={floor} onChange={setFloor} min={0} placeholder="e.g. 0.5" />
          </Field>
        </div>

        {guardNeedsGoal && (
          <div className="text-[13px] text-amber-400/90">
            ⚠ Guard levels without a goal do nothing — the tracker only runs while a daily gain goal is set.
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          <button className="btn-primary" disabled={saving || !dirty} onClick={save}>
            {saving ? 'Saving…' : 'Save daily goal'}
          </button>
          <button
            className="btn-ghost"
            disabled={saving || target === undefined || !(target > 0)}
            onClick={stampLevels}
            title="Fill the guard levels at 2/3 and 1/3 of the goal, the same shape a tune applies"
          >
            Stamp levels from goal
          </button>
          <button className="btn-ghost" disabled={saving || !stored} onClick={clearAll}>
            Clear all
          </button>
          {target !== undefined && target > 0 && (
            <span className="text-[11px] text-slate-500">
              A tune would stamp arm {fmtNum(guardLevelsFor(target).armPct)}% / floor{' '}
              {fmtNum(guardLevelsFor(target).floorPct)}% for a {fmtNum(target)}% goal.
            </span>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}

import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useToast } from '../components/ToastContext';
import { CollapsibleCard, Field, NumberInput, Segmented, Spinner } from '../components/ui';
import { cx, fmtNum } from '../lib/format';
import type { AutotradeConfig, DailyTargetSweepResult, PolicyOutcome, SweepLevel, SweepPolicy } from '../api/types';

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

const POLICY_LABEL: Record<Exclude<SweepPolicy, 'none'>, string> = {
  bank: 'Bank the day',
  giveBack: 'Bank + give-back guard',
  bankTrail: 'Bank + trail (not built)',
};
const POLICY_HINT: Record<Exclude<SweepPolicy, 'none'>, string> = {
  bank: 'halt new entries once the day reaches the level',
  giveBack: "today's stack: bank, plus the guard armed at 2/3 of the level and firing at a fade to 1/3",
  bankTrail:
    'keep entering past the level, halt only once the day fades back below it — measured here so it is built only if the record says so',
};

const fmtR = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${fmtNum(n)}R`;

/** One policy cell: the per-session delta against the record with its CI,
 *  and what it cost in halted sessions / dropped entries. */
function PolicyCell({ o }: { o: PolicyOutcome }) {
  if (!o.delta) return <td className="py-1 px-2 text-right tabular-nums text-slate-500">—</td>;
  const excludesZero = o.delta.ciLowR > 0 || o.delta.ciHighR < 0;
  return (
    <td className="py-1 px-2 text-right tabular-nums">
      <div className={cx(excludesZero ? (o.delta.meanR > 0 ? 'text-bull' : 'text-bear') : 'text-slate-300')}>
        {fmtR(o.delta.meanR)}/session
      </div>
      <div className="text-[11px] text-slate-500">
        CI {fmtR(o.delta.ciLowR)} … {fmtR(o.delta.ciHighR)} · halted {o.sessionsHalted} · dropped {o.entriesDropped}
      </div>
    </td>
  );
}

export function DailyGoalSection({ config, onSaved }: { config: AutotradeConfig; onSaved: () => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<number | undefined>(config.targetDailyGainPct ?? undefined);
  const [arm, setArm] = useState<number | undefined>(config.giveBackArmPct ?? undefined);
  const [floor, setFloor] = useState<number | undefined>(config.giveBackFloorPct ?? undefined);
  const [saving, setSaving] = useState(false);

  // The sweep: what the record says about each level. Fetched on demand (it
  // bootstraps), never on mount.
  const [book, setBook] = useState<'live' | 'paper'>('live');
  const [sessions, setSessions] = useState<number | undefined>(40);
  const [sweep, setSweep] = useState<DailyTargetSweepResult | undefined>();
  const [sweeping, setSweeping] = useState(false);
  const [sweepError, setSweepError] = useState<string | undefined>();
  const runSweep = async () => {
    setSweeping(true);
    setSweepError(undefined);
    try {
      setSweep(await client.dailyTargetSweep({ book, sessions }));
    } catch (e) {
      setSweep(undefined);
      setSweepError((e as Error).message);
    } finally {
      setSweeping(false);
    }
  };
  /** "Use this level": fill the goal at the level's % and stamp the guard at
   *  the tune's ratio. Fills the drafts only — a human still presses Save. */
  const applyLevel = (level: SweepLevel) => {
    if (level.levelPct === null) return;
    setTarget(level.levelPct);
    const levels = guardLevelsFor(level.levelPct);
    setArm(levels.armPct);
    setFloor(levels.floorPct);
  };

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

        <div className="border-t border-ink-700/50 pt-3 space-y-3">
          <h4 className="text-xs uppercase tracking-wide text-slate-400">What the record says</h4>
          <p className="text-xs text-slate-500">
            Replays each recent session of a book under a stopping rule at a grid of levels — in{' '}
            <span className="text-slate-300">R per session</span> (a strategy fact: no deposits, no manual trades), with
            the level as a % of equity at full size beside it — and reports, per level, the mean change per session
            against the record as it happened, with a bootstrap 95% confidence interval. A counterfactual, not a fit: it
            drops or keeps whole trades, never resizes or re-stops them. Read it as a shape — a plateau of levels that
            agree is evidence, a single spike is noise. The pre-committed rules for acting on it are in the Tune from
            target guide, §6b.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Book"
              hint={
                book === 'paper'
                  ? 'Paper is the control group — it takes every signal.'
                  : 'The live book: journal + live options.'
              }
            >
              <Segmented
                value={book}
                onChange={setBook}
                options={[
                  { value: 'live', label: 'Live' },
                  { value: 'paper', label: 'Paper (control)' },
                ]}
              />
            </Field>
            <Field label="Sessions" hint="Most recent trading sessions to replay (5–250).">
              <NumberInput value={sessions} onChange={setSessions} min={5} max={250} placeholder="40" />
            </Field>
            <button className="btn-ghost" disabled={sweeping} onClick={runSweep}>
              {sweeping ? 'Replaying…' : 'Run sweep'}
            </button>
          </div>
          {sweepError && <div className="text-bear text-sm">{sweepError}</div>}
          {sweeping && !sweep && <Spinner label="Replaying sessions…" />}
          {sweep && (
            <div className="space-y-2" data-testid="daily-goal-sweep">
              <div
                className={cx(
                  'text-[13px] rounded border px-2 py-1.5',
                  sweep.reliable ? 'border-ink-600 text-slate-400' : 'border-amber-500/40 text-amber-400/90',
                )}
              >
                {sweep.reliable ? 'Reliable record: ' : 'Thin record — read the shape, not the numbers: '}
                {sweep.tradesUsed} of 20 trades over {sweep.realized.sessions} of 20 sessions ({sweep.book} book
                {sweep.realized.sessionsWithoutEntries > 0
                  ? `, ${sweep.realized.sessionsWithoutEntries} with no entries`
                  : ''}
                ). Avg R {fmtR(sweep.realized.avgR)}, median {fmtNum(sweep.realized.tradesPerSession, 1)}{' '}
                entries/session.
                {sweep.droppedTrades > 0
                  ? ` ${sweep.droppedTrades} trade(s) dropped (undated, no stop, or no exit).`
                  : ''}
                {sweep.approximatedExits > 0
                  ? ` ${sweep.approximatedExits} exit moment(s) approximated to the close.`
                  : ''}
                {sweep.riskPerTradePct === null ? ' No risk % set, so levels have no % column.' : ''}
              </div>
              <div className="overflow-x-auto rounded border border-ink-700/60">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
                      <th className="py-1.5 px-2 font-medium">Level</th>
                      {(['bank', 'giveBack', 'bankTrail'] as const).map((p) => (
                        <th key={p} className="py-1.5 px-2 font-medium text-right" title={POLICY_HINT[p]}>
                          {POLICY_LABEL[p]}
                        </th>
                      ))}
                      <th className="py-1.5 px-2 font-medium text-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-ink-700/40 text-slate-400">
                      <td className="py-1 px-2">
                        Actual record{' '}
                        <span className="text-[11px] text-slate-500">
                          mean {fmtR(sweep.actual.meanDayR)}/day · median {fmtR(sweep.actual.medianDayR)} · worst{' '}
                          {fmtR(sweep.actual.worstDayR)} · total {fmtR(sweep.actual.totalR)}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right text-slate-500" colSpan={4}>
                        the baseline every cell is measured against
                      </td>
                    </tr>
                    {sweep.levels.map((level) => (
                      <tr
                        key={level.levelR}
                        className={cx(
                          'border-b border-ink-700/40 last:border-0',
                          level.isStoredTarget && 'bg-ink-700/30',
                        )}
                        data-testid={level.isStoredTarget ? 'sweep-stored-level' : undefined}
                      >
                        <td className="py-1 px-2 tabular-nums text-slate-300">
                          {fmtNum(level.levelR, 1)}R
                          {level.levelPct !== null && (
                            <span className="text-[11px] text-slate-500">
                              {' '}
                              · {fmtNum(level.levelPct)}% at full size
                            </span>
                          )}
                          {level.isStoredTarget && <span className="ml-1 text-[11px] text-accent">stored goal</span>}
                        </td>
                        {(['bank', 'giveBack', 'bankTrail'] as const).map((p) => {
                          const o = level.policies.find((x) => x.policy === p);
                          return o ? <PolicyCell key={p} o={o} /> : <td key={p} />;
                        })}
                        <td className="py-1 px-2 text-right">
                          <button
                            className="btn-ghost text-xs"
                            disabled={level.levelPct === null}
                            onClick={() => applyLevel(level)}
                            title="Fill the goal at this level (and the guard at 2/3 and 1/3 of it) — does not save"
                          >
                            Use this level
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-500">
                Not modelled, on purpose: the unrealized intraday path (production banks on net liquidation including
                open P&L and manual trades, so it touches every line earlier than this replay does — the replay is a
                lower bound on how often the stack engages), the two-tick confirmation, cash-flow re-basing, the sizing
                multipliers and probation (the % column assumes full size), finish-line sizing, the armed-day bar and
                the day-protective stop (whole trades are kept or dropped, never resized), and options premium sizing.
                Decision-support, not a promise.
              </p>
            </div>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}

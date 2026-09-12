import { useMemo } from 'react';
import type { DailyResult } from '../api/types';
import { cx, fmtNum, fmtSignedUsd } from '../lib/format';

// ---------------------------------------------------------------------------
// The day's percentage, as a month calendar (2026-09-12, operator's ask).
//
// FORM. The question is "how did each day go, at a glance, across a month" —
// magnitude plus polarity, on a fixed calendar grid. That is a heatmap over the
// calendar, not a line chart: the reader wants to find Tuesday, not follow a
// trend. Every tile carries its number as a direct label, which is also what
// makes the color safe to be recessive (see COLOR below).
//
// COLOR is a DIVERGING scale: two hues either side of a neutral midpoint, equal
// steps per arm. The two hues are the app's own `bull` (#22c55e) and `bear`
// (#ef4444) rather than the generic blue↔red, because in this domain green and
// red already mean gain and loss and every other surface in the app uses them —
// swapping in a blue "good" here would be the inconsistency, not the fix.
// Midpoint is neutral ink, never a hue.
//
// Three steps per arm, as alpha over the card surface, so the same steps work
// in both themes without a second palette. The fills deliberately sit in the
// recessive band (some below 3:1 against the surface): the dataviz relief rule
// allows that exactly when the value is readable another way, and here every
// tile shows its number in a TEXT token — the strongest fill still clears 5:1
// against the label in dark and 8:1 in light. The ring at the tile's edge is
// the same hue at higher alpha and is what carries the sign at a glance.
//
// SIGN IS NEVER COLOR ALONE. Every tile prints an explicit + or −, and the
// badges are letters, not dots. A colorblind reader, a printout and a
// forced-colors rendering all still read the day correctly.
//
// THE SCALE IS DYNAMIC. Magnitude is measured against the stored daily GOAL,
// not a hardcoded percentage: a day that reaches the goal is a full-strength
// tile, half the goal is the middle step. So the calendar re-scales itself when
// the goal or the risk % changes, which is the whole point of Decision 10.
// ---------------------------------------------------------------------------

/** How many steps per arm. Kept as a constant because the fill and ring arrays
 *  below must stay the same length — a mismatch would silently drop a step. */
const STEPS = 3;

/** Tailwind opacity suffixes for the three magnitude steps, fill then ring.
 *  Written as literal class names, not interpolated: Tailwind's scanner only
 *  sees complete strings. */
const BULL_FILL = ['bg-bull/15', 'bg-bull/35', 'bg-bull/55'];
const BEAR_FILL = ['bg-bear/15', 'bg-bear/35', 'bg-bear/55'];
const BULL_RING = ['border-bull/35', 'border-bull/60', 'border-bull/90'];
const BEAR_RING = ['border-bear/35', 'border-bear/60', 'border-bear/90'];

/** 1..STEPS by |pct| against the goal: full strength at the goal, the middle
 *  step at half of it. `goalPct` falling back to 3 keeps the scale sane before
 *  a goal is ever set. */
export function magnitudeStep(pct: number, goalPct: number | null): number {
  const goal = goalPct !== null && goalPct > 0 ? goalPct : 3;
  const ratio = Math.abs(pct) / goal;
  if (ratio >= 1) return STEPS;
  if (ratio >= 0.5) return 2;
  return 1;
}

export type ResultsMetric = 'account' | 'strategy';

export const pctOf = (r: DailyResult, metric: ResultsMetric): number | null =>
  metric === 'account' ? r.accountGainPct : r.strategyGainPct;

/** Monday-first weekday index for an ET date string, 0 = Monday. */
function weekdayIndex(etDate: string): number {
  const [y, m, d] = etDate.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface CalendarCell {
  etDate: string;
  /** The day number, for the tile's corner. */
  day: number;
  result: DailyResult | null;
}

/** Weekday rows only (Mon–Fri). Weekends are not market sessions, and a grid
 *  that reserves two empty columns for them spends 28% of the width saying
 *  nothing. */
export function buildMonthGrid(month: string, byDate: Map<string, DailyResult>): CalendarCell[][] {
  const [year, mon] = month.split('-').map(Number);
  const weeks: CalendarCell[][] = [];
  let week: CalendarCell[] = [];
  for (let day = 1; day <= daysInMonth(year, mon); day++) {
    const etDate = `${month}-${String(day).padStart(2, '0')}`;
    const wd = weekdayIndex(etDate);
    if (wd > 4) continue; // Saturday / Sunday
    if (week.length === 0 && wd > 0) week = Array.from({ length: wd }, () => null as unknown as CalendarCell);
    week.push({ etDate, day, result: byDate.get(etDate) ?? null });
    if (wd === 4) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) weeks.push(week);
  return weeks;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function Badges({ r }: { r: DailyResult }) {
  // Letters, not colored dots: a badge that only exists as a hue is invisible
  // to a colorblind reader and to a black-and-white printout.
  const items: { key: string; label: string; title: string; className: string }[] = [];
  if (r.goalReached) {
    items.push({ key: 'g', label: 'G', title: 'Daily goal reached', className: 'text-bull' });
  }
  if (r.giveBackHalted) {
    items.push({ key: 'b', label: 'B', title: 'Give-back guard halted entries', className: 'text-amber-400' });
  }
  if (r.drawdownHalted) {
    items.push({ key: 'h', label: 'H', title: 'Daily drawdown halt', className: 'text-bear' });
  }
  if (r.manualTrading) {
    items.push({
      key: 'm',
      label: 'M',
      title: 'The account and the strategy disagree by more than 0.5% — a deposit, a withdrawal, or manual trading',
      className: 'text-slate-400',
    });
  }
  if (items.length === 0) return null;
  return (
    <span className="flex gap-0.5 text-[9px] font-semibold leading-none">
      {items.map((i) => (
        <span key={i.key} className={i.className} title={i.title}>
          {i.label}
        </span>
      ))}
    </span>
  );
}

function Tile({ cell, metric, goalPct }: { cell: CalendarCell; metric: ResultsMetric; goalPct: number | null }) {
  const r = cell.result;
  const pct = r ? pctOf(r, metric) : null;
  const step = pct !== null && pct !== 0 ? magnitudeStep(pct, goalPct) - 1 : -1;
  const up = pct !== null && pct > 0;
  const fill = step < 0 ? 'bg-ink-700/40' : up ? BULL_FILL[step] : BEAR_FILL[step];
  const ring = step < 0 ? 'border-ink-600/60' : up ? BULL_RING[step] : BEAR_RING[step];
  const title = r
    ? [
        cell.etDate,
        pct === null
          ? metric === 'account'
            ? 'no account figure — this session predates the daily baseline'
            : 'no strategy % — no opening equity to divide by'
          : `${metric} ${pct > 0 ? '+' : ''}${fmtNum(pct, 2)}%`,
        `strategy ${fmtSignedUsd(r.strategyPnlUsd)} over ${r.liveTrades} live trade${r.liveTrades === 1 ? '' : 's'}`,
        `paper ${fmtSignedUsd(r.paperPnlUsd)}`,
        r.manualTrading ? 'account and strategy disagree — deposit, withdrawal or manual trading' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : `${cell.etDate} — no session recorded`;

  return (
    <div
      className={cx('rounded-lg border p-1.5 min-h-[64px] flex flex-col justify-between', fill, ring)}
      title={title}
      data-testid={`results-day-${cell.etDate}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-[10px] text-slate-400 tabular-nums leading-none">{cell.day}</span>
        {r && <Badges r={r} />}
      </div>
      {r ? (
        <div>
          <div className="text-sm font-semibold tabular-nums text-slate-100 leading-none">
            {pct === null ? '—' : `${pct > 0 ? '+' : ''}${fmtNum(pct, 2)}%`}
          </div>
          <div className="text-[10px] text-slate-400 tabular-nums leading-none mt-0.5">
            {fmtSignedUsd(r.strategyPnlUsd, 0)}
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-slate-600">—</div>
      )}
    </div>
  );
}

/**
 * One month of sessions. `weekTotals` shows the week's strategy dollars in a
 * trailing column — the only figure that sums honestly across days (a sum of
 * percentages is neither compounding nor free of deposits).
 */
export function DailyResultsCalendar({
  month,
  rows,
  metric,
  goalPct,
  weekTotals,
}: {
  month: string;
  rows: DailyResult[];
  metric: ResultsMetric;
  goalPct: number | null;
  weekTotals?: boolean;
}) {
  const grid = useMemo(() => buildMonthGrid(month, new Map(rows.map((r) => [r.etDate, r]))), [month, rows]);
  return (
    <div data-testid="results-calendar">
      <div
        className="grid gap-1 mb-1 text-[10px] uppercase tracking-wide text-slate-500"
        style={{ gridTemplateColumns: `repeat(5, minmax(0, 1fr))${weekTotals ? ' 4.5rem' : ''}` }}
      >
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
        {weekTotals && <div className="text-right">Week</div>}
      </div>
      <div className="space-y-1">
        {grid.map((week, i) => {
          const total = week.reduce((s, c) => s + (c?.result?.strategyPnlUsd ?? 0), 0);
          return (
            <div
              key={i}
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(5, minmax(0, 1fr))${weekTotals ? ' 4.5rem' : ''}` }}
            >
              {Array.from({ length: 5 }, (_, col) => {
                const cell = week[col];
                return cell ? (
                  <Tile key={cell.etDate} cell={cell} metric={metric} goalPct={goalPct} />
                ) : (
                  <div key={`pad-${i}-${col}`} className="min-h-[64px] rounded-lg border border-transparent" />
                );
              })}
              {weekTotals && (
                <div className="flex items-center justify-end text-[11px] tabular-nums text-slate-400">
                  {fmtSignedUsd(total, 0)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

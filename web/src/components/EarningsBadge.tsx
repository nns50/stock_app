import { CalendarClock } from 'lucide-react';
import { cx, daysUntilLocal } from '../lib/format';
import type { SymbolEvents } from '../api/types';

/** Re-exported for the pages that already import it from here. The logic lives
 *  in lib/format.ts next to fmtDate, which documents the same local-vs-UTC trap;
 *  this file, AssignmentRiskBadge and DashboardPage each had their own copy of
 *  it, all three counting in UTC. */
export const daysUntil = (date?: string): number | null => daysUntilLocal(date);

/**
 * Compact earnings indicator. Amber when earnings fall within `warnWithin` days
 * (the "don't hold options into earnings" window); muted otherwise. Renders
 * nothing when there's no upcoming earnings date.
 */
export function EarningsBadge({ events, warnWithin = 7 }: { events?: SymbolEvents; warnWithin?: number }) {
  const dte = daysUntil(events?.earningsDate);
  if (dte == null || dte < 0) return null;
  const soon = dte <= warnWithin;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        soon ? 'bg-amber-500/15 text-amber-400' : 'bg-ink-600 text-slate-400',
      )}
      title={`Earnings ${events?.earningsDate}${events?.earningsEstimated ? ' (estimated)' : ''}`}
    >
      <CalendarClock className="h-3 w-3" />
      ER {dte}d
    </span>
  );
}

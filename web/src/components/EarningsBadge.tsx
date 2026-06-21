import { CalendarClock } from 'lucide-react';
import { cx } from '../lib/format';
import type { SymbolEvents } from '../api/types';

/** Whole days from now until an ISO date (UTC), or null if absent/unparseable. */
export function daysUntil(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

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

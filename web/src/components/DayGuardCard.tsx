import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx, fmtUsd, todayISO } from '../lib/format';
import { Card, PnL } from './ui';

// Daily discipline guardrail (opt-in). Set a daily loss limit and/or a cap on
// new trades per day in Settings; this surfaces today's booked P&L and entry
// count on the dashboard and turns red when a limit is reached — a nudge to
// step away, not a hard block (the app never places or prevents trades).
export function DayGuardCard() {
  const [lossLimit] = useLocalStorage<number>('guard.dailyLossLimit', 0);
  const [maxTrades] = useLocalStorage<number>('guard.maxTradesPerDay', 0);
  const enabled = lossLimit > 0 || maxTrades > 0;
  const today = useAsync(
    () => (enabled ? client.journalToday(todayISO()) : Promise.resolve(null)),
    [enabled, lossLimit, maxTrades],
  );

  if (!enabled || today.loading || !today.data) return null;
  const d = today.data;

  const lossHit = lossLimit > 0 && d.realizedPnl <= -lossLimit;
  const tradesHit = maxTrades > 0 && d.entries >= maxTrades;
  const breached = lossHit || tradesHit;
  const remaining = Math.max(0, lossLimit + d.realizedPnl); // budget left before the limit

  return (
    <Card className={cx('p-3 flex flex-wrap items-center gap-x-6 gap-y-2', breached && 'border-bear/50 bg-bear/10')}>
      <div className="flex items-center gap-2">
        <span className={breached ? 'text-bear' : 'text-slate-400'}>{breached ? '⛔' : '🛡'}</span>
        <span className="text-sm font-medium">
          {breached ? 'Daily limit reached — consider stepping away.' : 'Daily guardrails'}
        </span>
      </div>
      <div className="text-sm text-slate-400 flex items-center gap-1.5">
        Booked today: <PnL value={d.realizedPnl} />
      </div>
      {lossLimit > 0 && (
        <div className={cx('text-xs tabular-nums', lossHit ? 'text-bear font-medium' : 'text-slate-500')}>
          Loss limit {fmtUsd(lossLimit)} {lossHit ? '— reached' : `· ${fmtUsd(remaining)} left`}
        </div>
      )}
      {maxTrades > 0 && (
        <div className={cx('text-xs tabular-nums', tradesHit ? 'text-amber-400 font-medium' : 'text-slate-500')}>
          {d.entries}/{maxTrades} new trades{tradesHit ? ' — cap reached' : ''}
        </div>
      )}
    </Card>
  );
}

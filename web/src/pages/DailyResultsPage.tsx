import { useMemo, useState } from 'react';
import { client } from '../api/client';
import type { DailyResult, DailyResultsAggregate } from '../api/types';
import { useAsync } from '../lib/hooks';
import { cx, fmtNum, fmtSignedUsd } from '../lib/format';
import { Card, Segmented, Spinner } from '../components/ui';
import { DailyResultsCalendar, pctOf, type ResultsMetric } from '../components/DailyResultsCalendar';

// ---------------------------------------------------------------------------
// The daily results calendar (2026-09-12).
//
// Two numbers per day, never one: the ACCOUNT percentage is what the operator
// feels and carries deposits, withdrawals and hand trading; the STRATEGY
// percentage is what the loop did. The toggle switches which one the tiles
// show; the tooltip always names both, and a day where they disagree by more
// than 0.5% of equity wears an M.
// ---------------------------------------------------------------------------

const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  return monthKey(new Date(Date.UTC(y, m - 1 + by, 1)));
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 1)));
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={cx(
          'text-sm font-semibold tabular-nums',
          tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-slate-200',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function MonthSummary({ a, metric }: { a: DailyResultsAggregate | undefined; metric: ResultsMetric }) {
  if (!a) return <p className="text-xs text-slate-500">No sessions recorded this month.</p>;
  const mean = metric === 'account' ? a.meanAccountGainPct : a.meanStrategyGainPct;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3" data-testid="results-month-summary">
      <Stat label="Sessions" value={String(a.sessions)} />
      <Stat
        label="Mean day"
        value={mean === null ? '—' : `${mean > 0 ? '+' : ''}${fmtNum(mean, 2)}%`}
        tone={mean === null ? undefined : mean > 0 ? 'bull' : mean < 0 ? 'bear' : undefined}
      />
      <Stat label="Strategy P&L" value={fmtSignedUsd(a.strategyPnlUsd, 0)} />
      <Stat label="Positive days" value={`${a.positiveDays} of ${a.sessions}`} />
      {/* The mean RED day is the plan's "least loss on red days" yardstick
          (<= -1.5%), which is why it sits beside the mean rather than only in
          the worst-day cell: one bad day and a run of small ones read very
          differently and the worst day cannot tell them apart. */}
      <Stat
        label="Mean red day"
        value={a.meanRedDayPct === null ? '—' : `${fmtNum(a.meanRedDayPct, 2)}%`}
        tone={a.meanRedDayPct === null ? undefined : 'bear'}
      />
      <Stat label="Goal days" value={String(a.goalDays)} />
      <Stat label="Best" value={a.bestDayPct === null ? '—' : `+${fmtNum(a.bestDayPct, 2)}%`} />
      <Stat label="Worst" value={a.worstDayPct === null ? '—' : `${fmtNum(a.worstDayPct, 2)}%`} />
    </div>
  );
}

/** One row per session, the visible range only. A table view is the
 *  accessibility fallback for the heatmap and the thing you paste into a
 *  spreadsheet. */
function toCsv(rows: DailyResult[]): string {
  const head = [
    'et_date',
    'account_gain_pct',
    'strategy_gain_pct',
    'strategy_pnl_usd',
    'live_trades',
    'paper_pnl_usd',
    'goal_reached',
    'give_back_halted',
    'drawdown_halted',
    'manual_trading',
  ];
  const body = rows.map((r) =>
    [
      r.etDate,
      r.accountGainPct ?? '',
      r.strategyGainPct ?? '',
      r.strategyPnlUsd,
      r.liveTrades,
      r.paperPnlUsd,
      r.goalReached ? 1 : 0,
      r.giveBackHalted ? 1 : 0,
      r.drawdownHalted ? 1 : 0,
      r.manualTrading ? 1 : 0,
    ].join(','),
  );
  return [head.join(','), ...body].join('\n');
}

export default function DailyResultsPage() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [metric, setMetric] = useState<ResultsMetric>('account');
  const report = useAsync(() => client.journalDailyResults(), []);
  const config = useAsync(() => client.autotradeConfig(), []);

  const rows = useMemo(() => report.data?.rows.filter((r) => r.etDate.startsWith(month)) ?? [], [report.data, month]);
  const monthAgg = report.data?.monthly.find((m) => m.key === month);
  const goalPct = config.data?.targetDailyGainPct ?? null;

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-results-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const streak = report.data?.currentStreak ?? 0;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <button className="btn-ghost text-xs" onClick={() => setMonth(shiftMonth(month, -1))}>
              ‹ Prev
            </button>
            <h2 className="text-base font-semibold text-slate-100" data-testid="results-month">
              {monthLabel(month)}
            </h2>
            <button className="btn-ghost text-xs" onClick={() => setMonth(shiftMonth(month, 1))}>
              Next ›
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'account', label: 'Account %' },
                { value: 'strategy', label: 'Strategy %' },
              ]}
            />
            <button className="btn-ghost text-xs" onClick={download} disabled={rows.length === 0}>
              Export CSV
            </button>
          </div>
        </div>

        {report.loading && <Spinner label="Loading results…" />}
        {report.error && <p className="text-xs text-bear">{report.error.message}</p>}
        {report.data && (
          <>
            <div className="mb-3">
              <MonthSummary a={monthAgg} metric={metric} />
            </div>
            <DailyResultsCalendar month={month} rows={rows} metric={metric} goalPct={goalPct} weekTotals />
            <p className="text-[11px] text-slate-500 mt-3">
              Tiles show the <strong>{metric === 'account' ? 'account' : 'strategy'}</strong> percentage; the small
              figure is the strategy&apos;s realized dollars. The two differ whenever money moves for a reason the loop
              did not cause — a deposit, a withdrawal, or trading by hand — and a day where they disagree by more than
              0.5% of equity is marked <strong className="text-slate-400">M</strong>. Other badges:{' '}
              <strong className="text-bull">G</strong> goal reached, <strong className="text-amber-400">B</strong>{' '}
              give-back guard halted the day, <strong className="text-bear">H</strong> drawdown halt. A dash means the
              session predates the daily-baseline record, so no account figure exists for it — the strategy dollars are
              still exact.
              {streak !== 0 && (
                <>
                  {' '}
                  Current run:{' '}
                  <strong className={streak > 0 ? 'text-bull' : 'text-bear'}>
                    {Math.abs(streak)} {streak > 0 ? 'green' : 'red'} session{Math.abs(streak) === 1 ? '' : 's'}
                  </strong>
                  .
                </>
              )}
            </p>
          </>
        )}
      </Card>

      {report.data && report.data.rows.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Every recorded session</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-ink-600/60 text-left">
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3 text-right">Account %</th>
                  <th className="py-1 pr-3 text-right">Strategy %</th>
                  <th className="py-1 pr-3 text-right">Strategy $</th>
                  <th className="py-1 pr-3 text-right">Trades</th>
                  <th className="py-1 pr-3 text-right">Paper $</th>
                  <th className="py-1">Flags</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {[...report.data.rows].reverse().map((r) => {
                  const pct = pctOf(r, metric);
                  return (
                    <tr key={r.etDate} className="border-b border-ink-700/50">
                      <td className="py-1 pr-3 tabular-nums">{r.etDate}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {r.accountGainPct === null ? '—' : `${fmtNum(r.accountGainPct, 2)}%`}
                      </td>
                      <td
                        className={cx(
                          'py-1 pr-3 text-right tabular-nums',
                          pct !== null && (pct > 0 ? 'text-bull' : pct < 0 ? 'text-bear' : ''),
                        )}
                      >
                        {r.strategyGainPct === null ? '—' : `${fmtNum(r.strategyGainPct, 2)}%`}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtSignedUsd(r.strategyPnlUsd, 0)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.liveTrades}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtSignedUsd(r.paperPnlUsd, 0)}</td>
                      <td className="py-1 text-slate-400">
                        {[
                          r.goalReached ? 'goal' : '',
                          r.giveBackHalted ? 'give-back' : '',
                          r.drawdownHalted ? 'halt' : '',
                          r.manualTrading ? 'manual' : '',
                        ]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

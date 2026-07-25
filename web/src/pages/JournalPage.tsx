import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { client } from '../api/client';
import { useAsync, useSort } from '../lib/hooks';
import { cx, fmtDate, fmtNum, fmtPct, fmtSignedUsd } from '../lib/format';
import { disciplineCount } from '../lib/checklist';
import {
  Badge,
  Card,
  CollapsibleCard,
  EmptyState,
  InfoTip,
  PageHeader,
  PnL,
  SortTh,
  Spinner,
  StatTile,
} from '../components/ui';
import { JournalEditModal } from '../components/PositionForms';
import { DataTools } from '../components/DataTools';
import { JournalAnalyticsModal } from '../components/JournalAnalyticsModal';
import { BenchmarkCard } from '../components/BenchmarkCard';
import type { GroupStat, Position, PositionWithPnl } from '../api/types';

/** Comparable value for a sortable Journal column (module-level → stable). */
function journalSortVal(r: PositionWithPnl, key: string): number | string | null {
  const p = r.position;
  switch (key) {
    case 'symbol':
      return p.symbol;
    case 'date':
      return p.exits.length ? p.exits[p.exits.length - 1].exitDate : p.entryDate;
    case 'grade':
      return p.grade ?? null;
    case 'realized':
      return r.pnl.totalPnl;
    case 'return':
      return r.pnl.returnPct;
    default:
      return null;
  }
}

/** services/washSale.ts — informational only, never a trading gate (see the
 *  tooltip copy below). Renders nothing when the row has no warning. */
function WashSaleBadge({ washSale }: { washSale: PositionWithPnl['washSale'] }) {
  if (!washSale) return null;
  const when =
    washSale.daysApart >= 0
      ? `reopened ${washSale.daysApart} day${washSale.daysApart === 1 ? '' : 's'} after this closed`
      : `already open ${Math.abs(washSale.daysApart)} day${Math.abs(washSale.daysApart) === 1 ? '' : 's'} before this closed`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-400"
      title={`Same symbol was ${when} (on ${washSale.triggerEntryDate}) — this loss may be wash-sale disallowed. Not tax advice; confirm against your 1099-B or a tax professional.`}
    >
      <TriangleAlert className="h-3 w-3" />
      wash sale?
    </span>
  );
}

/** Van Tharp's qualitative band for a System Quality Number. */
function sqnLabel(sqn: number): string {
  if (sqn >= 7) return 'holy grail';
  if (sqn >= 5) return 'superb';
  if (sqn >= 3) return 'excellent';
  if (sqn >= 2.5) return 'good';
  if (sqn >= 2) return 'average';
  if (sqn >= 1.6) return 'below average';
  return 'hard to trade';
}

/** Compact "realized P&L grouped by X" table used in the Performance breakdown.
 *  Profit factor and avg R (2026-07-23) are what separate a genuine edge from a
 *  merely-frequent one — a low-win-rate group with a big payoff can out-earn a
 *  high-win-rate group with a small one, which win%/P&L alone can't show. */
function Breakdown({ id, title, colLabel, rows }: { id: string; title: string; colLabel: string; rows: GroupStat[] }) {
  if (!rows.length) return null;
  return (
    <CollapsibleCard id={`journal.${id}`} title={title}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-left border-b border-ink-600/60">
            <th className="py-1 pr-2 font-medium">{colLabel}</th>
            <th className="py-1 px-2 font-medium text-right">Trades</th>
            <th className="py-1 px-2 font-medium text-right">Win%</th>
            <th className="py-1 px-2 font-medium text-right" title="Gross profit ÷ gross loss">
              PF
            </th>
            <th className="py-1 px-2 font-medium text-right" title="Mean R-multiple, over trades that logged a stop">
              Avg R
            </th>
            <th className="py-1 pl-2 font-medium text-right">Realized P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-ink-700/40 last:border-0">
              <td className="py-1 pr-2 text-slate-200 truncate max-w-[140px]" title={r.key}>
                {r.key}
              </td>
              <td className="py-1 px-2 text-right tabular-nums text-slate-400">{r.trades}</td>
              <td className="py-1 px-2 text-right tabular-nums text-slate-400">{fmtNum(r.winRate, 0)}%</td>
              <td className="py-1 px-2 text-right tabular-nums text-slate-400">
                {r.profitFactor === null ? '∞' : fmtNum(r.profitFactor, 1)}
              </td>
              <td className="py-1 px-2 text-right tabular-nums text-slate-400">
                {r.avgR === null ? '—' : `${fmtNum(r.avgR, 1)}R`}
              </td>
              <td className="py-1 pl-2 text-right">
                <PnL value={r.totalPnl} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CollapsibleCard>
  );
}

export default function JournalPage() {
  const stats = useAsync(() => client.journalStats(), []);
  const closed = useAsync(() => client.positionsWithPnl({ status: 'closed' }), []);
  const efficacy = useAsync(() => client.journalAutoTuneEfficacy(), []);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editPos, setEditPos] = useState<Position | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  const reload = () => {
    stats.reload();
    closed.reload();
    efficacy.reload();
  };

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const r of closed.data?.positions ?? []) for (const t of r.position.tags) set.add(t);
    return Array.from(set).sort();
  }, [closed.data]);

  const rows = useMemo(() => {
    const list = closed.data?.positions ?? [];
    return tagFilter ? list.filter((r) => r.position.tags.includes(tagFilter)) : list;
  }, [closed.data, tagFilter]);
  const { sorted: sortedRows, sortKey, sortDir, onSort } = useSort(rows, journalSortVal);

  if (stats.loading || closed.loading) return <Spinner label="Loading journal…" />;
  const s = stats.data!;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trade journal"
        subtitle="Stats, edge, and risk analytics from your closed trades."
        actions={
          <>
            <button className="btn-ghost" onClick={() => setAnalyticsOpen(true)}>
              Analytics
            </button>
            <DataTools onImported={reload} />
          </>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatTile label="Closed" value={s.totalClosed} sub={`${s.wins}W · ${s.losses}L`} />
        <StatTile
          label="Win rate"
          value={`${fmtNum(s.winRate, 1)}%`}
          info="Share of closed trades that were profitable."
        />
        <StatTile
          label="Expectancy"
          value={<PnL value={s.expectancy} />}
          sub="per trade"
          info="Average P&L per trade = (win rate × avg win) − (loss rate × avg loss)."
        />
        <StatTile
          label="Profit factor"
          value={s.profitFactor === null ? '∞' : fmtNum(s.profitFactor)}
          info="Gross profit ÷ gross loss. Above 1 means winners outweigh losers."
        />
        <StatTile label="Avg win" value={fmtSignedUsd(s.avgWin)} valueClass="text-bull" />
        <StatTile label="Avg loss" value={fmtSignedUsd(s.avgLoss)} valueClass="text-bear" />
        <StatTile label="Total realized" value={<PnL value={s.totalRealized} />} />
      </div>

      {s.rTrades > 0 && s.avgR != null && (
        <CollapsibleCard
          id="journal.edgeR"
          title="Edge (R-multiples)"
          action={
            <span className="flex items-center gap-2">
              <InfoTip text="P&L per trade in multiples of initial risk (entry→stop). A positive expectancy means an edge, independent of position size." />
              <span className="text-xs text-slate-500">{s.rTrades} closed trades with a stop</span>
            </span>
          }
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <StatTile
              label="Expectancy"
              value={`${s.avgR >= 0 ? '+' : ''}${fmtNum(s.avgR, 2)}R`}
              valueClass={s.avgR >= 0 ? 'text-bull' : 'text-bear'}
              sub="per trade"
            />
            {s.sqn != null && (
              <StatTile
                label="SQN"
                value={fmtNum(s.sqn, 2)}
                sub={sqnLabel(s.sqn)}
                info="System Quality Number (Van Tharp): mean R ÷ std-dev of R × √N (N capped at 100). Rewards a strong, consistent edge over many trades. ~2 is average, 3+ excellent."
              />
            )}
            <StatTile label="Best" value={`+${fmtNum(s.bestR, 2)}R`} valueClass="text-bull" />
            <StatTile label="Worst" value={`${fmtNum(s.worstR, 2)}R`} valueClass="text-bear" />
          </div>
          <div className="space-y-1">
            {s.rBuckets.map((b, i) => {
              const max = Math.max(1, ...s.rBuckets.map((x) => x.count));
              return (
                <div key={b.label} className="flex items-center gap-2 text-xs">
                  <span className="w-20 text-right text-slate-400">{b.label}</span>
                  <div className="flex-1 h-3 bg-ink-600 rounded overflow-hidden">
                    <div
                      className={cx('h-full', i < 3 ? 'bg-bear' : 'bg-bull')}
                      style={{ width: `${(b.count / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 tabular-nums text-slate-400">{b.count}</span>
                </div>
              );
            })}
          </div>
        </CollapsibleCard>
      )}

      {s.kelly && (
        <CollapsibleCard
          id="journal.edgeSizing"
          title="Edge-based sizing"
          action={
            <InfoTip text="Suggested risk per trade from your realized win rate and payoff ratio (quarter-Kelly, capped at 3%). Kelly is aggressive and assumes your edge persists — a ceiling, not a recommendation." />
          }
        >
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span>
              Suggested:{' '}
              <span className="font-semibold text-accent tabular-nums">{fmtNum(s.kelly.suggestedRiskPct, 2)}%</span>{' '}
              <span className="text-slate-500">/ trade</span>
            </span>
            <span className="text-slate-500 text-xs tabular-nums">
              from {fmtNum(s.winRate, 0)}% win rate · {fmtNum(s.kelly.payoffRatio, 2)}:1 payoff · full Kelly{' '}
              {fmtNum(s.kelly.fraction * 100, 1)}%
            </span>
          </div>
          {!s.kelly.reliable && (
            <div className="text-[11px] text-amber-400/90 mt-1">
              Only {s.kelly.sampleSize} decisive trades — too few to lean on; size conservatively.
            </div>
          )}
        </CollapsibleCard>
      )}

      {efficacy.data && efficacy.data.adjustments.length > 0 && (
        <CollapsibleCard
          id="journal.autoTuneEfficacy"
          title="Auto-tune efficacy"
          action={
            <InfoTip text="Did a past Auto-tune from realized edge risk-% change (Auto-Trade → Config) actually help? Before/after stats split by each adjustment's own date, scoped to autotrade's own trades only. Informational only — nothing here reverts a change automatically; you review and decide." />
          }
        >
          <div className="mt-2 space-y-3">
            {efficacy.data.adjustments.map((a) => (
              <div key={a.eventId} className="rounded border border-ink-600/60 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span>
                    {fmtDate(a.adjustedAt)} — riskPerTradePct{' '}
                    <span className="font-semibold tabular-nums">{fmtNum(a.from, 2)}%</span> →{' '}
                    <span className="font-semibold text-accent tabular-nums">{fmtNum(a.to, 2)}%</span>
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums">
                    Kelly suggested {fmtNum(a.kellySuggestedAtTheTime, 2)}% from {a.sampleSizeAtTheTime} trades
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">
                      Before ({a.before.totalClosed} trade{a.before.totalClosed === 1 ? '' : 's'})
                    </div>
                    <div className="text-xs tabular-nums">
                      {a.before.totalClosed > 0 ? (
                        <>
                          {fmtNum(a.before.winRate, 0)}% win · {fmtSignedUsd(a.before.expectancy)} / trade
                          {a.before.kelly && <> · Kelly {fmtNum(a.before.kelly.suggestedRiskPct, 2)}%</>}
                        </>
                      ) : (
                        <span className="text-slate-500">no closed trades</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">
                      After ({a.after.totalClosed} trade{a.after.totalClosed === 1 ? '' : 's'})
                    </div>
                    <div className="text-xs tabular-nums">
                      {a.after.totalClosed > 0 ? (
                        <>
                          {fmtNum(a.after.winRate, 0)}% win · {fmtSignedUsd(a.after.expectancy)} / trade
                          {a.after.kelly && <> · Kelly {fmtNum(a.after.kelly.suggestedRiskPct, 2)}%</>}
                        </>
                      ) : (
                        <span className="text-slate-500">too soon to tell</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleCard>
      )}

      <CollapsibleCard
        id="journal.pnlOverTime"
        title="P&L over time (cumulative realized)"
        action={
          s.totalClosed > 0 && (
            <div className="text-xs text-slate-500 tabular-nums flex flex-wrap gap-x-3">
              <span>
                Max drawdown <span className="text-bear">{fmtSignedUsd(-s.maxDrawdown)}</span>
              </span>
              <span>
                Current{' '}
                {s.currentDrawdown <= 0 ? (
                  <span className="text-bull">at peak ▲</span>
                ) : (
                  <span className={s.currentDrawdown >= s.maxDrawdown ? 'text-bear font-medium' : 'text-amber-400'}>
                    {fmtSignedUsd(-s.currentDrawdown)}
                    {s.currentDrawdown >= s.maxDrawdown ? ' (at max)' : ''}
                  </span>
                )}
              </span>
              <span>
                Streak{' '}
                {s.currentStreak.count === 0 ? (
                  <span className="text-slate-400">—</span>
                ) : (
                  <span className={s.currentStreak.type === 'win' ? 'text-bull' : 'text-bear'}>
                    {s.currentStreak.count}
                    {s.currentStreak.type === 'win' ? 'W' : 'L'}
                  </span>
                )}
              </span>
              <span>
                Longest <span className="text-bull">{s.longestWinStreak}W</span> /{' '}
                <span className="text-bear">{s.longestLossStreak}L</span>
              </span>
            </div>
          )
        }
      >
        {s.equityCurve.length === 0 ? (
          <div className="text-slate-500 text-sm py-8 text-center">Close some trades to build the equity curve.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={s.equityCurve} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <defs>
                <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                axisLine={{ stroke: 'var(--chart-grid)' }}
                tickLine={false}
              />
              <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                contentStyle={{
                  background: 'var(--chart-tooltip-bg)',
                  border: '1px solid var(--chart-grid)',
                  borderRadius: 10,
                  fontSize: 12,
                  boxShadow: '0 12px 34px -12px rgb(0 0 0 / 0.45)',
                }}
                labelStyle={{ color: 'var(--txt-300)' }}
                formatter={(v) => [fmtSignedUsd(Number(v)), 'Cumulative']}
              />
              <Area
                type="monotone"
                dataKey="cumulative"
                stroke="#38bdf8"
                strokeWidth={2}
                fill="url(#equityGrad)"
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CollapsibleCard>

      {s.rollingExpectancy.length > 0 && (
        <CollapsibleCard
          id="journal.edgeOverTime"
          title="Edge over time"
          action={
            <span className="flex items-center gap-2">
              <InfoTip text="Per-trade expectancy ($) over a trailing 20-trade window. Rising means your edge is strengthening; falling toward or below zero means it's decaying." />
              <span className="text-xs text-slate-500">rolling 20-trade expectancy</span>
            </span>
          }
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={s.rollingExpectancy} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                axisLine={{ stroke: 'var(--chart-grid)' }}
                tickLine={false}
              />
              <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                contentStyle={{
                  background: 'var(--chart-tooltip-bg)',
                  border: '1px solid var(--chart-grid)',
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelStyle={{ color: 'var(--txt-300)' }}
                formatter={(v) => [fmtSignedUsd(Number(v)), 'Expectancy']}
              />
              <ReferenceLine y={0} stroke="var(--chart-axis)" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </CollapsibleCard>
      )}

      {s.totalClosed > 0 && <BenchmarkCard />}

      {s.totalClosed > 0 && (s.byTag.length > 0 || s.byGrade.length > 0 || s.byDiscipline.length > 0) && (
        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-2">
            Performance by setup
            <span className="text-slate-500 font-normal"> — what’s actually working</span>
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
            <Breakdown id="byTag" title="By tag" colLabel="Tag" rows={s.byTag} />
            <Breakdown id="byGrade" title="By grade" colLabel="Grade" rows={s.byGrade} />
            <Breakdown id="byDiscipline" title="By discipline" colLabel="Checklist" rows={s.byDiscipline} />
          </div>
        </div>
      )}

      {s.totalClosed > 0 && (s.byWeekday.length > 0 || s.byHold.length > 0 || s.byTimeOfDay.length > 0) && (
        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-2">
            Performance by timing
            <span className="text-slate-500 font-normal"> — when do you trade best?</span>
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <Breakdown id="byWeekday" title="By weekday (exit)" colLabel="Day" rows={s.byWeekday} />
            <Breakdown id="byHold" title="By hold time" colLabel="Held" rows={s.byHold} />
            {s.byTimeOfDay.length > 0 && (
              <Breakdown id="byTimeOfDay" title="By entry session" colLabel="Session" rows={s.byTimeOfDay} />
            )}
          </div>
        </div>
      )}

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Tags:</span>
          <button
            className={cx('chip', !tagFilter ? 'bg-accent/20 text-accent' : 'bg-ink-600 text-slate-300')}
            onClick={() => setTagFilter(null)}
          >
            all
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              className={cx('chip', tagFilter === t ? 'bg-accent/20 text-accent' : 'bg-ink-600 text-slate-300')}
              onClick={() => setTagFilter(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No closed trades yet"
            hint="Closed positions appear here with tags, grades, notes, and stats. Log a trade and record an exit to start building your journal."
            action={
              <Link to="/positions" className="btn-primary">
                Log a trade →
              </Link>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-auto max-h-[70vh]">
          <table className="w-full table-zebra">
            <thead className="sticky-thead">
              <tr>
                <SortTh label="Symbol" k="symbol" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortTh label="Entry → last exit" k="date" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortTh label="Grade" k="grade" active={sortKey} dir={sortDir} onSort={onSort} />
                <th className="th">Rules</th>
                <th className="th">Tags</th>
                <SortTh
                  label="Realized P&L"
                  k="realized"
                  active={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                  align="right"
                />
                <SortTh label="Return" k="return" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                <th className="th">Notes</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const p = r.position;
                const lastExit = p.exits.length ? p.exits[p.exits.length - 1].exitDate : p.entryDate;
                return (
                  <tr key={p.id} className="border-b border-ink-700/50 hover:bg-ink-700/30 align-top">
                    <td className="td">
                      <Link to={`/symbol/${p.symbol}`} className="font-semibold hover:text-accent">
                        {p.symbol}
                      </Link>
                      {p.assetType === 'option' && (
                        <div className="text-[11px] text-slate-500">
                          {fmtNum(p.strike)} {p.optionType === 'call' ? 'C' : 'P'}
                        </div>
                      )}
                    </td>
                    <td className="td text-slate-400 text-xs">
                      {fmtDate(p.entryDate)} → {fmtDate(lastExit)}
                    </td>
                    <td className="td">
                      {p.grade ? (
                        <Badge color={p.grade <= 'B' ? 'green' : p.grade === 'C' ? 'amber' : 'red'}>{p.grade}</Badge>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="td">
                      {(() => {
                        const { checked, total } = disciplineCount(p.checklist);
                        if (total === 0) return <span className="text-slate-600">—</span>;
                        const all = checked === total;
                        return (
                          <span
                            className="chip bg-ink-600 text-slate-300 tabular-nums"
                            title={`${checked} of ${total} pre-trade rules checked`}
                          >
                            <span className={all ? 'text-bull' : 'text-amber-400'}>{all ? '✓' : '!'}</span> {checked}/
                            {total}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap gap-1">
                        {p.tags.length ? (
                          p.tags.map((t) => (
                            <span key={t} className="chip bg-ink-600 text-slate-300">
                              {t}
                            </span>
                          ))
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                      </div>
                    </td>
                    <td className="td text-right">
                      <PnL value={r.pnl.totalPnl} className="font-semibold" />
                      {r.washSale && (
                        <div className="mt-0.5">
                          <WashSaleBadge washSale={r.washSale} />
                        </div>
                      )}
                    </td>
                    <td className="td text-right">
                      <PnL value={r.pnl.returnPct} format={fmtPct} />
                      {r.pnl.rMultiple != null && (
                        <div className="text-[11px] text-slate-500 tabular-nums">
                          {r.pnl.rMultiple >= 0 ? '+' : ''}
                          {fmtNum(r.pnl.rMultiple, 2)}R
                        </div>
                      )}
                    </td>
                    <td className="td max-w-[220px] truncate text-slate-400 text-xs" title={p.notes ?? ''}>
                      {p.notes || '—'}
                    </td>
                    <td className="td">
                      <button className="text-xs text-accent" onClick={() => setEditPos(p)}>
                        edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <JournalEditModal position={editPos} onClose={() => setEditPos(null)} onSaved={reload} />
      <JournalAnalyticsModal open={analyticsOpen} onClose={() => setAnalyticsOpen(false)} />
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from '../lib/recharts';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtNum, fmtPct, fmtSignedUsd } from '../lib/format';
import { Badge, Card, EmptyState, PnL, Spinner, StatTile } from '../components/ui';
import { JournalEditModal } from '../components/PositionForms';
import { DataTools } from '../components/DataTools';
import type { Position } from '../api/types';

export default function JournalPage() {
  const stats = useAsync(() => client.journalStats(), []);
  const closed = useAsync(() => client.positionsWithPnl({ status: 'closed' }), []);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editPos, setEditPos] = useState<Position | null>(null);

  const reload = () => {
    stats.reload();
    closed.reload();
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

  if (stats.loading || closed.loading) return <Spinner label="Loading journal…" />;
  const s = stats.data!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trade journal</h1>
        <DataTools onImported={reload} />
      </div>

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

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-2">P&L over time (cumulative realized)</h3>
        {s.equityCurve.length === 0 ? (
          <div className="text-slate-500 text-sm py-8 text-center">Close some trades to build the equity curve.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={s.equityCurve} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#243042" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#7c8aa0', fontSize: 11 }}
                axisLine={{ stroke: '#243042' }}
                tickLine={false}
              />
              <YAxis tick={{ fill: '#7c8aa0', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                contentStyle={{ background: '#111722', border: '1px solid #243042', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#cbd5e1' }}
                formatter={(v: number) => [fmtSignedUsd(v), 'Cumulative']}
              />
              <Line
                type="monotone"
                dataKey="cumulative"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={{ r: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

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
            hint="Closed positions appear here with tags, grades, notes, and stats."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Symbol</th>
                <th className="th">Entry → last exit</th>
                <th className="th">Grade</th>
                <th className="th">Tags</th>
                <th className="th text-right">Realized P&L</th>
                <th className="th text-right">Return</th>
                <th className="th">Notes</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
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
                    </td>
                    <td className="td text-right">
                      <PnL value={r.pnl.returnPct} format={fmtPct} />
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
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { pnlClass } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Spinner, StatTile } from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { ExitModal, JournalEditModal, LogTradeModal } from '../components/PositionForms';
import { RiskSizingModal } from '../components/RiskSizingModal';
import type { Position, PositionWithPnl } from '../api/types';

type StatusFilter = 'all' | 'open' | 'closed';

export default function PositionsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const data = useAsync(
    () => client.positionsWithPnl(statusFilter === 'all' ? {} : { status: statusFilter }),
    [statusFilter],
  );

  const [logOpen, setLogOpen] = useState(false);
  const [sizerOpen, setSizerOpen] = useState(false);
  const [exitPos, setExitPos] = useState<Position | null>(null);
  const [editPos, setEditPos] = useState<Position | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const reload = () => {
    setLastUpdated(Date.now());
    data.reload();
  };

  const remove = async (id: number) => {
    if (!window.confirm('Delete this position and its exits?')) return;
    await client.deletePosition(id);
    reload();
  };

  const agg = data.data?.aggregate;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Positions &amp; P&amp;L</h1>
        <div className="flex items-center gap-3">
          <RefreshBar onRefresh={reload} lastUpdated={lastUpdated} loading={data.loading} />
          <button className="btn-ghost" onClick={() => setSizerOpen(true)}>Calc size</button>
          <button className="btn-primary" onClick={() => setLogOpen(true)}>+ Log trade</button>
        </div>
      </div>

      {agg && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile label="Total P&L" value={fmtSignedUsd(agg.total)} valueClass={pnlClass(agg.total)} />
          <StatTile label="Realized" value={fmtSignedUsd(agg.realized)} valueClass={pnlClass(agg.realized)} />
          <StatTile label="Unrealized" value={fmtSignedUsd(agg.unrealized)} valueClass={pnlClass(agg.unrealized)} />
          <StatTile label="Open mkt value" value={fmtUsd(agg.openMarketValue)} />
          <StatTile label="Open" value={agg.openCount} />
          <StatTile label="Closed" value={agg.closedCount} />
        </div>
      )}

      <div className="flex items-center gap-1">
        {(['open', 'closed', 'all'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            className={cx('px-3 py-1 rounded-md text-sm capitalize', statusFilter === s ? 'bg-ink-600 text-white' : 'text-slate-400 hover:bg-ink-700')}
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {data.loading && !data.data ? (
        <Spinner />
      ) : data.error ? (
        <Card><ErrorState error={data.error} onRetry={reload} /></Card>
      ) : data.data && data.data.positions.length === 0 ? (
        <Card>
          <EmptyState
            title="No positions yet"
            hint="Log your stock and option trades to track live P&L, realized vs unrealized, and build your journal."
            action={<button className="btn-primary" onClick={() => setLogOpen(true)}>+ Log trade</button>}
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Symbol</th>
                <th className="th">Side</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Entry</th>
                <th className="th text-right">Price</th>
                <th className="th text-right">Cost basis</th>
                <th className="th text-right">Realized</th>
                <th className="th text-right">Unrealized</th>
                <th className="th text-right">Total P&L</th>
                <th className="th text-right">Return</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.data!.positions.map((row) => (
                <PositionRow key={row.position.id} row={row} onExit={setExitPos} onEdit={setEditPos} onDelete={remove} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <LogTradeModal open={logOpen} onClose={() => setLogOpen(false)} onSaved={reload} />
      <RiskSizingModal open={sizerOpen} onClose={() => setSizerOpen(false)} />
      <ExitModal position={exitPos} onClose={() => setExitPos(null)} onSaved={reload} />
      <JournalEditModal position={editPos} onClose={() => setEditPos(null)} onSaved={reload} />
    </div>
  );
}

function PositionRow({
  row,
  onExit,
  onEdit,
  onDelete,
}: {
  row: PositionWithPnl;
  onExit: (p: Position) => void;
  onEdit: (p: Position) => void;
  onDelete: (id: number) => void;
}) {
  const p = row.position;
  const { pnl } = row;
  const isOption = p.assetType === 'option';
  return (
    <tr className="border-b border-ink-700/50 hover:bg-ink-700/30">
      <td className="td">
        <Link to={`/symbol/${p.symbol}`} className="font-semibold hover:text-accent">{p.symbol}</Link>
        {isOption && (
          <span className="ml-2 text-xs text-slate-500">
            {fmtNum(p.strike)} {p.optionType === 'call' ? 'C' : 'P'} {p.expiration}
          </span>
        )}
        {p.status === 'closed' && <span className="ml-2"><Badge>closed</Badge></span>}
      </td>
      <td className="td"><span className={p.side === 'long' ? 'text-bull' : 'text-bear'}>{p.side}</span></td>
      <td className="td text-right">{p.remainingQuantity}{p.remainingQuantity !== p.quantity && <span className="text-slate-500">/{p.quantity}</span>}</td>
      <td className="td text-right">{fmtUsd(p.entryPrice)}</td>
      <td className="td text-right">
        {pnl.currentPrice === null ? <span className="text-slate-600">—</span> : fmtUsd(pnl.currentPrice)}
        {row.stale && <span className="ml-1 chip bg-amber-500/15 text-amber-400" title="last-known cached price">stale</span>}
      </td>
      <td className="td text-right text-slate-400">{fmtUsd(pnl.costBasis)}</td>
      <td className={cx('td text-right', pnlClass(pnl.realizedPnl))}>{fmtSignedUsd(pnl.realizedPnl)}</td>
      <td className={cx('td text-right', pnlClass(pnl.unrealizedPnl))}>{pnl.unrealizedPnl === null ? '—' : fmtSignedUsd(pnl.unrealizedPnl)}</td>
      <td className={cx('td text-right font-semibold', pnlClass(pnl.totalPnl))}>{fmtSignedUsd(pnl.totalPnl)}</td>
      <td className={cx('td text-right', pnlClass(pnl.returnPct))}>{fmtPct(pnl.returnPct)}</td>
      <td className="td text-right whitespace-nowrap">
        {p.status === 'open' && <button className="text-xs text-accent hover:underline mr-2" onClick={() => onExit(p)}>exit</button>}
        <button className="text-xs text-slate-400 hover:text-slate-200 mr-2" onClick={() => onEdit(p)}>journal</button>
        <button className="text-xs text-slate-500 hover:text-bear" onClick={() => onDelete(p.id)}>del</button>
      </td>
    </tr>
  );
}

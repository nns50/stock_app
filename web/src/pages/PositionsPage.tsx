import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PnL,
  SkeletonStats,
  SkeletonTable,
  StatTile,
} from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { ExitModal, JournalEditModal, LogTradeModal } from '../components/PositionForms';
import { RiskSizingModal } from '../components/RiskSizingModal';
import { ExposurePanel } from '../components/ExposurePanel';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
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
  const { toast } = useToast();
  const confirm = useConfirm();

  const reload = () => {
    setLastUpdated(Date.now());
    data.reload();
  };

  const remove = async (id: number) => {
    const found = data.data?.positions.find((r) => r.position.id === id)?.position;
    const ok = await confirm({
      title: 'Delete position?',
      body: 'This removes the trade and its exits from your journal.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await client.deletePosition(id);
    reload();
    toast('Position deleted', {
      type: 'success',
      action: found
        ? {
            label: 'Undo',
            onClick: async () => {
              await client.importPositions([found], 'merge');
              reload();
            },
          }
        : undefined,
    });
  };

  const agg = data.data?.aggregate;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Positions & P&L"
        subtitle="Live realized & unrealized P&L across your open and closed trades."
        actions={
          <>
            <RefreshBar onRefresh={reload} lastUpdated={lastUpdated} loading={data.loading} />
            <button className="btn-ghost" onClick={() => setSizerOpen(true)}>
              Calc size
            </button>
            <button className="btn-primary" onClick={() => setLogOpen(true)}>
              <Plus className="h-4 w-4" /> Log trade
            </button>
          </>
        }
      />

      {agg ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile label="Total P&L" value={<PnL value={agg.total} />} />
          <StatTile label="Realized" value={<PnL value={agg.realized} />} />
          <StatTile label="Unrealized" value={<PnL value={agg.unrealized} />} />
          <StatTile label="Open mkt value" value={fmtUsd(agg.openMarketValue)} />
          <StatTile label="Open" value={agg.openCount} />
          <StatTile label="Closed" value={agg.closedCount} />
        </div>
      ) : data.loading ? (
        <SkeletonStats count={6} />
      ) : null}

      {data.data?.exposure && data.data.exposure.gross > 0 && <ExposurePanel exposure={data.data.exposure} />}

      <div className="flex items-center gap-1">
        {(['open', 'closed', 'all'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            className={cx(
              'px-3 py-1 rounded-md text-sm capitalize',
              statusFilter === s ? 'bg-ink-600 text-white' : 'text-slate-400 hover:bg-ink-700',
            )}
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {data.loading && !data.data ? (
        <Card>
          <SkeletonTable rows={6} cols={11} />
        </Card>
      ) : data.error ? (
        <Card>
          <ErrorState error={data.error} onRetry={reload} />
        </Card>
      ) : data.data && data.data.positions.length === 0 ? (
        <Card>
          <EmptyState
            title="No positions yet"
            hint="Log your stock and option trades to track live P&L, realized vs unrealized, and build your journal."
            action={
              <button className="btn-primary" onClick={() => setLogOpen(true)}>
                + Log trade
              </button>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-auto max-h-[70vh]">
          <table className="w-full table-zebra">
            <thead className="sticky-thead">
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
                <PositionRow
                  key={row.position.id}
                  row={row}
                  onExit={setExitPos}
                  onEdit={setEditPos}
                  onDelete={remove}
                />
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
        <Link to={`/symbol/${p.symbol}`} className="font-semibold hover:text-accent">
          {p.symbol}
        </Link>
        {isOption && (
          <span className="ml-2 text-xs text-slate-500">
            {fmtNum(p.strike)} {p.optionType === 'call' ? 'C' : 'P'} {p.expiration}
          </span>
        )}
        {p.status === 'closed' && (
          <span className="ml-2">
            <Badge>closed</Badge>
          </span>
        )}
        {p.status === 'open' && (p.stopPrice != null || p.targetPrice != null || pnl.rMultiple != null) && (
          <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums flex flex-wrap gap-x-2">
            {p.stopPrice != null && (
              <span className="text-bear" title="Stop level (distance from current price)">
                SL {fmtNum(p.stopPrice)}
                {row.price != null && ` ${fmtNum(Math.abs((row.price - p.stopPrice) / row.price) * 100, 0)}%`}
              </span>
            )}
            {p.targetPrice != null && (
              <span className="text-bull" title="Target level (distance from current price)">
                TP {fmtNum(p.targetPrice)}
                {row.price != null && ` ${fmtNum(Math.abs((row.price - p.targetPrice) / row.price) * 100, 0)}%`}
              </span>
            )}
            {pnl.rMultiple != null && (
              <span
                className={pnl.rMultiple >= 0 ? 'text-bull' : 'text-bear'}
                title="Current open P&L in R (vs initial risk)"
              >
                {pnl.rMultiple >= 0 ? '+' : ''}
                {fmtNum(pnl.rMultiple, 2)}R
              </span>
            )}
          </div>
        )}
      </td>
      <td className="td">
        <span className={p.side === 'long' ? 'text-bull' : 'text-bear'}>{p.side}</span>
      </td>
      <td className="td text-right">
        {p.remainingQuantity}
        {p.remainingQuantity !== p.quantity && <span className="text-slate-500">/{p.quantity}</span>}
      </td>
      <td className="td text-right">{fmtUsd(p.entryPrice)}</td>
      <td className="td text-right">
        {pnl.currentPrice === null ? <span className="text-slate-600">—</span> : fmtUsd(pnl.currentPrice)}
        {row.stale && (
          <span className="ml-1 chip bg-amber-500/15 text-amber-400" title="last-known cached price">
            stale
          </span>
        )}
      </td>
      <td className="td text-right text-slate-400">{fmtUsd(pnl.costBasis)}</td>
      <td className="td text-right">
        <PnL value={pnl.realizedPnl} />
      </td>
      <td className="td text-right">{pnl.unrealizedPnl === null ? '—' : <PnL value={pnl.unrealizedPnl} />}</td>
      <td className="td text-right">
        <PnL value={pnl.totalPnl} className="font-semibold" />
      </td>
      <td className="td text-right">
        <PnL value={pnl.returnPct} format={fmtPct} />
      </td>
      <td className="td text-right whitespace-nowrap">
        {p.status === 'open' && (
          <button className="text-xs text-accent hover:underline mr-2" onClick={() => onExit(p)}>
            exit
          </button>
        )}
        <button className="text-xs text-slate-400 hover:text-slate-200 mr-2" onClick={() => onEdit(p)}>
          journal
        </button>
        <button className="text-xs text-slate-500 hover:text-bear" onClick={() => onDelete(p.id)}>
          del
        </button>
      </td>
    </tr>
  );
}

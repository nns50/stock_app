import { memo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync, useSort } from '../lib/hooks';
import { fmtNum, fmtPct, fmtUsd } from '../lib/format';
import {
  Badge,
  CollapsibleCard,
  EmptyState,
  ErrorState,
  PageHeader,
  PnL,
  Segmented,
  SkeletonStats,
  SkeletonTable,
  SortTh,
  StatTile,
} from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { CloseModal, ExitModal, JournalEditModal } from '../components/PositionForms';
import { OPEN_LOG_TRADE_EVENT, TRADE_LOGGED_EVENT } from '../components/GlobalLogTrade';
import { RiskSizingModal } from '../components/RiskSizingModal';
import { ExposurePanel } from '../components/ExposurePanel';
import { PortfolioStressPanel } from '../components/PortfolioStressPanel';
import { CorrelationHeatmapPanel } from '../components/CorrelationHeatmapPanel';
import { EarningsBadge } from '../components/EarningsBadge';
import type { SymbolEvents } from '../api/types';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
import type { Position, PositionWithPnl } from '../api/types';

type StatusFilter = 'all' | 'open' | 'closed';

/** Mirrors the server's providers/webull/positions.ts isWebullTracked() —
 *  an open position counts as broker-attributable only if the app itself
 *  put it there from a real brokerage: imported by the Webull sync (tagged
 *  'webull'), opened by a live fill (tagged 'live'), or linked to a live
 *  order_intent (sourceIntentId). A plain manually-logged position (e.g.
 *  tracked at a different broker) has nothing to place a real order
 *  against, so it keeps the journal-only "exit" flow instead of "close". */
function isLivePosition(p: Position): boolean {
  return p.tags.includes('webull') || p.tags.includes('live') || p.sourceIntentId !== null;
}

/** Comparable value for a sortable Positions column (module-level → stable). */
function positionSortVal(row: PositionWithPnl, key: string): number | string | null {
  const p = row.position;
  const pnl = row.pnl;
  switch (key) {
    case 'symbol':
      return p.symbol;
    case 'side':
      return p.side;
    case 'qty':
      return p.remainingQuantity;
    case 'entry':
      return p.entryPrice;
    case 'price':
      return pnl.currentPrice;
    case 'cost':
      return pnl.costBasis;
    case 'realized':
      return pnl.realizedPnl;
    case 'unrealized':
      return pnl.unrealizedPnl;
    case 'total':
      return pnl.totalPnl;
    case 'return':
      return pnl.returnPct;
    default:
      return null;
  }
}

export default function PositionsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  // Fetch the WHOLE book once — the headline tiles and exposure describe the
  // portfolio ("open and closed", per the subtitle), so they must not be
  // scoped to the tab. The status tab only filters which rows the table shows,
  // done client-side below; switching tabs no longer triggers a refetch.
  const data = useAsync(() => client.positionsWithPnl({}), []);
  const allRows = data.data?.positions ?? [];
  const visibleRows = statusFilter === 'all' ? allRows : allRows.filter((r) => r.position.status === statusFilter);
  const { sorted: sortedPositions, sortKey, sortDir, onSort } = useSort(visibleRows, positionSortVal);

  // Earnings/ex-div for the listed symbols, to flag positions with events approaching.
  const symbolsKey = [...new Set(visibleRows.map((r) => r.position.symbol.toUpperCase()))].join(',');
  const events = useAsync(
    () => (symbolsKey ? client.events(symbolsKey.split(',')) : Promise.resolve({ events: [] })),
    [symbolsKey],
  );
  const eventsBySym = new Map((events.data?.events ?? []).map((e) => [e.symbol.toUpperCase(), e]));

  const [sizerOpen, setSizerOpen] = useState(false);
  const [exitPos, setExitPos] = useState<Position | null>(null);
  const [closePos, setClosePos] = useState<Position | null>(null);
  const [editPos, setEditPos] = useState<Position | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  // Refresh when a trade is logged from the global modal (header / `n` / palette).
  useEffect(() => {
    const onLogged = () => {
      setLastUpdated(Date.now());
      data.reload();
    };
    window.addEventListener(TRADE_LOGGED_EVENT, onLogged);
    return () => window.removeEventListener(TRADE_LOGGED_EVENT, onLogged);
  }, [data.reload]);

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
      <PortfolioStressPanel />
      <CorrelationHeatmapPanel />

      <Segmented
        options={[
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
          { value: 'all', label: 'All' },
        ]}
        value={statusFilter}
        onChange={setStatusFilter}
      />

      <CollapsibleCard id="positions.table" title="Positions">
        {data.loading && !data.data ? (
          <SkeletonTable rows={6} cols={11} />
        ) : data.error ? (
          <ErrorState error={data.error} onRetry={reload} />
        ) : data.data && sortedPositions.length === 0 ? (
          <EmptyState
            title="No positions yet"
            hint="Log your stock and option trades to track live P&L, realized vs unrealized, and build your journal."
            action={
              <button className="btn-primary" onClick={() => window.dispatchEvent(new Event(OPEN_LOG_TRADE_EVENT))}>
                + Log trade
              </button>
            }
          />
        ) : (
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full table-zebra">
              <thead className="sticky-thead">
                <tr>
                  <SortTh label="Symbol" k="symbol" active={sortKey} dir={sortDir} onSort={onSort} />
                  <SortTh label="Side" k="side" active={sortKey} dir={sortDir} onSort={onSort} />
                  <SortTh label="Qty" k="qty" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Entry" k="entry" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Price" k="price" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Cost basis" k="cost" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Realized" k="realized" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh
                    label="Unrealized"
                    k="unrealized"
                    active={sortKey}
                    dir={sortDir}
                    onSort={onSort}
                    align="right"
                  />
                  <SortTh label="Total P&L" k="total" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Return" k="return" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((row) => (
                  <PositionRow
                    key={row.position.id}
                    row={row}
                    events={eventsBySym.get(row.position.symbol.toUpperCase())}
                    onExit={setExitPos}
                    onClose={setClosePos}
                    onEdit={setEditPos}
                    onDelete={remove}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <RiskSizingModal open={sizerOpen} onClose={() => setSizerOpen(false)} />
      <ExitModal position={exitPos} onClose={() => setExitPos(null)} onSaved={reload} />
      <CloseModal position={closePos} onClose={() => setClosePos(null)} onSaved={reload} />
      <JournalEditModal position={editPos} onClose={() => setEditPos(null)} onSaved={reload} />
    </div>
  );
}

const PositionRow = memo(
  function PositionRow({
    row,
    events,
    onExit,
    onClose,
    onEdit,
    onDelete,
  }: {
    row: PositionWithPnl;
    events?: SymbolEvents;
    onExit: (p: Position) => void;
    onClose: (p: Position) => void;
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
          {p.status === 'open' && events?.earningsDate && (
            <span className="ml-2">
              <EarningsBadge events={events} warnWithin={p.assetType === 'option' ? 10 : 7} />
            </span>
          )}
          {p.status === 'closed' && (
            <span className="ml-2">
              <Badge>closed</Badge>
            </span>
          )}
          {p.accountId && (
            <span
              className="ml-2 chip bg-ink-700 text-slate-400 font-mono text-[10px]"
              title={`Webull account ${p.accountId}`}
            >
              {p.accountId.length > 14 ? `…${p.accountId.slice(-11)}` : p.accountId}
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
            <>
              {/* Every open position can record a manual exit — including a
                  live/Webull one you already sold OUTSIDE the app (directly at
                  the broker). This just writes the exit to your journal; it does
                  NOT place an order. Previously a live position only offered
                  "close" (a real broker order), leaving no clean way to record
                  an already-sold position without placing a redundant order or
                  deleting it. */}
              <button
                className="text-xs text-accent hover:underline mr-2"
                onClick={() => onExit(p)}
                title="Record an exit in your journal — no broker order (use this if you already sold it at the broker)"
              >
                exit
              </button>
              {isLivePosition(p) && (
                <button
                  className="text-xs text-bear hover:underline mr-2"
                  onClick={() => onClose(p)}
                  title="Place a real closing order at your broker"
                >
                  close
                </button>
              )}
            </>
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
  },
  // Every ~60s poll tick hands this page a brand-new object graph even when
  // nothing changed (the fetch layer never preserves row identity), so a
  // plain identity-based memo would never skip a render. Comparing content
  // instead — but only for row/events, deliberately not onExit/onEdit/
  // onDelete: those close over this page's own state (e.g. remove()'s
  // "Undo" needs the position data at delete time), but that state is the
  // SAME data this row's own (content-compared) prop is drawn from, so a
  // row whose content is unchanged would resolve identically either way.
  (prev, next) =>
    JSON.stringify(prev.row) === JSON.stringify(next.row) &&
    JSON.stringify(prev.events) === JSON.stringify(next.events),
);

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync, useSort } from '../lib/hooks';
import { ago, fmtNum, fmtPct, fmtUsd } from '../lib/format';
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
import { ExpiredOptionsBanner } from '../components/ExpiredOptionsBanner';
import { PortfolioStressPanel } from '../components/PortfolioStressPanel';
import { CorrelationHeatmapPanel } from '../components/CorrelationHeatmapPanel';
import { EarningsBadge } from '../components/EarningsBadge';
import { WashSaleBadge } from '../components/WashSaleBadge';
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
  // Memoized so useSort's own memo actually holds — derived fresh each render,
  // its input array is a new identity every time and the whole book re-sorts on
  // every keystroke and poll tick.
  const allRows = useMemo(() => data.data?.positions ?? [], [data.data]);
  const visibleRows = useMemo(
    () => (statusFilter === 'all' ? allRows : allRows.filter((r) => r.position.status === statusFilter)),
    [allRows, statusFilter],
  );
  const { sorted: sortedPositions, sortKey, sortDir, onSort } = useSort(visibleRows, positionSortVal);

  // Earnings/ex-div for the symbols that can actually show a badge — only OPEN
  // rows render one. Keyed off the open book rather than the visible rows so
  // switching status tabs (a client-side filter) doesn't refetch this and blank
  // every badge while it reloads; sorted so the key depends on which symbols
  // are held, not what order the table happens to be in.
  const symbolsKey = useMemo(
    () =>
      [...new Set(allRows.filter((r) => r.position.status === 'open').map((r) => r.position.symbol.toUpperCase()))]
        .sort()
        .join(','),
    [allRows],
  );
  const events = useAsync(
    () => (symbolsKey ? client.events(symbolsKey.split(',')) : Promise.resolve({ events: [] })),
    [symbolsKey],
  );
  const eventsBySym = useMemo(
    () => new Map((events.data?.events ?? []).map((e) => [e.symbol.toUpperCase(), e])),
    [events.data],
  );

  const [sizerOpen, setSizerOpen] = useState(false);
  // The open modals track a position by ID and re-derive it from the current
  // book, rather than holding the row object they were opened with. That
  // object is a snapshot: the 60s poll and the background Webull sync both
  // move remainingQuantity underneath it, so a dialog left open was quietly
  // acting on a stale size — an exit sized against a quantity that no longer
  // exists, or a close whose confirmation phrase names the wrong number of
  // shares. Derived, the dialog follows the truth, and a position that
  // disappears from the book while its dialog is open simply closes it.
  const [exitId, setExitId] = useState<number | null>(null);
  const [closeId, setCloseId] = useState<number | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  const positionById = useCallback(
    (id: number | null) => (id === null ? null : (allRows.find((r) => r.position.id === id)?.position ?? null)),
    [allRows],
  );
  const exitPos = positionById(exitId);
  const closePos = positionById(closeId);
  const editPos = positionById(editId);

  // Two different kinds of refresh, deliberately separate:
  //
  //   reload()     — re-read prices and P&L. What the 60s poll and the Refresh
  //                  button do. Cheap: one batched quote call.
  //   reloadBook() — the COMPOSITION of the book changed (an exit, a close, a
  //                  delete, a logged trade), so the panels below have to
  //                  recompute too.
  //
  // The panels aren't on the poll because each costs a per-symbol provider
  // call — fundamentals for the stress test, daily candles for the correlation
  // grid and the expiry sweep. Recomputing those every minute would be real
  // provider load for numbers that only move when a position does. Keyed on
  // the book instead, they stay correct without the cost: before this they
  // were keyed on nothing at all and simply never refreshed, so the stress
  // test and the expired-options banner kept describing a book you had
  // already changed.
  const reload = data.reload;
  const [bookVersion, setBookVersion] = useState(0);
  // The book's COMPOSITION (which lots exist, their status, how much of each
  // is still open) as one comparable string. bookVersion only moves on changes
  // made FROM this page — but the book also changes underneath it server-side:
  // the background Webull sync closes sold/expired positions, and live order
  // fills materialize new ones. Those arrive via the ordinary price poll,
  // which the panels deliberately don't follow — so a position the sync had
  // closed stayed in the expired-options banner and the stress/correlation
  // panels until you touched something. serverBookChanges counts polls whose
  // composition actually differs from the last one seen, so the panels follow
  // those too while a poll that moved nothing but prices still leaves them
  // alone. The first load only records the baseline, and reloadBook() resets
  // it so a page-initiated change (already covered by its bookVersion bump)
  // isn't double-counted when the refreshed book lands.
  const bookCompositionKey = useMemo(
    () => allRows.map((r) => `${r.position.id}:${r.position.status}:${r.position.remainingQuantity}`).join('|'),
    [allRows],
  );
  const lastComposition = useRef<string | null>(null);
  const [serverBookChanges, setServerBookChanges] = useState(0);
  useEffect(() => {
    if (!data.data) return;
    if (lastComposition.current !== null && lastComposition.current !== bookCompositionKey) {
      setServerBookChanges((c) => c + 1);
    }
    lastComposition.current = bookCompositionKey;
  }, [data.data, bookCompositionKey]);
  const reloadBook = useCallback(() => {
    lastComposition.current = null;
    setBookVersion((v) => v + 1);
    reload();
  }, [reload]);
  const panelsKey = `${bookVersion}|${serverBookChanges}`;

  // Refresh when a trade is logged from the global modal (header / `n` / palette).
  useEffect(() => {
    window.addEventListener(TRADE_LOGGED_EVENT, reloadBook);
    return () => window.removeEventListener(TRADE_LOGGED_EVENT, reloadBook);
  }, [reloadBook]);

  // Stamp the "Updated …" clock when a load SUCCEEDS. Stamping it when the
  // request was fired (what reload() used to do) meant a failed poll still
  // reported "Updated 0s ago" over numbers that were minutes stale — exactly
  // when the age of what's on screen matters most. `data` keeps its identity
  // through a failure, so this only fires on a fresh payload.
  useEffect(() => {
    if (data.data) setLastUpdated(Date.now());
  }, [data.data]);

  const remove = async (id: number) => {
    const found = allRows.find((r) => r.position.id === id)?.position;
    const ok = await confirm({
      title: 'Delete position?',
      body: 'This removes the trade and its exits from your journal.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // Guards the row while the request is in flight. Without it a second click
    // on a slow connection fires a second DELETE against a row that is already
    // gone, and the 404 surfaces as "Couldn't delete — position not found"
    // over a delete that actually worked.
    setDeletingId(id);
    try {
      await client.deletePosition(id);
    } catch (e) {
      // Unhandled before: a rejected delete left the row on screen with no
      // toast and no error, reading exactly like a successful one.
      toast(`Couldn't delete — ${(e as Error).message}`, { type: 'error' });
      return;
    } finally {
      setDeletingId(null);
    }
    reloadBook();
    toast('Position deleted', {
      type: 'success',
      action: found
        ? {
            label: 'Undo',
            onClick: async () => {
              try {
                await client.importPositions([found], 'merge');
                reloadBook();
              } catch (e) {
                toast(`Couldn't undo — ${(e as Error).message}`, { type: 'error' });
              }
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

      <ExpiredOptionsBanner onChanged={reloadBook} reloadKey={panelsKey} />

      {data.data?.exposure && data.data.exposure.gross > 0 && <ExposurePanel exposure={data.data.exposure} />}
      <PortfolioStressPanel reloadKey={panelsKey} />
      <CorrelationHeatmapPanel reloadKey={panelsKey} />

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
        {!data.data ? (
          // Nothing loaded yet: a first-load failure is the only case where the
          // full-card error belongs — once there ARE numbers on screen, a failed
          // poll is reported by the banner below instead of throwing them away.
          data.error ? (
            <ErrorState error={data.error} onRetry={reload} />
          ) : (
            <SkeletonTable rows={6} cols={11} />
          )
        ) : (
          <>
            {data.error && (
              <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                ⚠ Couldn&apos;t refresh — showing the last numbers that loaded ({ago(lastUpdated)}).{' '}
                {data.error.message}{' '}
                <button className="underline hover:text-amber-100" onClick={reload}>
                  Retry
                </button>
              </div>
            )}
            {!!events.data?.omitted?.length && (
              // A missing earnings badge otherwise reads as "no earnings
              // coming", which is a materially different thing from "we never
              // asked about this symbol".
              <div className="mb-3 text-[11px] text-amber-400/90">
                ⚠ Past the earnings-lookup limit, so no earnings badge was checked for: {events.data.omitted.join(', ')}
              </div>
            )}
            {allRows.length === 0 ? (
              <EmptyState
                title="No positions yet"
                hint="Log your stock and option trades to track live P&L, realized vs unrealized, and build your journal."
                action={
                  <button className="btn-primary" onClick={() => window.dispatchEvent(new Event(OPEN_LOG_TRADE_EVENT))}>
                    + Log trade
                  </button>
                }
              />
            ) : sortedPositions.length === 0 ? (
              // The book isn't empty, this TAB is — offering the first-run
              // "log your first trade" pitch here read as "you have no
              // positions at all", which is just wrong on a book with rows.
              <EmptyState
                title={statusFilter === 'open' ? 'No open positions' : 'No closed positions'}
                hint={
                  statusFilter === 'open'
                    ? 'Everything you’ve logged is closed — switch to Closed or All to see it.'
                    : 'Nothing has been fully exited yet — switch to Open or All to see what you’re holding.'
                }
                action={
                  <button className="btn-ghost" onClick={() => setStatusFilter('all')}>
                    Show all
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
                      <SortTh
                        label="Cost basis"
                        k="cost"
                        active={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                        align="right"
                      />
                      <SortTh
                        label="Realized"
                        k="realized"
                        active={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                        align="right"
                      />
                      <SortTh
                        label="Unrealized"
                        k="unrealized"
                        active={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                        align="right"
                      />
                      <SortTh
                        label="Total P&L"
                        k="total"
                        active={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                        align="right"
                      />
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
                        onExit={setExitId}
                        onClose={setCloseId}
                        onEdit={setEditId}
                        onDelete={remove}
                        deleting={deletingId === row.position.id}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CollapsibleCard>

      <RiskSizingModal open={sizerOpen} onClose={() => setSizerOpen(false)} />
      <ExitModal position={exitPos} onClose={() => setExitId(null)} onSaved={reloadBook} />
      <CloseModal position={closePos} onClose={() => setCloseId(null)} onSaved={reloadBook} />
      <JournalEditModal position={editPos} onClose={() => setEditId(null)} onSaved={reloadBook} />
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
    deleting,
  }: {
    row: PositionWithPnl;
    events?: SymbolEvents;
    onExit: (id: number) => void;
    onClose: (id: number) => void;
    onEdit: (id: number) => void;
    onDelete: (id: number) => void;
    deleting: boolean;
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
              {/* `=== 'put' ? 'P' : 'C'` would invent a call for a null type
                  exactly as the old `=== 'call' ? 'C' : 'P'` invented a put —
                  an unknown type has to read as unknown. */}
              {fmtNum(p.strike)} {p.optionType === 'call' ? 'C' : p.optionType === 'put' ? 'P' : '?'} {p.expiration}
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
          {row.washSale && (
            // The API returns this for every row and the Journal has always
            // shown it; this table dropped it, so the same closed loss carried
            // a wash-sale flag on one page and none on the other.
            <span className="ml-2">
              <WashSaleBadge washSale={row.washSale} />
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
              {/* `row.price &&` (not `!= null`) on purpose: a 0 price divides
                  to Infinity and renders a nonsense "∞%" distance. */}
              {p.stopPrice != null && (
                <span className="text-bear" title="Stop level (distance from current price)">
                  SL {fmtNum(p.stopPrice)}
                  {!!row.price && ` ${fmtNum(Math.abs((row.price - p.stopPrice) / row.price) * 100, 0)}%`}
                </span>
              )}
              {p.targetPrice != null && (
                <span className="text-bull" title="Target level (distance from current price)">
                  TP {fmtNum(p.targetPrice)}
                  {!!row.price && ` ${fmtNum(Math.abs((row.price - p.targetPrice) / row.price) * 100, 0)}%`}
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
                className="text-xs text-accent hover:underline mr-2 disabled:opacity-40"
                onClick={() => onExit(p.id)}
                disabled={deleting}
                title="Record an exit in your journal — no broker order (use this if you already sold it at the broker)"
              >
                exit
              </button>
              {isLivePosition(p) && (
                <button
                  className="text-xs text-bear hover:underline mr-2 disabled:opacity-40"
                  onClick={() => onClose(p.id)}
                  disabled={deleting}
                  title="Place a real closing order at your broker"
                >
                  close
                </button>
              )}
            </>
          )}
          <button
            className="text-xs text-slate-400 hover:text-slate-200 mr-2 disabled:opacity-40"
            onClick={() => onEdit(p.id)}
            disabled={deleting}
          >
            journal
          </button>
          <button
            className="text-xs text-slate-500 hover:text-bear disabled:opacity-40"
            onClick={() => onDelete(p.id)}
            disabled={deleting}
          >
            {deleting ? 'deleting…' : 'del'}
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
    prev.deleting === next.deleting &&
    JSON.stringify(prev.row) === JSON.stringify(next.row) &&
    JSON.stringify(prev.events) === JSON.stringify(next.events),
);

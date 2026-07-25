import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Camera, Star, TriangleAlert } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { TRADE_LOGGED_EVENT } from '../components/GlobalLogTrade';
import { cx, fmtDate, fmtPct, fmtUsd } from '../lib/format';
import { CollapsibleCard, EmptyState, PageHeader, PnL, Spinner, StatTile } from '../components/ui';
import { GettingStarted } from '../components/GettingStarted';
import { DayGuardCard } from '../components/DayGuardCard';
import { TodaysSetups } from '../components/TodaysSetups';
import { MarketMovers } from '../components/MarketMovers';
import { MarketRegimeGauge } from '../components/MarketRegimeGauge';
import { AssignmentRiskBadge } from '../components/AssignmentRiskBadge';
import { daysUntil } from '../components/EarningsBadge';
import type { SymbolEvents } from '../api/types';

function daysToExpiry(exp: string): number {
  return Math.ceil((Date.parse(exp) - Date.now()) / 86_400_000);
}

interface CatalystRow {
  symbol: string;
  kind: 'earnings' | 'exDividend';
  date: string;
  dte: number;
  estimated?: boolean;
}

/** Both catalyst types for one symbol's events, each only if upcoming (not past). */
function catalystRowsOf(e: SymbolEvents): CatalystRow[] {
  const rows: CatalystRow[] = [];
  const erDte = daysUntil(e.earningsDate);
  if (e.earningsDate && erDte !== null && erDte >= 0) {
    rows.push({ symbol: e.symbol, kind: 'earnings', date: e.earningsDate, dte: erDte, estimated: e.earningsEstimated });
  }
  const exDte = daysUntil(e.exDividendDate);
  if (e.exDividendDate && exDte !== null && exDte >= 0) {
    rows.push({ symbol: e.symbol, kind: 'exDividend', date: e.exDividendDate, dte: exDte });
  }
  return rows;
}

export default function DashboardPage() {
  const positions = useAsync(() => client.positionsWithPnl({ status: 'open' }), []);
  // Read-only snapshot — merely viewing the Dashboard must not flip one-shot
  // alert triggers (which would suppress the background scheduler's notification
  // for them). The AlertsContext poller owns the mutating evaluate.
  const alerts = useAsync(() => client.alertsState(), []);
  const watch = useAsync(async () => {
    const w = await client.watchlist();
    const quotes = w.symbols.length ? (await client.quotes(w.symbols)).quotes : [];
    return { symbols: w.symbols, quotes };
  }, []);
  const snapshots = useAsync(() => client.listSnapshots(), []);

  // Catalysts (earnings / ex-dividend) across everything worth checking before
  // the open: every open position's underlying + the watchlist. Waits for
  // both those loads to settle (the key is '' until then, which short-
  // circuits to an empty fetch) rather than firing twice.
  const eventSymbolsKey = Array.from(
    new Set(
      [...(positions.data?.positions ?? []).map((p) => p.position.symbol), ...(watch.data?.symbols ?? [])].map((s) =>
        s.toUpperCase(),
      ),
    ),
  )
    .sort()
    .join(',');
  const events = useAsync(
    () =>
      eventSymbolsKey ? client.events(eventSymbolsKey.split(',')) : Promise.resolve({ events: [] as SymbolEvents[] }),
    [eventSymbolsKey],
  );

  // Refresh open positions when a trade is logged from the global modal.
  // reloadPositions is useAsync's stable run() — depend on it directly so the
  // listener isn't re-bound every render.
  const reloadPositions = positions.reload;
  useEffect(() => {
    const onLogged = () => reloadPositions();
    window.addEventListener(TRADE_LOGGED_EVENT, onLogged);
    return () => window.removeEventListener(TRADE_LOGGED_EVENT, onLogged);
  }, [reloadPositions]);

  const agg = positions.data?.aggregate;
  const exposure = positions.data?.exposure;

  // Everything that wants action: position exits/stops + triggered symbol alerts.
  const positionAlerts = alerts.data?.positionAlerts ?? [];
  const triggered = (alerts.data?.alerts ?? []).filter((a) => a.triggered);
  const attentionCount = positionAlerts.length + triggered.length;

  const expiring = (positions.data?.positions ?? [])
    .filter((p) => p.position.assetType === 'option' && p.position.expiration)
    .map((p) => ({ p: p.position, price: p.price, dte: daysToExpiry(p.position.expiration as string) }))
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 5);

  // Assignment risk needs each expiring option's UNDERLYING price, not its own
  // mark (already on hand as `price` above) — a dedicated quotes fetch scoped
  // to just these symbols, since the underlying isn't necessarily on the
  // watchlist too.
  const expiringUnderlyingsKey = Array.from(new Set(expiring.map(({ p }) => p.symbol.toUpperCase())))
    .sort()
    .join(',');
  const underlyingQuotes = useAsync(
    () =>
      expiringUnderlyingsKey
        ? client.quotes(expiringUnderlyingsKey.split(','))
        : Promise.resolve({ quotes: [], asOf: 0 }),
    [expiringUnderlyingsKey],
  );
  const underlyingBySymbol = new Map((underlyingQuotes.data?.quotes ?? []).map((q) => [q.symbol.toUpperCase(), q]));

  const watchBySymbol = new Map((watch.data?.quotes ?? []).map((q) => [q.symbol.toUpperCase(), q]));
  const eventsBySymbol = new Map((events.data?.events ?? []).map((e) => [e.symbol.toUpperCase(), e]));
  const catalysts = (events.data?.events ?? [])
    .flatMap(catalystRowsOf)
    .filter((r) => r.dte <= 14)
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 8);
  const latestSnapshot = snapshots.data?.snapshots?.[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Today"
        subtitle="Open risk, alerts, and what needs your attention."
        actions={<span className="text-xs text-slate-500">{fmtDate(Date.now())}</span>}
      />

      <GettingStarted />
      <DayGuardCard />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatTile label="Open P&L" value={agg ? <PnL value={agg.total} /> : '—'} />
        <StatTile label="Unrealized" value={agg ? <PnL value={agg.unrealized} /> : '—'} />
        <StatTile label="Open positions" value={agg?.openCount ?? '—'} />
        <StatTile label="Gross exposure" value={exposure ? fmtUsd(exposure.gross) : '—'} />
        <StatTile
          label="Needs attention"
          value={alerts.loading ? '…' : attentionCount}
          valueClass={attentionCount > 0 ? 'text-amber-400' : undefined}
        />
      </div>

      <TodaysSetups />

      <MarketRegimeGauge />

      <MarketMovers />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <CollapsibleCard
          id="dashboard.attention"
          title="Needs attention"
          icon={<TriangleAlert className={cx('h-4 w-4', attentionCount > 0 ? 'text-amber-400' : 'text-slate-500')} />}
          action={
            <Link to="/alerts" className="text-xs text-accent">
              Alerts →
            </Link>
          }
        >
          {alerts.loading ? (
            <Spinner label="Checking…" />
          ) : attentionCount === 0 ? (
            <div className="text-sm text-slate-500 py-2">All clear — nothing hitting a rule right now.</div>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {positionAlerts.map((a) => (
                <li key={`p${a.positionId}:${a.rule}`} className="flex items-start gap-2">
                  <span className="text-amber-400">⚠</span>
                  <Link to="/positions" className="hover:text-accent">
                    {a.message}
                  </Link>
                </li>
              ))}
              {triggered.map((a) => (
                <li key={`a${a.id}`} className="flex items-start gap-2">
                  <span className="text-amber-400">🔔</span>
                  <Link to={`/symbol/${a.symbol}`} className="hover:text-accent">
                    {a.triggerMessage ?? `${a.symbol} ${a.kind} ${a.operator} ${a.threshold}`}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleCard>

        <CollapsibleCard
          id="dashboard.watchlist"
          title="Watchlist"
          icon={<Star className="h-4 w-4 text-slate-500" />}
          action={
            <Link to="/watchlist" className="text-xs text-accent">
              Watchlist →
            </Link>
          }
        >
          {watch.loading ? (
            <Spinner label="Loading…" />
          ) : !watch.data?.symbols.length ? (
            <div className="text-sm text-slate-500 py-2">
              Nothing watched yet — add symbols on the{' '}
              <Link to="/watchlist" className="text-accent">
                Watch
              </Link>{' '}
              tab.
            </div>
          ) : (
            <ul className="divide-y divide-ink-700/50">
              {watch.data.symbols.map((sym) => {
                const q = watchBySymbol.get(sym);
                return (
                  <li key={sym} className="flex items-center justify-between py-1.5 text-sm">
                    <Link to={`/symbol/${sym}`} className="font-medium hover:text-accent">
                      {sym}
                    </Link>
                    <span className="flex items-center gap-3 tabular-nums">
                      <span className="text-slate-400">{q ? fmtUsd(q.last) : '—'}</span>
                      {q && q.changePct !== undefined ? <PnL value={q.changePct} format={fmtPct} /> : <span>—</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsibleCard>

        <CollapsibleCard
          id="dashboard.expirations"
          title="Upcoming expirations"
          icon={<CalendarClock className="h-4 w-4 text-slate-500" />}
          action={
            <Link to="/positions" className="text-xs text-accent">
              Positions →
            </Link>
          }
        >
          {positions.loading ? (
            <Spinner label="Loading…" />
          ) : expiring.length === 0 ? (
            <div className="text-sm text-slate-500 py-2">No open option positions.</div>
          ) : (
            <ul className="divide-y divide-ink-700/50">
              {expiring.map(({ p, price, dte }) => (
                <li key={p.id} className="flex items-center justify-between py-1.5 text-sm gap-2">
                  <Link to={`/symbol/${p.symbol}`} className="hover:text-accent min-w-0">
                    <span className="font-medium">{p.symbol}</span>{' '}
                    <span className="text-slate-500 text-xs">
                      {p.strike} {p.optionType === 'call' ? 'C' : 'P'}
                    </span>
                  </Link>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {p.side === 'short' && p.optionType && p.strike != null && (
                      <AssignmentRiskBadge
                        side={p.optionType}
                        strike={p.strike}
                        mark={price}
                        underlyingPrice={underlyingBySymbol.get(p.symbol.toUpperCase())?.last ?? null}
                        events={eventsBySymbol.get(p.symbol.toUpperCase())}
                      />
                    )}
                    <span className="tabular-nums text-xs">
                      <span className="text-slate-400">{p.expiration}</span>{' '}
                      <span className={dte <= 7 ? 'text-amber-400' : 'text-slate-500'}>
                        {dte < 0 ? 'expired' : `${dte}d`}
                      </span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleCard>

        <CollapsibleCard
          id="dashboard.catalysts"
          title="Upcoming catalysts"
          icon={<CalendarClock className="h-4 w-4 text-slate-500" />}
        >
          {events.loading ? (
            <Spinner label="Checking earnings & ex-dividend dates…" />
          ) : catalysts.length === 0 ? (
            <div className="text-sm text-slate-500 py-2">
              No earnings or ex-dividend dates in the next 14 days for your positions or watchlist.
            </div>
          ) : (
            <ul className="divide-y divide-ink-700/50">
              {catalysts.map((c) => (
                <li key={`${c.symbol}-${c.kind}`} className="flex items-center justify-between py-1.5 text-sm">
                  <Link to={`/symbol/${c.symbol}`} className="font-medium hover:text-accent">
                    {c.symbol}
                  </Link>
                  <span className="tabular-nums text-xs">
                    <span className="text-slate-400">
                      {c.kind === 'earnings' ? 'Earnings' : 'Ex-div'}
                      {c.estimated ? ' (est.)' : ''}
                    </span>{' '}
                    <span className={c.dte <= 7 ? 'text-amber-400' : 'text-slate-500'}>{c.dte}d</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleCard>

        <CollapsibleCard
          id="dashboard.snapshot"
          title="Latest screener snapshot"
          icon={<Camera className="h-4 w-4 text-slate-500" />}
          action={
            <Link to="/screener" className="text-xs text-accent">
              Screener →
            </Link>
          }
        >
          {snapshots.loading ? (
            <Spinner label="Loading…" />
          ) : !latestSnapshot ? (
            <EmptyState title="No snapshots yet" hint="Snapshot a screener run to track its edge over time." />
          ) : (
            <div className="text-sm">
              <div className="flex items-center gap-2">
                <span className={latestSnapshot.direction === 'long' ? 'text-bull' : 'text-bear'}>
                  {latestSnapshot.direction}
                </span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400">{latestSnapshot.pickCount} picks</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-500 text-xs">{fmtDate(latestSnapshot.createdAt)}</span>
              </div>
              {latestSnapshot.note && <div className="text-slate-400 text-xs mt-1">{latestSnapshot.note}</div>}
            </div>
          )}
        </CollapsibleCard>
      </div>
    </div>
  );
}

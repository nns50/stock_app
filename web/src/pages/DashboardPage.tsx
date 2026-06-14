import { Link } from 'react-router-dom';
import { CalendarClock, Camera, Star, TriangleAlert } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtPct, fmtUsd } from '../lib/format';
import { Card, EmptyState, PageHeader, PnL, Spinner, StatTile } from '../components/ui';
import { GettingStarted } from '../components/GettingStarted';

function daysToExpiry(exp: string): number {
  return Math.ceil((Date.parse(exp) - Date.now()) / 86_400_000);
}

function Panel({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-ink-700/50">
        <h3 className="font-medium text-sm flex items-center gap-2 text-slate-200">
          {icon}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </Card>
  );
}

export default function DashboardPage() {
  const positions = useAsync(() => client.positionsWithPnl({ status: 'open' }), []);
  const alerts = useAsync(() => client.evaluateAlerts(), []);
  const watch = useAsync(async () => {
    const w = await client.watchlist();
    const quotes = w.symbols.length ? (await client.quotes(w.symbols)).quotes : [];
    return { symbols: w.symbols, quotes };
  }, []);
  const snapshots = useAsync(() => client.listSnapshots(), []);

  const agg = positions.data?.aggregate;
  const exposure = positions.data?.exposure;

  // Everything that wants action: position exits/stops + triggered symbol alerts.
  const positionAlerts = alerts.data?.positionAlerts ?? [];
  const triggered = (alerts.data?.alerts ?? []).filter((a) => a.triggered);
  const attentionCount = positionAlerts.length + triggered.length;

  const expiring = (positions.data?.positions ?? [])
    .filter((p) => p.position.assetType === 'option' && p.position.expiration)
    .map((p) => ({ p: p.position, dte: daysToExpiry(p.position.expiration as string) }))
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 5);

  const watchBySymbol = new Map((watch.data?.quotes ?? []).map((q) => [q.symbol.toUpperCase(), q]));
  const latestSnapshot = snapshots.data?.snapshots?.[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Today"
        subtitle="Open risk, alerts, and what needs your attention."
        actions={<span className="text-xs text-slate-500">{fmtDate(Date.now())}</span>}
      />

      <GettingStarted />

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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Panel
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
        </Panel>

        <Panel
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
        </Panel>

        <Panel
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
              {expiring.map(({ p, dte }) => (
                <li key={p.id} className="flex items-center justify-between py-1.5 text-sm">
                  <Link to={`/symbol/${p.symbol}`} className="hover:text-accent">
                    <span className="font-medium">{p.symbol}</span>{' '}
                    <span className="text-slate-500 text-xs">
                      {p.strike} {p.optionType === 'call' ? 'C' : 'P'}
                    </span>
                  </Link>
                  <span className="tabular-nums text-xs">
                    <span className="text-slate-400">{p.expiration}</span>{' '}
                    <span className={dte <= 7 ? 'text-amber-400' : 'text-slate-500'}>
                      {dte < 0 ? 'expired' : `${dte}d`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
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
        </Panel>
      </div>
    </div>
  );
}

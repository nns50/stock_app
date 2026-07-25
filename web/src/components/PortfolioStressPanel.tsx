import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtSignedUsd } from '../lib/format';
import { CollapsibleCard, EmptyState, ErrorState, Spinner } from './ui';

const REASON_LABEL: Record<string, string> = {
  'no-beta': 'no beta data',
  'no-price': 'no live price',
  'no-delta': 'no live delta',
};

/**
 * "How much would a broad market move cost or make me, right now?" — beta-
 * weights every open position (stock + option) against a fixed set of
 * hypothetical market moves. Collapsed by default and fetched only once
 * expanded: unlike the exposure panel above it (derived from data the page
 * already loaded), this needs its own per-symbol fundamentals lookups.
 */
export function PortfolioStressPanel() {
  return (
    <CollapsibleCard id="positions.stressTest" title="Market stress test" defaultCollapsed>
      <StressBody />
    </CollapsibleCard>
  );
}

function StressBody() {
  const data = useAsync(() => client.portfolioStress(), []);

  if (data.loading) return <Spinner label="Beta-weighting your open positions…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.totalCount === 0) {
    return (
      <EmptyState
        title="No open positions to stress test"
        hint="Log or import an open stock or option position to see how a market move would hit your book."
      />
    );
  }

  const { scenarios, unresolved, resolvedCount, totalCount } = data.data;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Estimated P&amp;L if the broad market moved by each amount below, beta-weighting every open position's own
        historical market sensitivity. A model, not a prediction — real moves aren't linear and beta drifts over time.
      </p>
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {scenarios.map((s) => (
          <div key={s.pct} className="card px-2 py-2 text-center">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              {s.pct >= 0 ? '+' : ''}
              {s.pct}%
            </div>
            <div
              className={cx(
                'text-sm font-semibold tabular-nums mt-1',
                s.estimatedPnl > 0 ? 'text-bull' : s.estimatedPnl < 0 ? 'text-bear' : 'text-slate-300',
              )}
            >
              {fmtSignedUsd(s.estimatedPnl, 0)}
            </div>
          </div>
        ))}
      </div>
      {resolvedCount < totalCount && (
        <p className="text-[11px] text-amber-400/90">
          ⚠ {resolvedCount} of {totalCount} open position{totalCount === 1 ? '' : 's'} included — excluded:{' '}
          {unresolved.map((u, i) => (
            <span key={`${u.positionId}-${u.reason}`}>
              {i > 0 && ', '}
              {u.symbol} ({REASON_LABEL[u.reason] ?? u.reason})
            </span>
          ))}
        </p>
      )}
      <p className="text-[11px] text-slate-500">
        Beta comes from your market-data provider and reflects each symbol's own historical relationship to the broad
        market — not tax or trading advice, and not the same as the Journal's own benchmark comparison.
      </p>
    </div>
  );
}

import type { CSSProperties } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx } from '../lib/format';
import { CollapsibleCard, EmptyState, ErrorState, Spinner } from './ui';

/**
 * "Which of my open names actually move together?" — a pairwise Pearson-
 * correlation heatmap of daily returns across the underlyings of every OPEN
 * position (server: services/portfolioCorrelation.ts). The single "correlated
 * exposure %" guardrail answers that as one number; this shows the whole grid,
 * so five "different" tickers that all trade as one are obvious at a glance.
 *
 * Collapsed by default and fetched only once expanded: like the stress test
 * below it, this needs its own per-symbol candle history.
 */
export function CorrelationHeatmapPanel() {
  return (
    <CollapsibleCard id="positions.correlation" title="Correlation heatmap" defaultCollapsed>
      <CorrelationBody />
    </CollapsibleCard>
  );
}

/** Positive correlation (names move together → concentration risk) reads red;
 *  negative (a natural hedge) reads green; near-zero (diversified) stays
 *  neutral. Opacity scales with |r| so the eye lands on the strongest pairs. */
function cellStyle(r: number | null): CSSProperties {
  if (r === null) return {};
  const a = Math.min(Math.abs(r), 1) * 0.85;
  // bull #22c55e (34,197,94) for hedges, bear #ef4444 (239,68,68) for clustering
  return r >= 0 ? { backgroundColor: `rgba(239, 68, 68, ${a})` } : { backgroundColor: `rgba(34, 197, 94, ${a})` };
}

function CorrelationBody() {
  const data = useAsync(() => client.portfolioCorrelation(), []);

  if (data.loading) return <Spinner label="Correlating your open positions…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.symbols.length === 0) {
    return (
      <EmptyState
        title="No open positions to correlate"
        hint="Log or import two or more open stock or option positions to see how tightly their daily returns move together."
      />
    );
  }

  const { symbols, matrix, topPair, unresolved, lookbackDays } = data.data;
  const resolvedCount = symbols.length - unresolved.length;

  if (resolvedCount < 2) {
    return (
      <EmptyState
        title="Not enough price history to correlate"
        hint="At least two of your open names need fetchable daily history over the lookback window."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Pearson correlation of daily returns over the last {lookbackDays} sessions, across every open position's
        underlying. <span className="text-bear">Red</span> pairs move together (concentration risk);{' '}
        <span className="text-bull">green</span> pairs move opposite (a natural hedge). Correlation is backward-looking
        and drifts — not a prediction.
      </p>

      {topPair && (
        <p className="text-xs text-slate-300">
          Most correlated:{' '}
          <span className="font-semibold text-slate-100">
            {topPair.a} / {topPair.b}
          </span>{' '}
          at{' '}
          <span className={cx('font-semibold tabular-nums', topPair.r >= 0 ? 'text-bear' : 'text-bull')}>
            {topPair.r >= 0 ? '+' : ''}
            {topPair.r.toFixed(2)}
          </span>
          {topPair.r >= 0.7 && ' — these two are effectively one bet.'}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-ink-900" />
              {symbols.map((s) => (
                <th key={s} className="px-1.5 py-1 text-slate-400 font-medium" title={s}>
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((rowSym, i) => (
              <tr key={rowSym}>
                <th className="sticky left-0 z-10 bg-ink-900 pr-2 text-right text-slate-400 font-medium whitespace-nowrap">
                  {rowSym}
                </th>
                {symbols.map((colSym, j) => {
                  const r = matrix[i][j];
                  return (
                    <td
                      key={colSym}
                      className={cx(
                        'h-7 w-9 min-w-9 text-center text-[10px]',
                        r === null ? 'text-slate-600' : Math.abs(r) > 0.5 ? 'text-white' : 'text-slate-300',
                      )}
                      style={cellStyle(r)}
                      title={r === null ? `${rowSym} · ${colSym}: no data` : `${rowSym} · ${colSym}: ${r.toFixed(2)}`}
                    >
                      {r === null ? '–' : r.toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {unresolved.length > 0 && (
        <p className="text-[11px] text-amber-400/90">⚠ Excluded (no fetchable history): {unresolved.join(', ')}</p>
      )}
    </div>
  );
}

import { Gauge } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtTime } from '../lib/format';
import type { RegimeLabel, RegimeSignal } from '../api/types';
import { CollapsibleCard, ErrorState, Spinner } from './ui';

/**
 * Read-only market-regime gauge for the Today dashboard: folds the proxy's
 * trend (vs its 50/200-day averages), market breadth, and proxy volatility into
 * one Risk-on / Neutral / Risk-off read (server: services/marketRegime.ts).
 * Context for the human — it does NOT gate or resize anything.
 */
export function MarketRegimeGauge() {
  return (
    <CollapsibleCard id="dashboard.regime" title="Market regime" icon={<Gauge className="h-4 w-4 text-slate-500" />}>
      <RegimeBody />
    </CollapsibleCard>
  );
}

const LABEL_TEXT: Record<RegimeLabel, string> = {
  'risk-on': 'Risk-on',
  neutral: 'Neutral',
  'risk-off': 'Risk-off',
};

/** Risk-on reads bull-green, risk-off bear-red, neutral/unknown muted. */
function signalClasses(signal: RegimeSignal): string {
  switch (signal) {
    case 'risk-on':
      return 'text-bull';
    case 'risk-off':
      return 'text-bear';
    default:
      return 'text-slate-400';
  }
}

function labelBadgeClasses(label: RegimeLabel): string {
  switch (label) {
    case 'risk-on':
      return 'bg-bull/15 text-bull border-bull/30';
    case 'risk-off':
      return 'bg-bear/15 text-bear border-bear/30';
    default:
      return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  }
}

const SIGNAL_DOT: Record<RegimeSignal, string> = {
  'risk-on': 'bg-bull',
  'risk-off': 'bg-bear',
  neutral: 'bg-slate-500',
  unknown: 'bg-slate-700',
};

function RegimeBody() {
  const data = useAsync(() => client.marketRegime(), []);

  if (data.loading) return <Spinner label="Reading the tape…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data) return null;

  const { label, proxySymbol, components, resolvedComponents, asOf } = data.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cx(
            'inline-flex items-center rounded-md border px-2.5 py-1 text-sm font-semibold',
            labelBadgeClasses(label),
          )}
        >
          {LABEL_TEXT[label]}
        </span>
        <span className="text-xs text-slate-500">
          {proxySymbol} proxy · {resolvedComponents} of {components.length} signals resolved
        </span>
      </div>

      <ul className="space-y-1.5">
        {components.map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-sm">
            <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', SIGNAL_DOT[c.signal])} />
            <div className="min-w-0">
              <span className="text-slate-300">{c.label}</span>{' '}
              <span className={cx('font-medium', signalClasses(c.signal))}>
                {c.signal === 'unknown' ? 'no data' : c.signal.replace('-', ' ')}
              </span>
              <div className="text-xs text-slate-500">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-slate-500">
        Context, not a signal — this doesn't place, size, or block any trade. Trend, breadth, and volatility are
        backward-looking and shift on the daily close. Updated {fmtTime(asOf)}.
      </p>
    </div>
  );
}

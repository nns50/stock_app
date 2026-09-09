import { Gauge } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtTime } from '../lib/format';
import type { MlRegime, MlRegimeReading, MlRegimeReason, RegimeLabel, RegimeSignal } from '../api/types';
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
      <MlRegimeBlock />
    </div>
  );
}

// --- the ML regime reading ---------------------------------------------------

const ML_LABEL: Record<MlRegime, string> = {
  high_vol_bearish: 'High Volatility/Bearish',
  low_vol_bullish: 'Low Volatility/Bullish',
  sideways: 'Sideways',
  unknown: 'Unknown',
};

const ML_BADGE: Record<MlRegime, string> = {
  high_vol_bearish: 'bg-bear/15 text-bear border-bear/30',
  low_vol_bullish: 'bg-bull/15 text-bull border-bull/30',
  sideways: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  unknown: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
};

const REASON_TEXT: Record<MlRegimeReason, string> = {
  no_model: 'no model file is shipped',
  source_off: 'the data source is switched off',
  no_data: 'not enough data to filter',
  stale: 'the data is too old',
  synthetic_provider: 'no real data source (mock provider)',
  fetch_failed: 'the data fetch failed',
};

/** What the reading says, in one line each — exported for the test. */
export function mlRegimeNotes(r: MlRegimeReading): string[] {
  const notes: string[] = [];
  const candidateP = r.probabilities && r.candidate !== 'unknown' ? r.probabilities[r.candidate] : null;
  if (r.stale) {
    notes.push(
      `Stale — data through ${r.asOf ?? '?'}; a reading this old is not acted on` +
        (r.candidate !== 'unknown' ? ` (the model would read ${ML_LABEL[r.candidate]})` : '') +
        '.',
    );
  } else if (r.regime === 'unknown' && r.reason) {
    notes.push(`Unknown — ${REASON_TEXT[r.reason]}.`);
  }
  if (r.heldBelowThreshold && !r.stale) {
    notes.push(
      `Held below ${r.threshold} — the model prefers ${ML_LABEL[r.candidate]}` +
        (candidateP !== null ? ` at ${candidateP.toFixed(2)}` : '') +
        ', not enough to switch.',
    );
  }
  if (r.drift) notes.push('Model drift — the tape has left the model’s distribution; retrain (see the model card).');
  return notes;
}

/**
 * The shipped HMM's reading of the tape (server: services/mlRegime.ts,
 * docs/MARKET_REGIME_MODEL.md): High Volatility/Bearish, Low Volatility/Bullish
 * or Sideways, with the filtered probability, the data date it is "as of", and
 * the caveats that matter (stale, held, drift). Display only — nothing acts on
 * it yet.
 */
function MlRegimeBlock() {
  const data = useAsync(() => client.marketRegimeMl(), []);

  if (data.loading) return <Spinner label="Reading the regime model…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data) return null;

  const r = data.data;
  const acted = r.regime !== 'unknown' ? r.regime : r.candidate;
  const p = r.probabilities && acted !== 'unknown' ? r.probabilities[acted] : null;

  return (
    <div className="space-y-1.5 border-t border-ink-600 pt-3" data-testid="ml-regime">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-400">ML regime (HMM)</span>
        <span
          className={cx(
            'inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-semibold',
            ML_BADGE[r.regime],
          )}
        >
          {r.label}
        </span>
        {p !== null && <span className="text-xs tabular-nums text-slate-500">p={p.toFixed(2)}</span>}
        {r.asOf && (
          <span className="text-xs text-slate-500">
            as of {r.asOf} · {r.source}
          </span>
        )}
      </div>
      {mlRegimeNotes(r).map((note) => (
        <p key={note} className="text-xs text-amber-400">
          {note}
        </p>
      ))}
      <p className="text-[11px] text-slate-500">
        A three-state hidden Markov model over daily S&amp;P 500 returns, the VIX and 20-day realized vol, read one to
        two sessions behind (FRED publishes the prior close next morning). “Bearish” and “Bullish” describe each state’s
        fitted drift, not a forecast. Nothing acts on this reading yet.
      </p>
    </div>
  );
}

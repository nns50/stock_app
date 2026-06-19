// ---------------------------------------------------------------------------
// Pure alert evaluation. Given an alert's condition and the current metrics for
// its symbol, decide whether it's triggered and build a human message. No I/O —
// the route gathers data and persists results.
// ---------------------------------------------------------------------------

// Stock/underlying metrics (symbol-level) and option-contract metrics (a
// specific call/put: its mark/bid/ask, absolute delta, and IV). Option alerts
// can also trigger on the *underlying* price via the shared `price` kind.
export type AlertKind =
  | 'price'
  | 'change'
  | 'relvol'
  | 'rsi'
  | 'macross'
  | 'high52'
  | 'low52'
  | 'optmark'
  | 'optbid'
  | 'optask'
  | 'optdelta'
  | 'optiv';
export type AlertOperator = 'above' | 'below';

export interface AlertCondition {
  kind: AlertKind;
  operator: AlertOperator;
  threshold: number;
}

export interface AlertMetrics {
  price: number | null;
  changePct: number | null;
  relVol: number | null;
  rsi: number | null;
  maSpreadPct: number | null;
  pctFromHigh52: number | null;
  pctFromLow52: number | null;
  /** Option-contract metrics — null for stock alerts. */
  optMark: number | null;
  optBid: number | null;
  optAsk: number | null;
  /** Absolute delta (|Δ|), 0..1. */
  optDelta: number | null;
  /** Implied volatility in percent (e.g. 42 for 42%). */
  optIv: number | null;
}

const LABEL: Record<AlertKind, string> = {
  price: 'price',
  change: 'change %',
  relvol: 'rel. volume',
  rsi: 'RSI',
  macross: 'MA20−MA50 spread',
  high52: '% from 52w high',
  low52: '% from 52w low',
  optmark: 'option mark',
  optbid: 'option bid',
  optask: 'option ask',
  optdelta: '|Δ|',
  optiv: 'IV',
};

/** Pull the value an alert cares about out of a symbol's current metrics. */
export function metricValue(kind: AlertKind, m: AlertMetrics): number | null {
  switch (kind) {
    case 'price':
      return m.price;
    case 'change':
      return m.changePct;
    case 'relvol':
      return m.relVol;
    case 'rsi':
      return m.rsi;
    case 'macross':
      return m.maSpreadPct;
    case 'high52':
      return m.pctFromHigh52;
    case 'low52':
      return m.pctFromLow52;
    case 'optmark':
      return m.optMark;
    case 'optbid':
      return m.optBid;
    case 'optask':
      return m.optAsk;
    case 'optdelta':
      return m.optDelta;
    case 'optiv':
      return m.optIv;
  }
}

function fmt(kind: AlertKind, v: number): string {
  if (kind === 'price' || kind === 'optmark' || kind === 'optbid' || kind === 'optask') return `$${v.toFixed(2)}`;
  if (kind === 'change' || kind === 'macross' || kind === 'high52' || kind === 'low52')
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  if (kind === 'relvol') return `${v.toFixed(2)}×`;
  if (kind === 'optiv') return `${v.toFixed(0)}%`;
  if (kind === 'optdelta') return v.toFixed(2);
  return v.toFixed(1);
}

export interface AlertEvaluation {
  value: number | null;
  triggered: boolean;
  message: string | null;
}

/**
 * Evaluate one alert against its symbol's metrics (one-shot: above/below).
 * `subject` names the thing being watched in the message — the bare symbol for a
 * stock alert, or a contract descriptor (e.g. `AAPL 150C 2026-07-17`) for an
 * option alert. Defaults to the symbol for backward compatibility.
 */
export function evaluateAlert(
  symbol: string,
  condition: AlertCondition,
  metrics: AlertMetrics,
  subject?: string,
): AlertEvaluation {
  const value = metricValue(condition.kind, metrics);
  if (value === null) return { value: null, triggered: false, message: null };
  const triggered = condition.operator === 'above' ? value > condition.threshold : value < condition.threshold;
  const who = subject ?? symbol.toUpperCase();
  const message = triggered
    ? `${who} ${LABEL[condition.kind]} ${fmt(condition.kind, value)} is ${condition.operator} ${fmt(condition.kind, condition.threshold)}`
    : null;
  return { value, triggered, message };
}

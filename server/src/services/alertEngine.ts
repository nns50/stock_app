// ---------------------------------------------------------------------------
// Pure alert evaluation. Given an alert's condition and the current metrics for
// its symbol, decide whether it's triggered and build a human message. No I/O —
// the route gathers data and persists results.
// ---------------------------------------------------------------------------

export type AlertKind = 'price' | 'change' | 'relvol' | 'rsi';
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
}

const LABEL: Record<AlertKind, string> = {
  price: 'price',
  change: 'change %',
  relvol: 'rel. volume',
  rsi: 'RSI',
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
  }
}

function fmt(kind: AlertKind, v: number): string {
  if (kind === 'price') return `$${v.toFixed(2)}`;
  if (kind === 'change') return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  if (kind === 'relvol') return `${v.toFixed(2)}×`;
  return v.toFixed(1);
}

export interface AlertEvaluation {
  value: number | null;
  triggered: boolean;
  message: string | null;
}

/** Evaluate one alert against its symbol's metrics (one-shot: above/below). */
export function evaluateAlert(symbol: string, condition: AlertCondition, metrics: AlertMetrics): AlertEvaluation {
  const value = metricValue(condition.kind, metrics);
  if (value === null) return { value: null, triggered: false, message: null };
  const triggered = condition.operator === 'above' ? value > condition.threshold : value < condition.threshold;
  const message = triggered
    ? `${symbol.toUpperCase()} ${LABEL[condition.kind]} ${fmt(condition.kind, value)} is ${condition.operator} ${fmt(condition.kind, condition.threshold)}`
    : null;
  return { value, triggered, message };
}

// ---------------------------------------------------------------------------
// Execution quality: for a live-traded fill (an order placed with a limit
// price), how did the actual broker fill compare to the price you committed
// to? Slippage is signed in dollars so POSITIVE always means it cost you
// money, regardless of side:
//   buy  (opening long / closing short): fill − limit   (paid more = bad)
//   sell (opening short / closing long): limit − fill    (received less = bad)
// Scope: only fills that trace back to an order with a persisted limit price
// (limit or stop-limit orders). A pure stop-market order has no reference
// price to compare against, and a manually logged or imported position was
// never a live order at all — both are simply excluded upstream, not guessed at.
// Pure and DB-free so it's directly unit-testable; the route does the DB
// orchestration (see routes/journal.ts).
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SlippageInput {
  positionId: number;
  symbol: string;
  kind: 'entry' | 'exit';
  /** The order's side (buy/sell) — not the resulting position's side. */
  side: 'buy' | 'sell';
  date: string;
  limitPrice: number;
  fillPrice: number;
  quantity: number;
  multiplier: number;
}

export interface SlippageRow extends SlippageInput {
  /** Signed $ per share/contract; positive = cost you money. */
  perUnit: number;
  /** perUnit × quantity × multiplier. */
  totalUsd: number;
  /** perUnit as a % of the limit price (signed). */
  pct: number;
}

export function computeSlippage(input: SlippageInput): SlippageRow {
  const perUnit = input.side === 'buy' ? input.fillPrice - input.limitPrice : input.limitPrice - input.fillPrice;
  const totalUsd = perUnit * input.quantity * input.multiplier;
  const pct = input.limitPrice !== 0 ? (perUnit / input.limitPrice) * 100 : 0;
  return { ...input, perUnit: round2(perUnit), totalUsd: round2(totalUsd), pct: round2(pct) };
}

export interface SlippageReport {
  /** Fills with a comparable limit price (the only ones counted below). */
  trades: number;
  /** Sum of totalUsd across all rows; positive = slippage cost you money overall. */
  totalUsd: number;
  avgPct: number | null;
  /** Most costly fills first (by totalUsd, descending) — where execution is bleeding money. */
  rows: SlippageRow[];
}

export function aggregateSlippage(rows: SlippageRow[]): SlippageReport {
  const totalUsd = round2(rows.reduce((s, r) => s + r.totalUsd, 0));
  const avgPct = rows.length ? round2(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : null;
  const sorted = [...rows].sort((a, b) => b.totalUsd - a.totalUsd);
  return { trades: rows.length, totalUsd, avgPct, rows: sorted };
}

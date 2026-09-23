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

/** The fields of an order that decide whether its limit is a fair reference. */
export interface SlippageIntentShape {
  assetKind: 'stock' | 'option';
  openClose: 'open' | 'close';
  isBracket: boolean;
  limitPrice: number | null;
}

/**
 * Whether a fill can be judged against this order's limit at all (2026-09-23).
 *
 * Two readers measured fills against the wrong order and reported the result as
 * execution:
 *
 *   - An ENTRY whose linked order is a different instrument. On 2026-09-23 the
 *     MRNA stock entry order was linked to the MRNA CALL's row, so a $2.84
 *     option fill was measured against a $187 share limit: -98.5%, in a mean
 *     that the leak scan reads as "fills land 0.85% better than the quote" on
 *     40 sessions of entries. That one row held the slippage alarm off for all
 *     of them.
 *   - An EXIT booked from a bracket LEG. A leg fill is booked against the
 *     bracket's own order, which is the ENTRY (materializeExitFill), so its
 *     "limit" is the entry price and the "slippage" is the trade's own move:
 *     DELL's +4.6% run to its target on 2026-09-02 read as 4.6% of execution
 *     cost. 35 of 106 exit rows were this. A resting leg has no marketable
 *     reference anyway — a take-profit fills at its price or better, and a
 *     stop's overrun is its own report (/journal/stop-overrun).
 *
 * So an entry counts only against an OPENING order of the same instrument, and
 * an exit only against a CLOSING order of the same instrument that the app
 * priced itself (a time exit, a stagnation close, a hand close from the app) —
 * never against a bracket.
 */
export function limitIsReference(
  kind: 'entry' | 'exit',
  positionAssetType: 'stock' | 'option',
  intent: SlippageIntentShape,
): boolean {
  if (intent.limitPrice === null) return false;
  if (intent.assetKind !== positionAssetType) return false;
  return kind === 'entry' ? intent.openClose === 'open' : intent.openClose === 'close' && !intent.isBracket;
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

export interface SymbolSlippage {
  symbol: string;
  trades: number;
  avgPct: number;
  totalUsd: number;
}

/** Per-symbol slippage breakdown — same rows aggregateSlippage() reports
 *  overall, grouped instead by symbol (services/autotrading/autoTune.ts's
 *  slippage-based auto-exclusion needs this; the Journal page's own report
 *  stays account-wide). Worst avgPct first. */
export function groupSlippageBySymbol(rows: SlippageRow[]): SymbolSlippage[] {
  const byId = new Map<string, SlippageRow[]>();
  for (const r of rows) {
    (byId.get(r.symbol) ?? byId.set(r.symbol, []).get(r.symbol)!).push(r);
  }
  return Array.from(byId.entries(), ([symbol, group]) => ({
    symbol,
    trades: group.length,
    avgPct: round2(group.reduce((s, r) => s + r.pct, 0) / group.length),
    totalUsd: round2(group.reduce((s, r) => s + r.totalUsd, 0)),
  })).sort((a, b) => b.avgPct - a.avgPct);
}

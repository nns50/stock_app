import { Position } from '../db/positions';

// ---------------------------------------------------------------------------
// P&L math. Pure functions over Position records (+ a resolved current price).
// Conventions:
//   - entry_price / exit_price are PER SHARE (per-share premium for options).
//   - notional = price * quantity * multiplier (multiplier = 100 for options).
//   - entry fees are allocated proportionally between the closed and open
//     portions of a partially-exited position.
// ---------------------------------------------------------------------------

export interface PositionPnl {
  positionId: number;
  currentPrice: number | null;
  /** Capital deployed at entry: entry_price * quantity * multiplier. */
  costBasis: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
  totalPnl: number;
  returnPct: number | null;
  /** Current market value of the still-open quantity. */
  marketValue: number | null;
  remainingQuantity: number;
  closedQuantity: number;
}

function sideSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Gross realized P&L (exits vs entry) net of all fees, for the whole position. */
export function realizedPnlOf(p: Position): number {
  const sign = sideSign(p.side);
  const grossRealized = p.exits.reduce(
    (sum, e) => sum + (e.exitPrice - p.entryPrice) * e.quantity * p.multiplier * sign,
    0,
  );
  const exitFees = p.exits.reduce((s, e) => s + e.fees, 0);
  return grossRealized - exitFees - p.fees; // all entry fees count once the math is whole-position
}

export function computePositionPnl(p: Position, currentPrice: number | null): PositionPnl {
  const sign = sideSign(p.side);
  const closedQty = p.quantity - p.remainingQuantity;
  const entryFeeClosed = p.quantity > 0 ? p.fees * (closedQty / p.quantity) : 0;
  const entryFeeOpen = p.fees - entryFeeClosed;

  const grossRealized = p.exits.reduce(
    (sum, e) => sum + (e.exitPrice - p.entryPrice) * e.quantity * p.multiplier * sign,
    0,
  );
  const exitFees = p.exits.reduce((s, e) => s + e.fees, 0);
  const realizedPnl = grossRealized - exitFees - entryFeeClosed;

  let unrealizedPnl: number | null = null;
  let marketValue: number | null = null;
  if (currentPrice !== null && p.remainingQuantity > 0) {
    unrealizedPnl = (currentPrice - p.entryPrice) * p.remainingQuantity * p.multiplier * sign - entryFeeOpen;
    marketValue = currentPrice * p.remainingQuantity * p.multiplier;
  } else if (p.remainingQuantity === 0) {
    unrealizedPnl = 0;
    marketValue = 0;
  }

  const costBasis = p.entryPrice * p.quantity * p.multiplier;
  const totalPnl = realizedPnl + (unrealizedPnl ?? 0);
  const returnPct = costBasis ? (totalPnl / costBasis) * 100 : null;

  return {
    positionId: p.id,
    currentPrice,
    costBasis: round2(costBasis),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl: unrealizedPnl === null ? null : round2(unrealizedPnl),
    totalPnl: round2(totalPnl),
    returnPct: returnPct === null ? null : round2(returnPct),
    marketValue: marketValue === null ? null : round2(marketValue),
    remainingQuantity: p.remainingQuantity,
    closedQuantity: round2(closedQty),
  };
}

export interface AggregatePnl {
  realized: number;
  unrealized: number;
  total: number;
  openMarketValue: number;
  openCount: number;
  closedCount: number;
}

export function aggregatePnl(items: PositionPnl[], positions: Position[]): AggregatePnl {
  const byId = new Map(positions.map((p) => [p.id, p]));
  let realized = 0;
  let unrealized = 0;
  let openMarketValue = 0;
  let openCount = 0;
  let closedCount = 0;
  for (const it of items) {
    realized += it.realizedPnl;
    unrealized += it.unrealizedPnl ?? 0;
    openMarketValue += it.marketValue ?? 0;
    const pos = byId.get(it.positionId);
    if (pos?.status === 'open') openCount++;
    else closedCount++;
  }
  return {
    realized: round2(realized),
    unrealized: round2(unrealized),
    total: round2(realized + unrealized),
    openMarketValue: round2(openMarketValue),
    openCount,
    closedCount,
  };
}

export interface JournalStats {
  totalClosed: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number; // %
  avgWin: number;
  avgLoss: number;
  expectancy: number; // mean realized P&L per closed trade
  profitFactor: number | null;
  totalRealized: number;
  bestTrade: number;
  worstTrade: number;
  equityCurve: { date: string; pnl: number; cumulative: number }[];
}

/** Stats over CLOSED positions (each closed position = one completed trade). */
export function computeJournalStats(closed: Position[]): JournalStats {
  const trades = closed
    .map((p) => ({
      date: lastExitDate(p) ?? p.entryDate,
      pnl: round2(realizedPnlOf(p)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const breakeven = trades.filter((t) => t.pnl === 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalRealized = trades.reduce((s, t) => s + t.pnl, 0);

  let cumulative = 0;
  const equityCurve = trades.map((t) => {
    cumulative = round2(cumulative + t.pnl);
    return { date: t.date, pnl: t.pnl, cumulative };
  });

  return {
    totalClosed: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    avgWin: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    expectancy: trades.length ? round2(totalRealized / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    totalRealized: round2(totalRealized),
    bestTrade: trades.length ? round2(Math.max(...trades.map((t) => t.pnl))) : 0,
    worstTrade: trades.length ? round2(Math.min(...trades.map((t) => t.pnl))) : 0,
    equityCurve,
  };
}

function lastExitDate(p: Position): string | null {
  if (p.exits.length === 0) return null;
  return p.exits.map((e) => e.exitDate).sort().slice(-1)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

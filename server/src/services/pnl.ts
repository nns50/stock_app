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
  /** P&L in units of initial risk (entry→stop). Null when no stop was logged. */
  rMultiple: number | null;
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

/** Dollars at risk if the logged stop is hit: |entry−stop| × qty × multiplier. */
export function initialRiskOf(p: Position): number | null {
  if (p.stopPrice == null || !p.entryPrice) return null;
  const risk = Math.abs(p.entryPrice - p.stopPrice) * p.quantity * p.multiplier;
  return risk > 0 ? risk : null;
}

/** P&L expressed in R (multiples of initial risk). Null when no stop was logged. */
export function rMultipleOf(p: Position, pnl: number): number | null {
  const risk = initialRiskOf(p);
  return risk === null ? null : round2(pnl / risk);
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
    rMultiple: rMultipleOf(p, totalPnl),
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

export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  winRate: number; // %
  totalPnl: number;
  avgPnl: number; // expectancy within the group
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
  /** Realized P&L broken down by tag, grade, and checklist discipline. */
  byTag: GroupStat[];
  byGrade: GroupStat[];
  byDiscipline: GroupStat[];
  /** Edge in R (multiples of initial risk) over closed trades that logged a stop. */
  rTrades: number;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  rBuckets: { label: string; count: number }[];
  /** Suggested risk-% per trade from realized edge (null until both W/L exist). */
  kelly: KellySuggestion | null;
}

const R_BUCKETS: { label: string; test: (r: number) => boolean }[] = [
  { label: '≤ -2R', test: (r) => r <= -2 },
  { label: '-2 to -1R', test: (r) => r > -2 && r <= -1 },
  { label: '-1 to 0', test: (r) => r > -1 && r < 0 },
  { label: '0 to 1R', test: (r) => r >= 0 && r < 1 },
  { label: '1 to 2R', test: (r) => r >= 1 && r < 2 },
  { label: '≥ 2R', test: (r) => r >= 2 },
];

function bucketRMultiples(rs: number[]): { label: string; count: number }[] {
  return R_BUCKETS.map((b) => ({ label: b.label, count: rs.filter((r) => b.test(r)).length }));
}

export interface KellySuggestion {
  /** Full Kelly fraction f* = W − (1−W)/b (can be negative when there's no edge). */
  fraction: number;
  /** Win/loss payoff ratio b = avgWin / |avgLoss|. */
  payoffRatio: number;
  /** Conservative suggestion: quarter-Kelly, clamped to [0, 3]% per trade. */
  suggestedRiskPct: number;
  sampleSize: number;
  /** Whether the sample is large enough (≥ 20 decisive trades) to lean on. */
  reliable: boolean;
}

/**
 * Position-size suggestion from realized edge (Kelly criterion). Needs both
 * winners and losers to estimate the payoff ratio. Kelly is aggressive and
 * assumes the historical edge persists, so we return a quarter-Kelly, capped at
 * 3% — a sane ceiling, not a recommendation.
 */
export function kellySuggestion(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  sampleSize: number,
): KellySuggestion | null {
  const w = winRate / 100;
  const loss = Math.abs(avgLoss);
  if (avgWin <= 0 || loss <= 0) return null;
  const b = avgWin / loss;
  const fraction = w - (1 - w) / b;
  const suggestedRiskPct = round2(Math.max(0, Math.min(3, fraction * 0.25 * 100)));
  return {
    fraction: round2(fraction),
    payoffRatio: round2(b),
    suggestedRiskPct,
    sampleSize,
    reliable: sampleSize >= 20,
  };
}

interface Acc {
  trades: number;
  wins: number;
  total: number;
}

function accumulate(map: Map<string, Acc>, key: string, pnl: number): void {
  const a = map.get(key) ?? { trades: 0, wins: 0, total: 0 };
  a.trades += 1;
  if (pnl > 0) a.wins += 1;
  a.total += pnl;
  map.set(key, a);
}

function toGroupStats(map: Map<string, Acc>): GroupStat[] {
  return [...map.entries()].map(([key, a]) => ({
    key,
    trades: a.trades,
    wins: a.wins,
    winRate: a.trades ? round2((a.wins / a.trades) * 100) : 0,
    totalPnl: round2(a.total),
    avgPnl: a.trades ? round2(a.total / a.trades) : 0,
  }));
}

/** Which discipline bucket a closed trade falls into, from its saved checklist. */
function disciplineBucket(p: Position): string {
  if (!p.checklist || p.checklist.length === 0) return 'No checklist';
  return p.checklist.every((c) => c.checked) ? 'Followed all rules' : 'Skipped a rule';
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

  // Breakdowns: attribute each closed trade's realized P&L to its tags (a trade
  // counts once per distinct tag), its grade, and its discipline bucket.
  const tagMap = new Map<string, Acc>();
  const gradeMap = new Map<string, Acc>();
  const discMap = new Map<string, Acc>();
  for (const p of closed) {
    const pnl = round2(realizedPnlOf(p));
    for (const tag of new Set(p.tags)) accumulate(tagMap, tag, pnl);
    accumulate(gradeMap, p.grade || 'Ungraded', pnl);
    accumulate(discMap, disciplineBucket(p), pnl);
  }
  const byTotalDesc = (a: GroupStat, b: GroupStat) => b.totalPnl - a.totalPnl;

  // Edge in R: closed trades that logged a stop, scored as realized P&L / initial risk.
  const rs = closed.map((p) => rMultipleOf(p, round2(realizedPnlOf(p)))).filter((r): r is number => r !== null);

  const winRate = trades.length ? round2((wins.length / trades.length) * 100) : 0;
  const avgWin = wins.length ? round2(grossProfit / wins.length) : 0;
  const avgLoss = losses.length ? round2(-grossLoss / losses.length) : 0;

  return {
    totalClosed: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy: trades.length ? round2(totalRealized / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    totalRealized: round2(totalRealized),
    bestTrade: trades.length ? round2(Math.max(...trades.map((t) => t.pnl))) : 0,
    worstTrade: trades.length ? round2(Math.min(...trades.map((t) => t.pnl))) : 0,
    equityCurve,
    byTag: toGroupStats(tagMap).sort(byTotalDesc),
    byGrade: toGroupStats(gradeMap).sort((a, b) => a.key.localeCompare(b.key)),
    byDiscipline: toGroupStats(discMap).sort(byTotalDesc),
    rTrades: rs.length,
    avgR: rs.length ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    bestR: rs.length ? Math.max(...rs) : null,
    worstR: rs.length ? Math.min(...rs) : null,
    rBuckets: bucketRMultiples(rs),
    kelly: kellySuggestion(winRate, avgWin, avgLoss, wins.length + losses.length),
  };
}

function lastExitDate(p: Position): string | null {
  if (p.exits.length === 0) return null;
  return p.exits
    .map((e) => e.exitDate)
    .sort()
    .slice(-1)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

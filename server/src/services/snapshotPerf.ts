import { Direction, SnapshotPick } from '../db/snapshots';

// ---------------------------------------------------------------------------
// Did the screener's picks actually go the way the rules expected? Given a
// snapshot's picks (with their price at run time) and current prices, compute
// each pick's direction-adjusted forward return and aggregate edge metrics.
// ---------------------------------------------------------------------------

export interface PickPerformance {
  rank: number;
  symbol: string;
  score: number;
  priceAtRun: number;
  currentPrice: number | null;
  returnPct: number | null; // direction-adjusted (+ = went the expected way)
  win: boolean | null;
}

export interface SnapshotPerformance {
  direction: Direction;
  picks: PickPerformance[];
  evaluated: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  hitRate: number | null; // % of evaluated picks that moved in the expected direction
  bestReturnPct: number | null;
  worstReturnPct: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Forward return, flipped so positive always means "the call was right". */
export function directionalReturn(priceAtRun: number, currentPrice: number, direction: Direction): number {
  if (!priceAtRun) return 0;
  const raw = ((currentPrice - priceAtRun) / priceAtRun) * 100;
  return direction === 'long' ? raw : -raw;
}

export function computeSnapshotPerformance(
  direction: Direction,
  picks: SnapshotPick[],
  currentPrices: Map<string, number | null>,
): SnapshotPerformance {
  const perf: PickPerformance[] = picks.map((p) => {
    const cur = currentPrices.get(p.symbol.toUpperCase()) ?? null;
    const ret = cur === null ? null : round2(directionalReturn(p.priceAtRun, cur, direction));
    return {
      rank: p.rank,
      symbol: p.symbol,
      score: p.score,
      priceAtRun: p.priceAtRun,
      currentPrice: cur,
      returnPct: ret,
      win: ret === null ? null : ret > 0,
    };
  });

  const returns = perf.filter((p) => p.returnPct !== null).map((p) => p.returnPct as number);
  const evaluated = returns.length;
  if (evaluated === 0) {
    return {
      direction,
      picks: perf,
      evaluated: 0,
      avgReturnPct: null,
      medianReturnPct: null,
      hitRate: null,
      bestReturnPct: null,
      worstReturnPct: null,
    };
  }

  const avg = returns.reduce((a, b) => a + b, 0) / evaluated;
  const wins = returns.filter((r) => r > 0).length;
  const sorted = [...returns].sort((a, b) => a - b);
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  return {
    direction,
    picks: perf,
    evaluated,
    avgReturnPct: round2(avg),
    medianReturnPct: round2(median),
    hitRate: round2((wins / evaluated) * 100),
    bestReturnPct: round2(Math.max(...returns)),
    worstReturnPct: round2(Math.min(...returns)),
  };
}

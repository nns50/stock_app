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

// --- cross-snapshot edge report ---------------------------------------------

export interface EdgeBucket {
  label: string;
  picks: number;
  hitRate: number; // %
  avgReturnPct: number;
}

export interface EdgeReport {
  snapshots: number;
  evaluated: number; // picks that had a current price
  hitRate: number | null;
  avgReturnPct: number | null;
  /** Average forward return by rank tier — the edge signal: do top ranks lead? */
  byRank: EdgeBucket[];
  byDirection: EdgeBucket[];
}

const RANK_BUCKETS: { label: string; max: number }[] = [
  { label: 'Rank 1-3', max: 3 },
  { label: 'Rank 4-10', max: 10 },
  { label: 'Rank 11+', max: Infinity },
];

function rankBucketLabel(rank: number): string {
  return (RANK_BUCKETS.find((b) => rank <= b.max) ?? RANK_BUCKETS[RANK_BUCKETS.length - 1]).label;
}

interface EdgeAcc {
  n: number;
  wins: number;
  sum: number;
}

/**
 * Aggregate forward-return edge across many snapshots. For each pick, compute
 * the direction-adjusted move from its snapshot price to the current price, then
 * roll it up overall, by rank tier (does the score rank lead?), and by direction.
 */
export function computeEdgeReport(
  snaps: { direction: Direction; picks: SnapshotPick[] }[],
  priceOf: (symbol: string) => number | null,
): EdgeReport {
  const all: EdgeAcc = { n: 0, wins: 0, sum: 0 };
  const rank = new Map<string, EdgeAcc>();
  const dir = new Map<string, EdgeAcc>();
  const add = (m: Map<string, EdgeAcc>, key: string, ret: number) => {
    const a = m.get(key) ?? { n: 0, wins: 0, sum: 0 };
    a.n += 1;
    if (ret > 0) a.wins += 1;
    a.sum += ret;
    m.set(key, a);
  };

  for (const s of snaps) {
    for (const p of s.picks) {
      const cur = priceOf(p.symbol);
      if (cur === null) continue;
      const ret = round2(directionalReturn(p.priceAtRun, cur, s.direction));
      all.n += 1;
      if (ret > 0) all.wins += 1;
      all.sum += ret;
      add(rank, rankBucketLabel(p.rank), ret);
      add(dir, s.direction, ret);
    }
  }

  const toBucket = (label: string, a: EdgeAcc): EdgeBucket => ({
    label,
    picks: a.n,
    hitRate: round2((a.wins / a.n) * 100),
    avgReturnPct: round2(a.sum / a.n),
  });

  return {
    snapshots: snaps.length,
    evaluated: all.n,
    hitRate: all.n ? round2((all.wins / all.n) * 100) : null,
    avgReturnPct: all.n ? round2(all.sum / all.n) : null,
    byRank: RANK_BUCKETS.map((b) => b.label)
      .filter((l) => rank.has(l))
      .map((l) => toBucket(l, rank.get(l)!)),
    byDirection: ['long', 'short'].filter((l) => dir.has(l)).map((l) => toBucket(l, dir.get(l)!)),
  };
}

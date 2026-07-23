import { getProvider } from '../providers';
import { listUniverse } from '../db/universe';
import { lookbackReturnPct } from '../indicators/screener';
import { mapPool } from '../util/async';

// ---------------------------------------------------------------------------
// "Which sectors are actually leading right now?" — a read-only leaderboard
// that ranks the universe's sectors by the MEDIAN relative strength of their
// members over a lookback window. Relative strength reuses the exact idea the
// screener's `relativeStrength` scoring component uses: a name's own lookback
// return minus a benchmark's (SPY) over the same window. The median (not the
// mean) keeps one runaway member from carrying a whole sector.
//
// v1 is a DISPLAY + navigation aid: it ranks sectors and hands the Screener a
// sector's member symbols to scan — it does NOT itself add any screener-score
// bonus or gate anything. Same "explainable, degrade honestly" posture as the
// rest of the app: a member whose history can't be fetched is dropped from its
// sector's sample (never a fake 0), and if the benchmark itself can't be
// fetched the board falls back to ranking by ABSOLUTE return, clearly labelled.
// ---------------------------------------------------------------------------

/** Cap on members sampled per sector — bounds provider fan-out and keeps one
 *  huge sector from dominating the scan. The sampled/resolved counts are
 *  reported so partial coverage is never mistaken for the whole sector. */
export const MAX_MEMBERS_PER_SECTOR = 30;
const FETCH_CONCURRENCY = 8;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — momentum turns on the daily bar
const DEFAULT_LOOKBACK_DAYS = 20;
const DEFAULT_BENCHMARK = 'SPY';

export type RotationBasis = 'relative-to-benchmark' | 'absolute-return';

export interface SectorRotationEntry {
  sector: string;
  /** Median of member relative strengths (member return − benchmark return),
   *  or of absolute returns when the benchmark couldn't be fetched. */
  medianRelStrengthPct: number;
  /** Members whose return actually resolved (the median's basis). */
  memberCount: number;
  /** Members attempted after the per-sector cap. */
  sampledCount: number;
  /** Resolved member symbols — handed to the Screener for a scoped scan. */
  members: string[];
  /** The single strongest member, for a quick "who's leading" callout. */
  topSymbol: { symbol: string; relStrengthPct: number } | null;
}

export interface SectorRotation {
  benchmarkSymbol: string;
  benchmarkReturnPct: number | null;
  basis: RotationBasis;
  lookbackDays: number;
  /** Sectors ranked strongest → weakest by medianRelStrengthPct. */
  sectors: SectorRotationEntry[];
  /** Sectors that had members but none resolved — listed, never ranked 0. */
  unresolvedSectors: string[];
  asOf: number;
}

export interface SectorMemberReturn {
  symbol: string;
  returnPct: number;
}

export interface RankSectorsInput {
  /** Resolved members grouped by sector (unresolved members already dropped). */
  membersBySector: Map<string, SectorMemberReturn[]>;
  /** Sectors that were sampled but had zero resolved members. */
  unresolvedSectors: string[];
  benchmarkReturnPct: number | null;
  benchmarkSymbol: string;
  lookbackDays: number;
  asOf: number;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Pure ranker: turns already-fetched member returns into the ranked board.
 *  Relative strength = member return − benchmark return; when the benchmark is
 *  null the effective benchmark is 0, so the board ranks by absolute return and
 *  reports `basis: 'absolute-return'`. Split out from the fetching so all the
 *  math is trivially testable. */
export function rankSectors(input: RankSectorsInput): SectorRotation {
  const effectiveBenchmark = input.benchmarkReturnPct ?? 0;
  const basis: RotationBasis = input.benchmarkReturnPct === null ? 'absolute-return' : 'relative-to-benchmark';

  const sectors: SectorRotationEntry[] = [];
  for (const [sector, members] of input.membersBySector) {
    if (members.length === 0) continue;
    const rel = members.map((m) => ({ symbol: m.symbol, relStrengthPct: m.returnPct - effectiveBenchmark }));
    const top = rel.reduce((best, r) => (best === null || r.relStrengthPct > best.relStrengthPct ? r : best), rel[0]);
    sectors.push({
      sector,
      medianRelStrengthPct: median(rel.map((r) => r.relStrengthPct)),
      memberCount: members.length,
      sampledCount: members.length,
      members: members.map((m) => m.symbol),
      topSymbol: top,
    });
  }

  sectors.sort((a, b) => b.medianRelStrengthPct - a.medianRelStrengthPct);

  return {
    benchmarkSymbol: input.benchmarkSymbol,
    benchmarkReturnPct: input.benchmarkReturnPct,
    basis,
    lookbackDays: input.lookbackDays,
    sectors,
    unresolvedSectors: input.unresolvedSectors,
    asOf: input.asOf,
  };
}

let cache: { value: SectorRotation; expiresAt: number } | null = null;

/** Async orchestrator: groups the universe by sector, fetches each sampled
 *  member's lookback return once (best-effort, bounded concurrency) plus the
 *  benchmark's, then ranks. Cached ~1h. */
export async function computeSectorRotation(opts?: {
  lookbackDays?: number;
  benchmarkSymbol?: string;
  force?: boolean;
}): Promise<SectorRotation> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const benchmarkSymbol = (opts?.benchmarkSymbol ?? DEFAULT_BENCHMARK).toUpperCase();
  const now = Date.now();
  if (
    !opts?.force &&
    cache &&
    cache.expiresAt > now &&
    cache.value.lookbackDays === lookbackDays &&
    cache.value.benchmarkSymbol === benchmarkSymbol
  ) {
    return cache.value;
  }

  const provider = getProvider();
  const candleLimit = lookbackDays + 5;

  // Group the universe by sector, capping each sector's sample.
  const bySector = new Map<string, string[]>();
  for (const u of listUniverse()) {
    const sector = u.sector?.trim();
    if (!sector) continue;
    const arr = bySector.get(sector) ?? [];
    if (arr.length < MAX_MEMBERS_PER_SECTOR) {
      arr.push(u.symbol.toUpperCase());
      bySector.set(sector, arr);
    }
  }

  // Benchmark return once (shared across all members).
  let benchmarkReturnPct: number | null = null;
  try {
    const candles = await provider.getCandles(benchmarkSymbol, 'daily', { limit: candleLimit });
    benchmarkReturnPct = lookbackReturnPct(candles, lookbackDays);
  } catch {
    /* leave null — board falls back to absolute-return basis */
  }

  // Fetch every sampled member's lookback return, best-effort, in one pool.
  const membersBySector = new Map<string, SectorMemberReturn[]>();
  const unresolvedSectors: string[] = [];
  for (const [sector, symbols] of bySector) {
    const returns = await mapPool(symbols, FETCH_CONCURRENCY, async (symbol) => {
      try {
        const candles = await provider.getCandles(symbol, 'daily', { limit: candleLimit });
        const r = lookbackReturnPct(candles, lookbackDays);
        return r === null ? null : { symbol, returnPct: r };
      } catch {
        return null;
      }
    });
    const resolved = returns.filter((r): r is SectorMemberReturn => r !== null);
    if (resolved.length === 0) unresolvedSectors.push(sector);
    else membersBySector.set(sector, resolved);
  }

  const result = rankSectors({
    membersBySector,
    unresolvedSectors,
    benchmarkReturnPct,
    benchmarkSymbol,
    lookbackDays,
    asOf: now,
  });

  cache = { value: result, expiresAt: now + CACHE_TTL_MS };
  return result;
}

/** Test hook — drop the in-memory cache. */
export function _resetSectorRotationCache(): void {
  cache = null;
}

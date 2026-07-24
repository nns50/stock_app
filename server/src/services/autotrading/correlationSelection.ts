// Correlation-aware candidate selection (2026-07-24). Default-off re-ranking
// that runs BETWEEN screening and the decision stage.
//
// The problem it solves: candidates arrive score-sorted and get approved
// top-down until a cap binds (maxConcurrentPositions / maxAggregateOpenRiskPct /
// the correlated-exposure veto). When the top two names move as one, the second
// is a redundant bet that can crowd out a genuinely different, only-slightly-
// lower-scored pick further down — the book ends up concentrated in one factor
// instead of diversified across the edge the screener actually found. The
// existing correlated-exposure guardrail is candidate-vs-OPEN-position only; it
// never looks candidate-vs-candidate within a single batch.
//
// This re-rank keeps the highest-scored member of each correlated cluster at its
// rank and DEMOTES the rest to the back of the list — so when a cap binds, the
// survivors are the diverse high-scorers, not a correlated huddle. It only
// reorders; it never drops anyone (the exposure veto stays the real backstop),
// so with every cap generous it changes nothing. Off unless
// AutotradeConfig.correlationAwareSelectionEnabled.
//
// Pure core (reorderByCorrelation) is DB-free and used by BOTH the live loop and
// the backtest engines; the async selectCorrelationAware wrapper fetches the
// return series for the live path (cache-friendly — screen.ts just fetched the
// same daily candles this tick).

import { getProvider } from '../../providers';
import { dailyReturns } from '../../indicators/indicators';
import { computeCorrelationMatrix, MAX_CORRELATION_SYMBOLS } from '../portfolioCorrelation';

export interface CorrelationSelectionConfig {
  enabled: boolean;
  /** |r| at or above this demotes a candidate to an earlier, higher-scored kept
   *  pick. Reuses the same 0–1 threshold the correlated-exposure guardrail uses. */
  threshold: number;
  /** Daily-return lookback window for the pairwise correlation. */
  lookbackDays: number;
}

/** One demoted candidate, for journaling/diagnostics: which higher pick it
 *  correlated with, and at what r. */
export interface DemotedCandidate {
  symbol: string;
  correlatedWith: string;
  r: number;
}

export interface CorrelationRerank<T> {
  /** Same members as the input, re-ordered: kept (diverse) picks first in their
   *  original score order, then demoted (redundant) picks in their original
   *  order. Identical to the input array when disabled or nothing correlates. */
  ordered: T[];
  demoted: DemotedCandidate[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pure re-rank. `candidates` MUST already be in the desired priority order
 * (score-descending), since "keep the higher pick, demote the correlated lower
 * one" is defined relative to that order. `symbolOf` extracts each candidate's
 * ticker (candidates carry it differently across the live loop vs the backtest).
 * A candidate whose returns are absent from `returnsBySymbol` (unfetchable, or
 * too little overlapping history) is never demoted — unknown correlation is
 * treated as "not correlated", never a fake demotion, mirroring the
 * correlated-exposure guardrail's own "never a fake 0" convention.
 */
export function reorderByCorrelation<T>(
  candidates: T[],
  symbolOf: (c: T) => string,
  returnsBySymbol: Map<string, number[]>,
  cfg: CorrelationSelectionConfig,
): CorrelationRerank<T> {
  if (!cfg.enabled || candidates.length < 2) return { ordered: candidates, demoted: [] };

  const symbols = candidates.map((c) => symbolOf(c).toUpperCase());
  const { matrix } = computeCorrelationMatrix(symbols, returnsBySymbol, cfg.lookbackDays);

  const keptIdx: number[] = [];
  const demotedIdx: number[] = [];
  const demoted: DemotedCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    let correlatedWith: { symbol: string; r: number } | null = null;
    for (const k of keptIdx) {
      const r = matrix[i][k];
      if (r !== null && Math.abs(r) >= cfg.threshold) {
        correlatedWith = { symbol: symbols[k], r };
        break;
      }
    }
    if (correlatedWith) {
      demotedIdx.push(i);
      demoted.push({ symbol: symbols[i], correlatedWith: correlatedWith.symbol, r: round2(correlatedWith.r) });
    } else {
      keptIdx.push(i);
    }
  }

  const ordered = [...keptIdx, ...demotedIdx].map((i) => candidates[i]);
  return { ordered, demoted };
}

/** Best-effort daily-return fetch for the live path — parallel, per-symbol,
 *  capped at MAX_CORRELATION_SYMBOLS. A symbol whose candles can't be fetched is
 *  simply absent (reported unresolved by the matrix, never a fake 0). Mirrors
 *  computePortfolioCorrelation's own fetch loop. */
async function fetchReturns(symbols: string[], lookbackDays: number): Promise<Map<string, number[]>> {
  const provider = getProvider();
  const returnsBySymbol = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const candles = await provider.getCandles(s, 'daily', { limit: lookbackDays + 1 });
        const returns = dailyReturns(candles.map((c) => c.close));
        if (returns.length >= 2) returnsBySymbol.set(s, returns);
      } catch {
        /* leave unset — treated as unresolved, never demoted on a fake 0 */
      }
    }),
  );
  return returnsBySymbol;
}

/** Async wrapper for the live loop: fetches the candidates' return series, then
 *  re-ranks. No-op (returns the input order) when disabled or fewer than two
 *  candidates, so the default-off path does zero fetching. */
export async function selectCorrelationAware<T>(
  candidates: T[],
  symbolOf: (c: T) => string,
  cfg: CorrelationSelectionConfig,
): Promise<CorrelationRerank<T>> {
  if (!cfg.enabled || candidates.length < 2) return { ordered: candidates, demoted: [] };
  const symbols = Array.from(new Set(candidates.map((c) => symbolOf(c).toUpperCase()))).slice(
    0,
    MAX_CORRELATION_SYMBOLS,
  );
  const returnsBySymbol = await fetchReturns(symbols, cfg.lookbackDays);
  return reorderByCorrelation(candidates, symbolOf, returnsBySymbol, cfg);
}

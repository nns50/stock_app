import { Position } from '../db/positions';
import { getProvider } from '../providers';
import { dailyReturns, pearsonCorrelation } from '../indicators/indicators';

// ---------------------------------------------------------------------------
// "How correlated is my open book, really?" — a pairwise Pearson-correlation
// matrix of daily returns across the underlyings of the human's OPEN positions.
// The single "correlated exposure %" guardrail (services/autotrading/
// riskCheck.ts) answers "is capital piling into names that move together" as
// one number; this shows the whole picture, so five "different" tickers that
// all trade as one are obvious at a glance.
//
// Reuses the exact dailyReturns + pearsonCorrelation the guardrail uses, and
// the same "unknown, never a fake 0" convention: a symbol whose history can't
// be fetched is reported as unresolved and its cells are null, not silently
// treated as uncorrelated.
// ---------------------------------------------------------------------------

/** Cap on distinct underlyings correlated in one request — bounds the fan-out
 *  of per-symbol candle fetches. A real open book is far smaller; this only
 *  guards a pathological one. */
export const MAX_CORRELATION_SYMBOLS = 40;

export interface CorrelationPair {
  a: string;
  b: string;
  r: number;
}

export interface PortfolioCorrelation {
  /** Symbols (uppercased underlyings), in the row/column order of `matrix`. */
  symbols: string[];
  /** symbols.length × symbols.length. matrix[i][j] is corr(symbols[i],
   *  symbols[j]); the diagonal is 1; a cell is null when either symbol is
   *  unresolved or the pair has too little overlapping history. */
  matrix: (number | null)[][];
  /** The most-correlated distinct pair (highest |r|), or null when fewer than
   *  two symbols resolved. */
  topPair: CorrelationPair | null;
  /** Symbols whose daily history couldn't be fetched — excluded from every
   *  correlation, never assumed uncorrelated. */
  unresolved: string[];
  lookbackDays: number;
}

/** Pure matrix builder from already-fetched return series. A symbol absent from
 *  `returnsBySymbol` (fetch failed) yields null cells and is reported
 *  unresolved. */
export function computeCorrelationMatrix(
  symbols: string[],
  returnsBySymbol: Map<string, number[]>,
  lookbackDays: number,
): PortfolioCorrelation {
  const matrix: (number | null)[][] = symbols.map((rowSym, i) =>
    symbols.map((colSym, j) => {
      if (i === j) return returnsBySymbol.has(rowSym) ? 1 : null;
      const a = returnsBySymbol.get(rowSym);
      const b = returnsBySymbol.get(colSym);
      return a && b ? pearsonCorrelation(a, b) : null;
    }),
  );

  let topPair: CorrelationPair | null = null;
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const r = matrix[i][j];
      if (r === null) continue;
      if (topPair === null || Math.abs(r) > Math.abs(topPair.r)) {
        topPair = { a: symbols[i], b: symbols[j], r };
      }
    }
  }

  const unresolved = symbols.filter((s) => !returnsBySymbol.has(s));
  return { symbols, matrix, topPair, unresolved, lookbackDays };
}

/** Async orchestrator: dedupes the open positions' underlyings, fetches each
 *  one's daily closes once (best-effort, in parallel), and builds the matrix.
 *  Options use their own `symbol` field — already the underlying ticker — so a
 *  stock and an option on the same name collapse to one row. */
export async function computePortfolioCorrelation(
  positions: Position[],
  lookbackDays: number,
): Promise<PortfolioCorrelation> {
  const symbols = Array.from(new Set(positions.map((p) => p.symbol.toUpperCase()))).slice(0, MAX_CORRELATION_SYMBOLS);
  if (symbols.length === 0) {
    return { symbols: [], matrix: [], topPair: null, unresolved: [], lookbackDays };
  }

  const provider = getProvider();
  const returnsBySymbol = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const candles = await provider.getCandles(s, 'daily', { limit: lookbackDays + 1 });
        const returns = dailyReturns(candles.map((c) => c.close));
        if (returns.length >= 2) returnsBySymbol.set(s, returns);
      } catch {
        /* leave unset — reported as unresolved, never a fake 0 correlation */
      }
    }),
  );

  return computeCorrelationMatrix(symbols, returnsBySymbol, lookbackDays);
}

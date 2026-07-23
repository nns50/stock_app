import { Position } from '../db/positions';
import { getProvider } from '../providers';
import { resolveOptionMarks, resolveStockPrices } from './quotes';

// ---------------------------------------------------------------------------
// "How much would a broad market move actually cost or make me, right now?" —
// beta-weights every OPEN position (stock + option) in the human's own book
// against a set of hypothetical market moves, using each symbol's own beta as
// reported by the configured provider. This is the standard "beta-weighted
// delta" idea professional risk tools use (symbolReturn ≈ beta × marketReturn),
// applied in dollar terms directly rather than "SPY-equivalent shares" — that
// avoids a second fetch for the index's own price, since beta already relates
// a symbol's OWN % move to the market's % move.
//
// Beta reflects each symbol's own historical relationship to the broad market
// as reported by the configured data provider — not fetched or recomputed
// here, and not tied to the Journal's own configurable benchmark symbol
// (a different, unrelated setting: that one compares YOUR realized returns to
// an index; this one is per-symbol market sensitivity).
// ---------------------------------------------------------------------------

// The extra `=== 0 ? 0 :` guards against returning -0 (e.g. 0 * a negative
// scenario pct) — mathematically equal to 0 but distinguishable by strict
// deep-equality, which would make an all-excluded/empty-book result an
// annoying moving target in tests and any strict client-side comparison.
const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

/** A small, fixed set of hypothetical broad-market moves, in percentage points
 *  (e.g. -10 means "the market falls 10%"). Deliberately not user-configurable
 *  in v1 — a stress test's value is in the standard, comparable checkpoints. */
export const DEFAULT_STRESS_SCENARIOS_PCT = [-10, -5, -2, 0, 2, 5, 10];

export interface StressPositionInput {
  symbol: string;
  /** $ change in this position's value for a 1-percentage-point move in the
   *  broad market (already beta-weighted). Positive = gains when the market
   *  rises. */
  dollarDeltaPerPct: number;
}

export interface StressScenario {
  /** Hypothetical market move, in percentage points (e.g. -10 = "-10%"). */
  pct: number;
  estimatedPnl: number;
}

export interface StressUnresolvedPosition {
  positionId: number;
  symbol: string;
  reason: 'no-beta' | 'no-price' | 'no-delta';
}

export interface StressResult {
  scenarios: StressScenario[];
  /** Sum of every resolved position's dollarDeltaPerPct — the portfolio's net
   *  beta-weighted sensitivity to a 1-point market move. */
  netDollarDeltaPerPct: number;
  /** Positions excluded from the sum because beta, an underlying price, or an
   *  option's delta couldn't be resolved — excluded, never assumed zero, so
   *  the report stays honest about its own coverage. */
  unresolved: StressUnresolvedPosition[];
  resolvedCount: number;
  totalCount: number;
}

/** Pure aggregator: sum each resolved position's per-1%-move dollar delta,
 *  then scale by each scenario's percentage move. */
export function computeStressScenarios(
  inputs: StressPositionInput[],
  scenarioPcts: number[] = DEFAULT_STRESS_SCENARIOS_PCT,
): StressScenario[] {
  const net = inputs.reduce((s, i) => s + i.dollarDeltaPerPct, 0);
  return scenarioPcts.map((pct) => ({ pct, estimatedPnl: round2(net * pct) }));
}

/** Batch beta lookup, one `getFundamentals` call per distinct symbol (no batch
 *  endpoint exists on MarketDataProvider). Best-effort: a provider with no
 *  fundamentals capability, or a symbol whose fundamentals fetch fails or
 *  omits beta, is simply absent from the returned map — never defaulted to a
 *  guessed beta like 1.0, which would silently misstate the position's real
 *  sensitivity. */
async function resolveBetaBySymbol(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const provider = getProvider();
  if (!provider.capabilities.fundamentals || symbols.length === 0) return out;
  const results = await Promise.allSettled(symbols.map((s) => provider.getFundamentals(s)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.beta != null) {
      out.set(symbols[i], r.value.beta);
    }
  });
  return out;
}

/** Async orchestrator: beta-weights every OPEN position (both asset types) in
 *  the given book. Stocks: current market value × beta. Options: the
 *  underlying's beta-weighted dollar move × the option's own current delta ×
 *  quantity × multiplier — options need the underlying's price, not the
 *  option's own premium, since beta describes the underlying's market
 *  sensitivity. A position's `symbol` field is always the underlying ticker
 *  for both asset types, so one batched stock-quote fetch resolves the
 *  underlying price for stocks and option positions alike. */
export async function computePortfolioStress(
  positions: Position[],
  scenarioPcts: number[] = DEFAULT_STRESS_SCENARIOS_PCT,
): Promise<StressResult> {
  const open = positions.filter((p) => p.status === 'open' && p.remainingQuantity > 1e-9);
  if (open.length === 0) {
    return {
      scenarios: computeStressScenarios([], scenarioPcts),
      netDollarDeltaPerPct: 0,
      unresolved: [],
      resolvedCount: 0,
      totalCount: 0,
    };
  }
  const symbols = Array.from(new Set(open.map((p) => p.symbol.toUpperCase())));
  const optionPositions = open.filter((p) => p.assetType === 'option');

  const [underlyingPrices, betaBySymbol, optionMarks] = await Promise.all([
    resolveStockPrices(symbols),
    resolveBetaBySymbol(symbols),
    resolveOptionMarks(optionPositions),
  ]);

  const inputs: StressPositionInput[] = [];
  const unresolved: StressUnresolvedPosition[] = [];

  for (const p of open) {
    const upper = p.symbol.toUpperCase();
    const beta = betaBySymbol.get(upper);
    if (beta == null) {
      unresolved.push({ positionId: p.id, symbol: p.symbol, reason: 'no-beta' });
      continue;
    }
    const underlyingPrice = underlyingPrices.get(upper)?.price;
    if (underlyingPrice == null) {
      unresolved.push({ positionId: p.id, symbol: p.symbol, reason: 'no-price' });
      continue;
    }
    const sign = p.side === 'long' ? 1 : -1;

    if (p.assetType === 'stock') {
      const marketValue = underlyingPrice * p.remainingQuantity * sign;
      inputs.push({ symbol: p.symbol, dollarDeltaPerPct: round2(marketValue * beta * 0.01) });
    } else {
      const delta = optionMarks.get(p.id)?.delta;
      if (delta == null) {
        unresolved.push({ positionId: p.id, symbol: p.symbol, reason: 'no-delta' });
        continue;
      }
      const underlyingDollarMovePerPct = underlyingPrice * beta * 0.01;
      const dollarDeltaPerPct = delta * underlyingDollarMovePerPct * p.remainingQuantity * p.multiplier * sign;
      inputs.push({ symbol: p.symbol, dollarDeltaPerPct: round2(dollarDeltaPerPct) });
    }
  }

  return {
    scenarios: computeStressScenarios(inputs, scenarioPcts),
    netDollarDeltaPerPct: round2(inputs.reduce((s, i) => s + i.dollarDeltaPerPct, 0)),
    unresolved,
    resolvedCount: inputs.length,
    totalCount: open.length,
  };
}

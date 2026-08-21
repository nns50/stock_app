import { Position, listPositions } from '../../db/positions';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { initialRiskOf, realizedPnlOf, lastExitDate } from '../pnl';

// ---------------------------------------------------------------------------
// Method-weighted sizing (2026-08-21). The operator's directive, verbatim in
// spirit: keep EVERY method on — long stock, short-side exposure, calls, puts
// — track which of them is actually earning toward the daily-gain goal, and
// lean size toward the ones that work. So this is the same idea as
// expectancy-weighted sizing (expectancySizing.ts), sliced along a different
// axis: that one asks "which CONVICTION GRADE earns?", this one asks "which
// INSTRUMENT/DIRECTION earns?" — and it deliberately reuses that engine's
// exact formula (multiplier = clamp(1 + avgR, min, max), sample-size gated)
// so there is one explainable piece of math, not two.
//
// LEANING, never switching: an underperforming method sizes down toward the
// min clamp, it is never turned off — every method keeps trading (and so
// keeps generating the evidence that could rehabilitate it), and an unproven
// method (below the sample floor) stays at exactly 1×. And leaning is not
// pressing: multipliers come from REALIZED performance, never from distance
// to the daily target.
//
// RECENT window: unlike grade expectancy (all closed trades), each method is
// judged on its most recent RECENT_TRADES_PER_METHOD closed trades — "what's
// working" in the operator's sense is a present-tense question, and the
// account's older history spans config regimes (a 10%/day aggressive era)
// that shouldn't outvote the current one forever.
//
// Methods are the four the journal can classify unambiguously: stock_long,
// stock_short, option_call, option_put. A debit spread's journal record rides
// with its long leg's side (option_call/option_put) — its per-leg structure
// isn't recoverable from the journal row, and for lean purposes "bullish
// premium" vs "bearish premium" is the axis that matters.
// ---------------------------------------------------------------------------

export type TradeMethod = 'stock_long' | 'stock_short' | 'option_call' | 'option_put';

/** Judge each method on its most recent N closed trades — see header. */
export const RECENT_TRADES_PER_METHOD = 20;

/** Classify a journal position, or null when it fits no method bucket. */
export function methodOf(p: Pick<Position, 'assetType' | 'side' | 'optionType'>): TradeMethod | null {
  if (p.assetType === 'stock') return p.side === 'short' ? 'stock_short' : 'stock_long';
  if (p.assetType === 'option') {
    if (p.optionType === 'call') return 'option_call';
    if (p.optionType === 'put') return 'option_put';
  }
  return null;
}

/** The method a candidate ENTRY belongs to, from what's known at signal time. */
export function methodOfEquitySignal(side: 'buy' | 'sell'): TradeMethod {
  return side === 'sell' ? 'stock_short' : 'stock_long';
}
export function methodOfOptionsSignal(side: 'call' | 'put'): TradeMethod {
  return side === 'call' ? 'option_call' : 'option_put';
}

export interface MethodStats {
  method: TradeMethod;
  /** Closed trades in the recent window (≤ RECENT_TRADES_PER_METHOD). */
  n: number;
  wins: number;
  avgR: number;
  /** The sizing multiplier currently in force for this method — 1 when
   *  weighting is off or the sample is below the floor. */
  multiplier: number;
}

/** {method, realizedR} rows for the recent window, newest first per method.
 *  Undated or risk-less trades are dropped, mirroring every other realized-R
 *  consumer (a trade with no initial risk has no R to learn from). */
function recentMethodTrades(closed: Position[]): { method: TradeMethod; realizedR: number }[] {
  const byMethod = new Map<TradeMethod, { date: string; realizedR: number }[]>();
  for (const p of closed) {
    const method = methodOf(p);
    if (!method) continue;
    const risk = initialRiskOf(p);
    const date = lastExitDate(p);
    if (!risk || risk <= 0 || !date) continue;
    const row = { date, realizedR: realizedPnlOf(p) / risk };
    const arr = byMethod.get(method);
    if (arr) arr.push(row);
    else byMethod.set(method, [row]);
  }
  const out: { method: TradeMethod; realizedR: number }[] = [];
  for (const [method, rows] of byMethod) {
    rows.sort((a, b) => b.date.localeCompare(a.date));
    for (const r of rows.slice(0, RECENT_TRADES_PER_METHOD)) out.push({ method, realizedR: r.realizedR });
  }
  return out;
}

/**
 * method → sizing multiplier, via the SAME engine grade expectancy uses (the
 * method plays the "grade" role; the sample floor and clamps are the shared
 * expectancy* config fields, documented as governing both leans). Empty when
 * methodWeightingEnabled is off; a missing method reads as 1× (neutral).
 */
export function computeMethodMultipliers(
  closed: Position[],
  cfg: Pick<
    AutotradeConfig,
    'methodWeightingEnabled' | 'expectancyMinTrades' | 'expectancyMinMultiplier' | 'expectancyMaxMultiplier'
  >,
): Record<string, number> {
  return computeGradeExpectancyMultipliers(
    recentMethodTrades(closed).map((t) => ({ grade: t.method, realizedR: t.realizedR })),
    {
      enabled: cfg.methodWeightingEnabled,
      minTrades: cfg.expectancyMinTrades,
      minMultiplier: cfg.expectancyMinMultiplier,
      maxMultiplier: cfg.expectancyMaxMultiplier,
    },
  );
}

/** Convenience for call sites without a closed-positions list in hand (the
 *  options books): fetch + filter the same population the equity snapshots
 *  use — closed, autotrade-tagged journal positions. */
export function journalMethodMultipliers(
  cfg: Pick<
    AutotradeConfig,
    'methodWeightingEnabled' | 'expectancyMinTrades' | 'expectancyMinMultiplier' | 'expectancyMaxMultiplier'
  >,
): Record<string, number> {
  if (!cfg.methodWeightingEnabled) return {};
  const closed = listPositions({ status: 'closed' }).filter((p) => p.tags.includes('autotrade'));
  return computeMethodMultipliers(closed, cfg);
}

/** Per-method performance for the dashboard — every bucket that has ANY
 *  recent trades, with the multiplier currently in force. */
export function computeMethodPerformance(closed: Position[], cfg: AutotradeConfig): MethodStats[] {
  const trades = recentMethodTrades(closed);
  const multipliers = computeMethodMultipliers(closed, cfg);
  const byMethod = new Map<TradeMethod, number[]>();
  for (const t of trades) {
    const arr = byMethod.get(t.method);
    if (arr) arr.push(t.realizedR);
    else byMethod.set(t.method, [t.realizedR]);
  }
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return [...byMethod.entries()]
    .map(([method, rs]) => ({
      method,
      n: rs.length,
      wins: rs.filter((r) => r > 0).length,
      avgR: round2(rs.reduce((a, b) => a + b, 0) / rs.length),
      multiplier: multipliers[method] ?? 1,
    }))
    .sort((a, b) => b.avgR - a.avgR);
}

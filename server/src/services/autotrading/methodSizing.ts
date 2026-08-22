import { Position, listPositions } from '../../db/positions';
import { LiveOptionsPosition, listLiveOptionsPositions, liveOptionsPnl } from '../../db/autotradeLiveOptionsPositions';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { initialRiskOf, realizedPnlOf, lastExitDate } from '../pnl';
import { etToday } from '../../util/marketDate';

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
// stock_short, option_call, option_put. A debit spread rides with its long
// leg's side (option_call/option_put) — for lean purposes "bullish premium"
// vs "bearish premium" is the axis that matters.
//
// TWO sources, because the loop's books split (found live 2026-08-22: the
// SRAD live options trade journaled as an untagged sync import, so a
// journal-only ledger would have left the calls/puts buckets empty forever):
//   - journal positions tagged 'autotrade' — the loop's STOCK trades, R from
//     entry-vs-stop distance (initialRiskOf);
//   - the LIVE OPTIONS book's own closed rows — the loop's calls/puts, R from
//     riskAmount (the premium paid IS the defined-risk 1R of a long option).
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
function recentMethodTrades(
  closed: Position[],
  liveOptionsClosed: LiveOptionsPosition[] = [],
): { method: TradeMethod; realizedR: number }[] {
  const byMethod = new Map<TradeMethod, { date: string; realizedR: number }[]>();
  const push = (method: TradeMethod, row: { date: string; realizedR: number }) => {
    const arr = byMethod.get(method);
    if (arr) arr.push(row);
    else byMethod.set(method, [row]);
  };
  for (const p of closed) {
    const method = methodOf(p);
    if (!method) continue;
    const risk = initialRiskOf(p);
    const date = lastExitDate(p);
    if (!risk || risk <= 0 || !date) continue;
    push(method, { date, realizedR: realizedPnlOf(p) / risk });
  }
  for (const p of liveOptionsClosed) {
    // riskAmount is the premium paid — the defined-risk 1R of a long option
    // (or net debit of a spread). A row with no usable exit or risk is
    // dropped, same discipline as above.
    if (p.status !== 'closed' || p.exitPrice === null || p.exitAt === null || !(p.riskAmount > 0)) continue;
    push(p.side === 'call' ? 'option_call' : 'option_put', {
      date: etToday(p.exitAt),
      realizedR: liveOptionsPnl(p, p.exitPrice) / p.riskAmount,
    });
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
  liveOptionsClosed: LiveOptionsPosition[] = [],
): Record<string, number> {
  return computeGradeExpectancyMultipliers(
    recentMethodTrades(closed, liveOptionsClosed).map((t) => ({ grade: t.method, realizedR: t.realizedR })),
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
  return computeMethodMultipliers(closed, cfg, listLiveOptionsPositions({ status: 'closed' }));
}

/** Per-method performance for the dashboard — every bucket that has ANY
 *  recent trades, with the multiplier currently in force. */
export function computeMethodPerformance(
  closed: Position[],
  cfg: AutotradeConfig,
  liveOptionsClosed: LiveOptionsPosition[] = [],
): MethodStats[] {
  const trades = recentMethodTrades(closed, liveOptionsClosed);
  const multipliers = computeMethodMultipliers(closed, cfg, liveOptionsClosed);
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

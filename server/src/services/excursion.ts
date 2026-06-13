// MAE / MFE excursion analysis. For a closed trade, over the candles spanning its
// holding period, how far did price run in your favor (Maximum Favorable
// Excursion) and against you (Maximum Adverse Excursion)? Expressed in R when a
// stop was logged. Reveals stops that are too tight and winners exited too early.

import { Candle } from '../providers/types';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ExcursionInput {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  multiplier: number;
  stopPrice: number | null;
  realizedPnl: number;
  entryDate: string;
}

export interface TradeExcursion {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  entryDate: string;
  mfePct: number; // best favorable excursion, % of cost basis (>= 0)
  maePct: number; // worst adverse excursion, % of cost basis (<= 0)
  mfeR: number | null;
  maeR: number | null;
  realizedR: number | null;
  /** Of the favorable move available (MFE), what fraction you kept. Winners only. */
  capturedPct: number | null;
}

export function computeExcursion(p: ExcursionInput, candles: Candle[]): TradeExcursion | null {
  if (!candles.length || !p.entryPrice) return null;
  const sign = p.side === 'long' ? 1 : -1;
  const costBasis = p.entryPrice * p.quantity * p.multiplier;
  const initialRisk =
    p.stopPrice != null ? Math.abs(p.entryPrice - p.stopPrice) * p.quantity * p.multiplier || null : null;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const c of candles) {
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
  }
  const favPrice = sign === 1 ? maxHigh : minLow; // most favorable price reached
  const advPrice = sign === 1 ? minLow : maxHigh; // most adverse price reached
  const favDollar = Math.max(0, (favPrice - p.entryPrice) * sign * p.quantity * p.multiplier);
  const advDollar = Math.min(0, (advPrice - p.entryPrice) * sign * p.quantity * p.multiplier);

  const mfeR = initialRisk ? round2(favDollar / initialRisk) : null;
  const maeR = initialRisk ? round2(advDollar / initialRisk) : null;
  const realizedR = initialRisk ? round2(p.realizedPnl / initialRisk) : null;
  return {
    positionId: p.positionId,
    symbol: p.symbol,
    side: p.side,
    entryDate: p.entryDate,
    mfePct: costBasis ? round2((favDollar / costBasis) * 100) : 0,
    maePct: costBasis ? round2((advDollar / costBasis) * 100) : 0,
    mfeR,
    maeR,
    realizedR,
    capturedPct: mfeR && mfeR > 0 && realizedR != null ? round2((realizedR / mfeR) * 100) : null,
  };
}

export interface ExcursionReport {
  trades: number;
  avgMfeR: number | null;
  avgMaeR: number | null;
  avgRealizedR: number | null;
  /** Average % of the favorable move captured on winning trades. */
  capturePct: number | null;
  rows: TradeExcursion[];
}

function mean(xs: number[]): number | null {
  return xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

export function aggregateExcursions(rows: TradeExcursion[]): ExcursionReport {
  const withR = rows.filter((r) => r.mfeR !== null);
  const captures = rows.filter((r) => r.capturedPct !== null).map((r) => r.capturedPct as number);
  return {
    trades: rows.length,
    avgMfeR: mean(withR.map((r) => r.mfeR as number)),
    avgMaeR: mean(withR.map((r) => r.maeR as number)),
    avgRealizedR: mean(withR.map((r) => r.realizedR as number)),
    capturePct: mean(captures),
    rows,
  };
}

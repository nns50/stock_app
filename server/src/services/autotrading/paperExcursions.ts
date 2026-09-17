import { PaperPosition, paperRealizedPnl } from '../../db/autotradePaperPositions';
import { etToday, etTimeOfDay } from '../../util/marketDate';
import type { ExcursionInput } from '../excursion';

// ---------------------------------------------------------------------------
// The paper book, measured the way the live book already is (2026-09-17).
//
// services/excursion.ts has computed MAE/MFE from candles for closed LIVE
// stock trades since 2026-07; the tuner in excursionTune.ts sizes a stop from
// the winners' heat it reports. None of it ever saw the paper book — the
// unconstrained control arm, which is both the larger sample (141 closed
// trades to live's ~85 when this landed) and the one where a rule's absence
// can be watched. The 2026-09-16 read that prompted this — winners reach
// +0.25R in a median 12 minutes, losers take a median 275 minutes to travel
// the full 2.5% to the stop — was done on the paper rows' best-price column
// alone, because the worst price was recorded nowhere. It IS recorded: in the
// bars. This maps a paper row onto the same input the live route builds, so
// the same candle walk measures both, and no second, tick-sampled excursion
// column has to exist.
// ---------------------------------------------------------------------------

/**
 * A closed paper row as an excursion input, or null for a row still open (no
 * holding window to measure).
 *
 * THE QUANTITY IS THE ORIGINAL, NOT THE ROW'S. A scale-out reduces `quantity`
 * in place and banks the slice into `realizedPartialPnl`, so the row's own
 * quantity is the final remainder while its P&L is the whole trade. The
 * excursion's R denominator is |entry − stop| × quantity; taken from the
 * remainder it would inflate every R on a scaled-out trade. `riskAmount` is
 * the dollar risk at entry — |entry − initial stop| × the original quantity —
 * so the original quantity is riskAmount over the initial stop distance, and
 * realizedR then equals paperRealizedR by construction rather than by luck.
 */
export function paperExcursionInput(p: PaperPosition): ExcursionInput | null {
  if (p.status !== 'closed' || p.exitAt === null) return null;
  const stop = p.initialStopPrice ?? p.stopPrice;
  const distance = Math.abs(p.entryPrice - stop);
  const originalQuantity = distance > 0 && p.riskAmount > 0 ? p.riskAmount / distance : p.quantity;
  return {
    positionId: p.id,
    symbol: p.symbol,
    side: p.side === 'buy' ? 'long' : 'short',
    entryPrice: p.entryPrice,
    quantity: originalQuantity,
    multiplier: 1,
    // The FROZEN stop — the ratchet mutates stopPrice, and a moved stop would
    // shrink the denominator and inflate every R. Same rule as the live route.
    stopPrice: stop,
    realizedPnl: paperRealizedPnl(p),
    entryDate: etToday(p.entryAt),
    exitDate: etToday(p.exitAt),
    entryTime: etTimeOfDay(p.entryAt),
    exitAt: p.exitAt,
  };
}

import { WebullOrderLeg, isExitLeg } from '../providers/webull/orders';
import { QTY_EPS } from './trading/fillDelta';

// ---------------------------------------------------------------------------
// Replace an ESTIMATED exit price with the fill the broker actually reported.
//
// Until the bracket response shape was confirmed (capture:broker Q3), a stop or
// target firing was never visible through the order path: every `comboType`
// filter looked for a tag that sits on the ENVELOPE, and only the matched
// envelope's own legs were read, so a bracket looked like a single-leg order.
// What actually closed those positions was the broker-truth position sync,
// which notices a holding has gone and books an exit priced from the latest
// QUOTE — flagged in its own note as an estimate, not a fill.
//
// That estimate is not cosmetic. Expectancy-weighted sizing reads each closed
// autotrade trade's realized R (realizedPnl / initialRisk) and turns a grade's
// average into the multiplier that sizes the NEXT trade in that grade. An exit
// price error lands directly in that numerator, so a grade whose exits were
// booked worse than they filled gets sized down on evidence that never
// happened. Auto-tune's walk-forward guard and the excursion tuner read the
// same closed-trade P&L.
//
// The real fill is recoverable now: position → source_intent_id → the entry's
// client_order_id → webullOrderStatus, which since the parser fix returns EVERY
// leg of the combo, including the exit leg that filled and its filled_price.
//
// This module is the pure half — given a recorded exit and the broker's legs,
// decide whether to correct it and to what. Every ambiguity resolves toward
// LEAVING THE RECORD ALONE, for the same reason fillDelta.ts resolves toward
// booking less: an approximate number that is known to be approximate is
// recoverable, while a confidently wrong "correction" writes fiction into
// realized P&L, the tax export, and every tuner downstream.
// ---------------------------------------------------------------------------

/** Prices are compared at cent resolution — anything finer is noise from the
 *  broker's own rounding, not a correction worth making. */
export const PRICE_EPS = 0.005;

export interface RecordedExit {
  exitId: number;
  positionId: number;
  symbol: string;
  /** Quantity this exit row booked. */
  quantity: number;
  /** The estimated price currently recorded. */
  exitPrice: number;
  exitDate: string;
}

export type ExitCorrection =
  | {
      action: 'correct';
      /** The broker's actual fill price for the exit leg. */
      realPrice: number;
      /** realPrice − recorded, per share/contract. Signed. */
      priceDelta: number;
      /** Total P&L difference this correction makes to the position. */
      pnlDelta: number;
    }
  | { action: 'skip'; reason: string };

/**
 * Decide whether a recorded exit should be corrected from the broker's legs.
 *
 * `legs` is the full combo for the position's ENTRY order — so the exit legs
 * are the ones that are not the order we asked about (isExitLeg, which
 * identifies them by our own client_order_id rather than by a broker label).
 */
export function decideExitCorrection(exit: RecordedExit, legs: WebullOrderLeg[]): ExitCorrection {
  const filled = legs.filter((l) => isExitLeg(l) && l.status === 'FILLED');

  if (filled.length === 0) {
    return {
      action: 'skip',
      reason: 'no filled exit leg at the broker — the combo may have aged out of order history',
    };
  }
  if (filled.length > 1) {
    // Same posture the live reconcilers take on this exact shape: two filled
    // exit legs shouldn't happen under OCO semantics and isn't ruled out, and
    // picking one would be a guess about which produced this exit.
    return { action: 'skip', reason: `${filled.length} filled exit legs — ambiguous, cannot say which produced this` };
  }

  const leg = filled[0];
  const realPrice = leg.filledPrice;
  if (realPrice === undefined || !Number.isFinite(realPrice) || realPrice <= 0) {
    return { action: 'skip', reason: 'the exit leg reported no usable fill price' };
  }

  // A quantity disagreement means this exit row and that leg are not describing
  // the same event — a partial exit, a leg that filled in instalments, or a
  // position closed across more than one order. Correcting the PRICE of a row
  // whose quantity we cannot match would apply the right number to the wrong
  // amount, which is worse than the estimate it replaces.
  if (leg.filledQty !== undefined && Math.abs(leg.filledQty - exit.quantity) > QTY_EPS) {
    return {
      action: 'skip',
      reason: `broker leg filled ${leg.filledQty} but this exit booked ${exit.quantity} — not the same event`,
    };
  }

  const priceDelta = realPrice - exit.exitPrice;
  if (Math.abs(priceDelta) < PRICE_EPS) {
    return { action: 'skip', reason: 'already matches the broker fill' };
  }

  return {
    action: 'correct',
    realPrice,
    priceDelta,
    pnlDelta: priceDelta * exit.quantity,
  };
}

/** The note left on a corrected exit, so the row says where its price came from
 *  and is never mistaken for the estimate it replaced. */
export function correctionNote(previousPrice: number): string {
  return (
    `Exit price corrected to the broker's actual fill by the exit-price backfill ` +
    `(was ${previousPrice}, an estimate recorded by the Webull position sync).`
  );
}

export interface BackfillSummary {
  examined: number;
  corrected: number;
  skipped: number;
  /** Net P&L change across every correction. Signed. */
  netPnlDelta: number;
}

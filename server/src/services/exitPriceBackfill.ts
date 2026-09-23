import { WebullOrderLeg, isExitLeg } from '../providers/webull/orders';
import type { PositionExitReason } from '../db/positions';
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
  /** The reason currently recorded — often 'manual' for a leg the sync priced
   *  between the levels (COIN's breakeven stop, 2026-09-21). */
  exitReason: PositionExitReason | null;
  /** The position's side. A higher exit price is a gain on a long and a loss
   *  on a short, so the P&L a correction moves carries this sign. */
  positionSide: 'long' | 'short';
}

/** Why an exit was left alone, as a stable code a journal row can carry and a
 *  report can split on, beside the sentence a person reads. `unreadable` and
 *  `aged_out` are the broker read's own outcomes, set by the callers. */
export type ExitCorrectionSkipCode =
  | 'unreadable'
  | 'aged_out'
  | 'no_filled_leg'
  | 'ambiguous_legs'
  | 'no_fill_price'
  | 'quantity_mismatch'
  | 'already_matches';

export type ExitCorrection =
  | {
      action: 'correct';
      /** The broker's actual fill price for the exit leg. */
      realPrice: number;
      /** realPrice − recorded, per share/contract. Signed. */
      priceDelta: number;
      /** Total P&L difference this correction makes to the position. */
      pnlDelta: number;
      /** Which leg filled, as an exit reason, or null when the leg does not
       *  say (the recorded reason is then left alone). */
      reason: PositionExitReason | null;
    }
  | { action: 'skip'; code: ExitCorrectionSkipCode; reason: string };

/**
 * The exit reason a filled bracket leg PROVES: the stop leg is a stop, the
 * take-profit leg is a target. Null when the leg carries neither label, and
 * never a guess from the price. The live reconcile books a leg's fill with the
 * same function (liveExecute.ts), so a correction and a first-time booking
 * cannot name the same leg differently.
 */
export function legExitReason(leg: Pick<WebullOrderLeg, 'comboType' | 'orderType'>): 'stop' | 'target' | null {
  if (leg.comboType === 'STOP_LOSS') return 'stop';
  if (leg.comboType === 'STOP_PROFIT') return 'target';
  // No combo label: only a stop ORDER TYPE is unambiguous. A plain LIMIT could
  // be the take-profit or any other limit sell, so it says nothing.
  if (leg.orderType === 'STOP_LOSS' || leg.orderType === 'STOP_LOSS_LIMIT') return 'stop';
  return null;
}

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
      code: 'no_filled_leg',
      reason: 'no filled exit leg at the broker — the combo may have aged out of order history',
    };
  }
  if (filled.length > 1) {
    // Same posture the live reconcilers take on this exact shape: two filled
    // exit legs shouldn't happen under OCO semantics and isn't ruled out, and
    // picking one would be a guess about which produced this exit.
    return {
      action: 'skip',
      code: 'ambiguous_legs',
      reason: `${filled.length} filled exit legs — ambiguous, cannot say which produced this`,
    };
  }

  const leg = filled[0];
  const realPrice = leg.filledPrice;
  if (realPrice === undefined || !Number.isFinite(realPrice) || realPrice <= 0) {
    return { action: 'skip', code: 'no_fill_price', reason: 'the exit leg reported no usable fill price' };
  }

  // A quantity disagreement means this exit row and that leg are not describing
  // the same event — a partial exit, a leg that filled in instalments, or a
  // position closed across more than one order. Correcting the PRICE of a row
  // whose quantity we cannot match would apply the right number to the wrong
  // amount, which is worse than the estimate it replaces.
  if (leg.filledQty !== undefined && Math.abs(leg.filledQty - exit.quantity) > QTY_EPS) {
    return {
      action: 'skip',
      code: 'quantity_mismatch',
      reason: `broker leg filled ${leg.filledQty} but this exit booked ${exit.quantity} — not the same event`,
    };
  }

  const priceDelta = realPrice - exit.exitPrice;
  const reason = legExitReason(leg);
  // The price can already be right while the reason is not: an estimate that
  // happened to land on the fill still says 'manual' for what was a stop.
  const reasonWrong = reason !== null && reason !== exit.exitReason;
  if (Math.abs(priceDelta) < PRICE_EPS && !reasonWrong) {
    return { action: 'skip', code: 'already_matches', reason: 'already matches the broker fill' };
  }

  return {
    action: 'correct',
    realPrice,
    priceDelta,
    // Signed by the position's side (2026-09-23, shorts pre-flight): a cover
    // that filled lower than its estimate is a GAIN on a short, and this used
    // to journal it as a loss. The ledger was right all along (realizedPnlOf
    // recomputes from the price); the journal's delta was not.
    pnlDelta: priceDelta * exit.quantity * (exit.positionSide === 'short' ? -1 : 1),
    reason,
  };
}

/** The note left on an estimate the broker's fill CONFIRMED to the cent. The
 *  price stays; the note is replaced so the row stops reading as an estimate
 *  and leaves the correction pass's candidates for good, a restart included. */
export function confirmationNote(price: number, filledBy: string): string {
  return (
    `Exit price confirmed against the broker's actual fill (${filledBy}): the Webull position sync's ` +
    `estimate of ${price} already matched it.`
  );
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

// ---------------------------------------------------------------------------
// Scale into winners (pyramiding), PAPER + BACKTEST equity only — the pure
// decision behind execute.ts's paper loop and both equity backtest engines.
//
// Once a position's unrealized gain reaches addOnTriggerRMultiple (measured
// from its CURRENT entry against its FROZEN original per-share risk), we add
// addOnSizePct% more shares, up to maxAddOns times. Each add:
//   • blends the entry toward the current price (up for a long, down for a
//     short) so P&L on the whole position stays honest;
//   • shifts the recorded initial-stop level by the SAME amount, so the
//     R-multiple denominator (|entry − initialStop|) stays the ORIGINAL
//     per-share risk — successive adds still trigger a real ~1R apart because
//     blending drops the instantaneous R-multiple;
//   • RAISES the protective stop to 1R below (long) / above (short) the new
//     blended entry, never loosening it.
//
// The trigger deliberately reads from the current (blended) entry, so no
// separate "levels" bookkeeping is needed: after an add the R-multiple falls
// back under the trigger and price must climb another ~1R to add again.
// maxAddOns caps how top-heavy the pyramid can get.
// ---------------------------------------------------------------------------

export interface ScaleInConfig {
  addOnTriggerRMultiple: number;
  addOnSizePct: number;
  maxAddOns: number;
}

export interface ScaleInState {
  /** 'buy' = long, 'sell' = short. */
  side: 'buy' | 'sell';
  entryPrice: number;
  /** Frozen original stop level (the R denominator's basis). */
  initialStopPrice: number;
  /** Current protective stop (possibly already ratcheted). */
  stopPrice: number;
  quantity: number;
  addOnsTaken: number;
}

export interface ScaleInResult {
  /** Shares to add at `last`. */
  addQty: number;
  newQuantity: number;
  /** Weighted-average entry after the add. */
  blendedEntry: number;
  /** Initial-stop level shifted to preserve the original per-share risk. */
  newInitialStopPrice: number;
  /** Protective stop after the add — raised, never loosened. */
  newStopPrice: number;
  /** The R-multiple that triggered the add (from the pre-add entry). */
  rMultiple: number;
}

/**
 * Should we pyramid into this winner right now? Returns the fully-resolved add
 * (quantities, blended entry, shifted initial stop, raised protective stop) or
 * null when scaling is off, capped out, not yet at the trigger, or the add
 * would round to zero shares. Pure — no I/O, no mutation.
 */
export function computeScaleIn(state: ScaleInState, last: number, cfg: ScaleInConfig): ScaleInResult | null {
  if (cfg.addOnTriggerRMultiple <= 0 || cfg.maxAddOns <= 0 || cfg.addOnSizePct <= 0) return null;
  if (state.addOnsTaken >= cfg.maxAddOns) return null;

  const long = state.side === 'buy';
  const initialStopDistance = Math.abs(state.entryPrice - state.initialStopPrice);
  if (!(initialStopDistance > 0)) return null;

  const rMultiple = long
    ? (last - state.entryPrice) / initialStopDistance
    : (state.entryPrice - last) / initialStopDistance;
  if (rMultiple < cfg.addOnTriggerRMultiple) return null;

  const addQty = Math.floor(state.quantity * (cfg.addOnSizePct / 100));
  if (addQty < 1) return null;

  const newQuantity = state.quantity + addQty;
  const blendedEntry = (state.entryPrice * state.quantity + last * addQty) / newQuantity;
  const entryDelta = blendedEntry - state.entryPrice; // >0 for a long winner, <0 for a short winner
  const newInitialStopPrice = state.initialStopPrice + entryDelta; // preserves |entry − initialStop|

  // Protective stop: at best 1R below/above the new blended entry, and never
  // looser than where it already sits.
  const protective = long ? blendedEntry - initialStopDistance : blendedEntry + initialStopDistance;
  const newStopPrice = long ? Math.max(state.stopPrice, protective) : Math.min(state.stopPrice, protective);

  return { addQty, newQuantity, blendedEntry, newInitialStopPrice, newStopPrice, rMultiple };
}

import { OrderIntentRecord } from '../../db/orders';

// ---------------------------------------------------------------------------
// How much of a broker-reported fill is NOT yet reflected in our own records,
// and at what price — the shared safety core behind partial-fill handling on
// BOTH live paths:
//
//   - the human Trade page / Webull scheduler  (trading/reconcile.ts)
//   - autotrade's own reconcile loop           (autotrading/liveExecute.ts,
//                                               autotrading/liveOptionsExecute.ts)
//
// The two paths BOOK differently — the human ledger records each instalment as
// its own lot, while autotrade blends instalments into the single position its
// `autotrade_live_orders.position_id` column can point at — but the decision of
// *how much* may be booked, and whether it is safe to book at all, must be
// identical. Duplicating these guards is how they drift, and they are the whole
// reason partial handling is safe, so they live here once.
//
// THE ASSUMPTION. The broker reports `filled_quantity` as a RUNNING TOTAL and
// `filled_price` as the AVERAGE over all executions, so a new instalment is
// recovered by subtraction. That reading has NOT been confirmed against a real
// partial fill — see `npm run capture:broker`, whose --watch mode exists to
// settle it. Every way it could be wrong is therefore checked below, and each
// resolves toward booking LESS with a visible warning.
//
// The asymmetry is deliberate: under-booking is recoverable (the shares surface
// in the next broker positions sync, and the warning says why), while
// over-booking invents cost basis that never existed and silently corrupts P&L
// and every risk figure derived from it. Ambiguity must never resolve toward
// inventing shares.
// ---------------------------------------------------------------------------

/** Quantities are REAL columns; compare with a tolerance, never exactly. */
export const QTY_EPS = 1e-9;

export interface FillDelta {
  /** Quantity safe to book now. 0 means "nothing to do" — which, when paired
   *  with a `warning`, means "refused" rather than "already up to date". */
  qty: number;
  /** Price for THIS instalment, backed out of the running average. */
  price: number;
  /** Set when the broker's data contradicted the running-total assumption.
   *  Callers must surface this, not swallow it. */
  warning?: string;
}

/**
 * Work out the bookable part of an observed fill against what an intent has
 * already had recorded (`materializedQty` / `materializedNotional`).
 *
 * Pure: it reads the intent and returns a decision, touching no tables. The
 * caller books it in whatever shape its own ledger uses, then advances the
 * high-water mark via advanceMaterialized().
 */
export function computeFillDelta(
  intent: Pick<OrderIntentRecord, 'quantity' | 'materializedQty' | 'materializedNotional'>,
  observedQty: number,
  observedAvgPrice: number,
): FillDelta {
  if (!Number.isFinite(observedQty) || observedQty <= QTY_EPS) return { qty: 0, price: observedAvgPrice };

  let delta = observedQty - intent.materializedQty;

  // A DECREASE can't happen to a running total. It means the broker reports
  // each execution on its own, so subtraction is meaningless and any number we
  // derived from it would be fiction. Refuse outright.
  if (delta < -QTY_EPS) {
    return {
      qty: 0,
      price: observedAvgPrice,
      warning:
        `broker reported ${observedQty} filled after ${intent.materializedQty} was already recorded — ` +
        `filled quantity decreased, so it is not a running total and cannot be differenced. ` +
        `Nothing booked; check this order against your broker.`,
    };
  }
  if (delta <= QTY_EPS) return { qty: 0, price: observedAvgPrice };

  let warning: string | undefined;

  // Never book more than was actually ordered — the ceiling that catches
  // per-execution semantics whose instalments happen to be increasing, which a
  // decrease check alone would miss.
  const bookable = intent.quantity - intent.materializedQty;
  let clamped = false;
  if (delta > bookable + QTY_EPS) {
    warning =
      `broker reported ${observedQty} filled on an order for ${intent.quantity} — ` +
      `booking only the ${Math.max(0, bookable)} outstanding.`;
    delta = Math.max(0, bookable);
    clamped = true;
    if (delta <= QTY_EPS) return { qty: 0, price: observedAvgPrice, warning };
  }

  // Price of THIS instalment: total cost so far, less what we already booked.
  //
  // Only valid when the delta covers the WHOLE unbooked increment. If it was
  // clamped, the observed notional spans more quantity than we're booking, so
  // differencing would divide the full cost across a smaller slice and inflate
  // the price badly (2 contracts' cost attributed to 1 doubles it). The
  // reported average is the honest figure for a partial slice.
  let price = observedAvgPrice;
  if (!clamped) {
    const incrementalNotional = observedQty * observedAvgPrice - intent.materializedNotional;
    price = incrementalNotional / delta;
    if (!Number.isFinite(price) || price <= 0) {
      // An average that moved in a way the already-booked cost can't explain —
      // inconsistent broker data, not a genuinely free lot.
      price = observedAvgPrice;
      warning = [warning, 'implied incremental price was not usable — falling back to the average fill price.']
        .filter(Boolean)
        .join(' ');
    }
  }

  return { qty: delta, price, warning };
}

/**
 * Is a fully-filled order's booked quantity short of what was ordered? A true
 * here means the ledger and the real account disagree — worth saying out loud
 * rather than letting a reconcile report success.
 */
export function isShortBooked(intent: Pick<OrderIntentRecord, 'quantity' | 'materializedQty'>): boolean {
  return Math.abs(intent.materializedQty - intent.quantity) > QTY_EPS;
}

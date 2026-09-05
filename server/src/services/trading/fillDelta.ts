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
// THE CONTRACT — confirmed against the vendor docs 2026-09-05
// (reference/order-detail), which this comment previously recorded as an
// unverified assumption:
//
//   total_quantity   "Total order quantity. Represents the total number of
//                     units submitted for this order."
//   filled_quantity  "Quantity that has been executed. Represents the number
//                     of units that have been filled SO FAR."   -> running total
//   filled_price     "AVERAGE transaction price of the filled quantity."
//
// and there is NO per-execution array anywhere in the response — the schema
// aggregates to those two fields plus filled_time_at — so backing an instalment
// out by subtraction is not merely one reading, it is the only one available.
//
// What is still unobserved is the BEHAVIOUR: no real partial fill has been
// captured from this account (see `npm run capture:broker --watch`). A broker
// departing from its own documented schema is exactly the sort of thing this
// repo has been bitten by, so every guard below stays, and each still resolves
// toward booking LESS with a visible warning.
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

  // A fill at a NON-POSITIVE price is never real, and booking one is the worst
  // outcome this module can produce: an entry at 0 gives a position infinite R
  // and a meaningless cost basis, an exit at 0 books a total loss that did not
  // happen, and every risk figure downstream is derived from those.
  //
  // Reachable per the vendor docs, which say filled_price "may be zero or null
  // if the order has not been executed yet" — so a broker that advances
  // filled_quantity before filled_price lands reports exactly this. The callers
  // cannot be relied on to catch it either: liveExecute's own fallback is
  // `broker.filledPrice ?? intent.limitPrice`, and `??` does not fire on 0, so
  // a literal zero passes straight through. Same shape as the empty-string
  // buying_power that read as $0 in the balance mapping.
  //
  // Refused rather than substituted, in keeping with the rest of this file: a
  // price we cannot stand behind is not improved by guessing one, and
  // under-booking is recoverable — the shares surface in the next positions
  // sync, with this warning saying why.
  if (!(price > 0)) {
    return {
      qty: 0,
      price,
      warning: [
        warning,
        `broker reported ${delta} filled at a non-positive price (${price}) — nothing booked, ` +
          `since booking at zero would invent a cost basis. Check this order against your broker.`,
      ]
        .filter(Boolean)
        .join(' '),
    };
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

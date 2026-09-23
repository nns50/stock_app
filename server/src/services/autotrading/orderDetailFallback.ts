import { logAutotradeEvent } from '../../db/autotradeEvents';
import { OrderIntentRecord } from '../../db/orders';
import { webullOrderDetail, WebullOrderStatus } from '../../providers/webull/orders';
import { claimOncePerDay } from './oncePerDayEvents';

// ---------------------------------------------------------------------------
// THE LISTS LAG; ASK FOR THE ORDER ITSELF (2026-09-23).
//
// An order the broker ACKNOWLEDGED is one it holds. When neither order list
// accounts for it (not found, or the list read failed), the broker's own
// reference says to query Order Detail by client_order_id instead. See
// webullOrderDetail for the quote. Before this, that case was silent: an
// acknowledged order missing from both lists was simply "left alone". SHOP's
// close sat there from 15:27:55 on 2026-09-22 into the evening. The position
// stayed open in the ledger, holding a slot, while the broker held no shares
// and the stock sync deferred to the "exit in flight" forever.
//
// ONE FUNCTION FOR BOTH BOOKS (#87, 2026-09-23). This block shipped inside
// the stock reconcile, and the options reconcile read the same two lists with
// the same blind spot. On options the symptom differs but it is still real.
// The options broker sync does not wait on a working close. After two misses
// it closes the position at an ESTIMATE from the delayed chain and labels it
// `manual`. So a close filled but unlisted lost its real price and its real
// reason, the one the options ladder's evidence is counted by. Both reconciles
// now call this, so the lookup cannot fix one book and drift in the other.
//
// Bounded, because Order Detail is paced at 2 requests / 2 seconds and the
// tick has other work to do. Newest first, so an order that aged out of the
// lists' 7-day window long ago cannot starve a fresh one of the budget.
// ---------------------------------------------------------------------------

/** How many acknowledged orders missing from both order lists are looked up
 *  directly (Order Detail) per reconcile tick, per book. The endpoint is paced
 *  at 2 requests / 2 seconds, so both books at their cap cost ~6 s of a 60 s
 *  tick. */
export const ORDER_DETAIL_LOOKUPS_PER_TICK = 3;

/** The top-level keys of an undocumented response (or its array length),
 *  never its values, for the journal. */
export function responseShape(raw: unknown): string {
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (raw && typeof raw === 'object')
    return `object{${Object.keys(raw as object)
      .slice(0, 20)
      .join(',')}}`;
  return typeof raw;
}

export interface UnlistedOrderCandidate {
  intent: OrderIntentRecord;
  symbol: string;
  role: string;
  riskProfile: string | null;
}

/**
 * Look up, by Order Detail, the acknowledged or partially filled orders that
 * neither list read accounted for, and put what the broker says into
 * `statuses`. The caller then reconciles every order from the one map, so an
 * answer found here reaches exactly the code a list answer reaches.
 *
 * Read-only toward the broker: nothing here places, cancels or modifies an
 * order. Journals, once per order per day, either the answer
 * (`…order_status_from_detail`) or the silence (`…order_status_unresolved`,
 * with the reply's keys only).
 */
export async function resolveUnlistedFromOrderDetail(
  book: 'stock' | 'options',
  accountId: string,
  orders: UnlistedOrderCandidate[],
  statuses: Map<string, WebullOrderStatus>,
): Promise<void> {
  const candidates = orders
    .filter(({ intent }) => intent.state === 'acknowledged' || intent.state === 'partially_filled')
    .filter(({ intent }) => {
      const listed = statuses.get(intent.idempotencyKey);
      return !listed || !listed.ok || !listed.found;
    })
    .sort((a, b) => b.intent.createdAt - a.intent.createdAt)
    .slice(0, ORDER_DETAIL_LOOKUPS_PER_TICK);
  for (const { intent, symbol, role, riskProfile } of candidates) {
    const listed = statuses.get(intent.idempotencyKey);
    const listRead = !listed ? 'not_asked' : listed.ok ? 'not_found' : (listed.error ?? 'list read failed');
    const detail = await webullOrderDetail(accountId, intent.idempotencyKey);
    if (detail.ok && detail.found) {
      statuses.set(intent.idempotencyKey, detail);
      // The throttle key is the action itself, as it was before the move, so
      // the stock book's once-a-day claim is unchanged. The action names are
      // spelled out as literals on purpose: the journal-action reachability
      // guard reads writers off the `action:` line, and a variable there is
      // invisible to it.
      if (
        claimOncePerDay(
          book === 'options' ? 'live_options_order_status_from_detail' : 'live_order_status_from_detail',
          String(intent.id),
        )
      ) {
        logAutotradeEvent({
          symbol,
          stage: 'execution',
          action: book === 'options' ? 'live_options_order_status_from_detail' : 'live_order_status_from_detail',
          detail: {
            intentId: intent.id,
            clientOrderId: intent.idempotencyKey,
            role,
            status: detail.status ?? null,
            filledQty: detail.filledQty ?? null,
            filledPrice: detail.filledPrice ?? null,
            listRead,
          },
          riskProfile,
        });
      }
    } else if (
      claimOncePerDay(
        book === 'options' ? 'live_options_order_status_unresolved' : 'live_order_status_unresolved',
        String(intent.id),
      )
    ) {
      // Once per order per day: the order is acknowledged, the lists do not
      // show it, and the direct read did not either. Loud, because this is the
      // state that held SHOP open, and before this row it was invisible.
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: book === 'options' ? 'live_options_order_status_unresolved' : 'live_order_status_unresolved',
        detail: {
          intentId: intent.id,
          clientOrderId: intent.idempotencyKey,
          role,
          state: intent.state,
          listRead,
          detailRead: detail.ok ? 'not_found' : (detail.error ?? 'detail read failed'),
          // The keys only, never the values: enough to learn an undocumented
          // response shape from the first real answer.
          detailShape: detail.ok ? responseShape(detail.raw) : null,
        },
        riskProfile,
      });
    }
  }
}

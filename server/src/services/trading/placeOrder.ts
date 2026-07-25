import { createHash } from 'crypto';
import { config } from '../../config';
import {
  AccountState,
  GuardrailReport,
  OrderIntent,
  blockingFailures,
  evaluateGuardrails,
  wouldOpenShort,
} from './guardrails';
import { getTradingConfig } from '../../db/trading';
import {
  OrderIntentRecord,
  countTodaysOrders,
  createIntent,
  getIntent,
  recordIntentNote,
  transitionIntent,
} from '../../db/orders';
import { webullAccountState, webullAccountType } from '../../providers/webull/accountState';
import { marketOpenContext } from './marketHours';
import { WebullPlaceResult, newClientOrderId, webullPlaceOrder } from '../../providers/webull/orders';
import { resolveStockPrices } from '../quotes';
import { getProvider } from '../../providers';

// ---------------------------------------------------------------------------
// Place a single live order (stock or single-leg option) — the ONLY path that
// can move real money (design §6, Phase 3). Server-authoritative: it re-pulls
// account state and re-runs the guardrails HERE, never trusting the client.
//
// An order fires ONLY when ALL of these hold:
//   1) TRADING_ENABLED is set on the server (deploy-level master gate),
//   2) the type-to-confirm phrase matches the order,
//   3) every guardrail passes against FRESH account state — which includes
//      config.enabled, the kill switch being off, the caps, and buying power.
//
// Every attempt (blocked, broker-rejected, or placed) is written to the audit
// trail via the order lifecycle.
// ---------------------------------------------------------------------------

export type PlaceReason =
  | 'trading_disabled'
  | 'not_confirmed'
  | 'account_error'
  | 'blocked'
  | 'broker_rejected'
  | 'duplicate'
  | 'placed'
  /** The broker never answered. The order may or may not be live — see the
   *  ambiguous branch in placeOrder() below. NOT a rejection. */
  | 'outcome_unknown';

export interface PlaceResult {
  /** The request was processed (not whether an order was placed). */
  ok: boolean;
  /** True only when a live order was submitted AND the broker accepted it. */
  placed: boolean;
  reason: PlaceReason;
  guardrails?: GuardrailReport;
  accountState?: AccountState;
  intent?: OrderIntentRecord;
  broker?: WebullPlaceResult;
  error?: string;
}

/** The exact phrase the client must echo to arm a place (type-to-confirm). */
export function placeConfirmation(intent: OrderIntent): string {
  return `${intent.side.toUpperCase()} ${intent.quantity} ${intent.symbol.toUpperCase()}`;
}

/** Re-derive the fat-finger reference SERVER-side for a LIMIT order, overriding
 *  whatever the client sent — a client can otherwise omit `referencePrice`
 *  (downgrading fat_finger to a warning) or set it equal to an absurd limit
 *  (making the deviation 0, defeating the check entirely). `referencePrice` is
 *  guardrail-only — never sent to the broker — so overriding it is safe. A
 *  market-data miss falls back to the client value (no worse than before).
 *  Stocks use a fresh quote; single-leg options use the current contract mark
 *  from the chain. Multi-leg spreads (net-premium reference) keep the client
 *  value — they don't come through this single-order /place path.
 *
 *  A STALE price is treated as a miss, not as data. resolveStockPrices() falls
 *  back to the `quote_cache` table whenever the provider call fails, and that
 *  table has no TTL and is never pruned — so the row it returns can be days
 *  old, and it comes back as an ordinary number with a `stale: true` flag
 *  beside it. Reading the number and dropping the flag made the check LOOK
 *  stricter while being weaker: fat_finger is a BLOCK when a reference exists
 *  and only a WARN when none does (guardrails.ts), so an unbounded-age price
 *  silently became the authority on whether today's limit is sane — able to
 *  pass a limit a fresh quote would block, and to block one it would pass. The
 *  documented behavior above ("a market-data miss falls back to the client
 *  value") was never actually reachable for any symbol that had ever been
 *  cached, which is every symbol you have ever looked at. */
async function withServerReference(intent: OrderIntent): Promise<OrderIntent> {
  if (intent.orderType !== 'limit') return intent;
  let ref: number | undefined;
  try {
    if (intent.assetKind === 'stock') {
      const resolved = (await resolveStockPrices([intent.symbol])).get(intent.symbol.toUpperCase());
      const px = resolved?.stale ? undefined : resolved?.price;
      if (typeof px === 'number' && Number.isFinite(px) && px > 0) ref = px;
    } else if (
      intent.assetKind === 'option' &&
      intent.optionType &&
      intent.strike !== undefined &&
      intent.expiration &&
      (intent.optionStrategy ?? 'SINGLE') === 'SINGLE'
    ) {
      const chain = await getProvider().getOptionsChain(intent.symbol, intent.expiration);
      const pool = intent.optionType === 'call' ? chain.calls : chain.puts;
      const match = pool.find((c) => Math.abs(c.strike - intent.strike!) < 1e-6);
      const mark = match?.mark ?? match?.last;
      if (typeof mark === 'number' && Number.isFinite(mark) && mark > 0) ref = mark;
    }
  } catch {
    // market-data miss — fall back to the client value below
  }
  return ref !== undefined ? { ...intent, referencePrice: ref } : intent;
}

export async function placeOrder(
  intent: OrderIntent,
  accountId: string,
  confirmation: string,
  idempotencyKey?: string,
): Promise<PlaceResult> {
  // 1) Deploy-level master gate — dead unless TRADING_ENABLED is set on the box.
  if (!config.trading.placeEnabled) {
    return {
      ok: true,
      placed: false,
      reason: 'trading_disabled',
      error: 'Order placement is disabled on the server (TRADING_ENABLED is not set).',
    };
  }
  // 2) Type-to-confirm, re-checked server-side so a blind/automated POST can't place.
  if (confirmation.trim().toUpperCase() !== placeConfirmation(intent)) {
    return { ok: true, placed: false, reason: 'not_confirmed', error: 'Confirmation phrase did not match the order.' };
  }

  // Fresh, authoritative account state (never client-supplied), with today's real
  // order count folded in for the max-orders/day rule. Pass the order's own
  // instrument so the naked_short / position_size checks see the quantity of
  // THAT instrument (this exact option contract, or stock), not a cross-asset
  // per-underlying sum — long stock must not silently cover a short option.
  const acct = await webullAccountState(accountId, intent.symbol, {
    assetKind: intent.assetKind,
    strike: intent.strike,
    expiration: intent.expiration,
    optionType: intent.optionType,
  });
  if (!acct.ok || !acct.state) {
    return { ok: true, placed: false, reason: 'account_error', error: acct.error ?? 'Could not load account state.' };
  }
  // Fail CLOSED if the broker's positions couldn't be read: a fabricated 0
  // would under-count a real holding and let the position_size cap be breached.
  if (acct.positionsUnavailable) {
    return {
      ok: true,
      placed: false,
      reason: 'account_error',
      error:
        'Could not verify current positions with the broker — order blocked rather than sized against an unknown position.',
    };
  }
  const accountType =
    intent.optionStrategy === 'VERTICAL' || intent.optionStrategy === 'IRON_CONDOR'
      ? await webullAccountType(accountId)
      : undefined;
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(), accountType };

  // Re-derive the fat-finger reference from fresh market data (never the
  // client's) so the guardrail can't be omitted or spoofed away.
  const priced = await withServerReference(intent);

  // 3) Re-run the guardrails server-side.
  const cfg = getTradingConfig();
  const guardrails = evaluateGuardrails(priced, accountState, cfg, { marketOpen: marketOpenContext(priced) });
  // Only matters for a permitted short (allowNakedShort — naked_short above
  // already blocks it otherwise): submit Webull's own SHORT side instead of a
  // plain SELL so the broker's real-time locate/borrow check runs at order time.
  const isShort = wouldOpenShort(priced, accountState);

  // Idempotency: a client-supplied key makes retries/double-clicks/proxy-replays
  // safe. Deriving the broker client_order_id deterministically from it means a
  // repeated request produces the SAME order id (so the broker dedups too) and
  // the SAME intent row (createIntent is keyed on it). If that intent already
  // advanced past 'draft', a prior request already placed (or is placing) it —
  // decline to submit a second time. Without a key, each call is unique (prior
  // behavior). The transitions below up to submit are synchronous, so a
  // concurrent duplicate sees 'submitted', never a second 'draft'.
  const clientOrderId = idempotencyKey
    ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
    : newClientOrderId();
  const intentRec = createIntent(priced, clientOrderId); // draft (audited)
  if (intentRec.state !== 'draft') {
    return { ok: true, placed: false, reason: 'duplicate', guardrails, accountState, intent: intentRec };
  }

  if (!guardrails.ok) {
    const reasons = blockingFailures(guardrails)
      .map((c) => `${c.rule}: ${c.detail}`)
      .join('; ');
    const rejected = transitionIntent(intentRec.id, 'rejected', { detail: `blocked: ${reasons}` });
    return { ok: true, placed: false, reason: 'blocked', guardrails, accountState, intent: rejected };
  }

  // Walk the lifecycle, then submit.
  transitionIntent(intentRec.id, 'validated', { detail: 'guardrails passed (live)' });
  transitionIntent(intentRec.id, 'confirmed', { detail: `confirmed: ${confirmation.trim()}` });
  transitionIntent(intentRec.id, 'submitted', { detail: `submitting (cid ${clientOrderId})` });

  const broker = await webullPlaceOrder(accountId, intent, clientOrderId, isShort);

  if (broker.ok) {
    const acked = transitionIntent(intentRec.id, 'acknowledged', {
      brokerOrderId: broker.orderId,
      detail: `broker accepted${broker.orderId ? ` (order ${broker.orderId})` : ''}`,
    });
    return { ok: true, placed: true, reason: 'placed', guardrails, accountState, intent: acked, broker };
  }

  // We never heard back — the request may well have reached the broker and been
  // accepted (see WebullPlaceResult.ambiguous). 'rejected' is TERMINAL, so
  // recording one here states as fact something we do not know, and the cost is
  // asymmetric: a real resting order would then have no intent tracking it, no
  // Positions row when it fills, and no presence in exposure or the caps, while
  // the UI reports "rejected" — an invitation to place it a second time.
  //
  // Leave it at 'submitted' instead. webullOrderStatus looks orders up by CLIENT
  // order id, so the outcome is still recoverable with no broker id in hand:
  // reconcileAllWorking() now includes exactly this shape (see its own filter),
  // and a per-order Refresh reaches it too. This mirrors what the autotrade
  // paths already do (liveExecute.ts's attemptLiveEntry, liveOptionsExecute.ts's
  // placeLiveOptionsOrder) — #337 fixed those three call sites and left this
  // one, the human Trade page's, on the old behavior.
  //
  // Deliberately NOT auto-retired the way autotrade retires an unknown
  // placement the broker denies knowing: that exists to free an unattended
  // loop's per-symbol dedup slot, and there is no such slot here. A human can
  // see the order and decide.
  if (broker.ambiguous) {
    recordIntentNote(intentRec.id, `placement outcome unknown (no broker response): ${broker.error}`);
    return {
      ok: true,
      placed: false,
      reason: 'outcome_unknown',
      guardrails,
      accountState,
      intent: getIntent(intentRec.id) ?? intentRec,
      broker,
      error:
        `The broker did not respond, so it is unknown whether this order was accepted (${broker.error}). ` +
        `It has NOT been marked rejected — refresh the order to resolve it against the broker before ` +
        `placing another, and check your broker directly if it stays unresolved.`,
    };
  }

  const rej = transitionIntent(intentRec.id, 'rejected', { detail: `broker rejected: ${broker.error}` });
  return { ok: true, placed: false, reason: 'broker_rejected', guardrails, accountState, intent: rej, broker };
}

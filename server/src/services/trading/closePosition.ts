import { Position } from '../../db/positions';
import { OrderIntent } from './guardrails';
import { placeOrder, PlaceResult } from './placeOrder';
import { getIntent } from '../../db/orders';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { recordLiveExitOrder, getLiveOrder } from '../../db/autotradeLiveOrders';
import { cancelLiveBracketExitLegs, isAutotradePosition } from '../autotrading/liveExecute';
import { fetchContractMark } from '../autotrading/optionsExecute';
import { getProvider } from '../../providers';

// ---------------------------------------------------------------------------
// Manually close a REAL (broker-tracked) position from the Positions page
// (2026-07-16) — the human-confirmed counterpart to autotrade's own
// checkLiveEquityTimeExits()/checkLiveOptionsExits() force-closes. Reuses
// trading/placeOrder.ts directly (the same TRADING_ENABLED + type-to-confirm
// + guardrails pipeline the Trade page uses for any other live order) rather
// than autotrade's own placeLiveEquityTimeExitClose()-style internals, which
// deliberately skip per-order confirmation because an autonomous caller
// confirming its own order proves nothing (see liveExecute.ts's own header
// comment) — that reasoning doesn't apply here: a human is genuinely typing
// the phrase.
// ---------------------------------------------------------------------------

/** Mirrors autotrading/liveExecute.ts's own MARKETABLE_LIMIT_BUFFER_PCT (0.5%
 *  for equities) and liveOptionsExecute.ts's own OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT
 *  (5% for options, options being far less liquid) — same "priced just past
 *  the mark to all but guarantee a fill without being a de facto unpriced
 *  market order" reasoning, just re-declared here rather than importing two
 *  private constants across module boundaries. */
const EQUITY_MARKETABLE_LIMIT_BUFFER_PCT = 0.5;
const OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT = 5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function buildCloseIntent(pos: Position): Promise<OrderIntent> {
  const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
  // Selling to close prices BELOW the mark to guarantee a fill; buying to
  // close (covering a short) prices ABOVE it — the same mirror-image
  // reasoning liveOptionsExecute.ts's own placeLiveOptionsExit uses.
  const sign = closeSide === 'buy' ? 1 : -1;

  if (pos.assetType === 'option') {
    if (!pos.optionType || !pos.strike || !pos.expiration) {
      throw new Error(`Position ${pos.id} is missing optionType/strike/expiration`);
    }
    const mark = await fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.optionType);
    const buffer = 1 + sign * (OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
    return {
      symbol: pos.symbol,
      assetKind: 'option',
      side: closeSide,
      openClose: 'close',
      quantity: pos.remainingQuantity,
      orderType: 'limit',
      limitPrice: round2(mark * buffer),
      referencePrice: mark,
      optionType: pos.optionType,
      strike: pos.strike,
      expiration: pos.expiration,
      multiplier: pos.multiplier,
    };
  }

  const quote = await getProvider().getQuote(pos.symbol);
  if (!Number.isFinite(quote.last) || quote.last <= 0) {
    throw new Error(`Invalid quote price for ${pos.symbol}`);
  }
  const buffer = 1 + sign * (EQUITY_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  return {
    symbol: pos.symbol,
    assetKind: 'stock',
    side: closeSide,
    openClose: 'close',
    quantity: pos.remainingQuantity,
    orderType: 'limit',
    limitPrice: round2(quote.last * buffer),
    referencePrice: quote.last,
  };
}

export interface ClosePositionResult extends PlaceResult {
  /** True only when this position had a resting bracket that needed
   *  cancelling before the close could be placed; absent when there was
   *  nothing to cancel. */
  bracketCancelled?: boolean;
}

/**
 * Close `pos` for real: cancel any resting bracket exit legs first, build a
 * marketable-limit closing order, then submit it through the exact same
 * guardrail + confirm-phrase pipeline the Trade page uses. `pos` must already
 * be verified open and broker-tracked by the caller (routes/positions.ts) —
 * this function does no such validation itself, matching placeOrder()'s own
 * "assumes a valid intent, the caller validated the request shape" posture.
 */
export async function closeLivePosition(
  pos: Position,
  accountId: string,
  confirmation: string,
): Promise<ClosePositionResult> {
  const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
  // Checked FIRST, before anything else touches the broker — cancelling a
  // resting bracket (below) is itself a real, consequential action, so an
  // unconfirmed request must have NO side effect at all, not just skip the
  // final placement. Same phrase algorithm placeOrder()'s own placeConfirmation
  // uses (a pure function of side/quantity/symbol); placeOrder() re-checks it
  // again later against the fully-built intent — redundant on the happy path,
  // cheap insurance against this pre-check and the later intent ever disagreeing.
  const expectedPhrase = `${closeSide.toUpperCase()} ${pos.remainingQuantity} ${pos.symbol.toUpperCase()}`;
  if (confirmation.trim().toUpperCase() !== expectedPhrase) {
    return { ok: true, placed: false, reason: 'not_confirmed', error: 'Confirmation phrase did not match the order.' };
  }

  let bracketCancelled: boolean | undefined;
  if (pos.sourceIntentId !== null) {
    const entryIntent = getIntent(pos.sourceIntentId);
    if (entryIntent?.isBracket) {
      const cancelled = await cancelLiveBracketExitLegs(entryIntent, accountId);
      if (!cancelled.ok) {
        return {
          ok: true,
          placed: false,
          reason: 'blocked',
          error: `Could not cancel the resting bracket order first: ${cancelled.reason ?? 'unknown reason'}`,
        };
      }
      bracketCancelled = true;
    }
  }

  let intent: OrderIntent;
  try {
    intent = await buildCloseIntent(pos);
  } catch (err) {
    return { ok: true, placed: false, reason: 'account_error', error: (err as Error).message, bracketCancelled };
  }

  const result = await placeOrder(intent, accountId, confirmation);

  // For an autotrade-managed EQUITY position, register the resulting order
  // with autotrade's own bookkeeping so checkLiveEquityTimeExits' maxHoldDays
  // dedup guard (autotrade_live_orders-based) sees this close already in
  // flight and doesn't independently race it with a second cancel+close
  // attempt of its own. Never needed for options: autotrade's own live
  // options positions live in a completely separate table
  // (autotrade_live_options_positions, shown on the Auto page, never on
  // Positions), so an options position reachable from THIS route can never
  // be one the autotrade options loop is also watching.
  if (result.placed && result.intent && pos.assetType === 'stock' && isAutotradePosition(pos)) {
    const riskProfile = pos.sourceIntentId
      ? (getLiveOrder(pos.sourceIntentId)?.riskProfile ?? getAutotradeConfig().riskProfile)
      : getAutotradeConfig().riskProfile;
    recordLiveExitOrder({ intentId: result.intent.id, symbol: pos.symbol, riskProfile, positionId: pos.id });
  }

  return { ...result, bracketCancelled };
}

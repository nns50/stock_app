import { Position } from '../../db/positions';
import { OrderIntent } from './guardrails';
import { placeOrder, PlaceResult } from './placeOrder';
import { getIntent } from '../../db/orders';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { recordLiveExitOrder, getLiveOrder } from '../../db/autotradeLiveOrders';
import { recordLiveOptionsExitOrder } from '../../db/autotradeLiveOptionsOrders';
import { LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { cancelLiveBracketExitLegs, isAutotradePosition } from '../autotrading/liveExecute';
import { fetchContractMark, fetchContractQuote, validPremium } from '../autotrading/optionsExecute';
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

/** A close intent, plus whether the price behind it is weaker than it looks. */
interface BuiltCloseIntent {
  intent: OrderIntent;
  /** Set when the limit derives from a LAST TRADE rather than a two-sided mark
   *  — see fetchContractQuote. Reported, not acted on: a human asked for this
   *  close, and refusing it outright would leave them holding a contract with
   *  no way to close it from here at all. */
  quoteWarning?: string;
}

async function buildCloseIntent(pos: Position): Promise<BuiltCloseIntent> {
  const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
  // Selling to close prices BELOW the mark to guarantee a fill; buying to
  // close (covering a short) prices ABOVE it — the same mirror-image
  // reasoning liveOptionsExecute.ts's own placeLiveOptionsExit uses.
  const sign = closeSide === 'buy' ? 1 : -1;

  if (pos.assetType === 'option') {
    if (!pos.optionType || !pos.strike || !pos.expiration) {
      throw new Error(`Position ${pos.id} is missing optionType/strike/expiration`);
    }
    const quote = await fetchContractQuote(pos.symbol, pos.expiration, pos.strike, pos.optionType);
    const mark = quote.price;
    const buffer = 1 + sign * (OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100);
    return {
      quoteWarning: quote.fromLastTrade
        ? `There is no live bid/ask for this contract, so the limit is based on its last TRADE ` +
          `($${mark}), which may be hours or days old — the close may rest unfilled. Check it at your broker.`
        : undefined,
      intent: {
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
      },
    };
  }

  const quote = await getProvider().getQuote(pos.symbol);
  if (!Number.isFinite(quote.last) || quote.last <= 0) {
    throw new Error(`Invalid quote price for ${pos.symbol}`);
  }
  const buffer = 1 + sign * (EQUITY_MARKETABLE_LIMIT_BUFFER_PCT / 100);
  return {
    intent: {
      symbol: pos.symbol,
      assetKind: 'stock',
      side: closeSide,
      openClose: 'close',
      quantity: pos.remainingQuantity,
      orderType: 'limit',
      limitPrice: round2(quote.last * buffer),
      referencePrice: quote.last,
    },
  };
}

export interface ClosePositionResult extends PlaceResult {
  /** True only when this position had a resting bracket that needed
   *  cancelling before the close could be placed; absent when there was
   *  nothing to cancel. */
  bracketCancelled?: boolean;
  /** Set when the closing limit was priced off a stale last trade rather than
   *  a live two-sided quote, so the order may simply not fill. */
  quoteWarning?: string;
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
      if (cancelled.raced) {
        // A resting stop/target filled while we were cancelling — the position
        // is already closing on its own, so we deliberately place NOTHING (a
        // fresh close would double-fill). Not a "couldn't cancel" failure.
        return {
          ok: true,
          placed: false,
          reason: 'blocked',
          error:
            'A resting stop or target order just filled — this position is already closing. Refresh in a moment to see it close.',
        };
      }
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

  let built: BuiltCloseIntent;
  try {
    built = await buildCloseIntent(pos);
  } catch (err) {
    return { ok: true, placed: false, reason: 'account_error', error: (err as Error).message, bracketCancelled };
  }
  const intent = built.intent;

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

  return { ...result, bracketCancelled, quoteWarning: built.quoteWarning };
}

// ---------------------------------------------------------------------------
// Manually close a live options position autotrade itself opened (Auto page,
// 2026-07-16) — same human-confirmed reasoning as closeLivePosition above,
// applied to autotrade_live_options_positions instead of the generic
// `positions` table (a structurally different table: a debit spread needs a
// second leg's columns positions.ts has no room for — see that table's own
// header comment). No bracket to cancel, ever: autotrade's options signals
// never carry a price-based stop/target (liveOptionsExecute.ts's own header
// comment), so every entry here is a plain order.
// ---------------------------------------------------------------------------

/** Mirrors liveOptionsExecute.ts's own placeLiveOptionsExit(): selling to
 *  close prices BELOW the mark to guarantee a fill. Every autotrade options
 *  position is opened LONG (single_leg or debit_spread alike — "an autotrade
 *  options position is always long the contract, a put for a bearish read
 *  instead of a call, which is already defined-risk"), so closing is always
 *  a sell; unlike closeLivePosition's equity/single-leg-option intent
 *  builder, there's no buy-to-close case to branch on here. */
async function buildLiveOptionsCloseIntent(pos: LiveOptionsPosition): Promise<OrderIntent> {
  const buffer = 1 - OPTIONS_MARKETABLE_LIMIT_BUFFER_PCT / 100;

  if (pos.kind === 'debit_spread') {
    const [longMark, shortMark] = await Promise.all([
      fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side),
      fetchContractMark(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
    ]);
    const netValue = longMark - shortMark;
    const limitPrice = round2(netValue * buffer);
    // A crossed/stale spread quote, or a net value the sell-side buffer
    // rounds to <= 0, would otherwise reach the limit_price>0 guardrail and
    // get blocked with no useful explanation — mirrors placeLiveOptionsExit's
    // own premium guard, with a precise reason surfaced to the human instead.
    if (!validPremium(limitPrice)) {
      throw new Error(`No usable exit quote (net ${netValue}: long ${longMark}, short ${shortMark})`);
    }
    return {
      symbol: pos.symbol,
      assetKind: 'option',
      side: 'sell', // selling the spread to close — net credit
      openClose: 'close',
      quantity: pos.quantity,
      orderType: 'limit',
      limitPrice,
      referencePrice: netValue,
      optionStrategy: 'VERTICAL',
      optionLegs: [
        { side: 'sell', optionType: pos.side, strike: pos.strike, expiration: pos.expiration }, // was bought — now sold
        { side: 'buy', optionType: pos.side, strike: pos.shortStrike!, expiration: pos.expiration }, // was sold — now bought back
      ],
    };
  }

  const mark = await fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side);
  const limitPrice = round2(mark * buffer);
  if (!validPremium(limitPrice)) {
    throw new Error(`No usable exit quote (mark ${mark})`);
  }
  return {
    symbol: pos.symbol,
    assetKind: 'option',
    side: 'sell',
    openClose: 'close',
    quantity: pos.quantity,
    orderType: 'limit',
    limitPrice,
    referencePrice: mark,
    optionType: pos.side,
    strike: pos.strike,
    expiration: pos.expiration,
  };
}

/**
 * Close `pos` (a live options position autotrade opened) for real. No
 * bracket-cancel step (see module comment). `placeOrder()`'s own instrument-
 * scoped webullAccountState() lookup already correctly isolates a single-leg
 * close's naked_short check to this exact contract (strike/expiration/
 * optionType, not a cross-instrument aggregate — see providers/webull/
 * accountState.ts's matchesInstrument()); a debit spread skips that check
 * entirely as a multi-leg order (guardrails.ts's isMultiLeg), so neither case
 * needs an override the way liveOptionsExecute.ts's own autonomous exit path
 * does for its unfiltered 2-arg webullAccountState() call.
 */
export async function closeLiveOptionsAutotradePosition(
  pos: LiveOptionsPosition,
  accountId: string,
  confirmation: string,
): Promise<ClosePositionResult> {
  const expectedPhrase = `SELL ${pos.quantity} ${pos.symbol.toUpperCase()}`;
  if (confirmation.trim().toUpperCase() !== expectedPhrase) {
    return { ok: true, placed: false, reason: 'not_confirmed', error: 'Confirmation phrase did not match the order.' };
  }

  let intent: OrderIntent;
  try {
    intent = await buildLiveOptionsCloseIntent(pos);
  } catch (err) {
    return { ok: true, placed: false, reason: 'account_error', error: (err as Error).message };
  }

  const result = await placeOrder(intent, accountId, confirmation);

  // Unlike closeLivePosition's equity case, this always registers,
  // unconditionally: every row in autotrade_live_options_positions is
  // autotrade's own by construction (a human's own options trades go
  // through the generic `positions` table instead — see that table's header
  // comment), so there's no "is this actually autotrade's" branch to take.
  // Closes the same race against checkLiveOptionsExits' own time-exit
  // trigger that closeLivePosition's equity registration closes for
  // checkLiveEquityTimeExits, and lets materializeOptionsExitFill record the
  // eventual fill against the RIGHT exitReason ('manual', not 'time_exit').
  if (result.placed && result.intent) {
    recordLiveOptionsExitOrder({
      intentId: result.intent.id,
      symbol: pos.symbol,
      kind: pos.kind,
      riskProfile: pos.riskProfile,
      positionId: pos.id,
      exitReason: 'manual',
    });
  }

  return result;
}

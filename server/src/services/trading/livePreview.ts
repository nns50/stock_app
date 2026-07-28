import {
  AccountState,
  GuardrailReport,
  OrderIntent,
  evaluateGuardrails,
  orderNotionalUsd,
  wouldOpenShort,
} from './guardrails';
import { marketOpenContext } from './marketHours';
import { getTradingConfig } from '../../db/trading';
import { countTodaysOrders } from '../../db/orders';
import { webullAccountState, webullAccountType } from '../../providers/webull/accountState';
import { WebullPreview, webullPreviewOrder } from '../../providers/webull/orders';

// ---------------------------------------------------------------------------
// Live pre-submit check (design §6, the gate before Place). Pull the REAL
// account state, run the guardrails against it, and — ONLY if they pass — fetch
// the broker's cost estimate. PLACES NOTHING. Stocks and single-leg options.
//
// This is dry-run with teeth: real buying power instead of typed numbers, plus
// the broker's own estimate. It's the step a human reviews before confirming a
// live order — and, for options, the step that validates our request leg shape
// (the broker rejects a malformed leg here, before any placement).
// ---------------------------------------------------------------------------

export interface LivePreviewResult {
  ok: boolean;
  accountId: string;
  accountState?: AccountState;
  guardrails?: GuardrailReport;
  notional?: number | null;
  /** True iff guardrails passed — the broker estimate is only fetched then. */
  wouldSubmit?: boolean;
  /** Broker cost estimate (only present when guardrails pass). */
  preview?: WebullPreview;
  error?: string;
}

export async function livePreview(intent: OrderIntent, accountId: string): Promise<LivePreviewResult> {
  // Same instrument-scoped lookup placeOrder uses, so the preview's
  // naked_short / position_size checks count the SAME quantity the place step
  // will: without it, this read the per-underlying aggregate, and a long STOCK
  // position made a short-option preview read "would submit" for an order the
  // (correctly scoped) place then blocks.
  const acct = await webullAccountState(accountId, intent.symbol, {
    assetKind: intent.assetKind,
    strike: intent.strike,
    expiration: intent.expiration,
    optionType: intent.optionType,
  });
  if (!acct.ok || !acct.state) {
    return { ok: false, accountId, error: acct.error ?? 'Could not load live account state.' };
  }
  // Mirror placeOrder's fail-closed posture: a fabricated 0 would under-count
  // a real holding, so the preview would render pass/fail verdicts the place
  // step is guaranteed to contradict.
  if (acct.positionsUnavailable) {
    return {
      ok: false,
      accountId,
      error:
        'Could not verify current positions with the broker — preview withheld rather than evaluated against an unknown position.',
    };
  }
  // Account type gates spreads (margin only) — fetch it only for a spread.
  const accountType =
    intent.optionStrategy === 'VERTICAL' || intent.optionStrategy === 'IRON_CONDOR'
      ? await webullAccountType(accountId)
      : undefined;
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders(), accountType };

  const config = getTradingConfig();
  const guardrails = evaluateGuardrails(intent, accountState, config, { marketOpen: marketOpenContext(intent) });

  // The broker COST ESTIMATE is informational and PLACES NOTHING, so fetch it
  // for any structurally-valid order unless the kill switch is engaged. It does
  // NOT require trading to be enabled or the risk caps / buying power to pass —
  // those gate PLACING, not estimating. (So a blocked order still shows the
  // broker's take alongside the block.)
  const malformed = guardrails.checks.some(
    (c) => (c.rule === 'quantity' || c.rule === 'limit_price' || c.rule === 'stop_price') && !c.passed,
  );
  // Same SHORT-vs-SELL side the actual place would submit (see placeOrder.ts),
  // so the broker estimate reflects the real order shape.
  const isShort = wouldOpenShort(intent, accountState);
  const preview = !config.killSwitch && !malformed ? await webullPreviewOrder(accountId, intent, isShort) : undefined;

  return {
    ok: true,
    accountId,
    accountState,
    guardrails,
    notional: orderNotionalUsd(intent) ?? null,
    wouldSubmit: guardrails.ok,
    preview,
  };
}

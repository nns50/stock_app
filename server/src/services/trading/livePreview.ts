import { AccountState, GuardrailReport, OrderIntent, evaluateGuardrails, orderNotionalUsd } from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { countTodaysOrders } from '../../db/orders';
import { webullAccountState } from '../../providers/webull/accountState';
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
  const acct = await webullAccountState(accountId, intent.symbol);
  if (!acct.ok || !acct.state) {
    return { ok: false, accountId, error: acct.error ?? 'Could not load live account state.' };
  }
  const accountState: AccountState = { ...acct.state, ordersToday: countTodaysOrders() };

  const config = getTradingConfig();
  const guardrails = evaluateGuardrails(intent, accountState, config);

  // The broker COST ESTIMATE is informational and PLACES NOTHING, so fetch it
  // for any structurally-valid order unless the kill switch is engaged. It does
  // NOT require trading to be enabled or the risk caps / buying power to pass —
  // those gate PLACING, not estimating. (So a blocked order still shows the
  // broker's take alongside the block.)
  const malformed = guardrails.checks.some((c) => (c.rule === 'quantity' || c.rule === 'limit_price') && !c.passed);
  const preview = !config.killSwitch && !malformed ? await webullPreviewOrder(accountId, intent) : undefined;

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

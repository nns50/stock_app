import { AccountState, GuardrailReport, OrderIntent, evaluateGuardrails, orderNotionalUsd } from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { webullAccountState } from '../../providers/webull/accountState';
import { WebullPreview, webullPreviewStockOrder } from '../../providers/webull/orders';

// ---------------------------------------------------------------------------
// Live pre-submit check (design §6, the gate before Place). Pull the REAL
// account state, run the guardrails against it, and — ONLY if they pass — fetch
// the broker's cost estimate. PLACES NOTHING. Stock only for now.
//
// This is dry-run with teeth: real buying power instead of typed numbers, plus
// the broker's own estimate. It's the step a human reviews before confirming a
// live order (the Place step is a later, separately-reviewed slice).
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
  if (intent.assetKind !== 'stock') {
    return { ok: false, accountId, error: 'Live preview currently supports stocks; options preview is coming next.' };
  }

  const acct = await webullAccountState(accountId, intent.symbol);
  if (!acct.ok || !acct.state) {
    return { ok: false, accountId, error: acct.error ?? 'Could not load live account state.' };
  }

  const config = getTradingConfig();
  const guardrails = evaluateGuardrails(intent, acct.state, config);

  // The broker COST ESTIMATE is informational and PLACES NOTHING, so fetch it
  // for any structurally-valid order unless the kill switch is engaged. It does
  // NOT require trading to be enabled or the risk caps / buying power to pass —
  // those gate PLACING, not estimating. (So a blocked order still shows the
  // broker's take alongside the block.)
  const malformed = guardrails.checks.some((c) => (c.rule === 'quantity' || c.rule === 'limit_price') && !c.passed);
  const preview = !config.killSwitch && !malformed ? await webullPreviewStockOrder(accountId, intent) : undefined;

  return {
    ok: true,
    accountId,
    accountState: acct.state,
    guardrails,
    notional: orderNotionalUsd(intent) ?? null,
    wouldSubmit: guardrails.ok,
    preview,
  };
}

import {
  AccountState,
  GuardrailReport,
  OrderIntent,
  blockingFailures,
  evaluateGuardrails,
  orderNotionalUsd,
} from './guardrails';
import { getTradingConfig } from '../../db/trading';
import { OrderIntentRecord, createIntent, getIntent, transitionIntent } from '../../db/orders';

// ---------------------------------------------------------------------------
// Dry-run order pipeline (design §6, Phase 2). Runs the FULL pre-submit path —
// persist the intent, evaluate the guardrails against the persisted config, and
// record the outcome to the audit trail — but STOPS before submission. A clean
// order lands at `validated` ("would submit X"); a blocked one at `rejected`
// with the failing rules. It never calls a broker; it's the skeleton the live
// pipeline will extend with the human-confirm + submit steps.
// ---------------------------------------------------------------------------

export interface DryRunResult {
  intent: OrderIntentRecord;
  guardrails: GuardrailReport;
  /** True iff guardrails passed — what the live path would submit after a human confirm. */
  wouldSubmit: boolean;
  notional: number | null;
  summary: string;
}

function describe(input: OrderIntent, notional: number | null): string {
  const price = input.orderType === 'limit' ? `limit ${input.limitPrice}` : 'market';
  const opt =
    input.assetKind === 'option'
      ? ` ${input.optionType ?? ''} ${input.strike ?? ''} ${input.expiration ?? ''}`.replace(/\s+/g, ' ').trimEnd()
      : '';
  const n = notional !== null ? ` ($${notional.toLocaleString('en-US')})` : '';
  return `${input.side.toUpperCase()} ${input.quantity} ${input.symbol.toUpperCase()}${opt} ${price}${n}`.trim();
}

/**
 * Validate-and-audit an order without submitting it. Idempotent on the client
 * key (a repeat call returns the same intent and doesn't re-transition). Never
 * places an order.
 */
export function dryRunOrder(input: OrderIntent, account: AccountState, idempotencyKey: string): DryRunResult {
  const config = getTradingConfig();
  const report = evaluateGuardrails(input, account, config);
  const notional = orderNotionalUsd(input) ?? null;

  const intent = createIntent(input, idempotencyKey);
  // Only advance a fresh draft; idempotent repeat calls leave the state as-is.
  if (intent.state === 'draft') {
    if (report.ok) {
      transitionIntent(intent.id, 'validated', { detail: `dry-run: would submit ${describe(input, notional)}` });
    } else {
      const reasons = blockingFailures(report)
        .map((c) => `${c.rule}: ${c.detail}`)
        .join('; ');
      transitionIntent(intent.id, 'rejected', { detail: `dry-run blocked: ${reasons}` });
    }
  }

  const blocked = blockingFailures(report).length;
  return {
    intent: getIntent(intent.id)!,
    guardrails: report,
    wouldSubmit: report.ok,
    notional,
    summary: report.ok
      ? `DRY RUN — would submit ${describe(input, notional)}`
      : `DRY RUN — blocked (${blocked} rule${blocked === 1 ? '' : 's'})`,
  };
}

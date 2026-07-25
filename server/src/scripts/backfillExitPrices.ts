import { initDb, db } from '../db';
import { correctExitPrice } from '../db/positions';
import { getIntent } from '../db/orders';
import { getAutotradeConfig } from '../db/autotradeConfig';
import { webullConfigured } from '../providers/webull/account';
import { WebullOrderStatus, webullOrderStatusBatch } from '../providers/webull/orders';
import {
  BackfillSummary,
  ExitCorrection,
  RecordedExit,
  correctionNote,
  decideExitCorrection,
} from '../services/exitPriceBackfill';

// ---------------------------------------------------------------------------
// CLI: `npm run backfill:exits` — replace estimated exit prices with the fills
// the broker actually reported. DRY RUN unless --apply is passed.
//
// Why these rows are wrong in the first place, and why it matters beyond
// tidiness, is in services/exitPriceBackfill.ts's header. The short version: a
// bracket's exit was invisible to the order path until the response shape was
// confirmed, so the position sync closed these at a QUOTE rather than a fill,
// and expectancy-weighted sizing reads exactly these numbers to size the next
// trade in each grade.
//
// Read-only toward the broker — it only pulls order status. The only write it
// ever makes is an exit row's price, and only with --apply.
//
// This is a one-shot repair with an expiry date, not a maintenance tool: the
// Trading API's order/history covers the past 7 days, so a row whose ENTRY
// order is older than that can never be corrected from the broker no matter how
// often this is re-run. Rows that report the 7-day skip below are final.
//
// Usage:
//   npm run backfill:exits                      # dry run: report, change nothing
//   npm run backfill:exits -- --apply           # write the corrections
//   npm run backfill:exits -- --account-id <id> # override the account to query
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface CandidateRow extends RecordedExit {
  sourceIntentId: number;
  positionAccountId: string | null;
}

/**
 * Exits the position sync recorded at an estimated price, for positions whose
 * ENTRY order we still know — that entry's client_order_id is what makes the
 * broker's combo (and so the real exit fill) reachable at all.
 *
 * Deliberately not filtered to bracketed entries: whether a combo actually has
 * a filled exit leg is decided from the broker's own response, not inferred
 * from our record, so a non-bracket simply reports "no filled exit leg" and is
 * skipped rather than being excluded by a guess up front.
 */
function candidates(): CandidateRow[] {
  return db
    .prepare(
      `SELECT e.id AS exitId, e.position_id AS positionId, p.symbol, e.quantity,
              e.exit_price AS exitPrice, e.exit_date AS exitDate,
              p.source_intent_id AS sourceIntentId, p.account_id AS positionAccountId
         FROM position_exits e
         JOIN positions p ON p.id = e.position_id
        WHERE e.notes LIKE 'Auto-closed via Webull sync%'
          AND p.source_intent_id IS NOT NULL
        ORDER BY e.exit_date ASC, e.id ASC`,
    )
    .all() as CandidateRow[];
}

function fmt(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

async function main(): Promise<void> {
  initDb();
  if (!webullConfigured()) {
    console.error('Webull is not configured — set WEBULL_APP_KEY and WEBULL_APP_SECRET.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const fallbackAccount = arg('account-id') || getAutotradeConfig().liveAccountId;

  const rows = candidates();
  console.log(
    `\n${rows.length} sync-closed exit(s) with a known entry order.` +
      `${apply ? '' : '  DRY RUN — nothing will be written.'}\n`,
  );
  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const summary: BackfillSummary = { examined: 0, corrected: 0, skipped: 0, netPnlDelta: 0 };
  const skips: string[] = [];

  // Resolve every candidate's entry order up front, then ask the broker ONCE
  // per account rather than once per row. The order-query endpoints allow 2
  // requests per 2 seconds and a per-row lookup spends two of them, so the
  // original shape ran itself into a 429 partway down the list.
  interface Resolved {
    row: CandidateRow;
    accountId: string;
    clientOrderId: string;
  }
  const resolved: Resolved[] = [];
  for (const row of rows) {
    // The position's OWN account, not whatever is configured now: these are
    // historical rows and the live account setting may have changed since.
    const accountId = row.positionAccountId ?? fallbackAccount;
    if (!accountId) {
      summary.examined++;
      summary.skipped++;
      skips.push(`  ${row.symbol} ${row.exitDate}: no account recorded and none configured`);
      continue;
    }
    const intent = getIntent(row.sourceIntentId);
    if (!intent) {
      summary.examined++;
      summary.skipped++;
      skips.push(`  ${row.symbol} ${row.exitDate}: entry intent ${row.sourceIntentId} is gone`);
      continue;
    }
    resolved.push({ row, accountId, clientOrderId: intent.idempotencyKey });
  }

  const byAccount = new Map<string, string[]>();
  for (const r of resolved) {
    const ids = byAccount.get(r.accountId) ?? [];
    ids.push(r.clientOrderId);
    byAccount.set(r.accountId, ids);
  }
  const statuses = new Map<string, Map<string, WebullOrderStatus>>();
  for (const [accountId, ids] of byAccount) {
    statuses.set(accountId, await webullOrderStatusBatch(accountId, ids));
  }

  for (const { row, accountId, clientOrderId } of resolved) {
    summary.examined++;
    const broker = statuses.get(accountId)?.get(clientOrderId);
    let decision: ExitCorrection;
    if (!broker) {
      decision = { action: 'skip', reason: 'no status returned for this order' };
    } else if (!broker.ok) {
      decision = { action: 'skip', reason: `broker lookup failed: ${broker.error}` };
    } else if (!broker.found) {
      // Not "deleted" — Webull's Trading API order/history covers the past 7
      // days only, so an entry order older than that is gone for good and this
      // row can never be corrected from the broker. Nothing to retry.
      decision = { action: 'skip', reason: 'entry order predates the broker’s 7-day history window' };
    } else {
      decision = decideExitCorrection(row, broker.legs ?? []);
    }

    if (decision.action === 'skip') {
      summary.skipped++;
      skips.push(`  ${row.symbol} ${row.exitDate}: ${decision.reason}`);
      continue;
    }

    summary.corrected++;
    summary.netPnlDelta += decision.pnlDelta;
    console.log(
      `  ${row.symbol.padEnd(6)} ${row.exitDate}  ${String(row.quantity).padStart(5)} @ ` +
        `${row.exitPrice} → ${decision.realPrice}   P&L ${fmt(decision.pnlDelta)}`,
    );

    if (apply) correctExitPrice(row.exitId, decision.realPrice, correctionNote(row.exitPrice));
  }

  if (skips.length) {
    console.log(`\nSkipped ${skips.length} — left exactly as they were:`);
    for (const s of skips) console.log(s);
  }

  console.log(
    `\n${summary.examined} examined · ${summary.corrected} correctable · ${summary.skipped} skipped` +
      `\nNet realized P&L change: ${fmt(summary.netPnlDelta)}`,
  );
  console.log(
    apply
      ? '\nApplied. Re-run to confirm everything now reports "already matches the broker fill".'
      : '\nDRY RUN — nothing written. Re-run with --apply to write these corrections.',
  );
}

void main();

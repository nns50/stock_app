import { writeFileSync } from 'node:fs';
import { webullConfigured, webullProbe } from '../providers/webull/account';
import { webullOrderStatus } from '../providers/webull/orders';
import { sleep } from '../util/http';
import {
  CaptureMode,
  FillSample,
  classifyFillSemantics,
  pnlLikeFields,
  redact,
  summarizeOrders,
} from '../services/brokerCapture';

// ---------------------------------------------------------------------------
// CLI: `npm run capture:broker` — dumps the RAW Webull payloads behind two
// field-semantics questions the app currently guesses at, so the fixes for them
// are built on confirmed responses rather than a plausible reading of a field
// name. Same "confirmed payloads, not guesses" discipline as the existing probe
// UI (providers/webull/account.ts) — this is that probe, aimed at two specific
// questions and shaped into something safe to share.
//
// STRICTLY READ-ONLY. Every call is a GET routed through webullProbe()'s
// whitelist (balance / positions / open-orders / order-history) or the
// read-only webullOrderStatus(). It places nothing, cancels nothing, and writes
// nothing back to the broker or to the app's own database.
//
//   Q1 — does `total_day_profit_loss` include UNREALIZED P&L? accountState.ts
//        maps it to AccountState.realizedPnlTodayUsd, which guardrails.ts
//        documents as "Today's realized P&L" and halts the trading day on. If
//        the broker's number is actually total, the halt trips on paper
//        drawdown that was never lost, AND an unrealized gain can mask a real
//        realized loss so it never trips.
//
//   Q2 — is `filled_quantity` CUMULATIVE across executions? reconcile.ts only
//        materializes a Position at terminal `filled`, so a partial fill that
//        is then cancelled leaves real shares held with no position row. The
//        fix materializes the delta per observation, which needs a cumulative
//        field. A snapshot can't answer this — `--watch` polls one order over
//        time and reports whether the value ever decreases.
//
// Usage:
//   npm run capture:broker
//   npm run capture:broker -- --shapes-only            # field names/types only
//   npm run capture:broker -- --watch <client_order_id> [--watch-seconds 180]
//   npm run capture:broker -- --account-id <id> --out capture.json
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Pull the first account_id out of whatever envelope the account list uses. */
function firstAccountId(payload: unknown): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown, depth: number): void => {
    if (found || depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((i) => walk(i, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^account_?id$/i.test(k) && (typeof val === 'string' || typeof val === 'number')) {
        found = String(val);
        return;
      }
      walk(val, depth + 1);
    }
  };
  walk(payload, 0);
  return found;
}

async function resolveAccountId(): Promise<string | undefined> {
  const explicit = arg('account-id') || process.env.WEBULL_ACCOUNT_ID;
  if (explicit) return explicit;
  const list = await webullProbe('account-list');
  return list.ok ? firstAccountId(list.data) : undefined;
}

/** Poll ONE order's status and record the filled-quantity series. Read-only. */
async function watchOrder(
  accountId: string,
  clientOrderId: string,
  seconds: number,
  intervalMs = 3000,
): Promise<{ samples: FillSample[]; verdict: ReturnType<typeof classifyFillSemantics> }> {
  const samples: FillSample[] = [];
  const deadline = Date.now() + seconds * 1000;
  let polls = 0;

  console.log(`\nWatching ${clientOrderId} for ${seconds}s (read-only status polls every ${intervalMs}ms)…`);
  while (Date.now() < deadline) {
    const r = await webullOrderStatus(accountId, clientOrderId);
    polls++;
    const sample: FillSample = { status: r.status, filledQty: r.filledQty, totalQty: r.totalQty };
    const prev = samples[samples.length - 1];
    samples.push(sample);

    if (!r.ok) console.log(`  [${polls}] error: ${r.error}`);
    else if (!prev || prev.status !== sample.status || prev.filledQty !== sample.filledQty) {
      console.log(
        `  [${polls}] status=${sample.status ?? '—'} filled=${sample.filledQty ?? '—'}/${sample.totalQty ?? '—'}`,
      );
    }

    if (r.ok && r.status && /^(FILLED|CANCELLED|CANCELED|REJECTED|FAILED|EXPIRED)$/.test(r.status)) {
      console.log(`  reached terminal status ${r.status} — stopping early.`);
      break;
    }
    await sleep(intervalMs);
  }

  return { samples, verdict: classifyFillSemantics(samples) };
}

async function main(): Promise<void> {
  if (!webullConfigured()) {
    console.error('Webull is not configured — set WEBULL_APP_KEY and WEBULL_APP_SECRET in server/.env.');
    process.exit(1);
  }

  const mode: CaptureMode = process.argv.includes('--shapes-only') ? 'shapes-only' : 'values';
  const out = arg('out') || 'broker-capture.json';
  const watch = arg('watch');

  const accountId = await resolveAccountId();
  if (!accountId) {
    console.error('Could not resolve an account_id. Pass --account-id <id> (see Settings → Webull probe).');
    process.exit(1);
  }
  console.log(`Account resolved (id withheld from the output file). Mode: ${mode}.`);

  const [balance, positions, openOrders, history] = await Promise.all([
    webullProbe('balance', { accountId }),
    webullProbe('positions', { accountId }),
    webullProbe('open-orders', { accountId }),
    webullProbe('order-history', { accountId }),
  ]);

  for (const [label, r] of [
    ['balance', balance],
    ['positions', positions],
    ['open-orders', openOrders],
    ['order-history', history],
  ] as const) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${label}${r.ok ? '' : `  — ${r.error ?? `status ${r.status}`}`}`);
  }

  // ---- Q1 ----
  const pnlFields = pnlLikeFields(balance.data);
  console.log('\nQ1 — P&L-like fields on the balance payload:');
  if (!pnlFields.length) console.log('  (none matched — inspect the raw payload in the output file)');
  for (const f of pnlFields) {
    const ours = /total_day_profit_loss$/.test(f.field);
    const shown = mode === 'shapes-only' ? '<hidden>' : String(f.value);
    console.log(`  ${ours ? '→' : ' '} ${f.field} = ${shown}${ours ? '   ← mapped to realizedPnlTodayUsd' : ''}`);
  }

  // ---- Q2 ----
  const allOrders = [...summarizeOrders(openOrders.data), ...summarizeOrders(history.data)];
  const partials = allOrders.filter((o) => o.isPartial);
  console.log(`\nQ2 — ${allOrders.length} order row(s) seen, ${partials.length} partial:`);
  for (const p of partials.slice(0, 10)) {
    console.log(`  ${p.clientOrderId ?? '—'}  status=${p.status}  filled=${p.filledQty}/${p.totalQty}`);
  }
  if (!partials.length) {
    console.log('  none — a snapshot alone cannot settle cumulative-vs-per-execution.');
    console.log('  Re-run with --watch <client_order_id> while an order is actively filling.');
  }

  const watched = watch ? await watchOrder(accountId, watch, Number(arg('watch-seconds') ?? 120)) : undefined;

  const artifact = {
    note: 'Read-only Webull field capture. Account identifiers redacted. Generated by npm run capture:broker.',
    mode,
    questions: {
      q1_dailyPnlSemantics: {
        appReads: 'bal.total_day_profit_loss → AccountState.realizedPnlTodayUsd (providers/webull/accountState.ts)',
        treatedAs: 'realized-only, per the AccountState docs + the daily_loss_halt rule in guardrails.ts',
        pnlLikeFields: mode === 'shapes-only' ? pnlFields.map((f) => f.field) : pnlFields,
        howToAnswer:
          "Compare total_day_profit_loss against your own realized total for today (closed trades only). If it moves with an OPEN position's mark, it includes unrealized and the halt is mis-specified.",
      },
      q2_filledQuantitySemantics: {
        appAssumes: 'cumulative across executions (required by the delta-materialization fix in reconcile.ts)',
        ordersSeen: allOrders.length,
        partialsSeen: partials,
        watch: watched
          ? { samples: watched.samples, verdict: watched.verdict }
          : 'not run — pass --watch <client_order_id>',
      },
    },
    raw: {
      balance: redact(balance.data, mode),
      positions: redact(positions.data, mode),
      openOrders: redact(openOrders.data, mode),
      orderHistory: redact(history.data, mode),
    },
  };

  writeFileSync(out, JSON.stringify(artifact, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(
    mode === 'values'
      ? 'NOTE: contains real balances and positions (identifiers redacted). Review before sharing, or re-run with --shapes-only.'
      : 'Values withheld (--shapes-only): field names and types only.',
  );
  if (watched) console.log(`\nQ2 verdict [${watched.verdict.semantics}]: ${watched.verdict.detail}`);
}

void main();

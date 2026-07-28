import { writeFileSync } from 'node:fs';
import { webullConfigured, webullProbe } from '../providers/webull/account';
import { webullOrderStatus } from '../providers/webull/orders';
import { sleep } from '../util/http';
import {
  BalanceSample,
  CaptureMode,
  FillSample,
  classifyDayPnlSemantics,
  classifyFillSemantics,
  pnlLikeFields,
  classifyComboLegSemantics,
  collectComboEvidence,
  redact,
  summarizeOrders,
} from '../services/brokerCapture';

// ---------------------------------------------------------------------------
// CLI: `npm run capture:broker` — dumps the RAW Webull payloads behind three
// field-semantics questions the app currently guesses at, so the fixes for them
// are built on confirmed responses rather than a plausible reading of a field
// name. Same "confirmed payloads, not guesses" discipline as the existing probe
// UI (providers/webull/account.ts) — this is that probe, aimed at specific
// questions and shaped into something safe to share.
//
// STRICTLY READ-ONLY. Every call is a GET routed through webullProbe()'s
// whitelist (balance / positions / open-orders / order-history) or the
// read-only webullOrderStatus(). It places nothing, cancels nothing, and writes
// nothing back to the broker or to the app's own database.
//
//   Q1 — does `total_day_profit_loss` include UNREALIZED P&L? ANSWERED
//        2026-07-28 (a live watch: it moved 1:1 with open marks, no orders in
//        between) — it does. accountState.ts now derives realizedPnlTodayUsd
//        as the worse of (day − unrealized) and the app's own exits dated
//        today, so the daily-loss halt no longer consumes the raw figure. The
//        watch stays useful as a regression check on the broker's semantics.
//
//   Q2 — is `filled_quantity` CUMULATIVE across executions? reconcile.ts only
//        materializes a Position at terminal `filled`, so a partial fill that
//        is then cancelled leaves real shares held with no position row. The
//        fix materializes the delta per observation, which needs a cumulative
//        field. A snapshot can't answer this — `--watch` polls one order over
//        time and reports whether the value ever decreases.
//
//   Q3 — is `combo_type` echoed back PER LEG? WebullOrderLeg marks this
//        UNCONFIRMED, and it is load-bearing: it gates the both-legs-FILLED
//        ambiguity detection, and it is why checkLiveBracketProtection has to
//        ask "is any exit-side order resting on this symbol" instead of the
//        precise "is THIS position's stop still there". Unlike Q1/Q2 this is
//        answerable from a plain snapshot — but only once the account has
//        actually placed a BRACKET (a spread's legs carry no MASTER/exit roles
//        and cannot settle it).
//
// Usage:
//   npm run capture:broker
//   npm run capture:broker -- --shapes-only            # field names/types only
//   npm run capture:broker -- --watch-day-pnl          # settles Q1 (see below)
//   npm run capture:broker -- --watch <client_order_id> [--watch-seconds 180]
//   npm run capture:broker -- --account-id <id> --out capture.json
//
// --watch-day-pnl samples the balance repeatedly while you hold an open position
// and place NO orders. Realized P&L is therefore pinned, so anything that moves
// must be mark-to-market — which is what makes the two readings of
// total_day_profit_loss distinguishable without any interpretation on the
// operator's part. It reports includes-unrealized / realized-only /
// inconclusive, and deliberately says inconclusive when the mark never ticked
// (a flat mark yields identical samples that would otherwise LOOK like a clean
// realized-only answer while containing no information at all).
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Every account_id the list endpoint returns, in order. */
function allAccountIds(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((i) => walk(i, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^account_?id$/i.test(k) && (typeof val === 'string' || typeof val === 'number')) {
        const id = String(val);
        if (!found.includes(id)) found.push(id);
      } else {
        walk(val, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return found;
}

/**
 * Which account to probe — and a loud warning when that was a GUESS.
 *
 * Falling back to the first account in the list is fine for a single-account
 * setup and quietly wrong for any other: the app itself trades
 * autotradeConfig.liveAccountId, which is set separately in the UI and need not
 * be the first one the broker happens to list. A capture that silently probed a
 * DIFFERENT account than the app trades reads as "this account has almost no
 * orders" — indistinguishable from a real answer, and pointing at the wrong
 * conclusion. So say when the choice was arbitrary rather than leaving the
 * operator to reconcile a puzzling result later.
 */
async function resolveAccountId(): Promise<string | undefined> {
  const explicit = arg('account-id') || process.env.WEBULL_ACCOUNT_ID;
  if (explicit) return explicit;
  const list = await webullProbe('account-list');
  if (!list.ok) return undefined;
  const ids = allAccountIds(list.data);
  if (ids.length > 1) {
    console.warn(
      `\n⚠  This login has ${ids.length} accounts and none was specified — probing the FIRST one.\n` +
        '   If the app trades a different account, everything below describes the wrong one.\n' +
        '   Check Auto-Trade → live account id, then re-run with --account-id <id>.\n',
    );
  }
  return ids[0];
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

/** Pull one balance snapshot's day/unrealized P&L pair. Read-only. */
async function balanceSample(accountId: string): Promise<BalanceSample & { ok: boolean; error?: string }> {
  const r = await webullProbe('balance', { accountId });
  if (!r.ok) return { ok: false, dayPnl: null, unrealizedPnl: null, error: r.error };
  const fields = pnlLikeFields(r.data);
  const pick = (suffix: string): number | null => {
    const hit = fields.find((f) => f.field.endsWith(suffix));
    const n = typeof hit?.value === 'string' ? Number(hit.value) : typeof hit?.value === 'number' ? hit.value : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return { ok: true, dayPnl: pick('total_day_profit_loss'), unrealizedPnl: pick('total_unrealized_profit_loss') };
}

/** Sample the balance over time to settle whether the day figure tracks marks. */
async function watchDayPnl(
  accountId: string,
  samples: number,
  intervalMs: number,
): Promise<{ samples: BalanceSample[]; verdict: ReturnType<typeof classifyDayPnlSemantics> }> {
  const collected: BalanceSample[] = [];
  console.log(
    `\nSampling balance ${samples}x every ${Math.round(intervalMs / 1000)}s.` +
      ' Hold an open position and place NO orders during this window.',
  );
  for (let i = 0; i < samples; i++) {
    const s = await balanceSample(accountId);
    if (!s.ok) {
      console.log(`  [${i + 1}/${samples}] balance failed: ${s.error}`);
    } else {
      collected.push({ dayPnl: s.dayPnl, unrealizedPnl: s.unrealizedPnl });
      console.log(`  [${i + 1}/${samples}] day=${s.dayPnl ?? '—'}  unrealized=${s.unrealizedPnl ?? '—'}`);
    }
    if (i < samples - 1) await sleep(intervalMs);
  }
  return { samples: collected, verdict: classifyDayPnlSemantics(collected) };
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

  // ---- Q3 ----
  // Answerable straight from the snapshot, unlike Q1/Q2: either a bracket is
  // in the account's order history tagged per leg, or it isn't.
  const open3 = collectComboEvidence(openOrders.data);
  const hist3 = collectComboEvidence(history.data);
  const evidence = {
    groups: [...open3.groups, ...hist3.groups],
    totalOrderRows: open3.totalOrderRows + hist3.totalOrderRows,
  };
  const comboVerdict = classifyComboLegSemantics(evidence);
  console.log(`\nQ3 — ${evidence.groups.length} multi-leg combo(s) across ${evidence.totalOrderRows} order row(s):`);
  for (const e of evidence.groups.slice(0, 10)) {
    const tags = e.legComboTypes.map((t) => t ?? '«untagged»').join(', ');
    console.log(`  ${e.clientOrderId ?? e.comboOrderId ?? '—'}  ${e.shape}  ${e.legCount} legs  combo_type: [${tags}]`);
  }
  if (!evidence.groups.length) {
    console.log(
      evidence.totalOrderRows === 0
        ? '  none — and no order rows at all, so there is nothing here to read yet.'
        : '  none — orders exist, but none is multi-leg under either shape.',
    );
  }

  const watched = watch ? await watchOrder(accountId, watch, Number(arg('watch-seconds') ?? 120)) : undefined;
  const dayPnlWatch = process.argv.includes('--watch-day-pnl')
    ? await watchDayPnl(accountId, Number(arg('samples') ?? 6), Number(arg('every') ?? 20) * 1000)
    : undefined;

  const artifact = {
    note: 'Read-only Webull field capture. Account identifiers redacted. Generated by npm run capture:broker.',
    mode,
    questions: {
      q1_dailyPnlSemantics: {
        appReads:
          'bal.total_day_profit_loss (visibility only) — realizedPnlTodayUsd is now the worse of day−unrealized and own-book exits dated today (providers/webull/accountState.ts + services/trading/realizedToday.ts)',
        treatedAs: 'includes-unrealized (confirmed 2026-07-28); the daily_loss_halt no longer consumes the raw figure',
        pnlLikeFields: mode === 'shapes-only' ? pnlFields.map((f) => f.field) : pnlFields,
        howToAnswer:
          'Run with --watch-day-pnl while holding an open position and placing no orders: if the day figure moves with the mark, it includes unrealized (the confirmed semantics the halt now accounts for).',
        watch: dayPnlWatch
          ? { samples: dayPnlWatch.samples, verdict: dayPnlWatch.verdict }
          : 'not run — pass --watch-day-pnl',
      },
      q3_comboLegSemantics: {
        appAssumes:
          'combo_type MAY be echoed per leg — WebullOrderLeg (providers/webull/orders.ts) marks this UNCONFIRMED, and every bracket-exit branch that filters on it is written to fail closed if it is not.',
        whyItMatters:
          'It gates the both-legs-FILLED ambiguity detection, and it is why checkLiveBracketProtection has to ask "is any exit-side order resting on this symbol" rather than "is THIS position\'s stop still there".',
        evidence,
        verdict: comboVerdict,
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
  if (dayPnlWatch) console.log(`\nQ1 verdict [${dayPnlWatch.verdict.semantics}]: ${dayPnlWatch.verdict.detail}`);
  if (watched) console.log(`\nQ2 verdict [${watched.verdict.semantics}]: ${watched.verdict.detail}`);
  console.log(`\nQ3 verdict [${comboVerdict.semantics}]: ${comboVerdict.detail}`);
}

void main();

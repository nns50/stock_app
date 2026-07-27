// Scripted research sweep over the walk-forward backtest API — `npm run research`.
//
// Runs the PRE-REGISTERED experiment sets from services/autotrading/researchSweep.ts
// (exits geometry, min-signal-score, direction mode, weight presets) against a
// RUNNING server instance, one POST per variant, and ranks every variant by its
// OUT-OF-SAMPLE expectancy. This is a client of the HTTP API on purpose: the
// walk-forward engine, its bar cache, and its significance stats all live
// server-side, and the API accepts far more than the UI exposes.
//
// Usage (server running, e.g. `npm run dev` in another terminal):
//
//   npm run research -- \
//     --symbols AAPL,MSFT,NVDA,AMD,META,AMZN,GOOGL,TSLA,NFLX,SMCI \
//     --from 2024-08-01 --to 2026-07-01 --split 2025-12-01
//
// Options:
//   --symbols  a,b,c        comma-separated (required; the API caps at 50)
//   --from/--to YYYY-MM-DD  backtest window (required; span capped at 1095 days)
//   --split    YYYY-MM-DD   walk-forward split (required; from <= split < to)
//   --experiments list      subset of: exits,minscore,direction,weights (default all)
//   --equity   N            starting equity (default 100000)
//   --risk     NAME         MODERATE | AGGRESSIVE (default MODERATE)
//   --max-concurrent N      max concurrent positions (default 3)
//   --base     URL          server base URL (default http://localhost:3001)
//   --password PW           APP_PASSWORD, when the instance has auth enabled
//   --code     NNNNNN       current TOTP code, when the instance enforces MFA
//   --out      FILE         JSON results path (default research-results.json)
//
// The first run over a new (symbols x window) pays the provider fetches; the
// bar cache makes every later variant pure local compute, so the sweep is
// cheap after variant #1. Results print worst-to-best per experiment and are
// also written as JSON for your own slicing.

import fs from 'node:fs';
import {
  buildExperiments,
  EXPERIMENT_NAMES,
  ExperimentName,
  formatResultRow,
  rankResults,
  SweepResult,
  SweepWindow,
} from '../services/autotrading/researchSweep';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const v = argValue(name);
  if (!v) {
    console.error(`Missing --${name}.\n\n${USAGE}`);
    process.exit(1);
  }
  return v;
}

const USAGE = `npm run research -- --symbols A,B,C --from YYYY-MM-DD --to YYYY-MM-DD --split YYYY-MM-DD
  [--experiments exits,minscore,direction,weights] [--equity 100000] [--risk MODERATE]
  [--max-concurrent 3] [--base http://localhost:3001] [--password APP_PASSWORD] [--code TOTP]
  [--out research-results.json]

Requires a RUNNING server (npm run dev). Symbols cap at 50, window span at 1095 days,
and from <= split < to. See this file's header comment for the full story.`;

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const symbols = requireArg('symbols')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0 || symbols.length > 50) {
    console.error(`--symbols must list 1-50 tickers (got ${symbols.length}); the API caps batches at 50.`);
    process.exit(1);
  }
  const from = requireArg('from');
  const to = requireArg('to');
  const splitDate = requireArg('split');

  const experimentsArg = (argValue('experiments') ?? EXPERIMENT_NAMES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = experimentsArg.filter((e) => !(EXPERIMENT_NAMES as readonly string[]).includes(e));
  if (unknown.length) {
    console.error(`Unknown experiment(s): ${unknown.join(', ')}. Valid: ${EXPERIMENT_NAMES.join(', ')}`);
    process.exit(1);
  }

  const base = argValue('base') ?? 'http://localhost:3001';
  const riskProfile = (argValue('risk') ?? 'MODERATE') as 'MODERATE' | 'AGGRESSIVE';
  const startingEquity = Number(argValue('equity') ?? 100_000);
  const maxConcurrentPositions = Number(argValue('max-concurrent') ?? 3);
  const outPath = argValue('out') ?? 'research-results.json';

  // Cookie auth (sa_session) — only needed when the instance sets APP_PASSWORD.
  // --code carries the current TOTP when the instance enforces MFA; it's a
  // one-shot login at script start, well inside a code's validity window.
  let cookie = '';
  const password = argValue('password');
  if (password) {
    const code = argValue('code');
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(code ? { password, code } : { password }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Login failed (${res.status}): ${text}`);
      if (text.includes('mfa_required')) {
        console.error('This instance enforces MFA — re-run with --code <current 6-digit TOTP>.');
      }
      process.exit(1);
    }
    const setCookie = res.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/sa_session=[^;]+/);
    if (!match) {
      console.error('Login succeeded but no sa_session cookie came back — cannot authenticate the sweep.');
      process.exit(1);
    }
    cookie = match[0];
  }

  const variants = buildExperiments(
    { symbols, from, to, splitDate, riskProfile, startingEquity, maxConcurrentPositions },
    experimentsArg as ExperimentName[],
  );
  console.log(
    `Sweeping ${variants.length} variants over ${symbols.length} symbols, ${from} → ${to} (split ${splitDate}).\n` +
      `First variant warms the bar cache (provider fetches); the rest are local compute.\n`,
  );

  const results: SweepResult[] = [];
  for (const [i, v] of variants.entries()) {
    process.stdout.write(`[${i + 1}/${variants.length}] ${v.experiment} · ${v.label} … `);
    try {
      const res = await fetch(`${base}/api/autotrade/backtest/walk-forward`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(v.body),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        results.push({
          experiment: v.experiment,
          label: v.label,
          outOfSample: null,
          inSample: null,
          error: `HTTP ${res.status}: ${text}`,
        });
        console.log(`HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { inSample: SweepWindow; outOfSample: SweepWindow };
      results.push({
        experiment: v.experiment,
        label: v.label,
        outOfSample: json.outOfSample,
        inSample: json.inSample,
      });
      const oos = json.outOfSample;
      console.log(`OOS expectancy $${oos.stats.expectancy.toFixed(2)}/trade over ${oos.stats.totalTrades} trades`);
    } catch (err) {
      results.push({
        experiment: v.experiment,
        label: v.label,
        outOfSample: null,
        inSample: null,
        error: (err as Error).message,
      });
      console.log(`failed: ${(err as Error).message}`);
    }
  }

  for (const experiment of new Set(results.map((r) => r.experiment))) {
    console.log(`\n=== ${experiment} — ranked by OUT-OF-SAMPLE expectancy ===`);
    for (const row of rankResults(results.filter((r) => r.experiment === experiment))) {
      console.log(formatResultRow(row));
    }
  }

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        base: { symbols, from, to, splitDate, riskProfile, startingEquity, maxConcurrentPositions },
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    `\nWrote ${outPath}.\n` +
      `Discipline notes: judge the OOS column only; 'thin' means fewer than 20 OOS trades — not evidence either way.\n` +
      `These are ${variants.length} looks at the same history with no multiple-comparisons correction: treat a winner\n` +
      `as a hypothesis to CONFIRM (fresh split date, or forward via snapshots/the Edge Report), not a conclusion.\n` +
      `Backtests here model zero slippage/commissions — see docs/STRATEGY_PLAYBOOK.md's backtest-reality section.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

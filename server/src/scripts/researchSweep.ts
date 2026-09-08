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
//   --experiments list      subset of: exits,minscore,direction,weights,rshorizon,ivrv,optexits,mlregime
//                           (default: the five equity sets; `ivrv` and
//                           `optexits` are OPT-IN — they run the OPTIONS
//                           walk-forward, whose first run fetches option
//                           contract references and per-contract bars from
//                           Polygon, far heavier than equity daily bars. Run
//                           them over a HANDFUL of liquid names; they share
//                           one cache, so the second set is cheap. `mlregime`
//                           is OPT-IN too: the ML regime overlay grid — 15
//                           cut × tighten cells on the equity walk-forward
//                           with the overlay replayed from the walk-forward
//                           regime history, then the High-Vol conviction bar
//                           at the winning cell, chosen by the rule in
//                           docs/MARKET_REGIME_MODEL.md §6a, which this
//                           script applies and prints.)
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
import { Agent, fetch as undiciFetch } from 'undici';
import {
  ALL_EXPERIMENT_NAMES,
  allZeroTrades,
  buildExperiments,
  buildOverlayFloorStage,
  EXPERIMENT_NAMES,
  ExperimentName,
  formatDataIssues,
  formatOverlaySelection,
  formatResultRow,
  overlayCellLabel,
  OverlaySelection,
  rankResults,
  selectOverlayCell,
  SweepDataIssues,
  SweepResult,
  SweepVariant,
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
  [--experiments exits,minscore,direction,weights,rshorizon,ivrv,optexits,mlregime] [--equity 100000]
  [--risk MODERATE] [--max-concurrent 3] [--base http://localhost:3001] [--password APP_PASSWORD]
  [--code TOTP] [--out research-results.json]

Requires a RUNNING server (npm run dev). Symbols cap at 50, window span at 1095 days,
and from <= split < to. The default experiment set is the five equity ones; 'ivrv'
(IV/RV cheapness-gate ladder) and 'optexits' (options exit shapes) are opt-in because
they run the options engine, whose first run fetches option contract data from
Polygon — run them over a few liquid names. 'mlregime' (the ML regime overlay grid,
two stages, the written rule applied and printed) is opt-in because it is 18 runs
and needs server/data/regimeHistory.json. See this file's header comment.`;

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

  // Default = the four equity sets. `ivrv` (the options-engine IV/RV ladder)
  // is deliberately opt-in — see the header comment on its data cost.
  const experimentsArg = (argValue('experiments') ?? EXPERIMENT_NAMES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = experimentsArg.filter((e) => !(ALL_EXPERIMENT_NAMES as readonly string[]).includes(e));
  if (unknown.length) {
    console.error(`Unknown experiment(s): ${unknown.join(', ')}. Valid: ${ALL_EXPERIMENT_NAMES.join(', ')}`);
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
  let lastIssuesLine: string | null = null;
  // Node's built-in fetch aborts after ~5 minutes of response silence (undici's
  // default headersTimeout) — an options walk-forward warming its contract/bar
  // cache at provider rate limits legitimately takes longer than that, and the
  // abort left the server grinding on an abandoned request while the next
  // variant piled on. No timeouts: the server always answers eventually.
  const patientDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  /** One POST, one result — pushed onto `results` and echoed to the console.
   *  Shared by the main sweep and the overlay grid's second stage, which
   *  cannot be built until the first stage has answered. */
  const runVariant = async (v: SweepVariant, progress: string): Promise<void> => {
    process.stdout.write(`${progress} ${v.experiment} · ${v.label} … `);
    const startedAt = Date.now();
    const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    try {
      const res = await undiciFetch(`${base}${v.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(v.body),
        dispatcher: patientDispatcher,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        results.push({
          experiment: v.experiment,
          label: v.label,
          cell: v.cell,
          outOfSample: null,
          inSample: null,
          error: `HTTP ${res.status}: ${text}`,
        });
        console.log(`HTTP ${res.status} (${elapsed()}): ${text.slice(0, 160)}`);
        return;
      }
      const json = (await res.json()) as {
        inSample: SweepWindow;
        outOfSample: SweepWindow;
        excludedSymbols?: SweepDataIssues['excludedSymbols'];
        errors?: SweepDataIssues['errors'];
      };
      const dataIssues: SweepDataIssues = {
        excludedSymbols: json.excludedSymbols ?? [],
        errors: json.errors ?? [],
      };
      results.push({
        experiment: v.experiment,
        label: v.label,
        cell: v.cell,
        outOfSample: json.outOfSample,
        inSample: json.inSample,
        dataIssues,
      });
      const oos = json.outOfSample;
      console.log(
        `OOS expectancy $${oos.stats.expectancy.toFixed(2)}/trade over ${oos.stats.totalTrades} trades (${elapsed()})`,
      );
      // Data problems the response reports alongside the windows — printed
      // once per distinct set, not once per variant (a sweep's variants all
      // hit the same symbols/window, so the set virtually never changes).
      const issuesLine = formatDataIssues(dataIssues);
      if (issuesLine && issuesLine !== lastIssuesLine) console.log(`    ⚠ ${issuesLine}`);
      lastIssuesLine = issuesLine;
    } catch (err) {
      results.push({
        experiment: v.experiment,
        label: v.label,
        cell: v.cell,
        outOfSample: null,
        inSample: null,
        error: (err as Error).message,
      });
      console.log(`failed after ${elapsed()}: ${(err as Error).message}`);
    }
  };
  for (const [i, v] of variants.entries()) await runVariant(v, `[${i + 1}/${variants.length}]`);

  // The ML regime overlay grid's second stage (2026-09-08): apply the written
  // rule to stage 1, then run the conviction-bar ladder at the cell it chose
  // and apply the same rule again with that cell as the baseline. Both
  // verdicts are printed and written to the results file; the cell that ships
  // ON goes into docs/AUTOTRADING_SPEC.md's decision log before any config
  // changes — this script never writes config.
  let overlaySelection: { stage1: OverlaySelection; stage2: OverlaySelection | null; final: string | null } | null =
    null;
  if (experimentsArg.includes('mlregime')) {
    const sweepBase = { symbols, from, to, splitDate, riskProfile, startingEquity, maxConcurrentPositions };
    const stage1 = selectOverlayCell(
      results.filter((r) => r.experiment === 'mlregime'),
      startingEquity,
      { baseline: { cut: 0, tighten: 0, floor: 0 } },
    );
    console.log(formatOverlaySelection('ML regime overlay, stage 1 — size cut × target tighten', stage1));
    let stage2: OverlaySelection | null = null;
    let finalCell = stage1.chosen;
    if (stage1.chosen) {
      const ladder = buildOverlayFloorStage(sweepBase, stage1.chosen);
      console.log(`\nStage 2 — the High-Vol conviction bar at ${overlayCellLabel(stage1.chosen)}:`);
      for (const [i, v] of ladder.entries()) await runVariant(v, `[${i + 1}/${ladder.length}]`);
      stage2 = selectOverlayCell(
        results.filter((r) => r.experiment === 'mlregime-floor'),
        startingEquity,
        { baseline: { ...stage1.chosen, floor: 0 } },
      );
      console.log(formatOverlaySelection('ML regime overlay, stage 2 — the High-Vol conviction bar', stage2));
      finalCell = stage2.chosen ?? stage1.chosen;
    }
    const final = finalCell ? overlayCellLabel(finalCell) : null;
    overlaySelection = { stage1, stage2, final };
    console.log(
      finalCell
        ? `\nThe cell that ships ON, by the written rule: ${final} → mlRegimeSizeCutPct ${finalCell.cut}, ` +
            `mlRegimeTargetTightenPct ${finalCell.tighten}, mlRegimeHighVolMinSignalScore ${finalCell.floor}. ` +
            `Record it in docs/AUTOTRADING_SPEC.md's decision log before enabling anything.`
        : '\nNo cell beat the baseline by the written rule — the overlay stays OFF.',
    );
  }

  for (const experiment of new Set(results.map((r) => r.experiment))) {
    console.log(`\n=== ${experiment} — ranked by OUT-OF-SAMPLE expectancy ===`);
    for (const row of rankResults(results.filter((r) => r.experiment === experiment))) {
      console.log(formatResultRow(row));
    }
  }

  if (allZeroTrades(results)) {
    console.log(
      '\n⚠ Every variant simulated ZERO trades in BOTH windows. That means the engine never entered a single\n' +
        '  position — almost always a data problem, not "no setup ever qualified" (13 variants spanning minScore 0\n' +
        '  through 75 never all agree on zero). Check any fetch-error/excluded lines above first. If there were\n' +
        '  none: server versions before 2026-07-27 cached Polygon daily bars with midnight-EASTERN timestamps the\n' +
        '  simulator could never match against its midnight-UTC calendar — upgrading the server repairs the cached\n' +
        '  bars automatically at startup; then re-run this sweep.',
    );
  }

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        base: { symbols, from, to, splitDate, riskProfile, startingEquity, maxConcurrentPositions },
        results,
        overlaySelection,
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
  // Keep-alive sockets would otherwise hold the process open after the sweep.
  await patientDispatcher.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

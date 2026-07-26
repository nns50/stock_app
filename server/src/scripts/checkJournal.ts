import { initDb } from '../db';
import { listPositions } from '../db/positions';
import { analyzeJournal, IntegrityFinding } from '../services/journalIntegrity';

// ---------------------------------------------------------------------------
// CLI: `npm run check:journal` — audit the trade journal for rows that are
// already wrong, and print them.
//
// REPORT ONLY. There is no --apply, by design (see services/journalIntegrity.ts
// for the reasoning): several of these have more than one defensible repair,
// and guessing at someone's real trading record is worse than naming the row
// and leaving it alone. Nothing here opens a write path, touches the network,
// or contacts the broker — it reads the local database and prints.
//
// Usage:
//   npm run check:journal              # everything
//   npm run check:journal -- --json    # machine-readable, for diffing over time
// ---------------------------------------------------------------------------

const SEVERITY_LABEL = { high: 'HIGH  ', medium: 'MEDIUM', info: 'INFO  ' } as const;

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

function printFinding(f: IntegrityFinding): void {
  const suffix = f.suggested ? `  → should be ${f.suggested}` : '';
  console.log(`    #${String(f.positionId).padEnd(5)} ${f.symbol.padEnd(6)} ${f.detail}${suffix}`);
}

function main(): void {
  initDb();
  const report = analyzeJournal(listPositions());

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `\nJournal integrity — ${report.positionsExamined} position(s), ${report.exitsExamined} exit(s), ` +
      `as of ${report.marketDate} (ET).\nREPORT ONLY — this command never writes anything.\n`,
  );

  // Gated on there being NOTHING to report, not on `clean` — `clean` now means
  // "nothing to fix", so an info-only run is clean AND has rows to show. Keyed
  // on the flag instead, this shortcut would swallow them entirely.
  if (report.findings.length === 0) {
    // Naming what was checked matters as much as the verdict: "clean" is only
    // meaningful if you can see the list it was clean against.
    console.log('No problems found. Checked:');
    for (const c of report.checks) console.log(`  · ${c.title}`);
    console.log('');
    return;
  }

  const byCheck = new Map<string, IntegrityFinding[]>();
  for (const f of report.findings) {
    const arr = byCheck.get(f.check) ?? [];
    arr.push(f);
    byCheck.set(f.check, arr);
  }

  for (const check of report.checks) {
    const rows = byCheck.get(check.id);
    if (!rows?.length) continue;
    console.log(`  [${SEVERITY_LABEL[check.severity]}] ${check.title} — ${rows.length} row(s)`);
    console.log(wrap(check.why, 92, '    '));
    console.log('');
    for (const f of rows) printFinding(f);
    console.log('');
  }

  const clean = report.checks.filter((c) => c.count === 0);
  if (clean.length) {
    console.log(`  Checked and clean: ${clean.map((c) => c.title).join(' · ')}\n`);
  }

  const count = (s: string) => report.findings.filter((f) => f.severity === s).length;
  console.log(
    report.clean
      ? `Nothing to fix — ${count('info')} informational note(s) above.\n` +
          'Those are correctly-recorded rows that are simply incomplete; act on them or\n' +
          'leave them, but nothing here is wrong.\n'
      : `${count('high') + count('medium')} to fix — ${count('high')} high, ${count('medium')} medium` +
          (count('info') ? `, plus ${count('info')} informational.` : '.') +
          '\nNothing was changed. Fix these from the Positions page (journal · exit · del) or by\n' +
          'correcting the underlying row; re-run to confirm the count drops.\n',
  );
}

main();

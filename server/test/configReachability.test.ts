import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Does anything actually READ this setting? (2026-08-26)
//
// Four separate settings groups in this codebase have shipped as configurable,
// validated, persisted and displayed — while the execution path they described
// never read them:
//
//   - partialExitRMultiple / partialExitPct   paper-only until 2026-08-25 (scaleOut.ts)
//   - maxHoldDays / endOfDayFlattenMinutes    equity-only for options until 2026-08-25 (#428)
//   - breakevenTrigger/trailStart/trailStop   paper-only until 2026-08-26 (#429)
//   - the five options breakeven/trail/partial fields — STILL paper-only (below)
//
// Each was found by hand, by asking of one specific number: what code reads
// this? That is not a thing to keep discovering.
//
// WHY THE EXISTING CHECKS DO NOT CATCH IT. targetTune.ts has a compile-time
// exhaustiveness check requiring every AutotradeConfig key to appear in
// TunablePatch or NEVER_TUNED_KEYS. That proves each key is CLASSIFIED. It
// says nothing about whether any code reads it — a key can be classified,
// accepted by the route, stored, and returned to the UI while no execution
// path has ever heard of it. routes.integration.test.ts's reachability sweep
// closes the neighbouring gap (a field the route silently drops) but stops at
// the database: a value that lands in the config and goes nowhere still passes.
//
// This test is deliberately a source scan rather than a type-level trick,
// because the property it wants — "some execution path reads this identifier" —
// is not expressible in the type system. A grep is crude, and it will count a
// mention in a comment; the failure mode of that is a field wrongly passing,
// never a correct field wrongly failing, so it errs toward silence rather than
// noise. It is still enough to have caught all four cases above.
// ---------------------------------------------------------------------------

const SERVER_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(SERVER_ROOT, 'src');

/** Files that MENTION every config key by nature, and so prove nothing about
 *  use: the module that declares and parses the shape, the route that
 *  transports it, and the tuner that classifies every key for exhaustiveness.
 *  Excluded so that "only these mention it" reads as UNREAD, which is the
 *  whole point. */
const PLUMBING = new Set(
  ['src/db/autotradeConfig.ts', 'src/routes/autotrade.ts', 'src/services/autotrading/targetTune.ts'].map((p) =>
    path.join(SERVER_ROOT, p),
  ),
);

/** The PAPER and BACKTEST execution paths. Everything else under src/ counts
 *  as reachable-by-live, which is the safe direction for this list to rot in:
 *  a new module is treated as live until someone deliberately names it here,
 *  so a genuinely paper-only field cannot hide behind a forgotten entry. */
const PAPER_PATHS = new Set(
  [
    'src/services/autotrading/execute.ts',
    'src/services/autotrading/optionsExecute.ts',
    'src/services/autotrading/backtest.ts',
    'src/services/autotrading/combinedBacktest.ts',
    'src/services/autotrading/optionsBacktest.ts',
    'src/services/autotrading/researchSweep.ts',
  ].map((p) => path.join(SERVER_ROOT, p)),
);

/**
 * Config fields that a paper or backtest path reads and NO live path does.
 *
 * Every entry is a setting that will silently do nothing if a user turns it on
 * for real money. That is sometimes a deliberate scope decision — but it must
 * be a decision someone wrote down, not something discovered months later by
 * grepping. Adding an entry here is the moment to ask whether the field should
 * instead be wired, or removed.
 */
const KNOWN_PAPER_ONLY: Record<string, string> = {
  // The options counterparts of the equity fields wired live in #429. Unlike
  // those, all four triggers here are 0 in production, so nothing is currently
  // being misrepresented — this is latent, not active. It becomes a live lie
  // the moment any of them is set to a non-zero value.
  optionsBreakevenTriggerPct: 'live options exits read only optionsStopLossPct / optionsTakeProfitPct',
  optionsTrailStartPct: 'live options exits read only optionsStopLossPct / optionsTakeProfitPct',
  optionsTrailStopPct: 'live options exits read only optionsStopLossPct / optionsTakeProfitPct',
  optionsPartialExitTriggerPct: 'no live options scale-out exists (equity got one in scaleOut.ts; options did not)',
  optionsPartialExitPct: 'size for optionsPartialExitTriggerPct, which is itself paper-only',
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

function configFieldNames(): string[] {
  const src = fs.readFileSync(path.join(SRC, 'db/autotradeConfig.ts'), 'utf8');
  const iface = /export interface AutotradeConfig \{(.*?)\n\}/s.exec(src);
  if (!iface) throw new Error('could not locate the AutotradeConfig interface');
  // Top-level members only (two-space indent) — nested object literals in a
  // field's type are that field's shape, not separate settings.
  return [...new Set([...iface[1].matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]))].sort();
}

/** Comment lines dropped before scanning. The header above concedes this scan
 *  "will count a mention in a comment", and that concession is load-bearing in
 *  the wrong direction: every field in this codebase is DESCRIBED in prose
 *  somewhere near the code that used to use it, so a field whose last real
 *  reader is deleted keeps passing on the strength of the comment explaining
 *  what it once did. Demonstrated 2026-09-06 — removing liveMinSignalScore's
 *  only read left this test green, because the module header still named it.
 *  Stripping comments can only ever REMOVE false passes; a field genuinely read
 *  by code is unaffected. (A mention in a TYPE — a Pick<AutotradeConfig, ...> —
 *  still counts, and that is the remaining soft spot.) */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

/**
 * PROSE STRINGS blanked too (2026-09-24, on review). A field NAMED inside a
 * message is a sentence about the field, not a read of it: the tune advisor's
 * advice text names `marketDirectionExitBreadthPct`, so deleting the loop's one
 * real read of it left this test green, the comment problem above one layer
 * over. A quoted string that contains whitespace reads as prose and is emptied;
 * one without (a key, an action name) is kept, since code does index by those.
 * A template literal keeps only its `${...}` expressions, which are code.
 *
 * Per FILE, and all-or-nothing: a file whose scan does not end cleanly is
 * left exactly as it was (null here). Run over the whole tree at once, one such
 * file swallowed the start of the next, and a field read there
 * (mlRegimeSwitchThreshold, in mlRegime.ts) read as unread. Trailing comments
 * and regex literals are skipped rather than read as strings. On 2026-09-24
 * two files of 260 still fall back: a non-null assertion before a division
 * (`x! / 100`) reads as a regex, and the exporter's CSV quoting. Like stripping
 * comments, this can only remove false passes.
 */
function proseBlankedOrNull(src: string): string | null {
  let out = '';
  let i = 0;
  // The last character that was code, for telling a regex literal from a
  // division: after one of these, a slash opens a regex.
  let prev = '\n';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      // A comment after code on the same line.
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (c === '/' && '(,=:[!&|?{};+-*%<>~^\n'.includes(prev)) {
      // A regex literal: copied as it is, never read as a string.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j += 1;
      }
      if (src[j] !== '/') return null;
      out += src.slice(i, j + 1);
      prev = '/';
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== c) return null; // unterminated on its line: not a string we understand
      const body = src.slice(i + 1, j);
      out += /\s/.test(body) ? c + c : src.slice(i, j + 1);
      prev = c;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      out += '`';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth > 0) {
            if (src[k] === '{') depth += 1;
            else if (src[k] === '}') depth -= 1;
            k += 1;
          }
          out += src.slice(j, k);
          j = k;
          continue;
        }
        j += 1;
      }
      if (j >= src.length) return null; // an unterminated template
      out += '`';
      prev = '`';
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c) || c === '\n') prev = c;
    i += 1;
  }
  return out;
}

const proseBlanked = (src: string): string => proseBlankedOrNull(src) ?? src;

const files = walk(SRC);
const scanned = (paths: string[]) => paths.map((f) => proseBlanked(codeOnly(fs.readFileSync(f, 'utf8')))).join('\n');
const liveSrc = scanned(files.filter((f) => !PLUMBING.has(f) && !PAPER_PATHS.has(f)));
const paperSrc = scanned([...PAPER_PATHS]);
const fields = configFieldNames();

const readBy = (haystack: string, field: string) => new RegExp(`\\b${field}\\b`).test(haystack);

describe('every autotrade config field is actually read by something', () => {
  it('found the config interface and the source tree', () => {
    // Guards the whole file: a bad path would make every haystack empty, and
    // the assertions below would then fail loudly rather than pass vacuously —
    // but a wrong FIELD list would make them pass with nothing to check.
    expect(fields.length).toBeGreaterThan(100);
    expect(fields).toContain('riskPerTradePct');
    expect(files.length).toBeGreaterThan(50);
    expect(PAPER_PATHS.size).toBeGreaterThan(0);
    for (const f of [...PLUMBING, ...PAPER_PATHS]) expect(fs.existsSync(f)).toBe(true);
  });

  it('no field is defined, stored and displayed while NOTHING consumes it', () => {
    const orphaned = fields.filter((f) => !readBy(liveSrc, f) && !readBy(paperSrc, f));
    expect(orphaned).toEqual([]);
  });

  it('every paper-only field is a WRITTEN-DOWN decision, not a discovery', () => {
    // Exact-set equality, in both directions on purpose:
    //  - a NEW paper-only field fails until someone documents why, which is
    //    the moment to ask whether it should just be wired instead;
    //  - WIRING one up also fails until it is removed from the list, so the
    //    list cannot quietly describe a gap that no longer exists.
    const paperOnly = fields.filter((f) => readBy(paperSrc, f) && !readBy(liveSrc, f)).sort();
    expect(paperOnly).toEqual(Object.keys(KNOWN_PAPER_ONLY).sort());
  });

  it('a field named only in a message does not count as read (2026-09-24)', () => {
    const blanked = proseBlanked(
      "advise('raise marketDirectionExitBreadthPct toward it'); const x = cfg.marketDirectionExitIndexPct;",
    );
    expect(readBy(blanked, 'marketDirectionExitBreadthPct')).toBe(false);
    expect(readBy(blanked, 'marketDirectionExitIndexPct')).toBe(true);
    // A key is kept, since code indexes by those, and so is a template's code.
    expect(readBy(proseBlanked("pick(cfg, 'riskPerTradePct')"), 'riskPerTradePct')).toBe(true);
    expect(readBy(proseBlanked('`${cfg.maxHoldDays} days held`'), 'maxHoldDays')).toBe(true);
    // A trailing comment and a regex are not strings, and do not swallow code.
    expect(readBy(proseBlanked("const a = 1; // it's\nconst b = cfg.maxHoldDays;"), 'maxHoldDays')).toBe(true);
    expect(readBy(proseBlanked('const r = /[\'"]/;\nconst b = cfg.maxHoldDays;'), 'maxHoldDays')).toBe(true);
  });

  it('the scan falls back on no more files than it did when written', () => {
    // A file the scanner cannot read cleanly is scanned unblanked, which lets
    // prose count as a read again. Two did on 2026-09-24; many more would mean
    // the scanner had quietly stopped doing its job.
    const fallbacks = files.filter((f) => proseBlankedOrNull(codeOnly(fs.readFileSync(f, 'utf8'))) === null);
    expect(fallbacks.map((f) => path.relative(SERVER_ROOT, f)).sort()).toEqual([
      'src/services/autotrading/optionsAffordability.ts',
      'src/services/exporter.ts',
    ]);
  });

  it('the settings fixed in August stay fixed', () => {
    // Regression locks on the three groups that shipped inert. Each of these
    // reaching only a paper path again would be a silent revert of a fix made
    // for real-money behaviour.
    for (const field of [
      'partialExitRMultiple', // scaleOut.ts (2026-08-25)
      'partialExitPct',
      'breakevenTriggerRMultiple', // stopAdjust.ts (2026-08-26)
      'trailStartRMultiple',
      'trailStopRMultiple',
      'endOfDayFlattenMinutes', // liveExecute + liveOptionsExecute (2026-08-25/26)
      'maxHoldDays',
      'liveTrailingEnabled',
      'liveScaleOutEnabled',
      // …and the 3%-goal trial's own settings (2026-09-12). The August list
      // above exists because four settings groups shipped inert — configurable,
      // validated, stored and displayed, while the execution path they
      // described never read them. These five are what the trial is BETTING
      // ON, and nothing was locking them: a refactor that left any of them
      // reaching only a paper path would leave the live book running the old
      // exits while every report said otherwise, which is precisely the
      // failure the August entries were added to prevent.
      'targetRMultiple', // decide.ts, liveExecute.ts, perLotBrackets.ts
      'stagnationExitMinutes', // stagnationExit.ts, liveExecute.ts
      'symbolReentryCooldownMinutes', // liveExecute.ts — Decision 8's whole mechanism
      'expectancyMaxMultiplier', // riskCheck.ts, and the options premium ceiling
      'maxStopDistancePct', // the sizer floor every dollar cap is derived from
    ]) {
      expect(readBy(liveSrc, field), `${field} must be read by a live execution path`).toBe(true);
    }
  });
});

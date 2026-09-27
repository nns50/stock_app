import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { BATCH_REFUSAL_ACTIONS, EXECUTION_ACTIONS, SKIP_ACTIONS } from '../src/services/autotrading/edgeLeakScanData';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Every journal action a consumer FILTERS ON must be one some emitter actually
// WRITES.
//
// Found 2026-09-06. riskCheck.ts's portfolio snapshot derived `tradesToday` by
// filtering execution events for `action === 'order_placed'` — an action that
// has never been journaled once. The emitters are named `paper_order_placed`
// and `live_order_placed`; the consumer was never updated when they were.
// Production's own events endpoint says it outright, answering that query with
//   {"events":[],"actionsNeverSeen":["order_placed"]}
// so `tradesToday` was a permanent 0 and `max_trades_per_day` could never fail
// on the two preview endpoints reading that snapshot. Confirmed live:
// POST /api/autotrade/risk-check answered "max_trades_per_day passed=True —
// 0 placed vs 14/day" on demand.
//
// This is configReachability.test.ts's idea one layer over: that file asks
// whether a config field is READ, this one asks whether an event a reader is
// waiting for is ever WRITTEN. A filter on a string nothing emits is invisible
// — no error, no empty-result warning, just a rule that silently always passes.
//
// Deliberately a source scan and not a runtime assertion: the failure is an
// ABSENCE, and an absence has no behaviour to drive. It cannot prove an emitter
// is reachable at runtime, only that one exists to be reached — which is
// exactly the step that was missing.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : name.endsWith('.ts') ? [p] : [];
  });
}

/** Comment lines stripped: the prose around these call sites names actions
 *  while explaining them, and a scan that reads prose measures the prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const ACTION = /'([a-z0-9_]+)'/g;
const files = tsFiles(SRC);

/** A `const` declaration up to its `=`, type annotation included. The
 *  annotation may hold an arrow (`=>`), and nothing else with an `=`. */
const DECLARE = String.raw`const\s+([A-Za-z0-9_]+)\s*(?::(?:[^=]|=>)*?)?=\s*`;

/** The index of the character that closes what opens at `i`: a quote, a
 *  template, or a comment. */
function skipped(src: string, i: number): number {
  if (src.startsWith('//', i)) {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end;
  }
  if (src.startsWith('/*', i)) {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 1;
  }
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === src[i]) return j;
  }
  return src.length;
}

/**
 * Every `const NAME = [...]` with its WHOLE body: brackets balanced, and
 * strings and comments stepped over.
 *
 * Until 2026-09-26 the body was read up to its first `]` and the annotation up
 * to its first `=`. #659 gave EXECUTION_ACTIONS an arrow-typed field
 * (`countsIf?: (detail) => boolean`), and from then on it matched neither: the
 * catalog stopped being a catalog, so its own `action:` entries vouched for
 * themselves as writes again (the failure catalogSpans exists to stop), and
 * its readers filtered on a name that resolved to nothing, so no dead entry
 * could be reported. The guard stayed green throughout.
 */
function arrays(src: string): { name: string; start: number; end: number; body: string }[] {
  const out: { name: string; start: number; end: number; body: string }[] = [];
  for (const m of src.matchAll(new RegExp(`${DECLARE}\\[`, 'g'))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`' || src.startsWith('//', i) || src.startsWith('/*', i)) {
        i = skipped(src, i);
      } else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) break;
    }
    out.push({ name: m[1], start: m.index, end: i + 1, body: src.slice(open + 1, i) });
  }
  return out;
}

/** `const NAME = '...'` / `const NAME = [...]` per file — both call sites reach
 *  for actions through named constants as often as through literals. */
function constants(src: string): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  for (const m of src.matchAll(new RegExp(`${DECLARE}'([a-z0-9_]+)'`, 'g'))) out.set(m[1], m[2]);
  for (const { name, body } of arrays(src)) {
    // An array of OBJECTS keyed by `action:` — EXECUTION_ACTIONS — must yield
    // only its action values. Taking every quoted string pulls in labels,
    // `splitOn` keys and split values, which then read as dead filters: the
    // first run of this rule reported `reason` as an unwritten action.
    const objects = [...body.matchAll(/\baction:\s*'([a-z0-9_]+)'/g)].map((x) => x[1]);
    out.set(name, objects.length ? objects : [...body.matchAll(ACTION)].map((x) => x[1]));
  }
  return out;
}

const constantsByFile = new Map<string, Map<string, string | string[]>>();
const constantsOf = (path: string) => {
  const hit = constantsByFile.get(path);
  if (hit) return hit;
  const found = constants(code(path));
  constantsByFile.set(path, found);
  return found;
};

/**
 * A file's own constants plus the ones it IMPORTS from another module under
 * src/, each under the name the file uses (`import { A as B }` → B).
 *
 * Until 2026-09-26 only a file's own `const` resolved, so an action constant
 * imported from its defining module was invisible to BOTH scans: loop.ts writes
 * `market_direction_read` and `market_tape_read` through imported constants and
 * marketDirectionIndex.ts / marketTapeIndex.ts filter on them the same way, so
 * neither side of either wire was checked. It surfaced as a false dead filter:
 * shockNowcast.ts defines `market_shock_shadow` and filters on it, while its
 * one writer, autotrading/shockShadow.ts, imports it. The resolution follows the
 * file's own import to the module it names, never a name-match across src, so a
 * name reused with another value elsewhere cannot vouch for anything.
 */
function resolvable(file: string, src: string): Map<string, string | string[]> {
  const out = new Map(constants(src));
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'(\.[^']*)'/g)) {
    const base = join(dirname(file), m[2]);
    const target = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
    if (!target) continue;
    for (const part of m[1].split(',')) {
      const [name, alias] = part
        .replace(/^\s*type\s+/, '')
        .trim()
        .split(/\s+as\s+/);
      const local = (alias ?? name).trim();
      const value = constantsOf(target).get(name.trim());
      if (local && value !== undefined && !out.has(local)) out.set(local, value);
    }
  }
  return out;
}

/**
 * Where each CATALOG sits in a file: a `const NAME = [...]` array whose
 * entries are keyed `action:`. A catalog is a list of things to READ, and its
 * entries must never count as writes.
 *
 * They did until 2026-09-23. The EMIT scan below takes every `action: '…'`
 * line as an emitter, and EXECUTION_ACTIONS writes each of its entries exactly
 * that way. So the edge-leak scan's catalog vouched for itself, and three of its
 * entries were names nothing writes: `live_order_unknown_outcome` (the writers
 * say `live_order_outcome_unknown`), `daily_drawdown_halt` (a guardrail rule's
 * name, never journaled) and `give_back_halt` (the writer says
 * `daily_give_back_halted`). An unknown order outcome or a halt could never
 * become a finding. The comment on the emit scan already named this failure,
 * a dead filter "vouching for itself", and guarded two other forms of it.
 */
function catalogSpans(src: string): [number, number][] {
  return arrays(src)
    .filter(({ body }) => /\baction:\s*'/.test(body))
    .map(({ start, end }): [number, number] => [start, end]);
}

/** Writers that take the journal action as a POSITIONAL argument. Both scans
 *  below read this, so a new wrapper is taught once rather than twice. */
const POSITIONAL_SKIP_WRITERS = ['journalEntrySkipOncePerDay', 'journalDeclinedEntry'];

/** Fresh each call: a global regex carries lastIndex between matchAll uses. */
const positionalSkips = () =>
  new RegExp(`(?:${POSITIONAL_SKIP_WRITERS.join('|')})\\(\\s*[^,]+,\\s*'([a-z0-9_]+)'`, 'g');

/** Writers whose FIRST argument is the action, a literal or a constant.
 *  mlRegime.ts journals every regime row this way; it was invisible until the
 *  import resolution below made `ml_regime_changed`'s reader visible
 *  (mlRegimeReadiness.ts imports the constant), which then read as dead. */
const FIRST_ARG_WRITERS = ['journalOncePerDay'];
const firstArgWrites = () =>
  new RegExp(`\\b(?:${FIRST_ARG_WRITERS.join('|')})\\(\\s*(?:'([a-z0-9_]+)'|([A-Z][A-Z0-9_]*))`, 'g');

/** The whole source by default; a test hands it a synthetic file. */
function scan(
  list: readonly string[] = files,
  read: (path: string) => string = code,
): { emitted: Set<string>; consumed: Map<string, Set<string>>; unresolved: string[] } {
  const emitted = new Set<string>();
  const consumed = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const note = (a: string, f: string) => consumed.set(a, (consumed.get(a) ?? new Set()).add(f));
  /** A filter's constant, or a note that it did not resolve: dropped quietly,
   *  it would hide exactly the dead filter this file exists to find. */
  const filterValues = (name: string, consts: Map<string, string | string[]>, f: string): string[] => {
    const v = consts.get(name);
    if (v === undefined) unresolved.push(`${name} (${f.split('/').pop()})`);
    return typeof v === 'string' ? [v] : (v ?? []);
  };

  for (const f of list) {
    const src = read(f);
    const consts = resolvable(f, src);
    const catalogs = catalogSpans(src);

    // EMIT side. Everything to the end of the `action:` line, so a ternary
    // (`action: role === 'exit' ? 'a' : 'b'`) counts BOTH of its branches —
    // liveExecute writes two materialization actions exactly that way, and a
    // literal-only regex reports them as dead when they are not.
    for (const m of src.matchAll(/action:\s*([^\n]*)/g)) {
      const seg = m[1];
      // Two things that look like an emit and are not, both of which would let
      // a dead filter hide from this scan by vouching for itself.
      //   1. A TYPE ANNOTATION (`{ action: string }`) is a shape, not a write.
      //   2. Anything after a `.action` READ on the same line belongs to the
      //      consumer, not to an emitter — so the segment is truncated there.
      // Note this cannot simply reject `===`: liveExecute writes two of these
      // through a ternary whose CONDITION contains one
      // (`action: meta.role === 'exit' ? … : …`), and rejecting that reports
      // two live emitters as dead.
      if (/^(?:string|number|boolean|unknown|any)\b/.test(seg.trim())) continue;
      //   3. An entry of a CATALOG (see catalogSpans) is a read, not a write.
      if (catalogs.some(([start, end]) => m.index >= start && m.index < end)) continue;
      const emitSeg = seg.split(/\.action\b/)[0];
      for (const a of emitSeg.matchAll(ACTION)) emitted.add(a[1]);
      for (const id of emitSeg.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
        const v = consts.get(id[1]);
        if (typeof v === 'string') emitted.add(v);
      }
    }

    // EMIT side, second form: helpers that take the action as a POSITIONAL
    // argument rather than an `action:` property. `journalEntrySkipOncePerDay`
    // is the throttled entry-skip writer, and on 2026-09-12 it wrote FOUR
    // actions this scan could not see — so a filter on any of them read as
    // dead, and this guard reported a live emitter as missing. The mirror of
    // that blind spot is the dangerous one: a genuinely dead filter on a
    // throttled action would have been vouched for by nothing and caught by
    // nothing. It happened AGAIN on 2026-09-14, in the other direction: wrapping
    // the writer in `journalDeclinedEntry` blinded this scan to the same four
    // actions in one rename, and the guard caught it. Both names live in
    // POSITIONAL_SKIP_WRITERS so the two scans below cannot learn a new writer
    // separately.
    for (const m of src.matchAll(positionalSkips())) emitted.add(m[1]);
    for (const m of src.matchAll(firstArgWrites())) {
      const v = m[1] ?? consts.get(m[2]);
      if (typeof v === 'string') emitted.add(v);
    }

    // CONSUME side: `actions: [...]` filters and `e.action === '...'` compares.
    for (const m of src.matchAll(/actions:\s*\[([^\]]*)\]/g)) {
      const body = m[1];
      for (const a of body.matchAll(ACTION)) note(a[1], f);
      for (const id of body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
        for (const a of filterValues(id[1], consts, f)) note(a, f);
      }
    }
    // …and `actions: SOME_CONST`, with no brackets for the pattern above to
    // find. `SKIP_ACTIONS` is passed exactly that way, so every skip action the
    // attribution filters on was invisible to the CONSUME side — meaning a dead
    // one among them could never have been reported.
    for (const m of src.matchAll(/actions:\s*([A-Z][A-Z0-9_]{2,})\b\.?/g)) {
      for (const a of filterValues(m[1], consts, f)) note(a, f);
    }
    for (const m of src.matchAll(/\.action\s*===\s*'([a-z0-9_]+)'/g)) note(m[1], f);
  }
  return { emitted, consumed, unresolved };
}

describe('journal action reachability', () => {
  const { emitted, consumed, unresolved } = scan();

  it('finds both sides of the wiring at all — a scan that matches nothing proves nothing', () => {
    // If a refactor changes how actions are written or read, the regexes above
    // go quiet and the guard passes vacuously. These floors are what make a
    // silent scan fail loudly instead.
    expect(emitted.size).toBeGreaterThan(80);
    expect(consumed.size).toBeGreaterThan(20);
  });

  it('never filters on an action no emitter writes', () => {
    const dead = [...consumed.entries()]
      .filter(([a]) => !emitted.has(a))
      .map(([a, fs]) => `${a} (read in ${[...fs].map((f) => f.split('/').pop()).join(', ')})`);
    expect(dead).toEqual([]);
  });

  it('resolves every constant a filter names, through the file itself or its imports', () => {
    // A name that resolves to nothing drops out of the CONSUME side, and a dead
    // filter behind it could never be reported.
    expect(unresolved).toEqual([]);
  });

  it('notes a filter constant that resolves to nothing rather than dropping it', () => {
    const synthetic = join(SRC, 'synthetic.ts');
    const src = 'listAutotradeEvents({ actions: [NOWHERE_ACTION] });\nlistAutotradeEvents({ actions: ALSO_NOWHERE });';
    expect(scan([synthetic], () => src).unresolved).toEqual([
      'NOWHERE_ACTION (synthetic.ts)',
      'ALSO_NOWHERE (synthetic.ts)',
    ]);
  });

  it('parses a declaration whole: an arrow in its type, a nested array, a bracket in a string or a comment', () => {
    const src = [
      'const CATALOG: { action: string; test?: (detail: string) => boolean }[] = [',
      "  { action: 'first', tags: ['x'], label: 'closes ] early' },",
      '  // so does ] this',
      "  { action: 'last' },",
      '];',
    ].join('\n');
    expect(constants(src).get('CATALOG')).toEqual(['first', 'last']);
    const [catalog] = arrays(src);
    expect(catalogSpans(src)).toEqual([[catalog.start, src.length - 1]]);
  });

  it('resolves an import under the name the file gives it', () => {
    const loop = join(SRC, 'services/autotrading/loop.ts');
    const src = "import { MARKET_TAPE_ACTION as TAPE_ACTION } from './marketTape';";
    expect(resolvable(loop, src).get('TAPE_ACTION')).toBe('market_tape_read');
  });

  it('reads the execution catalog whole, and as a catalog', () => {
    const src = code(join(SRC, 'services/autotrading/edgeLeakScanData.ts'));
    const catalog = arrays(src).find((a) => a.name === 'EXECUTION_ACTIONS');
    // Every entry the module holds at runtime, not the ones before the first
    // `]` or none at all (#659's arrow-typed field).
    expect(constants(src).get('EXECUTION_ACTIONS')).toEqual(
      expect.arrayContaining(EXECUTION_ACTIONS.map((a) => a.action)),
    );
    // Its whole span is a catalog's, so no entry vouches for itself as a write.
    expect(catalog && catalogSpans(src)).toContainEqual([catalog?.start, catalog?.end]);
  });

  it('follows an action constant to the module it is imported from, on both sides', () => {
    // shockShadow.ts writes this one only through a constant it imports.
    expect(emitted.has('market_shock_shadow')).toBe(true);
    // And these two index modules filter only through imported constants.
    const readers = (a: string) => [...(consumed.get(a) ?? [])].map((f) => f.split('/').pop());
    expect(readers('market_direction_read')).toContain('marketDirectionIndex.ts');
    expect(readers('market_tape_read')).toContain('marketTapeIndex.ts');
  });

  // -------------------------------------------------------------------------
  // THE THIRD DIRECTION (2026-09-12).
  //
  // The two guards above ask "is every action a reader waits for actually
  // written". Neither asks the reverse for the one family where the reverse
  // matters: an ENTRY SKIP that is written and that the attribution cannot
  // classify. Every one of those sends a paper entry into `no_live_row`, the
  // bucket meaning "nothing the journal explains" — so the refusal is recorded,
  // correctly, and still reads as a hole in the record.
  //
  // It found three. `liveEntryScoreGate` returns ONE of THREE actions from one
  // code path and only two of them were in SKIP_ACTIONS; the other two were an
  // equity entry refused for an unreachable stop, and one the broker cannot
  // trade. All three carry a symbol, all three go through the same throttled
  // writer as the classified ones, and the only thing keeping them out of the
  // attribution was a list nobody re-read when the emitters were added.
  // -------------------------------------------------------------------------
  it('classifies every throttled entry skip, or says out loud why not', () => {
    const entrySkips = new Set<string>();
    for (const f of files) {
      for (const m of code(f).matchAll(positionalSkips())) {
        entrySkips.add(m[1]);
      }
    }
    // The scan has to actually find the writer, or this passes vacuously.
    expect(entrySkips.size).toBeGreaterThan(4);

    // Written, and deliberately NOT an attribution class. Each needs a reason
    // here, which is the point: the list is the decision, not the oversight.
    const NOT_ATTRIBUTED: Record<string, string> = {
      // The attribution pairs paper EQUITY entries against live EQUITY entries.
      // The options sleeve is measured by collectOptionsFlowFindings instead,
      // which reads the refusal counts directly.
      live_options_entry_refused: 'options sleeve — measured by collectOptionsFlowFindings',
      options_probation_at_minimum: 'options sleeve — measured by collectOptionsFlowFindings',
      // Found BY this guard on the day it was written, which is the argument
      // for the guard rather than for the three fixes beside it: its call site
      // spans several lines, so the hand enumeration that found the other three
      // walked straight past it. Options sleeve, same reason as the two above.
      live_options_risk_blocked: 'options sleeve — measured by collectOptionsFlowFindings',
      // The market-direction gate's options half (2026-09-23). Not a pair the
      // equity attribution can make, and not a sizing refusal the options flow
      // finding counts: the paper options book's trades are cut by the same
      // reading in the scan's market-direction dimension, and every refusal
      // is a journal row with the reading on it.
      live_options_market_direction_skipped:
        'options sleeve — the market-direction dimension cuts both options books by the same reading',
      // The options sleeve's spent daily order budget (2026-09-24). A cap the
      // operator sets, not a flow refusal the options finding counts, and not a
      // pair the equity attribution makes.
      live_options_order_cap_skipped:
        "options sleeve — the day's order budget (liveOptionsMaxOrdersPerDay), not a flow refusal",
    };

    const unclassified = [...entrySkips]
      .filter((a) => !(SKIP_ACTIONS as readonly string[]).includes(a) && !(a in NOT_ATTRIBUTED))
      .sort();
    expect(unclassified).toEqual([]);
  });

  // THE FOURTH DIRECTION (2026-09-23).
  //
  // The guard above reads only the throttled writer. The live entry path also
  // refuses candidates through plain logAutotradeEvent calls, and four of those
  // (the level veto, a guardrail block, a broker refusal, an unanswered
  // placement) were never attribution classes: CRML's buying-power refusal on
  // 09-21 and TWST's level veto on 09-17 both read as `no_live_row`. So every
  // action liveExecute.ts writes is accounted for here: an attribution class,
  // or named as not an entry refusal and why. A new action fails this until
  // someone decides which it is.
  it('accounts for every action the live execution path writes', () => {
    const src = code(join(SRC, 'services/autotrading/liveExecute.ts'));
    const written = new Set([...src.matchAll(/action:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect(written.size).toBeGreaterThan(30);

    const NOT_AN_ENTRY_REFUSAL: Record<string, string> = {
      bracket_groups_observed: 'protection diagnostics on a position already held',
      entry_extension_shadow: 'a measurement taken beside the decision, not the decision',
      entry_filled: 'a fill: the entry happened, so the attribution pairs it',
      equity_moved_far_from_open: 'an account equity reading',
      equity_sync_rejected: 'an account equity reading',
      equity_synced: 'an account equity reading',
      exit_filled: 'an exit',
      level_exits_applied: 'the signal re-placed around levels and still traded',
      live_bracket_rearm_target_cancelled: 'protection on a position already held',
      live_bracket_rearmed: 'protection on a position already held',
      live_broker_status_unrecognized: 'a reconcile diagnostic on an order already placed',
      live_buying_power_unavailable: 'a risk control that failed open: an execution finding, not a refusal',
      live_entry_ceiling_resized: 'the entry resized and still placed',
      live_entry_risk_resized: 'the entry resized and still placed',
      live_exit_ambiguous: 'an exit',
      live_exit_materialization_failed: 'an exit',
      live_fill_not_fully_materialized: 'fill bookkeeping on an entry already placed',
      live_order_never_placed:
        'written when an unanswered placement is retired, minutes after the entry; the placement-time row is live_order_outcome_unknown',
      live_order_placed: 'the entry placed, so the attribution pairs it',
      live_position_adopted: 'position bookkeeping',
      live_position_closed: 'an exit',
      live_position_linked_to_adopted: 'position bookkeeping',
      live_position_opened: 'the entry filled, so the attribution pairs it',
      live_position_unprotected: 'protection on a position already held',
      live_scale_in_blocked: 'an add to a position already held, not a new entry',
      live_scale_in_direction_skipped: 'an add to a position already held, not a new entry',
      live_scale_in_failed: 'an add to a position already held, not a new entry',
      live_scale_in_orphaned: 'an add to a position already held, not a new entry',
      live_scaled_in: 'an add to a position already held, not a new entry',
      live_scaled_in_filled: 'an add to a position already held, not a new entry',
      live_scale_in_short_skipped: 'an add to a position already held, not a new entry',
      live_scale_out_blocked: 'an exit',
      live_scale_out_failed: 'an exit',
      live_scale_out_placed: 'an exit',
      live_stop_adjust_blocked: 'stop management on a position already held',
      live_stop_adjust_failed: 'stop management on a position already held',
      live_stop_adjust_held: 'stop management on a position already held',
      live_stop_adjust_skipped: 'stop management on a position already held',
      live_stop_ratcheted: 'stop management on a position already held',
      live_time_exit_blocked: 'an exit',
      live_time_exit_cancel_failed: 'an exit',
      live_time_exit_failed: 'an exit',
      live_time_exit_placed: 'an exit',
      per_lot_entry_planned: 'the entry planned and placed, so the attribution pairs it',
      per_lot_second_lot_blocked: 'the second lot of an entry already taken',
      per_lot_second_lot_direction_skipped: 'the second lot of an entry already taken',
      per_lot_second_lot_expired: 'the second lot of an entry already taken',
      per_lot_second_lot_short_skipped: 'the second lot of an entry already taken',
      per_lot_second_lot_failed: 'the second lot of an entry already taken',
      per_lot_second_lot_placed: 'the second lot of an entry already taken',
      stagnation_exit_held_slot_free: 'an exit',
    };
    const classified = new Set<string>([...SKIP_ACTIONS, ...BATCH_REFUSAL_ACTIONS]);
    const unaccounted = [...written].filter((a) => !classified.has(a) && !(a in NOT_AN_ENTRY_REFUSAL)).sort();
    expect(unaccounted).toEqual([]);
    // And the list names nothing the file no longer writes, so it cannot rot.
    expect(Object.keys(NOT_AN_ENTRY_REFUSAL).filter((a) => !written.has(a))).toEqual([]);
  });

  it('knows the specific action that started this — order_placed is not an emitter', () => {
    // Pinned rather than left implicit: if someone adds an `order_placed`
    // emitter later, this fails and they get to decide DELIBERATELY whether the
    // preview should count it, instead of a dead filter quietly coming alive.
    expect(emitted.has('order_placed')).toBe(false);
  });
});

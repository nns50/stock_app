import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eventBook, LIVE_ACTIONS, PAPER_ACTIONS } from '../src/services/autotrading/eventBook';

// ---------------------------------------------------------------------------
// The classifier behind Recent activity's Live/Paper split.
//
// A MISLABELLED row is worse than an unlabelled one — an unlabelled row makes
// you look it up, a mislabelled one makes you sure — so the table is checked
// against the source rather than trusted.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '../src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * `action:` literals that are not journal actions at all.
 *
 * The scan below is deliberately loose — it matches `action: '...'` anywhere,
 * because tightening it to only text near a `logAutotradeEvent(` call silently
 * MISSED real actions (entry_filled, exit_filled) whose object literal is long.
 * A scan that under-reads is the dangerous direction here: it would vouch for a
 * table that has a hole in it. So the loose scan stays and its handful of false
 * positives are named. All three below are discriminants of
 * liveCapsReanchor.ts's `ReanchorDecision` union, not journal rows.
 */
const NOT_A_JOURNAL_ACTION = new Set(['skip', 'hold', 'reanchor']);

/**
 * Every `const NAME = 'snake_case'` in the source, by name.
 *
 * An action written through a constant is still an action. Until 2026-09-26 the
 * scan read only a literal after `action:`, so `action: DAY_PROTECTIVE_ARMED_ACTION`
 * was invisible to it and the row it names filed under `shared` with this guard
 * green. A name declared with two different values keeps both, and the guard
 * below refuses it rather than picking one.
 */
function constantsIn(files: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*'([a-z0-9_]+)'/g)) {
      const values = out.get(m[1]) ?? new Set<string>();
      values.add(m[2]);
      out.set(m[1], values);
    }
  }
  return out;
}
const CONSTANTS = constantsIn(tsFiles(SRC));

/** The names a file writes as an action through a constant: `action: SOME_ACTION`. */
function actionConstantsIn(src: string): string[] {
  return [...src.matchAll(/action:\s*([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]);
}

/**
 * Every action a file writes, by the shapes the codebase uses: a literal, a
 * ternary between two literals, a constant, and the two skip helpers. A
 * constant that does not resolve to one value is left to the test that
 * refuses it, never dropped quietly.
 */
function actionsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/action:\s*'([a-z0-9_]+)'/g)) out.push(m[1]);
  for (const m of src.matchAll(/action:\s*[^,;'{}]*?\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) out.push(m[1], m[2]);
  for (const name of actionConstantsIn(src)) {
    const values = CONSTANTS.get(name);
    if (values?.size === 1) out.push(...values);
  }
  for (const m of src.matchAll(/(?:journalEntrySkipOncePerDay|journalDeclinedEntry)\(\s*[^,]+,\s*'([a-z0-9_]+)'/g)) {
    out.push(m[1]);
  }
  return out.filter((a) => !NOT_A_JOURNAL_ACTION.has(a));
}

describe('eventBook', () => {
  it('takes the writer’s own word first', () => {
    // Both books write `blocked`/`passed`, so no table keyed on the action
    // alone could ever separate them. The detail is the only thing that can.
    expect(eventBook('blocked', JSON.stringify({ book: 'paper', checks: [] }))).toBe('paper');
    expect(eventBook('blocked', JSON.stringify({ book: 'live' }))).toBe('live');
    // The manual /risk-check preview is a tool someone ran by hand. Showing it
    // under Live would put a hypothetical beside things the book really did.
    expect(eventBook('blocked', JSON.stringify({ book: 'preview' }))).toBe('shared');
    // Both books also write the extension shadow, in the same minute.
    expect(eventBook('entry_extension_shadow', JSON.stringify({ book: 'paper' }))).toBe('paper');
    expect(eventBook('entry_extension_shadow', JSON.stringify({ book: 'live' }))).toBe('live');
  });

  it('falls back to the action when the detail says nothing usable', () => {
    expect(eventBook('live_order_placed', null)).toBe('live');
    expect(eventBook('paper_order_placed', 'not json at all')).toBe('paper');
    expect(eventBook('live_order_placed', JSON.stringify({ book: 'nonsense' }))).toBe('live');
    // A detail that is valid JSON but not an object must not throw.
    expect(eventBook('live_order_placed', '"a string"')).toBe('live');
    expect(eventBook('live_order_placed', '42')).toBe('live');
  });

  it('classifies the live-path refusals a prefix filter would have missed', () => {
    // The whole reason this is not a `startsWith` check. Every one of these is
    // written by liveExecute.ts and reads as book-neutral.
    for (const a of [
      'risk_atr_unreachable_skipped',
      'absorbed_price_skipped',
      'symbol_reentry_cooldown_skipped',
      'symbol_unplaceable_skipped',
      'entry_window_closed',
      'entry_filled',
      'exit_filled',
      'level_veto',
      'per_lot_second_lot_placed',
    ]) {
      expect(eventBook(a, null), `${a} is written by liveExecute.ts`).toBe('live');
    }
  });

  it('classifies the paper options sleeve, which carries no paper_ prefix', () => {
    for (const a of ['options_paper_order_placed', 'options_paper_position_closed', 'options_paper_stop_ratcheted']) {
      expect(eventBook(a, null), `${a} is written by optionsExecute.ts only`).toBe('paper');
    }
  });

  it('will not guess a book for the three actions BOTH options sleeves write', () => {
    // The first draft of this file had these in PAPER_ACTIONS because
    // optionsExecute.ts writes them — and liveOptionsExecute.ts writes the same
    // three, so every LIVE options cutoff, exit and slot refusal would have
    // been filed under Paper. The guard below caught it. They carry `book` now;
    // a row written before that carries none, and `shared` is the honest answer
    // for one whose book genuinely cannot be recovered.
    for (const a of [
      'short_dated_entry_window_closed',
      'short_dated_options_exit',
      'short_dated_position_already_open',
    ]) {
      expect(eventBook(a, null), `${a} is written by BOTH sleeves`).toBe('shared');
      expect(eventBook(a, JSON.stringify({ book: 'live' }))).toBe('live');
      expect(eventBook(a, JSON.stringify({ book: 'paper' }))).toBe('paper');
    }
  });

  it('leaves the once-per-tick rows shared rather than inventing an attribution', () => {
    // Screening and decisions happen ONCE, before either book sees a signal;
    // config changes affect both. Filing them under a book would claim an
    // attribution that does not exist.
    for (const a of [
      'candidate_found',
      'signal_generated',
      'excluded_rel_vol_pace',
      'no_signal',
      'risk_profile_changed',
      'auto_tune_risk_adjusted',
      'config_auto_applied',
    ]) {
      expect(eventBook(a, null), `${a} precedes or spans the two books`).toBe('shared');
    }
  });
});

describe('the table is checked against the source, not trusted', () => {
  // The failure mode this exists for: someone adds an action to liveExecute.ts
  // next month, it carries no `live_` prefix, nobody adds it here, and it lands
  // silently in `shared` — where the operator filtering to Live will never see
  // it. That is the same class of bug as the unlabelled risk-check row this
  // whole feature was built to fix, so it gets a guard rather than a comment.

  /** Modules whose actions belong to one book by construction. */
  const LIVE_MODULES = [
    'services/autotrading/liveExecute.ts',
    'services/autotrading/liveOptionsExecute.ts',
    'services/autotrading/liveCapsReanchor.ts',
    'services/autotrading/liveOptionsExpiry.ts',
    'services/autotrading/liveFailureAlert.ts',
  ];
  const PAPER_MODULES = ['services/autotrading/optionsExecute.ts'];

  /** Actions a single-book module writes that genuinely are NOT that book's.
   *  Each needs a reason here — the list is the decision, not the oversight. */
  const NOT_ITS_MODULES_BOOK: Record<string, string> = {
    // Written by BOTH options sleeves. Listing them in either table would file
    // the other sleeve's rows under the wrong book -- which is exactly what the
    // first draft of this guard caught. They carry `book` in the detail.
    short_dated_entry_window_closed: 'written by BOTH options sleeves; resolved from the detail',
    short_dated_options_exit: 'written by BOTH options sleeves; resolved from the detail',
    short_dated_position_already_open: 'written by BOTH options sleeves; resolved from the detail',
    // execute.ts (paper) journals the extension shadow and the risk check, and
    // liveExecute.ts journals the same two actions. Both resolve from the
    // detail's `book`, never from the module.
    entry_extension_shadow: 'written by BOTH books; resolved from the detail',
    // The give-back guard and the drawdown halt are day-level rules that stop
    // the whole loop, not one book's activity.
    daily_give_back_halted: 'a day-level halt, not one book acting',
    daily_target_reached: 'a day-level state change',
    daily_target_pending_confirmation: 'a day-level state change',
    daily_baseline_rebased: 'a day-level state change',
    // Notifications and loop plumbing are not a book's trading.
    notification_delivery_failed: 'delivery plumbing',
    loop_stage_failed: 'loop plumbing',
  };

  const files = tsFiles(SRC);
  const fileOf = (suffix: string) => files.find((f) => f.replace(/\\/g, '/').endsWith(suffix));

  it('finds the modules it means to scan', () => {
    // Without this the loop below passes vacuously if a file is ever renamed.
    for (const m of [...LIVE_MODULES, ...PAPER_MODULES]) {
      expect(fileOf(m), `${m} not found — update this guard`).toBeTruthy();
    }
  });

  it('reads an action written through a constant or a ternary', () => {
    // The shapes the literal-only scan missed (2026-09-26). If the scan stops
    // reading one, the two classification checks below pass vacuously for it.
    const live = actionsIn(readFileSync(fileOf('services/autotrading/liveExecute.ts')!, 'utf8'));
    expect(live).toContain('day_protective_armed');
    expect(live).toEqual(expect.arrayContaining(['live_scale_out_filled', 'live_time_exit_closed']));
    const liveOptions = actionsIn(readFileSync(fileOf('services/autotrading/liveOptionsExecute.ts')!, 'utf8'));
    expect(liveOptions).toContain('short_dated_position_already_open');
  });

  it('resolves every constant a book module writes as an action', () => {
    // A name the scan cannot resolve drops out of it, and an under-reading
    // scan is the one direction this guard must never fail in.
    const unresolved: string[] = [];
    for (const m of [...LIVE_MODULES, ...PAPER_MODULES]) {
      const f = fileOf(m);
      if (!f) continue;
      for (const name of actionConstantsIn(readFileSync(f, 'utf8'))) {
        if (CONSTANTS.get(name)?.size !== 1) unresolved.push(`${name} (${m})`);
      }
    }
    expect(unresolved, "declare each as one `const NAME = 'value'` somewhere under src/").toEqual([]);
  });

  it('classifies every action a live-only module writes as live', () => {
    const missed: string[] = [];
    for (const m of LIVE_MODULES) {
      const f = fileOf(m);
      if (!f) continue;
      for (const action of new Set(actionsIn(readFileSync(f, 'utf8')))) {
        if (action in NOT_ITS_MODULES_BOOK) continue;
        if (eventBook(action, null) !== 'live') missed.push(`${action} (${m})`);
      }
    }
    expect(
      missed.sort(),
      'these actions are written by a LIVE-only module but do not classify as live. Add each to LIVE_ACTIONS in ' +
        'eventBook.ts, or to NOT_ITS_MODULES_BOOK here with the reason it is genuinely not the live book acting. ' +
        'Left alone they land in `shared`, where an operator filtering to Live will never see them.',
    ).toEqual([]);
  });

  it('classifies every action a paper-only module writes as paper', () => {
    const missed: string[] = [];
    for (const m of PAPER_MODULES) {
      const f = fileOf(m);
      if (!f) continue;
      for (const action of new Set(actionsIn(readFileSync(f, 'utf8')))) {
        if (action in NOT_ITS_MODULES_BOOK) continue;
        if (eventBook(action, null) !== 'paper') missed.push(`${action} (${m})`);
      }
    }
    expect(missed.sort(), 'written by a PAPER-only module but not classified paper — see the live twin above').toEqual(
      [],
    );
  });

  it('keeps the explicit tables free of entries the prefix rule already covers', () => {
    // A `live_` action listed in LIVE_ACTIONS is dead weight that reads as if
    // it were an exception, which is how a table stops being a list of the
    // genuinely surprising cases.
    expect([...LIVE_ACTIONS].filter((a) => a.startsWith('live_'))).toEqual([]);
    expect([...PAPER_ACTIONS].filter((a) => a.startsWith('paper_'))).toEqual([]);
    // And free of entries claimed by both.
    expect([...LIVE_ACTIONS].filter((a) => PAPER_ACTIONS.has(a))).toEqual([]);
  });
});

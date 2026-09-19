import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import {
  declinedSide,
  journalDeclinedEntry,
  parseDeclinedEntry,
  type DeclinedSignal,
} from '../src/services/autotrading/declinedEntry';

// ---------------------------------------------------------------------------
// A refusal nobody can score is a refusal nobody can judge.
//
// Task #45 established that every gate on the live entry path journals a row.
// What nothing checked was whether those rows could be REPLAYED, and none of
// them could — they carried the rule's own numbers and not the entry, the stop
// or the side. `risk_atr_unreachable_skipped` refused 80 symbol-days over eight
// sessions, 16 on 2026-09-14 against FOUR entries actually placed, and the
// question "was that right" had no answer available anywhere.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_events;'));

const signal = (over: Partial<DeclinedSignal> = {}): DeclinedSignal => ({
  symbol: 'MSFT',
  side: 'buy',
  entry: 504.6,
  stop: 491.97,
  score: 74,
  ...over,
});

describe('declinedSide', () => {
  it('speaks the replay’s vocabulary, not the order’s', () => {
    expect(declinedSide('buy')).toBe('long');
    expect(declinedSide('sell')).toBe('short');
  });
});

describe('journalDeclinedEntry', () => {
  it('stamps everything a replay needs, whatever the rule itself journaled', () => {
    // The MSFT row from 2026-09-14: stop $12.63 against an ATR of $10.65, a
    // ratio of 1.19 against the 0.7 cut.
    journalDeclinedEntry(signal(), 'risk_atr_unreachable_skipped', 81, {
      stopDistance: 12.63,
      atr: 10.65,
      ratio: 1.19,
      reason: '1R costs 1.19x this name’s daily range',
    });

    const rows = listAutotradeEvents({ actions: ['risk_atr_unreachable_skipped'] });
    expect(rows).toHaveLength(1);
    const d = JSON.parse(rows[0].detail ?? '{}') as Record<string, unknown>;
    // The rule's own reasoning survives...
    expect(d).toMatchObject({ stopDistance: 12.63, atr: 10.65, ratio: 1.19 });
    // ...and the replay's inputs are there beside it.
    expect(d).toMatchObject({ side: 'long', score: 74, entry: 504.6, stop: 491.97 });
    // The floor IN FORCE, so a later read cannot re-score its own history when
    // liveMinSignalScore moves. Raising it 72 -> 81 on 2026-09-14 cut the short
    // shadow's eligible rows from 32 to 1 exactly that way.
    expect(d).toMatchObject({ liveMinSignalScore: 81, liveEligible: false });
  });

  it('judges eligibility against the floor it is given, not a fixed one', () => {
    journalDeclinedEntry(signal({ symbol: 'AAA', score: 74 }), 'absorbed_price_skipped', 72, {});
    const d = JSON.parse(listAutotradeEvents({ symbol: 'AAA' })[0].detail ?? '{}') as Record<string, unknown>;
    expect(d).toMatchObject({ liveEligible: true, liveMinSignalScore: 72 });
  });

  it('never lets a rule’s own key shadow a replay field', () => {
    // The ordering is deliberate. A gate that journals its own `score` (several
    // did) must not be able to overwrite the signal's: the two have drifted
    // apart before, and the replay is the thing that has to be right.
    journalDeclinedEntry(signal({ symbol: 'BBB', score: 74, entry: 100, stop: 95 }), 'live_score_floor_skipped', 72, {
      score: 999,
      entry: 1,
      stop: 2,
      side: 'sideways',
    });
    const d = JSON.parse(listAutotradeEvents({ symbol: 'BBB' })[0].detail ?? '{}') as Record<string, unknown>;
    expect(d).toMatchObject({ score: 74, entry: 100, stop: 95, side: 'long' });
  });

  it('is still throttled to one row per symbol per ET day', () => {
    journalDeclinedEntry(signal({ symbol: 'CCC' }), 'symbol_cooldown_skipped', 72, {});
    journalDeclinedEntry(signal({ symbol: 'CCC' }), 'symbol_cooldown_skipped', 72, {});
    expect(listAutotradeEvents({ symbol: 'CCC' })).toHaveLength(1);
  });
});

describe('parseDeclinedEntry — the consumer', () => {
  it('round-trips a row the helper wrote', () => {
    journalDeclinedEntry(signal({ symbol: 'DDD', side: 'sell' }), 'live_symbol_held_skipped', 81, { holder: 'manual' });
    const row = listAutotradeEvents({ symbol: 'DDD' })[0];
    expect(parseDeclinedEntry(row)).toMatchObject({
      symbol: 'DDD',
      side: 'short',
      entry: 504.6,
      stop: 491.97,
      score: 74,
      floorAtSkip: 81,
      at: row.createdAt,
    });
  });

  it('refuses a row that predates the fields rather than scoring it as zero', () => {
    // Counting an unscorable row as 0R would drag every average toward nothing
    // while looking like data. Null, and the caller counts what it dropped.
    expect(parseDeclinedEntry({ symbol: 'EEE', detail: '{"ratio":1.19}', createdAt: 1 })).toBeNull();
    expect(parseDeclinedEntry({ symbol: 'EEE', detail: '{"entry":100}', createdAt: 1 })).toBeNull();
    expect(parseDeclinedEntry({ symbol: null, detail: '{"entry":100,"stop":95,"score":74}', createdAt: 1 })).toBeNull();
    expect(parseDeclinedEntry({ symbol: 'EEE', detail: 'not json', createdAt: 1 })).toBeNull();
    expect(parseDeclinedEntry({ symbol: 'EEE', detail: null, createdAt: 1 })).toBeNull();
  });

  it('reads a row with no floor stamp as unpinned rather than inventing one', () => {
    const parsed = parseDeclinedEntry({ symbol: 'FFF', detail: '{"entry":100,"stop":95,"score":74}', createdAt: 1 });
    expect(parsed?.floorAtSkip).toBeUndefined();
  });

  it('defaults a side-less row to long, which is what those rows were', () => {
    // Every gate predating the `side` stamp sits AFTER the naked-short skip, so
    // a short never reached one.
    expect(
      parseDeclinedEntry({ symbol: 'GGG', detail: '{"entry":100,"stop":95,"score":74}', createdAt: 1 })?.side,
    ).toBe('long');
  });

  it('carries the re-entry cooldown’s exit gap, and only when the row has one', () => {
    // The cooldown row spreads its own reading (`minutesSince`) beside the
    // replay fields; the gap is what a shorter-cooldown replay selects on.
    const cooldown = parseDeclinedEntry({
      symbol: 'HHH',
      detail: '{"entry":100,"stop":95,"score":90,"side":"long","minutesSince":121,"cooldownMinutes":390}',
      createdAt: 1,
    });
    expect(cooldown?.minutesSinceExit).toBe(121);
    // Any other gate's row: undefined, never 0 — a zero would read as "at the
    // exit" and qualify for every gap.
    const other = parseDeclinedEntry({ symbol: 'III', detail: '{"entry":100,"stop":95,"score":90}', createdAt: 1 });
    expect(other).not.toHaveProperty('minutesSinceExit');
    const junk = parseDeclinedEntry({
      symbol: 'JJJ',
      detail: '{"entry":100,"stop":95,"score":90,"minutesSince":"soon"}',
      createdAt: 1,
    });
    expect(junk).not.toHaveProperty('minutesSinceExit');
  });
});

describe('the entry path cannot journal an unscorable refusal', () => {
  it('routes every live entry skip through journalDeclinedEntry', () => {
    // A source scan, in the style of configReachability.test.ts, because the
    // failure mode is a NEW gate written next month that journals its reason
    // and forgets the three fields that make the reason answerable. Catching it
    // at review depends on the reviewer knowing this rule; catching it here
    // does not.
    const src = readFileSync(join(__dirname, '../src/services/autotrading/liveExecute.ts'), 'utf8');
    const bare = src.match(/journalEntrySkipOncePerDay\(/g) ?? [];
    expect(
      bare.length,
      'liveExecute.ts must journal entry refusals through journalDeclinedEntry (declinedEntry.ts), which stamps ' +
        'entry/stop/side and the floor in force. A refusal without those can be counted but never replayed, which ' +
        'is how risk_atr_unreachable_skipped refused 80 symbol-days with nothing able to say whether it should have.',
    ).toBe(0);
  });

  it('keeps the every-tick re-entry row carrying the same fields', () => {
    // symbol_reentry_cooldown_skipped deliberately journals on EVERY tick
    // rather than once a day, so it keeps its own writer — which is exactly how
    // it would drift out of this rule unnoticed.
    const src = readFileSync(join(__dirname, '../src/services/autotrading/liveExecute.ts'), 'utf8');
    const block = src.slice(
      src.indexOf("action: 'symbol_reentry_cooldown_skipped'"),
      src.indexOf("action: 'symbol_reentry_cooldown_skipped'") + 900,
    );
    for (const field of ['side: declinedSide(', 'entry: candidateSignal.entry', 'stop: candidateSignal.stop']) {
      expect(block, `the re-entry skip row must carry ${field}`).toContain(field);
    }
  });
});

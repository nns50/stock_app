import { describe, it, expect } from 'vitest';
import { analyzeJournal, IntegrityCheckId } from '../src/services/journalIntegrity';
import type { Position, PositionExit } from '../src/db/positions';

// 2026-07-26 01:30 UTC is still 2026-07-25 21:30 in New York — the window in
// which the old UTC-dating background writers recorded tomorrow's date.
const DIVERGENT = Date.parse('2026-07-26T01:30:00Z');
// 2026-07-25 18:00 UTC is 14:00 ET the same day — UTC and ET agree.
const AGREEING = Date.parse('2026-07-25T18:00:00Z');

function exitFixture(o: Partial<PositionExit> = {}): PositionExit {
  return {
    id: 1,
    positionId: 1,
    quantity: 10,
    exitPrice: 110,
    exitDate: '2026-07-20',
    fees: 0,
    notes: null,
    sourceIntentId: null,
    createdAt: AGREEING,
    ...o,
  };
}

function positionFixture(o: Partial<Position> = {}): Position {
  const exits = o.exits ?? [];
  const quantity = o.quantity ?? 10;
  return {
    id: 1,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity,
    entryPrice: 100,
    entryDate: '2026-07-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: exits.reduce((s, e) => s + e.quantity, 0) >= quantity ? 'closed' : 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    createdAt: AGREEING,
    updatedAt: AGREEING,
    remainingQuantity: Math.max(0, quantity - exits.reduce((s, e) => s + e.quantity, 0)),
    ...o,
    exits,
  };
}

const checksHit = (positions: Position[], now = DIVERGENT): IntegrityCheckId[] =>
  analyzeJournal(positions, now).findings.map((f) => f.check);

describe('analyzeJournal — a clean book', () => {
  it('reports clean, and still lists every check it ran', () => {
    const report = analyzeJournal([positionFixture()], DIVERGENT);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    // "Clean" only means something if you can see what it was clean against.
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.count === 0)).toBe(true);
    expect(report.positionsExamined).toBe(1);
  });
});

describe('analyzeJournal — the UTC-dating fingerprint is exact, not heuristic', () => {
  const syncExit = (o: Partial<PositionExit>) =>
    exitFixture({ notes: 'Auto-closed via Webull sync — no longer held at the broker. …', ...o });

  it('flags an exit the sync dated on the UTC day while ET was still the day before', () => {
    // What the pre-fix code wrote: new Date().toISOString().slice(0, 10).
    const p = positionFixture({
      exits: [syncExit({ exitDate: '2026-07-26', createdAt: DIVERGENT })],
    });
    const report = analyzeJournal([p], DIVERGENT);
    const finding = report.findings.find((f) => f.check === 'utc_dated_by_background_writer');
    expect(finding).toBeDefined();
    // It can name the correct value with certainty, because the fingerprint
    // carries it — though nothing here ever applies it.
    expect(finding!.suggested).toBe('2026-07-25');
    expect(finding!.detail).toContain('2026-07-26');
  });

  it('does NOT flag the same writer once it dates in ET (the fixed behaviour)', () => {
    const p = positionFixture({
      exits: [syncExit({ exitDate: '2026-07-25', createdAt: DIVERGENT })],
    });
    expect(checksHit([p])).not.toContain('utc_dated_by_background_writer');
  });

  it('does NOT flag a row written when UTC and ET agreed — it is not wrong', () => {
    // The old code wrote the right answer for most of the day. Those rows are
    // indistinguishable from correct ones because they ARE correct.
    const p = positionFixture({
      exits: [syncExit({ exitDate: '2026-07-25', createdAt: AGREEING })],
    });
    expect(checksHit([p])).not.toContain('utc_dated_by_background_writer');
  });

  it('does NOT flag a hand-entered exit that merely happens to look like one', () => {
    // Scoped to the two background writers by note prefix: a human who picks
    // tomorrow's date is making a different mistake, caught by future_dated.
    const p = positionFixture({
      exits: [exitFixture({ exitDate: '2026-07-26', createdAt: DIVERGENT, notes: 'sold half' })],
    });
    expect(checksHit([p])).not.toContain('utc_dated_by_background_writer');
  });

  it('flags the entry side too — a position the reconciler created from a live fill', () => {
    const p = positionFixture({
      entryDate: '2026-07-26',
      createdAt: DIVERGENT,
      notes: 'Auto-recorded from live order #42 (broker ABC)',
      tags: ['live'],
    });
    const finding = analyzeJournal([p], DIVERGENT).findings.find((f) => f.check === 'utc_dated_by_background_writer');
    expect(finding?.suggested).toBe('2026-07-25');
  });

  it('does not ALSO report the same row as future-dated — one defect, one entry', () => {
    // A row a background job dated tomorrow is trivially "in the future" too,
    // but that's the same defect seen twice: it would inflate the count and
    // split one fix across two headings. The specific finding wins, and it's
    // the one that names the correct value.
    const p = positionFixture({
      exits: [syncExit({ exitDate: '2026-07-26', createdAt: DIVERGENT })],
    });
    const hits = checksHit([p]);
    expect(hits).toEqual(['utc_dated_by_background_writer']);
  });

  it('still reports an unrelated future date on the same position', () => {
    // Suppression is scoped to the exact date the UTC finding explains, not
    // blanket-applied to the row.
    const p = positionFixture({
      entryDate: '2027-03-01',
      exits: [syncExit({ exitDate: '2026-07-26', createdAt: DIVERGENT })],
    });
    const hits = checksHit([p]);
    expect(hits).toContain('utc_dated_by_background_writer');
    expect(hits).toContain('future_dated');
  });

  it('leaves the expiry sweep alone — it dates on the expiration, never on "today"', () => {
    const p = positionFixture({
      assetType: 'option',
      expiration: '2026-07-17',
      exits: [
        exitFixture({
          exitDate: '2026-07-17',
          createdAt: DIVERGENT,
          notes: 'Expired worthless — auto-recorded by the expired-option sweep (out of the money)',
        }),
      ],
    });
    expect(checksHit([p])).not.toContain('utc_dated_by_background_writer');
  });
});

describe('analyzeJournal — rows that are wrong in ways nothing on screen reveals', () => {
  it('catches exits that close more than the position ever held', () => {
    // remainingQuantity clamps at 0, so this renders as an ordinary closed row.
    const p = positionFixture({
      quantity: 10,
      exits: [exitFixture({ id: 1, quantity: 8 }), exitFixture({ id: 2, quantity: 5 })],
      status: 'closed',
      remainingQuantity: 0,
    });
    const finding = analyzeJournal([p], DIVERGENT).findings.find((f) => f.check === 'exits_exceed_quantity');
    expect(finding?.detail).toBe('exits close 13 of a 10 position');
  });

  it('catches a status that contradicts the remaining quantity, both directions', () => {
    const openButEmpty = positionFixture({ id: 1, status: 'open', remainingQuantity: 0 });
    const closedButHeld = positionFixture({ id: 2, status: 'closed', remainingQuantity: 4 });
    expect(checksHit([openButEmpty])).toContain('status_disagrees_with_remaining');
    expect(checksHit([closedButHeld])).toContain('status_disagrees_with_remaining');
  });

  it('catches non-ISO dates on the entry, the expiration and any exit', () => {
    const p = positionFixture({
      entryDate: '07/01/2026',
      assetType: 'option',
      expiration: '2026-7-17',
      exits: [exitFixture({ exitDate: 'yesterday' })],
    });
    expect(checksHit([p]).filter((c) => c === 'non_iso_date')).toHaveLength(3);
  });

  it('does NOT call an open option’s expiration a future date', () => {
    // An expiration is a term of the contract, not a record of something that
    // happened — for any live option it is SUPPOSED to be ahead of today.
    // Flagging it made the report cry wolf on a perfectly healthy position.
    const p = positionFixture({
      assetType: 'option',
      optionType: 'call',
      strike: 6.5,
      expiration: '2026-08-21',
    });
    expect(checksHit([p])).toEqual([]);
  });

  it('still requires the expiration to be a well-formed date', () => {
    const p = positionFixture({ assetType: 'option', expiration: '21/08/2026' });
    expect(checksHit([p])).toEqual(['non_iso_date']);
  });

  it('catches a future date and an exit before its own entry', () => {
    const future = positionFixture({ id: 1, entryDate: '2027-01-01' });
    const backwards = positionFixture({
      id: 2,
      entryDate: '2026-07-10',
      exits: [exitFixture({ exitDate: '2026-07-01' })],
    });
    expect(checksHit([future])).toContain('future_dated');
    expect(checksHit([backwards])).toContain('exit_before_entry');
  });

  it('does not double-report a non-ISO date as also being in the future', () => {
    // A garbage string compares as garbage; reporting it twice under two
    // different explanations makes the report harder to act on, not easier.
    const p = positionFixture({ entryDate: 'zzzz' });
    const hits = checksHit([p]);
    expect(hits).toEqual(['non_iso_date']);
  });

  it('catches a zero entry price, which books the whole market value as fake gain', () => {
    expect(checksHit([positionFixture({ entryPrice: 0 })])).toContain('nonpositive_entry_price');
  });

  it('catches an exit closing zero quantity', () => {
    expect(checksHit([positionFixture({ exits: [exitFixture({ quantity: 0 })] })])).toContain(
      'nonpositive_exit_quantity',
    );
  });
});

describe('analyzeJournal — an option entered after its own contract expired', () => {
  // The shape found in a real book (position 489, 2026-07-26): the Webull
  // import had no open-date in the broker payload, fell back to stamping the
  // IMPORT date, and the contract — still listed overnight after expiry — had
  // already expired the day before.
  const expiredBeforeEntry = positionFixture({
    id: 489,
    symbol: 'QS',
    assetType: 'option',
    optionType: 'call',
    strike: 6.5,
    quantity: 17,
    entryPrice: 0.19,
    entryDate: '2026-07-25',
    expiration: '2026-07-24',
    tags: ['webull'],
    notes: 'Imported from Webull',
    exits: [
      exitFixture({
        id: 483,
        quantity: 17,
        exitPrice: 0,
        exitDate: '2026-07-24',
        notes: 'Expired worthless — auto-recorded by the expired-option sweep (…)',
      }),
    ],
  });

  it('is proof the entry date is wrong, not a judgement about it', () => {
    const finding = analyzeJournal([expiredBeforeEntry], DIVERGENT).findings.find(
      (f) => f.check === 'entry_after_expiration',
    );
    expect(finding).toBeDefined();
    expect(finding!.detail).toBe('entry dated 2026-07-25, but the contract expired 2026-07-24');
  });

  it('names the cause instead of the symptom — the early exit is not reported twice', () => {
    // The exit is "before the entry" only relative to a date the position
    // cannot have had. One defect, one entry; fix the entry and re-run.
    expect(checksHit([expiredBeforeEntry])).toEqual(['entry_after_expiration']);
  });

  it('still reports an early exit when the entry is not the proven culprit', () => {
    const p = positionFixture({
      assetType: 'option',
      expiration: '2026-12-18',
      entryDate: '2026-07-10',
      exits: [exitFixture({ exitDate: '2026-07-01' })],
    });
    expect(checksHit([p])).toContain('exit_before_entry');
  });

  it('leaves a normal option alone — entry before expiry is the ordinary case', () => {
    const p = positionFixture({
      assetType: 'option',
      optionType: 'put',
      expiration: '2026-08-21',
      entryDate: '2026-07-01',
    });
    expect(checksHit([p])).toEqual([]);
  });

  it('never fires on a stock, which has no expiration to be after', () => {
    expect(checksHit([positionFixture({ assetType: 'stock', expiration: null })])).not.toContain(
      'entry_after_expiration',
    );
  });
});

describe('analyzeJournal — broker-tracked lots that lost their account', () => {
  const unassigned = positionFixture({ id: 1, symbol: 'VRAX', tags: ['webull'], accountId: null, status: 'open' });

  it('flags it once a second account is known — the sync will not touch it', () => {
    const other = positionFixture({ id: 2, symbol: 'MSFT', accountId: 'ACC1' });
    expect(checksHit([unassigned, other])).toContain('broker_tracked_without_account');
  });

  it('stays quiet in a single-account book, where an unassigned lot is unambiguous', () => {
    // Mirrors the sync's own rule: with no other account known, an unassigned
    // row can only belong to the one account, so it is not a problem.
    expect(checksHit([unassigned])).not.toContain('broker_tracked_without_account');
  });

  it('ignores a plain manually-logged position, which has no account to lose', () => {
    const manual = positionFixture({ id: 1, tags: [], sourceIntentId: null, accountId: null });
    const other = positionFixture({ id: 2, accountId: 'ACC1' });
    expect(checksHit([manual, other])).not.toContain('broker_tracked_without_account');
  });

  it('ignores a closed one — there is nothing left for the sync to reconcile', () => {
    const closed = positionFixture({
      id: 1,
      tags: ['webull'],
      status: 'closed',
      remainingQuantity: 0,
      quantity: 10,
      exits: [exitFixture({ quantity: 10 })],
    });
    const other = positionFixture({ id: 2, accountId: 'ACC1' });
    expect(checksHit([closed, other])).not.toContain('broker_tracked_without_account');
  });
});

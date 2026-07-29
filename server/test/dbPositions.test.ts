import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, addExit, deleteExit, listPositions, getPosition } from '../src/db/positions';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM position_exits; DELETE FROM positions;'));

function makePosition(symbol: string) {
  return createPosition({
    assetType: 'stock',
    symbol,
    side: 'long',
    quantity: 100,
    entryPrice: 10,
    entryDate: '2026-01-01',
    fees: 0,
  });
}

describe('listPositions — batched exits (not one query per position)', () => {
  it("gives each position exactly its own exits, not mixed up with another position's", () => {
    const a = makePosition('AAA');
    const b = makePosition('BBB');
    const c = makePosition('CCC'); // no exits at all

    addExit(a.id, { quantity: 40, exitPrice: 12, exitDate: '2026-01-05' });
    addExit(a.id, { quantity: 60, exitPrice: 13, exitDate: '2026-01-10' });
    addExit(b.id, { quantity: 100, exitPrice: 9, exitDate: '2026-01-06' });

    const all = listPositions();
    const byId = new Map(all.map((p) => [p.id, p]));

    expect(byId.get(a.id)!.exits).toHaveLength(2);
    expect(
      byId
        .get(a.id)!
        .exits.map((e) => e.exitPrice)
        .sort(),
    ).toEqual([12, 13]);
    expect(byId.get(a.id)!.remainingQuantity).toBe(0);

    expect(byId.get(b.id)!.exits).toHaveLength(1);
    expect(byId.get(b.id)!.exits[0].exitPrice).toBe(9);
    expect(byId.get(b.id)!.remainingQuantity).toBe(0);

    expect(byId.get(c.id)!.exits).toEqual([]);
    expect(byId.get(c.id)!.remainingQuantity).toBe(100);
  });

  it('matches getPosition (the single-position lookup path) for the same position', () => {
    const a = makePosition('AAA');
    addExit(a.id, { quantity: 25, exitPrice: 11, exitDate: '2026-01-03' });

    const viaList = listPositions().find((p) => p.id === a.id)!;
    const viaGet = getPosition(a.id)!;
    expect(viaList.exits).toEqual(viaGet.exits);
    expect(viaList.remainingQuantity).toBe(viaGet.remainingQuantity);
  });

  it('returns an empty array (not an error) when there are no positions at all', () => {
    expect(listPositions()).toEqual([]);
  });
});

describe('at-entry context and exit reasons (2026-07-26)', () => {
  it('round-trips entryScore / marketRegime / marketAtrPct on a position', () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'CTX',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-07-01',
      entryScore: 66.7,
      marketRegime: 'risk-off',
      marketAtrPct: 3.2,
    });
    const got = getPosition(p.id)!;
    expect(got.entryScore).toBe(66.7);
    expect(got.marketRegime).toBe('risk-off');
    expect(got.marketAtrPct).toBe(3.2);
  });

  it('leaves context null for a plain manual entry — never a guessed value', () => {
    const p = makePosition('CTXB');
    expect(p.entryScore).toBeNull();
    expect(p.marketRegime).toBeNull();
    expect(p.marketAtrPct).toBeNull();
  });

  it('round-trips an exit reason, and leaves it null when the caller has none', () => {
    const p = makePosition('CTXC');
    addExit(p.id, { quantity: 40, exitPrice: 12, exitDate: '2026-01-05', exitReason: 'stop' });
    addExit(p.id, { quantity: 60, exitPrice: 13, exitDate: '2026-01-10' });
    const exits = getPosition(p.id)!.exits;
    expect(exits.map((e) => e.exitReason)).toEqual(['stop', null]);
  });
});

describe('exit mutations are atomic with the position status they derive', () => {
  // The exit row and the position's status/remaining-quantity are one fact.
  // These tests force the SECOND write (the derived-status UPDATE) to fail and
  // prove the FIRST (the exit insert/delete) rolls back with it — i.e. a crash
  // or error mid-sequence can never leave the two disagreeing. Without the
  // db.transaction() wrapper in addExit/deleteExit the exit change would have
  // already auto-committed before the status write ran, and these would fail.
  //
  // The failure is injected with a temp trigger that ABORTs any UPDATE touching
  // positions.status — more faithful to a real mid-sequence failure than
  // mocking would be (it aborts inside SQLite exactly where recomputeStatus
  // writes), and it doesn't depend on spying a native better-sqlite3 method.
  function armStatusUpdateFailure() {
    db.exec(
      `CREATE TEMP TRIGGER fail_status_update BEFORE UPDATE OF status ON positions
       BEGIN SELECT RAISE(ABORT, 'simulated crash before status commit'); END`,
    );
  }
  function disarm() {
    db.exec('DROP TRIGGER IF EXISTS fail_status_update');
  }

  it('rolls the exit INSERT back when the status update fails', () => {
    const p = makePosition('ATOM1');
    // A full-close exit makes recomputeStatus flip status open→closed, so the
    // guarded UPDATE actually runs (and hits the trigger).
    armStatusUpdateFailure();
    try {
      expect(() => addExit(p.id, { quantity: 100, exitPrice: 12, exitDate: '2026-01-05' })).toThrow(/simulated crash/);
    } finally {
      disarm();
    }
    const after = getPosition(p.id)!;
    expect(after.exits).toHaveLength(0); // insert rolled back, not left orphaned
    expect(after.status).toBe('open'); // and status is untouched — still consistent
  });

  it('rolls the exit DELETE back when the status update fails', () => {
    const p = makePosition('ATOM2');
    addExit(p.id, { quantity: 100, exitPrice: 12, exitDate: '2026-01-05' }); // fully closed
    const exitId = getPosition(p.id)!.exits[0].id;
    expect(getPosition(p.id)!.status).toBe('closed');

    // Deleting this exit reopens the position (status flips closed→open), so the
    // derived UPDATE runs and hits the trigger; the DELETE must roll back with it.
    armStatusUpdateFailure();
    try {
      expect(() => deleteExit(exitId)).toThrow(/simulated crash/);
    } finally {
      disarm();
    }
    const after = getPosition(p.id)!;
    expect(after.exits).toHaveLength(1); // delete rolled back
    expect(after.status).toBe('closed'); // still consistent with the surviving exit
  });
});

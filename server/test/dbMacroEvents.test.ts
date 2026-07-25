import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { addMacroEvent, listMacroEvents, removeMacroEvent } from '../src/db/macroEvents';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM macro_events'));

describe('macro event blackout list', () => {
  it('starts empty — nothing pre-seeded', () => {
    expect(listMacroEvents()).toEqual([]);
  });

  it('adds an event and returns the full record', () => {
    const eventAt = Date.parse('2026-09-16T18:00:00Z');
    const rec = addMacroEvent('FOMC decision', eventAt);
    expect(rec.label).toBe('FOMC decision');
    expect(rec.eventAt).toBe(eventAt);
    expect(rec.id).toBeGreaterThan(0);
    expect(rec.createdAt).toBeGreaterThan(0);
  });

  it('lists soonest first, regardless of insertion order', () => {
    addMacroEvent('Later event', Date.parse('2026-12-10T14:30:00Z'));
    addMacroEvent('Sooner event', Date.parse('2026-09-16T18:00:00Z'));
    addMacroEvent('Middle event', Date.parse('2026-11-05T13:30:00Z'));
    expect(listMacroEvents().map((e) => e.label)).toEqual(['Sooner event', 'Middle event', 'Later event']);
  });

  it('removes an event and reports false for an unknown id', () => {
    const rec = addMacroEvent('CPI release', Date.parse('2026-09-11T12:30:00Z'));
    expect(removeMacroEvent(rec.id)).toBe(true);
    expect(listMacroEvents()).toEqual([]);
    expect(removeMacroEvent(rec.id)).toBe(false);
    expect(removeMacroEvent(999999)).toBe(false);
  });

  it('allows multiple distinct events with the same label', () => {
    addMacroEvent('FOMC decision', Date.parse('2026-09-16T18:00:00Z'));
    addMacroEvent('FOMC decision', Date.parse('2026-11-04T19:00:00Z'));
    expect(listMacroEvents()).toHaveLength(2);
  });
});

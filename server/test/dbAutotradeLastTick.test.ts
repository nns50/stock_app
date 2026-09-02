import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { getLastTick, saveLastTick } from '../src/db/autotradeLastTick';
import type { LoopTickSummary } from '../src/services/autotrading/loop';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_last_tick'));

function summary(overrides: Partial<LoopTickSummary> = {}): LoopTickSummary {
  return {
    ranEntries: true,
    exitsChecked: 0,
    exitsClosed: 0,
    optionsExitsChecked: 0,
    optionsExitsClosed: 0,
    liveOrdersReconciled: 0,
    livePositionsClosed: 0,
    liveOptionsOrdersReconciled: 0,
    liveOptionsPositionsClosed: 0,
    liveOptionsExitsRequested: 0,
    liveTimeExitsRequested: 0,
    liveScaleInsRequested: 0,
    liveScaleOutsRequested: 0,
    liveStopsRatcheted: 0,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    optionsSignalsGenerated: 0,
    optionsCandidatesConsidered: 0,
    entriesOpened: 0,
    optionsEntriesOpened: 0,
    liveEntriesOpened: 0,
    liveOptionsEntriesOpened: 0,
    moversAutoPromoted: 0,
    moversDiscovered: 0,
    moversCandidates: 0,
    moversFetchError: null,
    ...overrides,
  };
}

describe('autotrade last-tick persistence', () => {
  it('returns null before any tick has ever been saved', () => {
    expect(getLastTick()).toBeNull();
  });

  it('persists a summary and round-trips it, stamping ranAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      saveLastTick(summary({ candidatesScreened: 5, signalsGenerated: 2, entriesOpened: 1 }));
    } finally {
      vi.restoreAllMocks();
    }
    const last = getLastTick();
    expect(last?.ranAt).toBe(1_700_000_000_000);
    expect(last?.summary).toMatchObject({ candidatesScreened: 5, signalsGenerated: 2, entriesOpened: 1 });
  });

  it('overwrites the previous snapshot on the next save — a snapshot, not a history', () => {
    saveLastTick(summary({ candidatesScreened: 1 }));
    saveLastTick(summary({ candidatesScreened: 2 }));
    expect(getLastTick()?.summary.candidatesScreened).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM autotrade_last_tick').get()).toEqual({ n: 1 });
  });

  it('preserves a skippedReason through the round trip', () => {
    saveLastTick(summary({ ranEntries: false, skippedReason: 'Market is closed' }));
    expect(getLastTick()?.summary.skippedReason).toBe('Market is closed');
  });
});

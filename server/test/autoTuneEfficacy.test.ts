import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, addExit } from '../src/db/positions';
import { computeAutoTuneRiskEfficacy } from '../src/services/autotrading/autoTuneEfficacy';

// autotrade_events.created_at is always Date.now() inside logAutotradeEvent()
// (no override parameter) — a raw INSERT is the only way to fix a test
// event's timestamp to a specific historical date, which this needs since
// the whole point is comparing positions' entryDate against it.
function seedRiskAdjustedEvent(
  createdAt: number,
  detail: { from: number; to: number; kellySuggested: number; sampleSize: number },
) {
  db.prepare(
    `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at)
     VALUES (NULL, 'config', 'auto_tune_risk_adjusted', ?, NULL, ?)`,
  ).run(JSON.stringify(detail), createdAt);
}

const ADJUSTED_AT = Date.parse('2026-08-10T15:00:00Z'); // a Monday, well inside market hours ET

function autotradeTrade(pnl: number, entryDate: string) {
  const p = createPosition({
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    entryDate,
    tags: ['autotrade'],
  });
  addExit(p.id, { quantity: 1, exitPrice: 100 + pnl, exitDate: entryDate });
  return p;
}

function manualTrade(pnl: number, entryDate: string) {
  // No 'autotrade' tag — must never count toward before/after stats.
  const p = createPosition({
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 1,
    entryPrice: 100,
    entryDate,
  });
  addExit(p.id, { quantity: 1, exitPrice: 100 + pnl, exitDate: entryDate });
  return p;
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_events;');
});

describe('computeAutoTuneRiskEfficacy', () => {
  it('returns an empty list with no auto_tune_risk_adjusted events at all', () => {
    expect(computeAutoTuneRiskEfficacy()).toEqual([]);
  });

  it('splits autotrade trades into before/after by entry date relative to the adjustment', () => {
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 20 });
    autotradeTrade(100, '2026-08-05'); // before
    autotradeTrade(-50, '2026-08-08'); // before
    autotradeTrade(80, '2026-08-11'); // after
    const [result] = computeAutoTuneRiskEfficacy();
    expect(result.before.totalClosed).toBe(2);
    expect(result.after.totalClosed).toBe(1);
  });

  it('treats a trade entered on the adjustment day itself as "after"', () => {
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 20 });
    autotradeTrade(50, '2026-08-10'); // same ET day as the adjustment
    const [result] = computeAutoTuneRiskEfficacy();
    expect(result.before.totalClosed).toBe(0);
    expect(result.after.totalClosed).toBe(1);
  });

  it('excludes manually-placed (non-autotrade-tagged) trades entirely', () => {
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 20 });
    autotradeTrade(100, '2026-08-05');
    manualTrade(9999, '2026-08-05'); // huge P&L, must not leak into before's stats
    const [result] = computeAutoTuneRiskEfficacy();
    expect(result.before.totalClosed).toBe(1);
    expect(result.before.totalRealized).toBe(100);
  });

  it('surfaces the from/to/kellySuggested/sampleSize the adjustment itself journaled', () => {
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 24 });
    const [result] = computeAutoTuneRiskEfficacy();
    expect(result.from).toBe(1);
    expect(result.to).toBe(1.3);
    expect(result.kellySuggestedAtTheTime).toBe(1.5);
    expect(result.sampleSizeAtTheTime).toBe(24);
    expect(result.adjustedAt).toBe(ADJUSTED_AT);
  });

  it('returns one entry per adjustment, newest first, each with its own independent split', () => {
    const laterAdjustedAt = Date.parse('2026-08-17T15:00:00Z'); // a week later
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 20 });
    seedRiskAdjustedEvent(laterAdjustedAt, { from: 1.3, to: 1.5, kellySuggested: 1.6, sampleSize: 25 });
    autotradeTrade(100, '2026-08-05'); // before both
    autotradeTrade(50, '2026-08-12'); // after the first, before the second
    autotradeTrade(-20, '2026-08-18'); // after both
    const results = computeAutoTuneRiskEfficacy();
    expect(results).toHaveLength(2);
    expect(results[0].adjustedAt).toBe(laterAdjustedAt); // newest first
    expect(results[0].before.totalClosed).toBe(2); // the 08-05 and 08-12 trades
    expect(results[0].after.totalClosed).toBe(1); // the 08-18 trade
    expect(results[1].adjustedAt).toBe(ADJUSTED_AT);
    expect(results[1].before.totalClosed).toBe(1); // just 08-05
    expect(results[1].after.totalClosed).toBe(2); // 08-12 and 08-18
  });

  it('an adjustment with no trades on either side still returns valid (empty) stats, not a crash', () => {
    seedRiskAdjustedEvent(ADJUSTED_AT, { from: 1, to: 1.3, kellySuggested: 1.5, sampleSize: 20 });
    const [result] = computeAutoTuneRiskEfficacy();
    expect(result.before.totalClosed).toBe(0);
    expect(result.after.totalClosed).toBe(0);
    expect(result.before.kelly).toBeNull();
    expect(result.after.kelly).toBeNull();
  });
});

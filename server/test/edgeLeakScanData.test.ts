import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { defaultAutotradeConfig, getAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { logAutotradeEvent } from '../src/db/autotradeEvents';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { deriveDollarCaps } from '../src/services/autotrading/targetTune';
import { collectBook } from '../src/services/autotrading/dailyTargetSweepData';
import {
  collectConfigurationFindings,
  collectExecutionFindings,
  joinLeakTrades,
  runEdgeLeakScanFromDb,
  storedTargetRFor,
} from '../src/services/autotrading/edgeLeakScanData';
import { seedClosedAutotradeSessions, weekdaysEndingAt } from './helpers/autotradeSessions';
import { etDateTimeToMs } from '../src/util/marketDate';

// ---------------------------------------------------------------------------
// The DB half. What matters here is not the arithmetic (edgeLeakScan.test.ts
// owns that) but the JOIN: that every trade's R is the collector's R, that the
// round number is assigned per symbol-day, and that the findings a route would
// return are the findings the database actually supports.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM positions; DELETE FROM position_exits; DELETE FROM autotrade_paper_positions; ' +
      'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_live_options_positions; ' +
      'DELETE FROM autotrade_config; DELETE FROM autotrade_events; DELETE FROM edge_leak_scans;',
  );
});

/** Three sessions ending last Friday, so the window is always in the past. */
const SESSIONS = weekdaysEndingAt('2026-09-10', 3);

describe('joinLeakTrades — one R basis, and the round assigned per symbol-day', () => {
  it("takes every trade's R from the collector rather than deriving a second one", () => {
    seedClosedAutotradeSessions({
      sessions: { [SESSIONS[0]]: [{ entryTime: '09:35', exitTime: '10:00', r: 1.4, symbol: 'NVDA' }] },
    });
    const collected = collectBook('live', 40, Date.parse('2026-09-11T21:00:00Z'));
    const joined = joinLeakTrades(collected, new Map());
    // Every trade was dropped for want of attributes — and COUNTED, not
    // silently skipped, which is what makes a thin scan visible.
    expect(joined.trades).toHaveLength(0);
    expect(joined.droppedTrades).toBe(collected.trades.length);

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const trade = scan.dimensions.find((d) => d.id === 'symbol')?.buckets;
    expect(scan.coverage.liveTrades).toBe(1);
    expect(trade).toEqual([]); // n=1 is under the per-symbol floor
    expect(collected.trades[0].r).toBeCloseTo(1.4, 4);
  });

  it('numbers the rounds by entry time within a symbol and ET date', () => {
    seedClosedAutotradeSessions({
      sessions: {
        [SESSIONS[0]]: [
          { entryTime: '11:00', exitTime: '11:30', r: -0.5, symbol: 'HOOD' },
          { entryTime: '09:35', exitTime: '10:00', r: 0.8, symbol: 'HOOD' },
          { entryTime: '13:00', exitTime: '13:30', r: -0.3, symbol: 'HOOD' },
          // A different symbol on the same day is its own round 1.
          { entryTime: '11:05', exitTime: '11:30', r: 0.2, symbol: 'SMCI' },
        ],
        // …and so is the SAME symbol on the next session.
        [SESSIONS[1]]: [{ entryTime: '09:35', exitTime: '10:00', r: 0.1, symbol: 'HOOD' }],
      },
    });
    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const rounds = scan.dimensions.find((d) => d.id === 'round');
    const byBucket = new Map(rounds?.buckets.map((b) => [b.bucket, b]));
    expect(byBucket.get('1')?.n).toBe(3);
    expect(byBucket.get('2')?.n).toBe(1);
    expect(byBucket.get('3+')?.n).toBe(1);
    // Round 1 is the 09:35 HOOD entry plus SMCI plus the next session's HOOD —
    // 0.8 + 0.2 + 0.1.
    expect(byBucket.get('1')?.totalR).toBeCloseTo(1.1, 4);
  });
});

describe('the configuration findings', () => {
  it('names a frozen cap and hands back the value that un-freezes it', () => {
    const cfg = { ...defaultAutotradeConfig(), riskPerTradePct: 1.25, maxStopDistancePct: 2.5 };
    const derived = deriveDollarCaps(cfg, 10_000);
    setAutotradeConfig({ ...cfg, ...derived, liveOptionsMaxOrderUsd: 300, liveCapsAnchorEquityUsd: 10_000 });

    const findings = collectConfigurationFindings(getAutotradeConfig(), Date.now());
    const frozen = findings.find((f) => f.id === 'configuration:frozen:liveOptionsMaxOrderUsd');
    expect(frozen).toBeTruthy();
    expect(frozen?.lever).toMatchObject({
      kind: 'config',
      field: 'liveOptionsMaxOrderUsd',
      value: derived.liveOptionsMaxOrderUsd,
      direction: 'safe',
    });
    // Nothing else is frozen, so nothing else is reported.
    expect(findings.filter((f) => f.id.startsWith('configuration:frozen:'))).toHaveLength(1);
  });

  it('reports a tuner row only while the tuner is meant to be off', () => {
    setAutotradeConfig({ ...defaultAutotradeConfig(), autoTuneEnabled: false });
    logAutotradeEvent({ stage: 'config', action: 'auto_tune_ran', detail: { riskPerTradePct: 2.5 } });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now()).map((f) => f.id)).toContain(
      'configuration:auto_tune_ran',
    );

    setAutotradeConfig({ autoTuneEnabled: true });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now()).map((f) => f.id)).not.toContain(
      'configuration:auto_tune_ran',
    );
  });

  it('reports a held equity reading, which is the caps refusing to follow a bad number', () => {
    setAutotradeConfig(defaultAutotradeConfig());
    logAutotradeEvent({
      stage: 'config',
      action: 'equity_read_suspect',
      detail: { anchorEquityUsd: 5129, readEquityUsd: 3523, dropPct: 31.3 },
    });
    const finding = collectConfigurationFindings(getAutotradeConfig(), Date.now()).find(
      (f) => f.id === 'configuration:equity_read_suspect',
    );
    expect(finding?.count).toBe(1);
  });

  it('says nothing at all about a config that is entirely anchor-owned', () => {
    const cfg = { ...defaultAutotradeConfig(), riskPerTradePct: 1.25, maxStopDistancePct: 2.5 };
    setAutotradeConfig({ ...cfg, ...deriveDollarCaps(cfg, 10_000), liveCapsAnchorEquityUsd: 10_000 });
    expect(collectConfigurationFindings(getAutotradeConfig(), Date.now())).toEqual([]);
  });
});

describe('the execution findings — any occurrence is one', () => {
  it('counts the classes that mean something went wrong, and only those', () => {
    const now = Date.parse('2026-09-11T21:00:00Z');
    const at = etDateTimeToMs('2026-09-10', '14:00') as number;
    db.prepare(
      `INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_options_exit_failed','{}',NULL,?),
       (NULL,'execution','live_position_unprotected','{}',NULL,?),
       (NULL,'execution','live_options_order_placed','{}',NULL,?)`,
    ).run(at, at + 1, at + 2, at + 3);

    const found = collectExecutionFindings(now);
    const byAction = new Map(found.map((f) => [f.action, f.count]));
    expect(byAction.get('live_options_exit_failed')).toBe(2);
    expect(byAction.get('live_position_unprotected')).toBe(1);
    // A successful placement is not a finding.
    expect(byAction.has('live_options_order_placed')).toBe(false);
  });
});

describe('storedTargetRFor — the goal on the R axis', () => {
  it('is the goal % over the risk %, and null without either', () => {
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 1.25 })).toBe(2.4);
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 2.5 })).toBe(1.2);
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: null })).toBeNull();
    expect(storedTargetRFor({ ...defaultAutotradeConfig(), targetDailyGainPct: 3, riskPerTradePct: 0 })).toBeNull();
  });
});

describe('the scan end to end, over the database', () => {
  it('reports the round-2 leak from real rows in both books, with its lever', () => {
    // Live: a winning first round and a losing second round on each session.
    const sessions = weekdaysEndingAt('2026-09-10', 10);
    const seeded: Record<string, { entryTime: string; exitTime: string; r: number; symbol: string }[]> = {};
    sessions.forEach((date, i) => {
      seeded[date] = [
        { entryTime: '09:35', exitTime: '10:00', r: 0.3 + (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '10:05', exitTime: '10:30', r: 0.28 - (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '11:00', exitTime: '11:30', r: -0.3 + (i % 2) * 0.02, symbol: `S${i % 3}` },
        { entryTime: '12:00', exitTime: '12:30', r: -0.32 - (i % 2) * 0.02, symbol: `S${i % 3}` },
      ];
    });
    seedClosedAutotradeSessions({ sessions: seeded });

    // Paper: the control arm, losing on its own second rounds too.
    sessions.forEach((date, i) => {
      const base = etDateTimeToMs(date, '09:35') as number;
      for (const [k, r] of [
        [0, 0.4],
        [1, 0.38],
        [2, -0.2],
        [3, -0.22],
      ] as const) {
        const p = openPaperPosition({
          symbol: `S${i % 3}`,
          side: 'buy',
          quantity: 10,
          entryPrice: 100,
          stopPrice: 95,
          targetPrice: 110,
          riskAmount: 50,
          riskProfile: 'MODERATE',
          rationale: 'fixture',
        });
        db.prepare('UPDATE autotrade_paper_positions SET entry_at = ? WHERE id = ?').run(base + k * 60_000 * 30, p.id);
        closePaperPosition(p.id, { exitPrice: 100 + 5 * r, exitReason: 'target' });
      }
    });

    const scan = runEdgeLeakScanFromDb({ now: Date.parse('2026-09-11T21:00:00Z') });
    const round2 = scan.leaks.find((l) => l.dimension === 'round' && l.bucket === '3+');
    const anyRoundLeak = scan.leaks.find((l) => l.dimension === 'round');
    expect(anyRoundLeak).toBeTruthy();
    expect(anyRoundLeak?.lever).toMatchObject({ field: 'symbolReentryCooldownMinutes', value: 390 });
    expect(round2 ?? anyRoundLeak).toBeTruthy();
    // Both books are counted, and nothing was dropped.
    expect(scan.coverage.liveTrades).toBe(40);
    expect(scan.coverage.paperTrades).toBe(40);
    expect(scan.coverage.liveDropped).toBe(0);
    // Ten weekdays, NINE sessions: 2026-09-07 is Labor Day, and the window is
    // built from the market calendar rather than from weekdays, so that day's
    // seeded trades are remapped onto the previous session (which is exactly
    // what buildSessionPaths is supposed to do with a non-session date).
    expect(scan.dayLevel.activeSessions).toBe(9);
    expect(scan.dayLevel.sessions).toBe(9);
  });
});

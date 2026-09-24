import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, initDb } from '../src/db';
import { defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { closePaperPosition, openPaperPosition } from '../src/db/autotradePaperPositions';
import { addSymbols } from '../src/db/universe';
import { Candle, Timeframe } from '../src/providers/types';
import { etDateTimeToMs } from '../src/util/marketDate';
import { runTapeBackfill, TapeBackfillResult } from '../src/services/autotrading/historicalTapeData';

// ---------------------------------------------------------------------------
// The tape rebuild at its consumers (the tape plan's PR 3). The rebuilt
// readings are only worth anything where something READS them: the edge-leak
// scan's by-side cut, and the two short replays. So every test here drives
// runTapeBackfill end to end — bars through a fake fetch, the book and the
// journal from the database — and asserts on what came out the far side.
// ---------------------------------------------------------------------------

const DAY = '2026-09-10';
const NOW = Date.parse('2026-09-10T21:00:00Z'); // 17:00 ET: the session is complete
const at = (hhmm: string) => etDateTimeToMs(DAY, hhmm) as number;
const OURS = Array.from({ length: 110 }, (_, i) => `TPB${String(i).padStart(3, '0')}`);

/** Weekdays from `from` to `to`, inclusive. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * A red session, as Polygon would serve it: every name 2% under its prior
 * close from the 09:35 bar and 9% under from 10:30 (so a short taken at 10:30
 * pays), SPY 0.1% down in the first bar and 0.5% from the next. A premarket
 * bar at 04:00 prints green on everything, and must move nothing.
 */
async function redSession(symbol: string, timeframe: Timeframe, from: string, to: string): Promise<Candle[]> {
  const isIndex = symbol === 'SPY';
  const base = isIndex ? 100 : 50;
  if (timeframe === 'daily') {
    return weekdays(from, to).map((d) => ({
      time: Date.parse(`${d}T00:00:00Z`),
      open: base,
      high: base + (isIndex ? 0.5 : 2),
      low: base - (isIndex ? 0.5 : 2),
      close: base,
      volume: 1e6,
    }));
  }
  const bars: Candle[] = [
    { time: at('04:00'), open: base * 1.02, high: base * 1.02, low: base * 1.02, close: base * 1.02, volume: 10 },
  ];
  for (let m = 9 * 60 + 30; m < 16 * 60; m += 5) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const pct = isIndex ? (hhmm === '09:30' ? -0.1 : -0.5) : hhmm === '09:30' ? -0.1 : hhmm < '10:30' ? -2 : -9;
    const close = base * (1 + pct / 100);
    const open = !isIndex && hhmm === '10:30' ? 49 : close;
    bars.push({
      time: at(hhmm),
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      volume: 1_000,
    });
  }
  return bars;
}

function insertEvent(symbol: string | null, stage: string, action: string, detail: unknown, createdAt: number) {
  db.prepare(
    'INSERT INTO autotrade_events (symbol, stage, action, detail, risk_profile, created_at) VALUES (?,?,?,?,NULL,?)',
  ).run(symbol, stage, action, JSON.stringify(detail), createdAt);
}

function paperTrade(symbol: string, side: 'buy' | 'sell', entryAt: number, exitPrice: number) {
  const p = openPaperPosition({
    symbol,
    side,
    quantity: 10,
    entryPrice: 49,
    stopPrice: side === 'buy' ? 48 : 50,
    targetPrice: side === 'buy' ? 51 : 47,
    riskAmount: 10,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
  });
  closePaperPosition(p.id, { exitPrice, exitReason: exitPrice === 47 ? 'target' : 'stop' });
  db.prepare('UPDATE autotrade_paper_positions SET entry_at = ?, exit_at = ? WHERE id = ?').run(
    entryAt,
    entryAt + 30 * 60_000,
    p.id,
  );
}

/** A short signal and its tick's candidate row, as decide.ts and screen.ts
 *  journal them. */
function shortSignal(symbol: string, hhmm: string, score: number, stop = 50) {
  insertEvent(symbol, 'screen', 'candidate_found', { direction: 'short', total: score, price: 49 }, at(hhmm) - 2_000);
  insertEvent(symbol, 'decision', 'signal_generated', { side: 'sell', entry: 49, stop, target: 47 }, at(hhmm));
}

const run = () =>
  runTapeBackfill({
    fetch: redSession,
    sessions: 1,
    now: NOW,
  });

const bucket = (r: TapeBackfillResult, tape: string, atr = false) =>
  (atr ? r.counterfactual.atrReachableByTape : r.counterfactual.byTape).find((b) => b.tape === tape);

beforeAll(() => {
  initDb();
  addSymbols(OURS.map((symbol) => ({ symbol, sector: 'Technology' })));
});
afterAll(() => {
  db.prepare("DELETE FROM universe WHERE symbol LIKE 'TPB%'").run();
});
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events; DELETE FROM autotrade_paper_positions; DELETE FROM positions;');
  setAutotradeConfig({ ...defaultAutotradeConfig(), maxRiskAtrFraction: 0.7 });
});

describe('runTapeBackfill — the rebuilt tape, read by the app’s own readers', () => {
  it('rebuilds the session from the regular-session bars, and journals a row per change', async () => {
    const r = await run();
    expect(r.sessions).toEqual([DAY]);
    expect(r.coverage).toEqual([expect.objectContaining({ day: DAY, slots: 78, unknownSlots: 0 })]);
    // The 09:30 bar (SPY -0.1%) reads mixed at 09:35; the 09:35 bar reads red
    // at 09:40, and the day stays red. The green 04:00 print moved nothing.
    expect(r.rows.map((x) => [x.at, x.direction])).toEqual([
      [at('09:35'), 'mixed'],
      [at('09:40'), 'red'],
    ]);
    expect(r.liveDays).toEqual([]);
  });

  it('files a rebuilt-red paper short in equity_short_red, and a paper long in equity_long_red', async () => {
    paperTrade('TPB001', 'sell', at('10:30'), 47);
    paperTrade('TPB002', 'buy', at('10:30'), 48);
    const r = await run();
    const bySide = r.leakScan.bySide;
    expect(Object.fromEntries(bySide!.buckets.map((b) => [b.bucket, { live: b.n, paper: b.control?.n ?? 0 }]))).toEqual(
      {
        equity_short_red: { live: 0, paper: 1 },
        equity_long_red: { live: 0, paper: 1 },
      },
    );
  });

  it('takes a day the loop journaled from the journal, and measures the rebuild against it', async () => {
    // The loop read green from 09:31 on this day: that is the tape of record.
    insertEvent(null, 'screen', 'market_direction_read', { direction: 'green' }, at('09:31'));
    paperTrade('TPB001', 'sell', at('10:30'), 47);
    const r = await run();
    expect(r.liveDays).toEqual([DAY]);
    expect(r.leakScan.bySide!.buckets.map((b) => [b.bucket, b.control?.n ?? 0])).toEqual([['equity_short_green', 1]]);
    // Every rebuilt slot disagreed with the loop's green.
    expect(r.parity).toEqual([{ day: DAY, compared: 78, agreed: 0 }]);
    expect(r.flips.find((f) => f.day === DAY)?.source).toBe('journal');
  });

  it('replays a declined live short at the tape it was declined on', async () => {
    insertEvent(
      'TPB003',
      'execution',
      'live_short_skipped',
      { score: 85, entry: 49, stop: 50, target: 47, liveEligible: true, liveMinSignalScore: 81 },
      at('10:30'),
    );
    const r = await run();
    expect(r.shortShadow.rows).toBe(1);
    const red = r.shortShadow.byTape.find((b) => b.tape === 'red');
    expect(red?.n).toBe(1);
    expect(red!.avgR!).toBeGreaterThan(0);
    expect(r.shortShadow.byTape.find((b) => b.tape === 'all')?.n).toBe(1);
  });

  it('replays every short signal by the tape it met, under the floor in force and the ATR gate', async () => {
    // The floor in force on the day, as a refusal recorded it: 81.
    insertEvent('ZZZ', 'execution', 'live_score_floor_skipped', { liveMinSignalScore: 81 }, at('09:40'));
    shortSignal('TPB006', '09:32', 85); // before the first reading: unlabeled
    shortSignal('TPB007', '09:37', 85); // the 09:35 reading: mixed
    shortSignal('TPB004', '10:30', 85); // red
    shortSignal('TPB004', '10:45', 88); // the same symbol-day again: the first is kept
    shortSignal('TPB005', '10:30', 75); // red, under the floor
    shortSignal('TPB008', '10:30', 90, 52); // red, but a 3.00 stop against a 4.00 ATR: 3 > 0.7 x 4
    const r = await run();

    expect(r.counterfactual.signals).toBe(6);
    expect(r.counterfactual.unscored).toBe(0);
    expect(r.counterfactual.floorNow).toBe(0);
    expect(bucket(r, 'unlabeled')?.n).toBe(1);
    expect(bucket(r, 'mixed')?.n).toBe(1);
    expect(bucket(r, 'red')?.n).toBe(2); // TPB004 once, TPB008
    expect(bucket(r, 'all')?.n).toBe(4); // TPB004, TPB006, TPB007, TPB008
    expect(r.counterfactual.excluded.below_live_floor).toBeGreaterThan(0);
    // The live entry path's ATR gate refuses TPB008 and nothing else.
    expect(bucket(r, 'red', true)?.n).toBe(1);
    expect(bucket(r, 'all', true)?.n).toBe(3);
    expect(r.counterfactual.atrUnknown).toBe(0);
  });

  it("reads the floor from the floor's own refusal where the row predates liveMinSignalScore", async () => {
    // 2026-09-08 to 09-10: the only record of the floor is the `bar` of a
    // `live_floor` refusal. Read as no floor, TPB005 (75) would clear it.
    insertEvent('ZZZ', 'execution', 'live_score_floor_skipped', { bar: 81, source: 'live_floor' }, at('09:40'));
    // Another source's bar is not the everyday floor, and must not be read as it.
    insertEvent('YYY', 'execution', 'live_score_floor_skipped', { bar: 95, source: 'armed_day' }, at('09:41'));
    shortSignal('TPB004', '10:30', 85); // red, over 81
    shortSignal('TPB005', '10:30', 75); // red, under 81
    const r = await run();

    expect(r.counterfactual.signals).toBe(2);
    expect(bucket(r, 'red')?.n).toBe(1); // TPB004 only: 95 would refuse it, 0 would keep both
    expect(r.counterfactual.excluded.below_live_floor).toBe(1);
  });
});

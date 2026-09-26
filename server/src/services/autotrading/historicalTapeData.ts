import { getAutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEventsInWindow } from '../../db/autotradeEvents';
import { listUniverseSymbols } from '../../db/universe';
import { Candle } from '../../providers/types';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import { sessionDatesEndingAt } from '../trading/marketCalendar';
import { atrReachRefuses } from './atrReach';
import { lastCompletedSessionDate } from './dailyTargetSweepData';
import { DeclinedEntry } from './declinedEntry';
import { buildDeclinedEntryShadow, DECLINED_SHADOW_REPLAY_VERSION, ShadowTrade } from './declinedEntryShadow';
import { liveEntryConcessionPct } from './declinedEntryShadowData';
import { DimensionReport, mulberry32, SCAN_RNG_SEED } from './edgeLeakScan';
import { runEdgeLeakScanFromDb } from './edgeLeakScanData';
import {
  atrBefore,
  directionChangeRows,
  directionSlots,
  FloorObservation,
  floorReader,
  flipsPerSession,
  JournaledCandidate,
  JournaledSignal,
  mergeDirectionIndex,
  readingsFromBars,
  scoreSignals,
  seededSample,
  TAPE_BUCKETS,
  TapeBucket,
  tapeBucketOf,
  TapeReading,
  TapeSeries,
  TapeThresholds,
  toDirectionIndex,
  WindowBarFetch,
  windowCandleSource,
} from './historicalTape';
import { MARKET_DIRECTION_INDEX_SYMBOL, MarketDirection } from './marketDirection';
import { directionAt, directionIndex } from './marketDirectionIndex';
import { loadSkippedShorts, SHORT_SHADOW_SINCE_MS } from './shortShadowRecordData';
import { computeSignificanceStats } from './significance';

// ---------------------------------------------------------------------------
// The tape rebuild's database half (the tape plan's PR 3, 2026-09-26): fetch
// the bars, rebuild the readings (historicalTape.ts), and read the record
// against them with the app's own readers — the edge-leak scan and the
// declined-entry replay — so no R is derived here a second way.
//
// Run by scripts/tapeBackfill.ts against a COPY of the database, never the
// live one: the bars it fetches are cached in the copy's `backtest_bars`, and
// nothing it computes is written anywhere else. Rebuilt readings never count
// toward any switch.
// ---------------------------------------------------------------------------

/** The seed a breadth sample is drawn with, when one is asked for. By default
 *  breadth reads the whole universe, as the loop does; a sample trades Polygon
 *  calls for sampling error, about 4 points on a 65% share at 120 names. */
export const TAPE_SAMPLE_SEED = 20260926;
/** The edge-leak scan's own default window. */
export const TAPE_DEFAULT_SESSIONS = 40;
/** Calendar days of daily bars fetched before the first session: 15 bars for a
 *  14-day ATR, and the prior close, with holidays to spare. */
const DAILY_LEAD_DAYS = 45;
/** Journal rows the counterfactual may read: far past any window's
 *  `signal_generated` count (~3,000 short rows a session), so reaching it means
 *  the read was cut, and the report says so. */
const JOURNAL_READ_MAX = 2_000_000;

export interface TapeBucketStats {
  tape: TapeBucket | 'all';
  n: number;
  avgR: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  winRatePct: number | null;
  totalR: number;
}

/** A replay read by tape: every bucket, then all of them together. */
export interface TapeReplayReading {
  byTape: TapeBucketStats[];
  /** The same trades after the ATR reachability gate the live entry path
   *  applies right after the shorts-off skip (atrReach.ts), with each name's
   *  ATR as of the previous close. */
  atrReachableByTape: TapeBucketStats[];
  /** Rows whose name had no daily bars to take an ATR from: kept, and
   *  counted, since the live gate refuses nothing it cannot measure. */
  atrUnknown: number;
  excluded: Record<string, number>;
}

export interface TapeBackfillResult {
  asOf: number;
  sessions: string[];
  thresholds: TapeThresholds;
  /** The breadth sample (by default the whole universe): the names read,
   *  those whose fetch failed, and those Polygon returned no intraday bars for
   *  (not listed over the window). */
  sample: { size: number; seed: number; symbols: string[]; failed: string[]; empty: string[] };
  /** Per rebuilt session: slots read, slots the reading could not see, and the
   *  breadth sample's size across the day. */
  coverage: { day: string; slots: number; unknownSlots: number; minSample: number; medianSample: number }[];
  /** Days the journal already had readings for, and so were taken from it. */
  liveDays: string[];
  /** On those days, how often the rebuild agreed with the loop's own reading
   *  at the rebuild's slots: the rebuild's error, measured where it can be. */
  parity: { day: string; compared: number; agreed: number }[];
  /** Rebuilt slots by direction, over the sessions not taken from the
   *  journal. */
  tapeMix: Record<MarketDirection, number>;
  flips: { day: string; rows: number; flips: number; source: 'rebuilt' | 'journal' }[];
  /** The rebuilt rows themselves, one per change, as the loop would have
   *  journaled them: what the tables below were placed against. */
  rows: {
    day: string;
    at: number;
    direction: MarketDirection;
    heldBy: string | null;
    indexChangePct: number | null;
    redPct: number | null;
    greenPct: number | null;
    sample: number;
  }[];
  leakScan: {
    bySide: DimensionReport | null;
    alignment: DimensionReport | null;
    /** The by-side cut again, with the index leg alone deciding the tape:
     *  the same readings at a 0% breadth bar. The breadth leg is the rebuild's
     *  noisiest input; a result that holds without it does not rest on it. */
    spyOnlyBySide: DimensionReport | null;
  };
  entryConcessionPct: number;
  replayVersion: number;
  /** The declined live shorts (`live_short_skipped`, the shorts switch's own
   *  record), each at the tape it was declined on. */
  shortShadow: TapeReplayReading & { rows: number };
  /** Every short signal the decision step produced in the window
   *  (`signal_generated`), scored from its tick's candidate row and kept when
   *  it cleared the live floor in force at the time; per tape, the FIRST such
   *  signal per symbol-day. What a short book that traded only on one tape
   *  would have taken, not what the switch record holds. */
  counterfactual: TapeReplayReading & {
    signals: number;
    unscored: number;
    journalTruncated: boolean;
    floorNow: number;
  };
}

export interface TapeBackfillOptions {
  fetch: WindowBarFetch;
  /** Completed sessions to rebuild (default TAPE_DEFAULT_SESSIONS). */
  sessions?: number;
  /** Names in the breadth sample; unset reads the whole universe. */
  sampleSize?: number;
  seed?: number;
  now?: number;
  progress?: (line: string) => void;
}

function shiftCalendarDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function stats(tape: TapeBucket | 'all', trades: ShadowTrade[]): TapeBucketStats {
  const rs = trades.map((t) => t.exitR);
  const sig = computeSignificanceStats(
    rs.map((r) => ({ pnl: r })),
    { rng: mulberry32(SCAN_RNG_SEED) },
  );
  return {
    tape,
    n: rs.length,
    avgR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null,
    ciLow: sig.ciLow,
    ciHigh: sig.ciHigh,
    winRatePct: rs.length ? (rs.filter((v) => v > 0).length / rs.length) * 100 : null,
    totalR: rs.reduce((s, v) => s + v, 0),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The floor observations the journal holds: every row carrying
 *  `liveMinSignalScore`, and before those, the floor's own refusals. */
function floorObservations(since: number): FloorObservation[] {
  const out: FloorObservation[] = [];
  const { events } = listAutotradeEventsInWindow(
    {
      actions: [
        'live_short_skipped',
        'live_score_floor_skipped',
        'risk_atr_unreachable_skipped',
        'live_symbol_held_skipped',
        'symbol_reentry_cooldown_skipped',
      ],
      since,
    },
    JOURNAL_READ_MAX,
  );
  for (const e of events) {
    if (!e.detail) continue;
    try {
      const d = JSON.parse(e.detail) as { liveMinSignalScore?: unknown; bar?: unknown; source?: unknown };
      // Refusal rows carry the floor as `liveMinSignalScore` from 2026-09-11.
      // Before that (09-08 to 09-10 on the production record) only the floor's
      // own refusals recorded it, as the `bar` of a `live_floor` refusal, and
      // without them those days read as no floor at all (0), so every short
      // signal on them counted as clearing it (review, 2026-09-24). Another
      // source's bar (the armed-day or High-Vol bar) is not the everyday floor.
      const floor =
        typeof d.liveMinSignalScore === 'number'
          ? d.liveMinSignalScore
          : e.action === 'live_score_floor_skipped' && d.source === 'live_floor'
            ? d.bar
            : undefined;
      if (typeof floor === 'number' && Number.isFinite(floor)) out.push({ at: e.createdAt, floor });
    } catch {
      // A row that does not parse records no floor.
    }
  }
  return out;
}

function journaledShortSignals(since: number): { signals: JournaledSignal[]; truncated: boolean } {
  const { events, truncated } = listAutotradeEventsInWindow({ actions: ['signal_generated'], since }, JOURNAL_READ_MAX);
  const signals: JournaledSignal[] = [];
  for (const e of events) {
    if (!e.symbol || !e.detail) continue;
    try {
      const d = JSON.parse(e.detail) as { side?: unknown; entry?: unknown; stop?: unknown };
      if (d.side !== 'sell' || typeof d.entry !== 'number' || typeof d.stop !== 'number') continue;
      signals.push({ symbol: e.symbol, at: e.createdAt, side: 'sell', entry: d.entry, stop: d.stop });
    } catch {
      // Unparseable: not a signal the replay can use.
    }
  }
  return { signals, truncated };
}

function journaledShortCandidates(since: number): { candidates: JournaledCandidate[]; truncated: boolean } {
  const { events, truncated } = listAutotradeEventsInWindow({ actions: ['candidate_found'], since }, JOURNAL_READ_MAX);
  const candidates: JournaledCandidate[] = [];
  for (const e of events) {
    if (!e.symbol || !e.detail) continue;
    try {
      const d = JSON.parse(e.detail) as { direction?: unknown; total?: unknown };
      if (d.direction !== 'short' || typeof d.total !== 'number') continue;
      candidates.push({ symbol: e.symbol, at: e.createdAt, direction: 'short', total: d.total });
    } catch {
      // Unparseable: no score to join.
    }
  }
  return { candidates, truncated };
}

/**
 * Rebuild the tape over the last `sessions` completed sessions and read the
 * record against it. Bars come through `fetch` (the script passes
 * historicalData.getHistoricalBars), one call per symbol and timeframe for the
 * whole window.
 */
export async function runTapeBackfill(opts: TapeBackfillOptions): Promise<TapeBackfillResult> {
  const now = opts.now ?? Date.now();
  const lookback = opts.sessions ?? TAPE_DEFAULT_SESSIONS;
  const seed = opts.seed ?? TAPE_SAMPLE_SEED;
  const progress = opts.progress ?? (() => undefined);
  const cfg = getAutotradeConfig();
  const thresholds: TapeThresholds = {
    indexPct: cfg.marketDirectionIndexPct,
    breadthPct: cfg.marketDirectionBreadthPct,
    exitIndexPct: cfg.marketDirectionExitIndexPct,
    exitBreadthPct: cfg.marketDirectionExitBreadthPct,
  };

  const sessions = sessionDatesEndingAt(lastCompletedSessionDate(now), lookback);
  if (sessions.length === 0) throw new Error('no completed sessions to rebuild');
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const window = { from: shiftCalendarDays(first, -DAILY_LEAD_DAYS), to: last };
  const source = windowCandleSource(opts.fetch, window);
  const windowStart = etDateTimeToMs(first, '00:00') ?? now - lookback * 86_400_000;

  const series = async (symbol: string): Promise<TapeSeries> => ({
    symbol,
    intraday: await source.getCandles(symbol, '5min', { start: window.from, end: window.to }),
    daily: await source.getCandles(symbol, 'daily', { start: window.from, end: window.to }),
  });

  // The index must load: without it no slot can be read at all.
  progress(`index ${MARKET_DIRECTION_INDEX_SYMBOL}: ${window.from}..${window.to}`);
  const index = await series(MARKET_DIRECTION_INDEX_SYMBOL);

  const universe = listUniverseSymbols();
  const sampleSize = opts.sampleSize ?? universe.length;
  const symbols = seededSample(universe, sampleSize, seed);
  const names: TapeSeries[] = [];
  const failed: string[] = [];
  const empty: string[] = [];
  for (const [i, symbol] of symbols.entries()) {
    try {
      const s = await series(symbol);
      if (s.intraday.length === 0) empty.push(symbol);
      names.push(s);
    } catch (e) {
      failed.push(symbol);
      progress(`  ${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((i + 1) % 10 === 0) progress(`sample ${i + 1}/${symbols.length}`);
  }

  // --- the readings --------------------------------------------------------
  const readings: TapeReading[] = [];
  const spyOnly: TapeReading[] = [];
  const coverage: TapeBackfillResult['coverage'] = [];
  for (const day of sessions) {
    const dayReadings = readingsFromBars(day, index, names, thresholds);
    readings.push(...dayReadings);
    spyOnly.push(...readingsFromBars(day, index, names, { ...thresholds, breadthPct: 0, exitBreadthPct: 0 }));
    const samples = dayReadings.map((r) => r.reading.sample);
    coverage.push({
      day,
      slots: dayReadings.length,
      unknownSlots: dayReadings.filter((r) => r.reading.direction === 'unknown').length,
      minSample: samples.length ? Math.min(...samples) : 0,
      medianSample: median(samples),
    });
  }
  const changeRows = directionChangeRows(readings);
  const rebuilt = toDirectionIndex(changeRows);
  const live = directionIndex(windowStart);
  const merged = mergeDirectionIndex(rebuilt, live);
  const liveDays = [...live.keys()].filter((d) => sessions.includes(d) && (live.get(d)?.length ?? 0) > 0).sort();

  const parity = liveDays.map((day) => {
    let compared = 0;
    let agreed = 0;
    for (const r of readings) {
      if (r.day !== day) continue;
      const loop = directionAt(live, day, r.at);
      if (loop === null) continue;
      compared += 1;
      if (loop === r.reading.direction) agreed += 1;
    }
    return { day, compared, agreed };
  });

  const tapeMix: Record<MarketDirection, number> = { red: 0, green: 0, mixed: 0, unknown: 0 };
  const slots = directionSlots(readings.filter((r) => !liveDays.includes(r.day)));
  for (const k of Object.keys(tapeMix) as MarketDirection[]) tapeMix[k] = slots[k];

  const liveFlips = new Set(liveDays);
  const flips = flipsPerSession(merged)
    .filter((f) => sessions.includes(f.day))
    .map((f) => ({ ...f, source: liveFlips.has(f.day) ? ('journal' as const) : ('rebuilt' as const) }));

  // --- the book, by the app's own scan -------------------------------------
  progress('edge-leak scan');
  const scan = runEdgeLeakScanFromDb({ lookbackSessions: lookback, directions: merged, now });
  const spyOnlyScan = runEdgeLeakScanFromDb({
    lookbackSessions: lookback,
    directions: toDirectionIndex(directionChangeRows(spyOnly)),
    now,
  });
  const dimension = (s: typeof scan, id: string) => s.dimensions.find((d) => d.id === id) ?? null;

  // --- the replays -----------------------------------------------------------
  const entryConcessionPct = liveEntryConcessionPct();
  const tapeOf = (at: number): TapeBucket => tapeBucketOf(directionAt(merged, etToday(at), at));
  const atrMemo = new Map<string, number | null>();
  const atrOn = async (symbol: string, day: string): Promise<number | null> => {
    const key = `${symbol}|${day}`;
    if (!atrMemo.has(key)) {
      let daily: Candle[] | null;
      try {
        daily = await source.getCandles(symbol, 'daily', { start: window.from, end: window.to });
      } catch {
        daily = null;
      }
      atrMemo.set(key, daily ? atrBefore(daily, day) : null);
    }
    return atrMemo.get(key) ?? null;
  };
  // The live entry path's ATR gate, applied with each name's ATR as of the
  // previous close. Unknown ATR: kept (the live gate refuses nothing it cannot
  // measure) and counted.
  const atrFilter = async <T extends DeclinedEntry>(rows: T[]): Promise<{ kept: T[]; unknown: number }> => {
    const kept: T[] = [];
    let unknown = 0;
    for (const r of rows) {
      const atr = await atrOn(r.symbol, etToday(r.at));
      if (atr === null) unknown += 1;
      if (!atrReachRefuses(r.entry, r.stop, atr, cfg.maxRiskAtrFraction)) kept.push(r);
    }
    return { kept, unknown };
  };
  // The floor the replay itself filters on (buildDeclinedEntryShadow): applied
  // first here too, so the ATR gate only looks up names the replay would keep.
  const clearsFloor = (r: DeclinedEntry) => r.score >= (r.floorAtSkip ?? cfg.liveMinSignalScore);
  // One replay per tape, so each keeps the first row per symbol-day ON that
  // tape; then all tapes together. The replay does not re-apply the direction
  // gate: the tape is what is being read, not a filter on it.
  const replayByTape = async (
    rows: DeclinedEntry[],
  ): Promise<{ byTape: TapeBucketStats[]; excluded: Record<string, number> }> => {
    const tapes = rows.map((r) => tapeOf(r.at));
    const out: TapeBucketStats[] = [];
    const excluded: Record<string, number> = {};
    for (const tape of TAPE_BUCKETS) {
      const shadow = await buildDeclinedEntryShadow(
        source,
        rows.filter((_, i) => tapes[i] === tape),
        cfg,
        { entryConcessionPct },
      );
      out.push(stats(tape, shadow.trades));
      for (const [k, v] of Object.entries(shadow.excluded)) excluded[k] = (excluded[k] ?? 0) + v;
    }
    const all = await buildDeclinedEntryShadow(source, rows, cfg, { entryConcessionPct });
    out.push(stats('all', all.trades));
    return { byTape: out, excluded };
  };

  progress('short shadow record');
  const skipped = loadSkippedShorts(SHORT_SHADOW_SINCE_MS).rows.map((r) => ({ ...r, side: 'short' as const }));
  const shadowRead = await replayByTape(skipped);
  const shadowAtr = await atrFilter(skipped.filter(clearsFloor));
  const shadowAtrRead = await replayByTape(shadowAtr.kept);

  progress('short signals');
  const { signals, truncated: signalsTruncated } = journaledShortSignals(windowStart);
  const { candidates, truncated: candidatesTruncated } = journaledShortCandidates(windowStart - 10 * 60_000);
  const scored = scoreSignals(signals, candidates);
  // From well before the window, so the floor carried into its first session
  // is on record.
  const floorAt = floorReader(floorObservations(windowStart - 30 * 86_400_000));
  const signalRows: DeclinedEntry[] = scored.map((s) => ({
    symbol: s.symbol,
    at: s.at,
    score: s.score,
    entry: s.entry,
    stop: s.stop,
    side: 'short',
    floorAtSkip: floorAt(s.at),
  }));
  const cfRead = await replayByTape(signalRows);
  const cfAtr = await atrFilter(signalRows.filter(clearsFloor));
  const cfAtrRead = await replayByTape(cfAtr.kept);

  return {
    asOf: now,
    sessions,
    thresholds,
    sample: { size: sampleSize, seed, symbols, failed, empty },
    coverage,
    liveDays,
    parity,
    tapeMix,
    flips,
    rows: changeRows.map((r) => ({
      day: r.day,
      at: r.at,
      direction: r.reading.direction,
      heldBy: r.reading.heldBy ?? null,
      indexChangePct: r.reading.indexChangePct,
      redPct: r.reading.redPct,
      greenPct: r.reading.greenPct,
      sample: r.reading.sample,
    })),
    leakScan: {
      bySide: dimension(scan, 'marketTapeBySide'),
      alignment: dimension(scan, 'marketTape'),
      spyOnlyBySide: dimension(spyOnlyScan, 'marketTapeBySide'),
    },
    entryConcessionPct,
    replayVersion: DECLINED_SHADOW_REPLAY_VERSION,
    shortShadow: {
      rows: skipped.length,
      byTape: shadowRead.byTape,
      atrReachableByTape: shadowAtrRead.byTape,
      atrUnknown: shadowAtr.unknown,
      excluded: shadowRead.excluded,
    },
    counterfactual: {
      signals: signals.length,
      unscored: signals.length - scored.length,
      journalTruncated: signalsTruncated || candidatesTruncated,
      floorNow: cfg.liveMinSignalScore,
      byTape: cfRead.byTape,
      atrReachableByTape: cfAtrRead.byTape,
      atrUnknown: cfAtr.unknown,
      excluded: cfRead.excluded,
    },
  };
}

// --- the report ----------------------------------------------------------------

const fmtR = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
const fmtPct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

function replayTable(title: string, rows: TapeBucketStats[]): string[] {
  return [
    `**${title}**`,
    '',
    '| Tape | n | mean R | 95% CI | win % | total R |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.tape} | ${r.n} | ${fmtR(r.avgR)} | ${r.ciLow === null ? '—' : `${fmtR(r.ciLow)} … ${fmtR(r.ciHigh)}`} | ` +
        `${fmtPct(r.winRatePct)} | ${fmtR(r.totalR)} |`,
    ),
    '',
  ];
}

function dimensionTable(title: string, dim: DimensionReport | null): string[] {
  if (dim === null) return [`**${title}**: not reported.`, ''];
  const side = (n: number, meanR: number | null, lo: number | null, hi: number | null, total: number) =>
    `${n} | ${fmtR(meanR)} | ${lo === null ? '—' : `${fmtR(lo)} … ${fmtR(hi)}`} | ${fmtR(total)}`;
  return [
    `**${title}** (${dim.covered} trades placed, ${dim.uncovered} without a reading)`,
    '',
    '| Bucket | live n | live mean R | live 95% CI | live total R | paper n | paper mean R | paper 95% CI | paper total R |',
    '|---|---|---|---|---|---|---|---|---|',
    ...dim.buckets.map((b) => {
      const c = b.control;
      return (
        `| ${b.bucket} | ${side(b.n, b.meanR, b.ciLow, b.ciHigh, b.totalR)} | ` +
        `${c ? side(c.n, c.meanR, c.ciLow, c.ciHigh, c.totalR) : '0 | — | — | —'} |`
      );
    }),
    '',
  ];
}

/** The run as Markdown: what the reading in the spec is written from. */
export function formatTapeBackfill(r: TapeBackfillResult): string {
  const rebuiltFlips = r.flips.filter((f) => f.source === 'rebuilt');
  const meanFlips = rebuiltFlips.length ? rebuiltFlips.reduce((s, f) => s + f.flips, 0) / rebuiltFlips.length : null;
  const totalSlots = Object.values(r.tapeMix).reduce((s, v) => s + v, 0);
  const share = (v: number) => (totalSlots ? `${((v / totalSlots) * 100).toFixed(1)}%` : '—');
  return [
    `# Tape rebuild: ${r.sessions[0]} … ${r.sessions[r.sessions.length - 1]} (${r.sessions.length} sessions)`,
    '',
    `Thresholds: index ${r.thresholds.indexPct}% and ${r.thresholds.breadthPct}% of names; held inside ` +
      `${r.thresholds.exitIndexPct}% / ${r.thresholds.exitBreadthPct}%. Sample: ` +
      `${r.sample.symbols.length - r.sample.failed.length - r.sample.empty.length} of ${r.sample.symbols.length} names ` +
      `with bars (seed ${r.sample.seed})${r.sample.failed.length ? `; failed: ${r.sample.failed.join(', ')}` : ''}` +
      `${r.sample.empty.length ? `; no bars: ${r.sample.empty.join(', ')}` : ''}.`,
    `Days taken from the journal: ${r.liveDays.length ? r.liveDays.join(', ') : 'none'}.`,
    '',
    '## The rebuilt tape',
    '',
    `Slots: red ${share(r.tapeMix.red)}, green ${share(r.tapeMix.green)}, mixed ${share(r.tapeMix.mixed)}, ` +
      `unknown ${share(r.tapeMix.unknown)}. Flips per rebuilt session: ${meanFlips === null ? '—' : meanFlips.toFixed(1)} ` +
      `(max ${rebuiltFlips.length ? Math.max(...rebuiltFlips.map((f) => f.flips)) : '—'}).`,
    ...r.parity.map(
      (p) =>
        `Parity on ${p.day}: the rebuild agreed with the loop's reading at ${p.agreed} of ${p.compared} slots` +
        (p.compared ? ` (${((p.agreed / p.compared) * 100).toFixed(0)}%).` : '.'),
    ),
    `Sessions with an unreadable slot: ${r.coverage.filter((c) => c.unknownSlots > 0).length}; smallest breadth sample ` +
      `${r.coverage.length ? Math.min(...r.coverage.map((c) => c.minSample)) : '—'}.`,
    '',
    '## The book against the tape (edge-leak scan)',
    '',
    ...dimensionTable('By side and tape', r.leakScan.bySide),
    ...dimensionTable('With / against the tape', r.leakScan.alignment),
    ...dimensionTable('By side and tape, index leg only', r.leakScan.spyOnlyBySide),
    '## Declined live shorts by tape',
    '',
    `Replay version ${r.replayVersion}, entry concession ${r.entryConcessionPct.toFixed(3)}%. ` +
      `${r.shortShadow.rows} journaled rows.`,
    '',
    ...replayTable('As recorded', r.shortShadow.byTape),
    ...replayTable(
      `After the ATR reachability gate (${r.shortShadow.atrUnknown} rows without an ATR kept)`,
      r.shortShadow.atrReachableByTape,
    ),
    '## Every short signal by tape (counterfactual)',
    '',
    `${r.counterfactual.signals} short signals, ${r.counterfactual.unscored} without a candidate row in their tick. ` +
      `Kept when they cleared the live floor in force at the time (now ${r.counterfactual.floorNow}); per tape, the ` +
      `first per symbol-day.${r.counterfactual.journalTruncated ? ' **The journal read was cut: counts are short.**' : ''}`,
    '',
    ...replayTable('As signalled', r.counterfactual.byTape),
    ...replayTable(
      `After the ATR reachability gate (${r.counterfactual.atrUnknown} rows without an ATR kept)`,
      r.counterfactual.atrReachableByTape,
    ),
    'Rebuilt readings never count toward any switch.',
    '',
  ].join('\n');
}

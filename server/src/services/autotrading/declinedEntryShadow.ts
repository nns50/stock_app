import { AutotradeConfig } from '../../db/autotradeConfig';
import { CandleSource, INTRADAY_TIMEFRAME } from '../excursion';
import { ExitRules, liveExitRules, replayExit } from '../exitReplay';
import { Candle } from '../../providers/types';
import { DeclinedEntry } from './declinedEntry';
import { MARKETABLE_LIMIT_BUFFER_PCT } from './marketableLimit';
import { MarketDirection, tapeAlignment } from './marketDirection';

// ---------------------------------------------------------------------------
// What the live book WOULD have made on the entries it refused (2026-09-14).
//
// This is shortShadowRecord.ts's machinery with the SHORT taken out of it. That
// module was written for one gate — `liveAllowNakedShort` — and the same
// question turned out to be open for every other gate on the entry path, with
// nothing able to answer it:
//
//   risk_atr_unreachable_skipped   80 symbol-days over 8 sessions (09-02..09-14)
//                                  16 on 09-14 alone, against FOUR entries placed
//
// That gate refuses when 1R costs more than `maxRiskAtrFraction` of the name's
// daily ATR. Its reasoning is sound in isolation, but composed with the stop
// derivation it is not the setup filter it reads as. The stop is
// `min(stopAtrMultiple x ATR, maxStopDistancePct% x price)`, so at 1.5 / 2.5% /
// 0.7 the ATR term can never pass and the percentage clamp must bind — leaving
// a single admission rule: ATR >= 2.5/0.7 = 3.57% of price. It is a UNIVERSE
// filter. On 09-14 it refused GOOGL (1.06), MSFT (1.19), META (0.77), IBM
// (0.86), NFLX (0.92), XOM (1.19) and ten more — the liquid large-cap universe,
// by construction rather than by any judgement about those setups.
//
// AND PAPER IS NOT THE CONTROL IT WAS BELIEVED TO BE. The gate was moved
// live-only in 2026-09-01 precisely so paper could be the control group. Over
// the same eight sessions, exactly TWO closed paper trades land on a symbol-day
// the gate refused: paper's three slots fill early on the same high-ATR names,
// so it almost never reaches the ones the gate turns away. A control arm that
// produces two trades in eight sessions is not a control arm — the same
// discovery the entry-extension dimension made on the same day, in a different
// disguise.
//
// So the refused signals have to be replayed on their own bars, which is what
// this does.
//
// THE CAVEATS, and they are not softened by generalising:
//
//   NOT A P&L. Slots, aggregate-risk room and cooldowns are ignored, so this is
//   per-trade expectancy and not money the book could have banked.
//
//   A FILL THE LIVE BOOK COULD HAVE HAD (replay version 2, 2026-09-26). Version
//   1 entered at the signal's exact price and let every exit fill the way the
//   `touch` model fills: stops at their price through gaps, breakeven and the
//   trail on bar highs, targets on a touch. Each favoured the trade, and these
//   records feed rules that ADD exposure (red-day shorts, a shorter re-entry
//   cooldown). Version 2:
//     - enters at the signal's price plus the share of the marketable-limit
//       buffer live entries actually pay (`entryConcessionPct`, measured from
//       the live fills; the whole buffer when nothing is measured). The
//       signal's price is the quote live places against: a median 2 seconds
//       before the order. Calibrated on 2026-09-24 against 109 live stock
//       fills since 07-27. The signal's price missed the fill by 0.075R on
//       average (bias +0.009R). The open of the next 5-minute bar missed by
//       0.136R: it prices a trade up to five minutes after live would have
//       filled, and on the 27 declined red-open shorts that move alone cost
//       0.15R a trade;
//     - a first bar that gaps THROUGH the stop is a stop-out, not a refusal:
//       the honest exit fills it at that bar's open, past 1R, as a live stop
//       would;
//     - replays the market-direction gate when it is on, from the readings in
//       force at the decision (`refused_by_direction`);
//     - exits under replayExit's `honest` model.
//   Still not claimed: that a short was borrowable, or that the size funds.
//
//   NOT NEUTRAL ABOUT AMBIGUITY, deliberately. `replayExit` resolves every
//   intrabar stop-and-target collision AGAINST the trade, so it understates. A
//   gate that looks worth loosening on this reading looks so pessimistically,
//   which is the only direction worth being wrong in when the change ADDS
//   exposure.
// ---------------------------------------------------------------------------

/** Which replay a record was built by: 1 filled at the signal's price under the
 *  touch model; 2 is the honest fill (the header). A record says which, so
 *  numbers from the two are never read as one series. */
export const DECLINED_SHADOW_REPLAY_VERSION = 2;

export type ShadowSkipReason =
  | 'below_live_floor'
  | 'duplicate_same_day'
  | 'no_bars'
  | 'unusable_signal'
  /** Under `minMinutesSinceExit`: a refusal earlier than the gap asked for. */
  | 'before_min_gap'
  /** Under `minMinutesSinceExit`: a row that carries no exit gap at all — a
   *  gate other than the re-entry cooldown, whose rows cannot answer a gap
   *  question and are counted rather than silently passed. */
  | 'no_exit_gap'
  /** The market-direction gate, replayed: the reading in force at the decision
   *  leaned against the side, and the gate is on. */
  | 'refused_by_direction';

export interface ShadowTrade extends DeclinedEntry {
  /** The price the replay entered at: the signal's price (`entry`, from the
   *  row) plus the entry concession. */
  entryFill: number;
  exitR: number;
  reason: string;
  bestR: number;
  barsHeld: number;
}

export interface DeclinedEntryShadow {
  /** Replayed trades, one per symbol per ET day. */
  trades: ShadowTrade[];
  n: number;
  avgR: number | null;
  winRatePct: number | null;
  byReason: Record<string, number>;
  /** Journaled rows that produced no trade, and why. */
  excluded: Record<ShadowSkipReason, number>;
  /**
   * The gap this record was replayed at (ShadowOptions.minMinutesSinceExit; 0
   * when none was asked for). On the wire for the same reason `exitRules` is:
   * a reading at 120 minutes and one at the first refusal are different
   * questions, and the number must say which one it answers.
   */
  minMinutesSinceExit: number;
  /**
   * The exit geometry these numbers were replayed under.
   *
   * Every figure above is a function of it, and it is read from LIVE config, so
   * it moves when the book is re-tuned — three of its fields changed in one
   * settings PUT on 2026-09-14. Reading today's rules is the right question
   * ("would these work under the exits we actually run"), which is exactly why
   * the basis has to travel with the number: otherwise two evenings' readings
   * differ and nothing says whether the trades changed or a knob did.
   */
  exitRules: ExitRules;
  /** DECLINED_SHADOW_REPLAY_VERSION: which replay built these numbers. */
  replayVersion: number;
  /** The percent charged against each signal's price, in the trade's
   *  disfavour (ShadowOptions.entryConcessionPct). */
  entryConcessionPct: number;
  /** Whether the market-direction gate was replayed (it is on, and readings
   *  were supplied). */
  directionGateReplayed: boolean;
}

// The live book's exit geometry lives in exitReplay.ts, beside the rules type,
// so the paper book and the exit-replay route read the same function this
// shadow does. Re-exported for the callers that import it from here.
export { liveExitRules };

const etDate = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * One trade per symbol per ET day, keeping the EARLIEST — the moment live
 * actually declined it. Duplicates exist for a real reason: the once-per-day
 * claim behind the journal row is in-memory, so a mid-session deploy
 * re-journals a symbol already seen (observed 2026-09-10: 61 rows, 39 symbols).
 * Deduping on the READ side means the record is not hostage to how often the
 * box restarted.
 */
export function dedupeBySymbolDay<T extends { symbol: string; at: number }>(rows: T[]): { kept: T[]; dropped: number } {
  const first = new Map<string, T>();
  let dropped = 0;
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const key = `${r.symbol.toUpperCase()}|${etDate(r.at)}`;
    if (first.has(key)) dropped += 1;
    else first.set(key, r);
  }
  return { kept: [...first.values()], dropped };
}

/** Bars at or after the moment live saw the signal. An entry declined at 14:00
 *  must not be credited with the morning's move. */
export function barsFromSignal(bars: Candle[], at: number): Candle[] {
  return bars.filter((b) => b.time >= at);
}

/**
 * Actions whose gate IS the score floor.
 *
 * The floor filter below exists because most of these gates run BEFORE the
 * score floor, so their rows include candidates the book would have declined
 * anyway and scoring those would answer the wrong question. For the floor's own
 * refusals it is exactly backwards: filtering them by the floor excludes
 * precisely the population the gate refused, and the replay would come back
 * empty — which reads as "no evidence" when it means "wrong question asked".
 *
 * `finish_line_skipped` and `regime_score_floor_skipped` are here for the same
 * reason and are subtler: those rows sit ABOVE the everyday floor and were
 * refused by a stricter bar (an armed day, a High-Vol regime), so the filter
 * would pass them and quietly measure only part of what each rule costs.
 * Naming all three keeps that a decision rather than an accident of which bar
 * happened to bind.
 */
export const SCORE_FLOOR_ACTIONS = new Set([
  'live_score_floor_skipped',
  'finish_line_skipped',
  'regime_score_floor_skipped',
]);

/**
 * The gate refusals the DIRECTION replay must not be applied to (2026-09-24,
 * on review): the market-direction gate's own. The loop journals the tick's
 * reading before it places, so the reading in force at each of these rows is
 * the one that refused it, and replaying the gate over them refuses every one:
 * the route came back n 0 for the question it was asked. The same mistake
 * SCORE_FLOOR_ACTIONS exists to prevent, one gate over.
 */
export const DIRECTION_GATE_ACTIONS = new Set(['live_market_direction_skipped']);

export interface ShadowOptions {
  /**
   * Whether to drop rows below the floor that judged them. True for a gate that
   * runs before the score floor; FALSE when the gate under test IS the floor
   * (see SCORE_FLOOR_ACTIONS), where the filter would delete the evidence.
   */
  applyScoreFloor?: boolean;
  /**
   * Replay the first eligible refusal per symbol-day at or after this many
   * minutes since the symbol's last live exit, instead of the first refusal of
   * the day (2026-09-19). It is the question a SHORTER cooldown asks: the
   * re-entry cooldown journals every tick it refuses a name, so a symbol-day
   * holds the whole series and "what would a 120-minute cooldown have
   * admitted" is answered by entering at the first row at or past 120. The
   * first refusal of the day — the default — is instead the immediate
   * re-entry the paper book takes, which is a different trade.
   *
   * Rows carrying no exit gap (every other gate's) are counted `no_exit_gap`
   * under a positive value, never passed through as if they qualified. 0 or
   * unset: no gap requirement.
   */
  minMinutesSinceExit?: number;
  /**
   * The percent of the signal's price charged against the trade: the share
   * of the marketable-limit buffer live entries pay (meanBufferConsumedPct over
   * the live fills). Unset: the whole buffer, MARKETABLE_LIMIT_BUFFER_PCT —
   * the most a live entry can pay, and the right default for a caller that
   * measured nothing.
   */
  entryConcessionPct?: number;
  /**
   * The market-direction reading in force at a moment (the journal's
   * `market_direction_read` rows). When given and the gate is on, an entry the
   * gate would have refused is excluded. Unset: the gate is not replayed.
   */
  directionAt?: (at: number) => MarketDirection | null;
}

/** The price a live entry pays against the quote it placed at: through it by
 *  the concession, up for a long and down for a short. */
export function entryFillPrice(quote: number, side: 'long' | 'short', concessionPct: number): number {
  const sign = side === 'long' ? 1 : -1;
  return quote * (1 + (sign * concessionPct) / 100);
}

/**
 * A candle source that fetches each (symbol, timeframe, window) once for its
 * lifetime, so a caller replaying the same rows at several gaps (the re-entry
 * record's four) pays one bar fetch per symbol-day rather than four. A failed
 * fetch is not remembered: the next replay retries it.
 */
export function memoCandleSource(source: CandleSource): CandleSource {
  const cache = new Map<string, Promise<Candle[]>>();
  return {
    getCandles(symbol, timeframe, query) {
      const key = `${symbol.toUpperCase()}|${timeframe}|${query?.start ?? ''}|${query?.end ?? ''}|${query?.limit ?? ''}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = source.getCandles(symbol, timeframe, query);
        cache.set(key, hit);
        hit.catch(() => cache.delete(key));
      }
      return hit;
    },
  };
}

/**
 * Replay a set of declined entries on real intraday bars under the book's own
 * exit geometry.
 *
 * Rows are filtered by the floor each one was judged against
 * (`floorAtSkip`), never by today's: several of these gates run BEFORE the
 * score floor, so their rows include candidates the book would have declined
 * anyway — and filtering by the CURRENT floor silently re-scores history every
 * time `liveMinSignalScore` moves. Raising it 72 -> 81 on 2026-09-14 cut the
 * short record's eligible rows from 32 to 1 that way.
 */
export async function buildDeclinedEntryShadow(
  source: CandleSource,
  rows: DeclinedEntry[],
  cfg: AutotradeConfig,
  options: ShadowOptions = {},
): Promise<DeclinedEntryShadow> {
  const applyScoreFloor = options.applyScoreFloor ?? true;
  const minGap = options.minMinutesSinceExit ?? 0;
  const excluded: Record<ShadowSkipReason, number> = {
    below_live_floor: 0,
    duplicate_same_day: 0,
    no_bars: 0,
    unusable_signal: 0,
    before_min_gap: 0,
    no_exit_gap: 0,
    refused_by_direction: 0,
  };
  const concessionPct = Math.max(0, options.entryConcessionPct ?? MARKETABLE_LIMIT_BUFFER_PCT);
  const directionAt = cfg.marketDirectionGateEnabled ? (options.directionAt ?? null) : null;

  const eligible = rows.filter((r) => {
    const floor = r.floorAtSkip ?? cfg.liveMinSignalScore;
    if (applyScoreFloor && !(r.score >= floor)) {
      excluded.below_live_floor += 1;
      return false;
    }
    // A signal whose stop sits at or through its entry has no 1R to measure:
    // equal, or on the wrong side for the trade (a long's stop at or above its
    // entry, a short's at or below).
    const stopBelow = r.side === 'long' ? r.entry - r.stop : r.stop - r.entry;
    if (!Number.isFinite(r.entry) || !Number.isFinite(r.stop) || !(stopBelow > 0)) {
      excluded.unusable_signal += 1;
      return false;
    }
    // The gap filter runs BEFORE the dedupe, so "earliest per symbol-day"
    // below becomes "the first refusal at or past the gap".
    if (minGap > 0) {
      if (typeof r.minutesSinceExit !== 'number') {
        excluded.no_exit_gap += 1;
        return false;
      }
      if (r.minutesSinceExit < minGap) {
        excluded.before_min_gap += 1;
        return false;
      }
    }
    return true;
  });

  // The gate is replayed BEFORE the dedupe, as the gap filter is, so the
  // record keeps the first refusal of the day the gate would have let through.
  const admitted = directionAt
    ? eligible.filter((r) => {
        if (tapeAlignment(directionAt(r.at), r.side) === 'against') {
          excluded.refused_by_direction += 1;
          return false;
        }
        return true;
      })
    : eligible;

  const { kept, dropped } = dedupeBySymbolDay(admitted);
  excluded.duplicate_same_day = dropped;

  const rules = liveExitRules(cfg);
  const trades: ShadowTrade[] = [];
  for (const r of kept) {
    const day = etDate(r.at);
    let bars: Candle[];
    try {
      bars = await source.getCandles(r.symbol, INTRADAY_TIMEFRAME, { start: day, end: day });
    } catch {
      // A provider failure must cost this one signal, never the whole record.
      excluded.no_bars += 1;
      continue;
    }
    const window = barsFromSignal(bars, r.at);
    const first = window[0];
    if (!first) {
      excluded.no_bars += 1;
      continue;
    }
    // The concession moves the fill AWAY from the stop (a long pays up, a short
    // sells lower), so a usable signal always keeps its 1R. A first bar that
    // opens through the stop is a stop-out, which the honest exit fills at
    // that open.
    const entryFill = entryFillPrice(r.entry, r.side, concessionPct);
    const out = replayExit({ side: r.side, entryPrice: entryFill, initialStopPrice: r.stop }, window, rules, 'honest');
    if (!out) {
      excluded.no_bars += 1;
      continue;
    }
    trades.push({ ...r, entryFill, exitR: out.exitR, reason: out.reason, bestR: out.bestR, barsHeld: out.barsHeld });
  }

  const rs = trades.map((t) => t.exitR);
  const avgR = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null;
  const winRatePct = rs.length ? (rs.filter((v) => v > 0).length / rs.length) * 100 : null;
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;

  return {
    trades,
    n: trades.length,
    avgR,
    winRatePct,
    byReason,
    excluded,
    minMinutesSinceExit: minGap,
    exitRules: rules,
    replayVersion: DECLINED_SHADOW_REPLAY_VERSION,
    entryConcessionPct: concessionPct,
    directionGateReplayed: directionAt !== null,
  };
}

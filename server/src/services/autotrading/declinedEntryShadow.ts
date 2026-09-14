import { AutotradeConfig } from '../../db/autotradeConfig';
import { CandleSource, INTRADAY_TIMEFRAME } from '../excursion';
import { ExitRules, replayExit } from '../exitReplay';
import { Candle } from '../../providers/types';
import { DeclinedEntry } from './declinedEntry';

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
// THE SAME THREE CAVEATS APPLY, and they are not softened by generalising:
//
//   NOT A P&L. Slots, aggregate-risk room and cooldowns are ignored, so this is
//   per-trade expectancy and not money the book could have banked.
//
//   NOT A FILL. The entry is the signal's price. No slippage, and no claim the
//   size would have funded.
//
//   NOT NEUTRAL ABOUT AMBIGUITY, deliberately. It reuses `replayExit`, which
//   resolves every intrabar stop-and-target collision AGAINST the trade, so it
//   understates. A gate that looks worth loosening on this reading looks so
//   pessimistically, which is the only direction worth being wrong in when the
//   change ADDS exposure.
// ---------------------------------------------------------------------------

export type ShadowSkipReason = 'below_live_floor' | 'duplicate_same_day' | 'no_bars' | 'unusable_signal';

export interface ShadowTrade extends DeclinedEntry {
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
}

/**
 * The live book's own exit geometry — the rules a real entry would have been
 * managed under, not a hypothetical set. Every field is read straight from
 * config so the two cannot drift: the replay treats 0 as "disabled", the same
 * convention the config uses, so a rule the book switches off switches off here
 * by construction rather than by anyone remembering to.
 *
 * NOT modelled, and named here so the omission stays a decision: the
 * scale-out's scarcity gate, its cancel/replace mechanics, and whether the
 * second lot's bracket actually got placed. Those are execution questions; this
 * measures geometry.
 */
export function liveExitRules(cfg: AutotradeConfig): ExitRules {
  return {
    breakevenTriggerR: cfg.breakevenTriggerRMultiple,
    trailStartR: cfg.trailStartRMultiple,
    trailStopR: cfg.trailStopRMultiple,
    targetR: cfg.targetRMultiple,
    scaleOutR: cfg.liveScaleOutEnabled ? cfg.partialExitRMultiple : 0,
    scaleOutFraction: cfg.partialExitPct / 100,
    stagnationMinutes: cfg.stagnationExitMinutes,
    stagnationMinR: cfg.stagnationExitMinR,
  };
}

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

export interface ShadowOptions {
  /**
   * Whether to drop rows below the floor that judged them. True for a gate that
   * runs before the score floor; FALSE when the gate under test IS the floor
   * (see SCORE_FLOOR_ACTIONS), where the filter would delete the evidence.
   */
  applyScoreFloor?: boolean;
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
  const excluded: Record<ShadowSkipReason, number> = {
    below_live_floor: 0,
    duplicate_same_day: 0,
    no_bars: 0,
    unusable_signal: 0,
  };

  const eligible = rows.filter((r) => {
    const floor = r.floorAtSkip ?? cfg.liveMinSignalScore;
    if (applyScoreFloor && !(r.score >= floor)) {
      excluded.below_live_floor += 1;
      return false;
    }
    // A signal whose stop sits at or through its entry has no 1R to measure.
    if (!Number.isFinite(r.entry) || !Number.isFinite(r.stop) || !(Math.abs(r.entry - r.stop) > 0)) {
      excluded.unusable_signal += 1;
      return false;
    }
    return true;
  });

  const { kept, dropped } = dedupeBySymbolDay(eligible);
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
    const out = window.length
      ? replayExit({ side: r.side, entryPrice: r.entry, initialStopPrice: r.stop }, window, rules)
      : null;
    if (!out) {
      excluded.no_bars += 1;
      continue;
    }
    trades.push({ ...r, exitR: out.exitR, reason: out.reason, bestR: out.bestR, barsHeld: out.barsHeld });
  }

  const rs = trades.map((t) => t.exitR);
  const avgR = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null;
  const winRatePct = rs.length ? (rs.filter((v) => v > 0).length / rs.length) * 100 : null;
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;

  return { trades, n: trades.length, avgR, winRatePct, byReason, excluded, exitRules: rules };
}

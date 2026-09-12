import { Candle } from '../../providers/types';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { CandleSource, INTRADAY_TIMEFRAME } from '../excursion';
import { ExitRules, replayExit } from '../exitReplay';

/**
 * What the live book WOULD have made on the shorts it declined — measured on
 * real bars, independently of the paper book's slots.
 *
 * WHY THIS EXISTS. Task #21's enabling rule reads paper's closed shorts, and
 * paper is the wrong instrument for the question. It has three slots and a
 * score floor of 60 against live's 72, so it fills those slots first-come with
 * names live would never take and is then unable to record the higher-scoring
 * short that arrives an hour later. On 2026-09-10 every one of 1000 sampled
 * paper risk checks was refused on max_concurrent_positions, and two of five
 * paper entries scored below the live floor. The sample the decision reads is
 * therefore a slot lottery biased toward early-session signals, not a sample of
 * live-eligible shorts — and it accrues slowly for the same structural reason.
 *
 * This replays the DECLINED signals themselves. `live_short_skipped` already
 * carries everything a trade needs — score, entry, stop, target, and the moment
 * live saw it — so the shadow record needs no new capture, only bars.
 *
 * THREE THINGS IT IS NOT, and each matters when reading the number:
 *
 *  1. Not a P&L. It ignores slots, aggregate-risk room and cooldowns, so it
 *     measures per-trade EXPECTANCY, not money the book could have made. That
 *     is the right quantity for #21's avgR/win-rate gate and the wrong one for
 *     "how much did we leave on the table".
 *  2. Not a fill. The entry is the signal's price, with no slippage and no
 *     assumption that a short was borrowable at that moment.
 *  3. Not neutral about ambiguity — deliberately. It reuses exitReplay, which
 *     resolves every intrabar stop/target collision AGAINST the trade. So this
 *     understates shorts. A gate that passes here passes on a pessimistic read,
 *     which is the only direction worth being wrong in when the decision is
 *     whether to point real money at a new direction.
 */

/** One declined short, as journaled. */
export interface SkippedShort {
  symbol: string;
  /** Epoch ms the live book declined it — the replay starts at this bar. */
  at: number;
  score: number;
  entry: number;
  stop: number;
}

export interface ShadowTrade extends SkippedShort {
  exitR: number;
  reason: string;
  bestR: number;
  barsHeld: number;
}

export type ShadowSkipReason = 'below_live_floor' | 'duplicate_same_day' | 'no_bars' | 'unusable_signal';

export interface ShortShadowRecord {
  /** Replayed trades, one per symbol per ET day. */
  trades: ShadowTrade[];
  n: number;
  avgR: number | null;
  winRatePct: number | null;
  byReason: Record<string, number>;
  /** Journaled rows that produced no trade, and why. */
  excluded: Record<ShadowSkipReason, number>;
  /** The three numbers task #21's rule reads, and whether each passes. */
  gate: {
    minTrades: number;
    minAvgR: number;
    minWinRatePct: number;
    passesN: boolean;
    passesAvgR: boolean;
    passesWinRate: boolean;
    passes: boolean;
  };
}

/** Task #21's pre-committed enabling rule, in one place so the report and any
 *  future reader cannot drift from it. Changing these is changing the DECISION,
 *  which is a written-down operator call, not a tuning knob. */
export const SHORT_ENABLE_GATE = { minTrades: 30, minAvgR: 0.1, minWinRatePct: 50 } as const;

/**
 * The live book's own exit geometry — the rules a real short would have been
 * managed under, not a hypothetical set. Every field is read straight from
 * config so the two cannot drift: the replay treats 0 as "disabled", which is
 * the same convention the config itself uses, so a rule the book switches off
 * switches off here by construction rather than by anyone remembering to.
 *
 * The scale-out and the stagnation timer were added on 2026-09-11, the day
 * after the shadow record shipped. exitReplay learned them in #563 and the live
 * book has been running both all along (partialExitPct 67 at partialExitRMultiple
 * 0.25, and a 90-minute stagnation scratch below 0.5R), so a record that omitted
 * them was not replaying the book's geometry — it was replaying the four-field
 * subset that existed when it was written, and UNDERSTATING as a result: a
 * winner that peaks at 0.44R and falls back to breakeven books 0.00R without the
 * scale-out and roughly +0.17R with it, which is most of the difference between
 * a direction that looks flat and one that looks slightly positive.
 *
 * NOT modelled, and named here so the omission stays a decision: the scale-out's
 * scarcity gate, its cancel/replace mechanics, and whether the second lot's
 * bracket actually got placed. Those are execution questions; this measures
 * geometry.
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
export function dedupeBySymbolDay(rows: SkippedShort[]): { kept: SkippedShort[]; dropped: number } {
  const first = new Map<string, SkippedShort>();
  let dropped = 0;
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const key = `${r.symbol.toUpperCase()}|${etDate(r.at)}`;
    if (first.has(key)) dropped += 1;
    else first.set(key, r);
  }
  return { kept: [...first.values()], dropped };
}

/** Bars at or after the moment live saw the signal. A short declined at 14:00
 *  must not be credited with the morning's fall. */
export function barsFromSignal(bars: Candle[], at: number): Candle[] {
  return bars.filter((b) => b.time >= at);
}

export async function buildShortShadowRecord(
  source: CandleSource,
  rows: SkippedShort[],
  cfg: AutotradeConfig,
): Promise<ShortShadowRecord> {
  const excluded: Record<ShadowSkipReason, number> = {
    below_live_floor: 0,
    duplicate_same_day: 0,
    no_bars: 0,
    unusable_signal: 0,
  };

  const eligible = rows.filter((r) => {
    if (!(r.score >= cfg.liveMinSignalScore)) {
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
      ? replayExit({ side: 'short', entryPrice: r.entry, initialStopPrice: r.stop }, window, rules)
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

  const g = SHORT_ENABLE_GATE;
  const passesN = trades.length >= g.minTrades;
  const passesAvgR = avgR !== null && avgR >= g.minAvgR;
  const passesWinRate = winRatePct !== null && winRatePct >= g.minWinRatePct;
  return {
    trades,
    n: trades.length,
    avgR,
    winRatePct,
    byReason,
    excluded,
    gate: { ...g, passesN, passesAvgR, passesWinRate, passes: passesN && passesAvgR && passesWinRate },
  };
}

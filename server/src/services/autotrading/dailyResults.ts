import { listPositions, Position } from '../../db/positions';
import { listLiveOptionsPositions, liveOptionsPnl } from '../../db/autotradeLiveOptionsPositions';
import { listPaperPositions, paperRealizedPnl } from '../../db/autotradePaperPositions';
import { listOptionsPaperPositions } from '../../db/autotradeOptionsPaperPositions';
import { optionsPaperRealizedPnl } from './optionsExecute';
import { getDailyBaseline } from '../../db/dailyBaseline';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import { DailyResult, GoalBasis, listDailyResults, saveDailyResult } from '../../db/dailyResults';
import { realizedPnlOf } from '../pnl';
import { DayMark, listDayMarks } from '../../db/dayMarks';
import { etToday } from '../../util/marketDate';
import { isTradingSession } from '../trading/marketCalendar';
import { isAfterSessionClose, isBeforeSessionOpen } from '../trading/marketHours';

// ---------------------------------------------------------------------------
// The day's result, kept (2026-09-12, operator's ask).
//
// Before this, the day's percentage existed in two places and neither one
// remembered it: the singleton baseline row (overwritten every morning) and the
// dashboard's live `dailyTarget.gainPct` (recomputed per poll). "How did last
// Tuesday go" had no answer at all.
//
// TWO PERCENTAGES, ALWAYS BOTH. The ACCOUNT figure is what the operator feels,
// and it carries deposits, withdrawals and any trading done by hand. The
// STRATEGY figure is what the loop did: realized P&L on positions the loop
// itself opened and closed, over the same baseline. A strategy decision is made
// on the second (OPTIONS_TUNING_PLAN's data-quality rule — a position-derived
// series carries no flows); a "how am I doing" glance is the first. Reporting
// only one of them would be wrong in one direction or the other every time they
// diverge, so the row carries both and FLAGS the days they disagree.
//
// WHAT IS NEVER INVENTED. A session before the baseline row existed has no
// opening equity anywhere, so the account columns stay null and the calendar
// says so on those cells. The strategy columns are exact for every past session,
// because the positions ledger goes back further than the baseline does.
// ---------------------------------------------------------------------------

/** How far the account and the strategy may differ, as a share of the day's
 *  opening equity, before the day is flagged. 0.5% is comfortably above
 *  mark-to-market on open positions (the account figure is net liquidation, the
 *  strategy figure is realized only) and well below any real deposit or an
 *  afternoon of hand trading.
 *
 *  It flags a DISAGREEMENT and names no cause. It was called
 *  MANUAL_TRADING_DIVERGENCE_PCT until 2026-09-16, when it fired on a session
 *  with no trade in either book: the broker posted -$193.50 settling the
 *  previous day's option expiry at 04:03 ET, against a baseline captured at ET
 *  midnight, and the day's row asserted hand trading that never happened.
 *  Deposits, withdrawals, hand trades, fees, interest, overnight settlement and
 *  the unrealized mark on anything still open at the close all cross this line,
 *  and nothing in the row distinguishes them — so `preOpenMoveUsd` reports the
 *  one split the data CAN make, and the label stopped guessing. */
export const ACCOUNT_STRATEGY_DIVERGENCE_PCT = 0.5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isAutotrade = (p: Position): boolean => p.tags.includes('autotrade');

/** The ET date a position's realized P&L belongs to: its LAST exit's date. A
 *  trade opened Monday and closed Wednesday books on Wednesday, which is when
 *  the money actually moved. */
function lastExitDate(p: Position): string | null {
  if (p.exits.length === 0) return null;
  return p.exits.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).exitDate;
}

export interface StrategyDay {
  pnlUsd: number;
  trades: number;
}

/** What the LOOP realized on `etDate` — live stock plus live options. Exact,
 *  and independent of every equity reading. */
export function strategyDayFor(etDate: string): StrategyDay {
  let pnlUsd = 0;
  let trades = 0;
  for (const p of listPositions({ status: 'closed' })) {
    if (!isAutotrade(p) || lastExitDate(p) !== etDate) continue;
    pnlUsd += realizedPnlOf(p);
    trades += 1;
  }
  for (const p of listLiveOptionsPositions({ status: 'closed' })) {
    if (p.exitAt === null || p.exitPrice === null || etToday(p.exitAt) !== etDate) continue;
    pnlUsd += liveOptionsPnl(p, p.exitPrice);
    trades += 1;
  }
  return { pnlUsd: round2(pnlUsd), trades };
}

/** The paper book's realized P&L on `etDate` — the control arm's own day, kept
 *  beside the live one so a red live day on a green paper day is visible as
 *  the execution question it is. */
export function paperDayFor(etDate: string): number {
  let pnl = 0;
  for (const p of listPaperPositions({ status: 'closed' })) {
    if (p.exitAt === null || etToday(p.exitAt) !== etDate) continue;
    pnl += paperRealizedPnl(p);
  }
  for (const p of listOptionsPaperPositions({ status: 'closed' })) {
    if (p.exitAt === null || p.exitPrice === null || etToday(p.exitAt) !== etDate) continue;
    pnl += optionsPaperRealizedPnl(p);
  }
  return round2(pnl);
}

export interface RecordDailyResultInput {
  etDate: string;
  /** The day's opening equity, or null for a session that predates the
   *  baseline row. */
  baselineEquityUsd: number | null;
  closeEquityUsd: number | null;
  goalReached: boolean;
  giveBackHalted: boolean;
  drawdownHalted: boolean;
  recordedAt: number;
  /** The risk % in force on this session. The review counts "sessions since
   *  the sizing changed" off this rather than off a journal row, because the
   *  journal row did not exist for the trial that needed it. */
  riskPerTradePct: number | null;
  /** Which quantity this session's daily-target evaluator measured — see
   *  DailyResult.goalBasis. Present on a missed session too, on purpose. */
  goalBasis: GoalBasis;
  /** The pre-open share of the account's move, from `preOpenMoveUsdFor`, or
   *  null when the samples cannot answer. Passed in rather than read here so
   *  this stays pure. */
  preOpenMoveUsd: number | null;
}

/** Pure: the row a set of readings implies. Split out so the two percentages,
 *  the divergence flag and every null case are testable without a loop tick. */
export function buildDailyResult(input: RecordDailyResultInput, strategy: StrategyDay, paperPnl: number): DailyResult {
  const { baselineEquityUsd, closeEquityUsd } = input;
  const haveAccount = baselineEquityUsd !== null && baselineEquityUsd > 0 && closeEquityUsd !== null;
  const accountGainPct = haveAccount ? round2(((closeEquityUsd - baselineEquityUsd) / baselineEquityUsd) * 100) : null;
  const strategyGainPct =
    baselineEquityUsd !== null && baselineEquityUsd > 0 ? round2((strategy.pnlUsd / baselineEquityUsd) * 100) : null;
  // Both percentages are of the SAME baseline, so the difference between them
  // is itself a percentage of equity and can be compared to the threshold
  // directly — no unit change between the two sides of this comparison.
  const accountStrategyDiverged =
    accountGainPct !== null && strategyGainPct !== null
      ? Math.abs(accountGainPct - strategyGainPct) > ACCOUNT_STRATEGY_DIVERGENCE_PCT
      : false;
  // The same gap in DOLLARS, which is the unit the flag's causes are spoken of
  // in ("a $30,000 deposit", "a -$193.50 settlement"). Derived from the account
  // move rather than from the percentages, so rounding to 2dp twice cannot make
  // the money disagree with itself.
  const divergenceUsd = haveAccount ? round2(closeEquityUsd - baselineEquityUsd - strategy.pnlUsd) : null;
  return {
    etDate: input.etDate,
    baselineEquityUsd,
    closeEquityUsd,
    accountGainPct,
    strategyPnlUsd: strategy.pnlUsd,
    strategyGainPct,
    liveTrades: strategy.trades,
    riskPerTradePct: input.riskPerTradePct,
    paperPnlUsd: paperPnl,
    goalReached: input.goalReached,
    goalBasis: input.goalBasis,
    giveBackHalted: input.giveBackHalted,
    drawdownHalted: input.drawdownHalted,
    accountStrategyDiverged,
    divergenceUsd,
    preOpenMoveUsd: input.preOpenMoveUsd,
    recordedAt: input.recordedAt,
  };
}

/**
 * How much of a session's account move landed BEFORE the opening bell, from
 * the day-marks series — or null when the samples cannot answer.
 *
 * The loop ticks from ET midnight, so a whole overnight sits inside a session's
 * own date, and the day's baseline is captured before the broker has finished
 * clearing the previous one. Settlement, fees and interest therefore post
 * INSIDE a session the loop had not begun to trade. 2026-09-16 is the worked
 * example: -$193.50 at 04:03 ET, flat for the remaining 798 samples, and a row
 * that called it manual trading.
 *
 * Measured against the day's FIRST sample rather than the stored baseline, so
 * this is the account's own move over the pre-open window and cannot inherit a
 * re-baselining that happened later in the day (`rebaseDailyBaseline` moves the
 * baseline on a real cash flow; the samples keep their own history).
 */
export function preOpenMoveUsdFor(marks: DayMark[]): number | null {
  const withEquity = marks.filter((m) => m.accountEquityUsd !== null);
  if (withEquity.length === 0) return null;
  const preOpen = withEquity.filter((m) => isBeforeSessionOpen(m.at));
  // No pre-open sample is not the same as no pre-open move: a loop that started
  // mid-session simply never saw the window, and 0 would assert it was quiet.
  if (preOpen.length < 2) return null;
  const first = preOpen[0].accountEquityUsd as number;
  const last = preOpen[preOpen.length - 1].accountEquityUsd as number;
  return round2(last - first);
}

/**
 * Record `etDate` from whatever the database knows right now. Idempotent: the
 * loop calls it on every tick after the close and the row is simply rewritten,
 * which is also what makes `POST …/record?date=` a usable correction after a
 * bad equity reading.
 *
 * The baseline row is the day's opening equity ONLY while it still belongs to
 * that date — it is a singleton and rolls over at the next morning's first
 * tick. So a recording for a past date takes the account columns from the row
 * that is already stored (if any) rather than from a baseline that has since
 * moved on; nothing is invented and nothing already recorded is lost.
 */
export function recordDailyResult(etDate: string, now: number = Date.now()): DailyResult {
  const baseline = getDailyBaseline();
  const cfg = getAutotradeConfig();
  const existing = listDailyResults(etDate, etDate)[0] ?? null;
  const current = baseline !== null && baseline.etDate === etDate ? baseline : null;

  const result = buildDailyResult(
    {
      etDate,
      baselineEquityUsd: current ? current.equityUsd : (existing?.baselineEquityUsd ?? null),
      closeEquityUsd: current ? (cfg.accountEquityUsd ?? null) : (existing?.closeEquityUsd ?? null),
      // Only stamp the CURRENT sizing when this is genuinely today's session.
      // Re-recording a past date (a correction) must keep whatever sizing that
      // day actually ran under; writing today's onto it would be exactly the
      // fabrication this column exists to avoid.
      riskPerTradePct: current ? cfg.riskPerTradePct : (existing?.riskPerTradePct ?? null),
      goalReached: current ? current.reachedAt !== null : (existing?.goalReached ?? false),
      // READ from the stamp, never asserted from the code running now. This
      // said `current ? 'strategy' : …` for a few hours on 2026-09-14 and got
      // its very first row wrong: the reach was stamped at 14:41 by the
      // account-based evaluator, one deploy earlier, and the row claimed a
      // strategy-basis goal day at +2.01% against a 3% goal. A recorder runs
      // after the fact; only the stamp knows what stamped it.
      goalBasis: current ? current.goalBasis : (existing?.goalBasis ?? null),
      // From the samples of the date being recorded, so a correction for a past
      // day reads that day's own overnight rather than tonight's.
      preOpenMoveUsd: preOpenMoveUsdFor(listDayMarks(etDate)),
      giveBackHalted: current ? current.giveBackHaltedAt !== null : (existing?.giveBackHalted ?? false),
      // The drawdown halt has no baseline stamp of its own; the journal is its
      // record, and the caller passes it through the same route that reads it.
      drawdownHalted: existing?.drawdownHalted ?? false,
      recordedAt: now,
    },
    strategyDayFor(etDate),
    paperDayFor(etDate),
  );
  saveDailyResult(result);
  return result;
}

/**
 * The loop's hook: once the bell has rung, make sure today's row exists.
 * Returns the row it wrote, or null when it is not after the close (or the day
 * is not a session at all).
 *
 * Deliberately re-records rather than writing once and stopping. An exit can
 * still reconcile after the close, and the equity sync keeps running — a row
 * frozen at the first post-close tick would miss both.
 */
export function recordTodayAfterClose(now: number = Date.now()): DailyResult | null {
  const today = etToday(now);
  if (!isTradingSession(today) || !isAfterSessionClose(now)) return null;
  return recordDailyResult(today, now);
}

/**
 * Fill the STRATEGY columns for every past session the ledger knows about and
 * this table does not.
 *
 * Account columns are left null on purpose: before the baseline row existed
 * there is no record anywhere of what equity opened at, and a calendar cell
 * that says "no account figure" is worth more than one that quietly shows a
 * number derived from a guess. Sessions already recorded are not touched.
 */
export function backfillDailyResults(from: string, now: number = Date.now()): { written: number; dates: string[] } {
  const dates = new Set<string>();
  for (const p of listPositions({ status: 'closed' })) {
    if (!isAutotrade(p)) continue;
    const d = lastExitDate(p);
    if (d && d >= from && isTradingSession(d)) dates.add(d);
  }
  for (const p of listLiveOptionsPositions({ status: 'closed' })) {
    if (p.exitAt === null) continue;
    const d = etToday(p.exitAt);
    if (d >= from && isTradingSession(d)) dates.add(d);
  }
  const already = new Set(listDailyResults(from).map((r) => r.etDate));
  const written: string[] = [];
  for (const etDate of [...dates].sort()) {
    if (already.has(etDate)) continue;
    saveDailyResult(
      buildDailyResult(
        {
          etDate,
          baselineEquityUsd: null,
          closeEquityUsd: null,
          goalReached: false,
          giveBackHalted: false,
          drawdownHalted: false,
          // Unknowable for a historical session, and null is the point: the
          // review's window test treats null as "not this trial", so a
          // backfill can never pad the count.
          riskPerTradePct: null,
          // `goalReached` is hard false above — a historical session has no
          // stamp at all — so there is no basis to name.
          goalBasis: null,
          // A backfilled session predates the day-marks table by definition, so
          // there is nothing to read and null is the honest answer.
          preOpenMoveUsd: null,
          recordedAt: now,
        },
        strategyDayFor(etDate),
        paperDayFor(etDate),
      ),
    );
    written.push(etDate);
  }
  return { written: written.length, dates: written };
}

// --- aggregates ------------------------------------------------------------

export interface ResultsAggregate {
  /** The bucket's label: an ISO week (`2026-W37`) or a month (`2026-09`). */
  key: string;
  sessions: number;
  /** Sum of the STRATEGY dollars — the only figure that sums honestly. A sum
   *  of account percentages would be wrong in two ways at once (it is not
   *  compounding, and it counts deposits). */
  strategyPnlUsd: number;
  /** Mean of the account percentages over the days that have one. */
  meanAccountGainPct: number | null;
  /** Mean of the strategy percentages over the days that have one. */
  meanStrategyGainPct: number | null;
  positiveDays: number;
  /**
   * Red days, and the mean of them — Decision 9's own yardstick ("mean red
   * day <= -1.5%"), which had no field until 2026-09-12 and was recomputed by
   * hand by whoever read the calendar.
   *
   * UNITS MATTER HERE and two quantities are easy to confuse: this is a mean
   * of PERCENTAGES (`dayPctOf`: the account figure where there is one, the
   * strategy figure otherwise), over the calendar's window. The edge-leak
   * scan's `dayLevel.meanRedSessionR` is a mean of R over the SCAN's window.
   * They answer the same question in different units over different spans and
   * will not agree; quote whichever the rule being applied is written in, and
   * Decision 9 is written in percent.
   */
  redDays: number;
  meanRedDayPct: number | null;
  goalDays: number;
  haltDays: number;
  bestDayPct: number | null;
  worstDayPct: number | null;
}

export interface DailyResultsReport {
  rows: DailyResult[];
  weekly: ResultsAggregate[];
  monthly: ResultsAggregate[];
  /** Consecutive most-recent sessions with the same sign, as a signed count:
   *  +3 = three green days running, -2 = two red. 0 when the latest day is
   *  flat or there are no rows. Uses the ACCOUNT figure where there is one and
   *  the strategy figure otherwise, so a pre-go-live stretch still streaks. */
  currentStreak: number;
}

/** ISO week key (`2026-W37`) — Monday-based, the week a calendar column is. */
export function isoWeekKey(etDate: string): string {
  const [y, m, d] = etDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // ISO: Thursday of this week decides the year and the week number.
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** The percentage a day is judged by: the account figure when the record has
 *  one, the strategy figure otherwise. Named, because three different readers
 *  need to agree on it. */
export const dayPctOf = (r: DailyResult): number | null => r.accountGainPct ?? r.strategyGainPct;

function aggregate(rows: DailyResult[], keyOf: (r: DailyResult) => string): ResultsAggregate[] {
  const buckets = new Map<string, DailyResult[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const hit = buckets.get(k);
    if (hit) hit.push(r);
    else buckets.set(k, [r]);
  }
  const mean = (xs: number[]): number | null => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return [...buckets.entries()]
    .map(([key, rs]) => {
      const pcts = rs.map(dayPctOf).filter((p): p is number => p !== null);
      return {
        key,
        sessions: rs.length,
        strategyPnlUsd: round2(rs.reduce((s, r) => s + r.strategyPnlUsd, 0)),
        meanAccountGainPct: mean(rs.map((r) => r.accountGainPct).filter((p): p is number => p !== null)),
        meanStrategyGainPct: mean(rs.map((r) => r.strategyGainPct).filter((p): p is number => p !== null)),
        positiveDays: pcts.filter((p) => p > 0).length,
        redDays: pcts.filter((p) => p < 0).length,
        meanRedDayPct: mean(pcts.filter((p) => p < 0)),
        goalDays: rs.filter((r) => r.goalReached).length,
        haltDays: rs.filter((r) => r.drawdownHalted || r.giveBackHalted).length,
        bestDayPct: pcts.length ? Math.max(...pcts) : null,
        worstDayPct: pcts.length ? Math.min(...pcts) : null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function buildDailyResultsReport(rows: DailyResult[]): DailyResultsReport {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const pct = dayPctOf(rows[i]);
    if (pct === null || pct === 0) break;
    const sign = pct > 0 ? 1 : -1;
    if (streak !== 0 && Math.sign(streak) !== sign) break;
    streak += sign;
  }
  return {
    rows,
    weekly: aggregate(rows, (r) => isoWeekKey(r.etDate)),
    monthly: aggregate(rows, (r) => r.etDate.slice(0, 7)),
    currentStreak: streak,
  };
}

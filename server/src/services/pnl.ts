import { Position } from '../db/positions';

// ---------------------------------------------------------------------------
// P&L math. Pure functions over Position records (+ a resolved current price).
// Conventions:
//   - entry_price / exit_price are PER SHARE (per-share premium for options).
//   - notional = price * quantity * multiplier (multiplier = 100 for options).
//   - entry fees are allocated proportionally between the closed and open
//     portions of a partially-exited position.
// ---------------------------------------------------------------------------

export interface PositionPnl {
  positionId: number;
  currentPrice: number | null;
  /** Capital deployed at entry: entry_price * quantity * multiplier. */
  costBasis: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
  totalPnl: number;
  returnPct: number | null;
  /** P&L in units of initial risk (entry→stop). Null when no stop was logged. */
  rMultiple: number | null;
  /** Current market value of the still-open quantity. */
  marketValue: number | null;
  remainingQuantity: number;
  closedQuantity: number;
}

function sideSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Gross realized P&L (exits vs entry) net of all fees, for the whole position. */
export function realizedPnlOf(p: Position): number {
  const sign = sideSign(p.side);
  const grossRealized = p.exits.reduce(
    (sum, e) => sum + (e.exitPrice - p.entryPrice) * e.quantity * p.multiplier * sign,
    0,
  );
  const exitFees = p.exits.reduce((s, e) => s + e.fees, 0);
  return grossRealized - exitFees - p.fees; // all entry fees count once the math is whole-position
}

/**
 * The trade's ORIGINAL risk — the R denominator. Frozen: it uses
 * `initialStopPrice` and the ORIGINAL quantity, so it does not move when the
 * breakeven/trailing ratchet raises the stop or a scale-out sells part of the
 * position.
 *
 * It used to read `p.stopPrice`, which the ratchet MUTATES. That was harmless
 * only because the ratchet had never once succeeded (a combo_type bug meant it
 * could not identify the stop leg — fixed 2026-09-02 in PR #467). The moment
 * it starts working the denominator shrinks and every R figure computed from
 * it inflates: DELL on 2026-09-02 asked to move its stop 434.52 -> 449.58 on a
 * 445.40 entry, which would have taken the denominator from |445.40-434.52| =
 * 10.88 to |445.40-449.58| = 4.18 and reported its real +2.07R as +5.4R.
 *
 * That number is not cosmetic — it feeds method/grade expectancy sizing, the
 * journal's MAE/MFE excursions, and the auto-tuner that reads them.
 *
 * `initialStopPrice` is backfilled from the first stop a position is given
 * (db/positions.ts), so the fallback to `stopPrice` only covers rows written
 * before that column existed.
 */
export function initialRiskOf(p: Position): number | null {
  const stop = p.initialStopPrice ?? p.stopPrice;
  if (stop == null || !p.entryPrice) return null;
  const risk = Math.abs(p.entryPrice - stop) * p.quantity * p.multiplier;
  return risk > 0 ? risk : null;
}

/**
 * What the position is risking RIGHT NOW — current stop, remaining quantity.
 * The opposite question to initialRiskOf, and the one an open-risk budget
 * asks: a ratcheted stop genuinely reduces exposure, and shares already sold
 * in a scale-out are no longer at risk at all.
 *
 * Split out 2026-09-02. Open risk used to call initialRiskOf, which answered
 * neither question correctly once either mechanism worked: it used the CURRENT
 * stop (right here, wrong for R) and the ORIGINAL quantity (right for R, wrong
 * here). A 50% scale-out would have kept charging the aggregate-risk budget
 * for shares that had already been sold.
 */
export function openRiskOf(p: Position): number | null {
  const stop = p.stopPrice ?? p.initialStopPrice;
  if (stop == null || !p.entryPrice) return null;
  const risk = Math.abs(p.entryPrice - stop) * p.remainingQuantity * p.multiplier;
  return risk > 0 ? risk : null;
}

/** P&L expressed in R (multiples of initial risk). Null when no stop was logged. */
export function rMultipleOf(p: Position, pnl: number): number | null {
  const risk = initialRiskOf(p);
  return risk === null ? null : round2(pnl / risk);
}

export function computePositionPnl(p: Position, currentPrice: number | null): PositionPnl {
  const sign = sideSign(p.side);
  const closedQty = p.quantity - p.remainingQuantity;
  const entryFeeClosed = p.quantity > 0 ? p.fees * (closedQty / p.quantity) : 0;
  const entryFeeOpen = p.fees - entryFeeClosed;

  const grossRealized = p.exits.reduce(
    (sum, e) => sum + (e.exitPrice - p.entryPrice) * e.quantity * p.multiplier * sign,
    0,
  );
  const exitFees = p.exits.reduce((s, e) => s + e.fees, 0);
  const realizedPnl = grossRealized - exitFees - entryFeeClosed;

  let unrealizedPnl: number | null = null;
  let marketValue: number | null = null;
  if (currentPrice !== null && p.remainingQuantity > 0) {
    unrealizedPnl = (currentPrice - p.entryPrice) * p.remainingQuantity * p.multiplier * sign - entryFeeOpen;
    marketValue = currentPrice * p.remainingQuantity * p.multiplier;
  } else if (p.remainingQuantity === 0) {
    unrealizedPnl = 0;
    marketValue = 0;
  }

  const costBasis = p.entryPrice * p.quantity * p.multiplier;
  const totalPnl = realizedPnl + (unrealizedPnl ?? 0);
  const returnPct = costBasis ? (totalPnl / costBasis) * 100 : null;

  return {
    positionId: p.id,
    currentPrice,
    costBasis: round2(costBasis),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl: unrealizedPnl === null ? null : round2(unrealizedPnl),
    totalPnl: round2(totalPnl),
    returnPct: returnPct === null ? null : round2(returnPct),
    rMultiple: rMultipleOf(p, totalPnl),
    marketValue: marketValue === null ? null : round2(marketValue),
    remainingQuantity: p.remainingQuantity,
    closedQuantity: round2(closedQty),
  };
}

/**
 * Unrealized P&L for an OPEN autotrade paper position, from a live quote.
 * Mirrors computePositionPnl's core formula, without the human journal's
 * multiplier/fees/partial-exit complexity — paper positions are always a
 * single entry -> single exit on one stock leg (see
 * db/autotradePaperPositions.ts). Null for an already-closed position (its
 * own exitPrice-based realized P&L covers that) or when no current price
 * could be resolved.
 */
export function computePaperUnrealizedPnl(
  p: { status: 'open' | 'closed'; side: 'buy' | 'sell'; entryPrice: number; quantity: number },
  currentPrice: number | null,
): number | null {
  if (p.status !== 'open' || currentPrice === null) return null;
  const sign = p.side === 'buy' ? 1 : -1;
  return round2((currentPrice - p.entryPrice) * p.quantity * sign);
}

/**
 * Unrealized P&L for an OPEN options autotrade paper position (Phase 12).
 * Single-leg: no sign flip — every single-leg position is long the contract
 * itself (call or put), matching optionsRiskCheck.ts's sizing convention —
 * and the 100x contract multiplier applies. Debit spread (Task #69): the
 * spread's "price" is long mark minus short mark, so unrealized P&L is
 * (currentNetValue - netDebitAtEntry) x spreads x 100; null (unknown, not
 * zero) if the short leg's mark couldn't be resolved even though the long
 * leg's could.
 */
export function computeOptionsPaperUnrealizedPnl(
  p: {
    status: 'open' | 'closed';
    kind?: 'single_leg' | 'debit_spread';
    entryPrice: number;
    shortEntryPrice?: number | null;
    quantity: number;
  },
  currentPrice: number | null,
  shortCurrentPrice: number | null = null,
): number | null {
  if (p.status !== 'open' || currentPrice === null) return null;
  if (p.kind === 'debit_spread') {
    if (shortCurrentPrice === null) return null;
    const netDebitAtEntry = p.entryPrice - (p.shortEntryPrice ?? 0);
    const netValueNow = currentPrice - shortCurrentPrice;
    return round2((netValueNow - netDebitAtEntry) * p.quantity * 100);
  }
  return round2((currentPrice - p.entryPrice) * p.quantity * 100);
}

export interface AggregatePnl {
  realized: number;
  unrealized: number;
  total: number;
  openMarketValue: number;
  openCount: number;
  closedCount: number;
}

export function aggregatePnl(items: PositionPnl[], positions: Position[]): AggregatePnl {
  const byId = new Map(positions.map((p) => [p.id, p]));
  let realized = 0;
  let unrealized = 0;
  let openMarketValue = 0;
  let openCount = 0;
  let closedCount = 0;
  for (const it of items) {
    realized += it.realizedPnl;
    unrealized += it.unrealizedPnl ?? 0;
    openMarketValue += it.marketValue ?? 0;
    const pos = byId.get(it.positionId);
    if (pos?.status === 'open') openCount++;
    else closedCount++;
  }
  return {
    realized: round2(realized),
    unrealized: round2(unrealized),
    total: round2(realized + unrealized),
    openMarketValue: round2(openMarketValue),
    openCount,
    closedCount,
  };
}

export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  winRate: number; // %
  totalPnl: number;
  avgPnl: number; // expectancy within the group
  /** Gross profit ÷ gross loss within the group — the "does this setup have a
   *  real edge" number win rate/avgPnl alone can't show (a 40%-win-rate setup
   *  with a 3:1 payoff can out-earn a 60%-win-rate one with a 1:1 payoff).
   *  null means "infinite" (wins with zero losses in the group), same
   *  convention as the top-level profitFactor above. */
  profitFactor: number | null;
  /** Mean R-multiple within the group, over just the group's own trades that
   *  logged a stop (a subset of `trades` — mirrors the top-level avgR's own
   *  "only trades with a stop" scope). null when none did. */
  avgR: number | null;
}

export interface JournalStats {
  totalClosed: number;
  /** How many of `totalClosed` carry a usable date, and so appear in the
   *  path-dependent figures: the equity curve, rolling expectancy, drawdown,
   *  streaks, and the weekday and hold-time breakdowns. Lower than totalClosed
   *  when a position was imported without an open date (see db/positions.ts) —
   *  surfaced so a shorter curve reads as "we don't know when those happened"
   *  rather than as missing trades. Everything that needs only a P&L —
   *  win rate, expectancy, profit factor, the realized total, best/worst trade,
   *  and every R-multiple statistic — is over all `totalClosed`. */
  datedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number; // %
  avgWin: number;
  avgLoss: number;
  expectancy: number; // mean realized P&L per closed trade
  profitFactor: number | null;
  totalRealized: number;
  bestTrade: number;
  worstTrade: number;
  equityCurve: { date: string; pnl: number; cumulative: number }[];
  /** Per-trade expectancy ($) over a trailing window — is the edge trending up or fading? */
  rollingExpectancy: { date: string; value: number }[];
  /** Realized P&L broken down by tag, grade, and checklist discipline. */
  byTag: GroupStat[];
  byGrade: GroupStat[];
  byDiscipline: GroupStat[];
  /** Realized P&L by the weekday a trade was closed on, and by how long it was held. */
  byWeekday: GroupStat[];
  byHold: GroupStat[];
  /** Realized P&L by entry session (open / midday / power hour) — only over trades with a logged entry time. */
  byTimeOfDay: GroupStat[];
  /** Edge in R (multiples of initial risk) over closed trades that logged a stop. */
  rTrades: number;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  /** Sample std-dev of R and Van Tharp's System Quality Number (edge × consistency). */
  stdevR: number | null;
  sqn: number | null;
  rBuckets: { label: string; count: number }[];
  /** Suggested risk-% per trade from realized edge (null until both W/L exist). */
  kelly: KellySuggestion | null;
  /** Max drawdown of the realized equity curve and win/loss streaks. */
  maxDrawdown: number;
  currentDrawdown: number;
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
}

const R_BUCKETS: { label: string; test: (r: number) => boolean }[] = [
  { label: '≤ -2R', test: (r) => r <= -2 },
  { label: '-2 to -1R', test: (r) => r > -2 && r <= -1 },
  { label: '-1 to 0', test: (r) => r > -1 && r < 0 },
  { label: '0 to 1R', test: (r) => r >= 0 && r < 1 },
  { label: '1 to 2R', test: (r) => r >= 1 && r < 2 },
  { label: '≥ 2R', test: (r) => r >= 2 },
];

function bucketRMultiples(rs: number[]): { label: string; count: number }[] {
  return R_BUCKETS.map((b) => ({ label: b.label, count: rs.filter((r) => b.test(r)).length }));
}

export interface StreakDrawdown {
  /** Largest peak-to-trough drop in the cumulative realized-P&L curve ($). */
  maxDrawdown: number;
  /** Current drop from the equity peak to now ($, 0 when at a fresh high). */
  currentDrawdown: number;
  /** The trailing run of same-result trades. */
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
}

/** Max drawdown and win/loss streaks over closed trades (in chronological order). */
export function computeStreaksAndDrawdown(pnls: number[]): StreakDrawdown {
  let peak = 0;
  let cum = 0;
  let maxDD = 0;
  let type: 'win' | 'loss' | 'none' = 'none';
  let count = 0;
  let longW = 0;
  let longL = 0;
  for (const pnl of pnls) {
    cum += pnl;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    const t = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'none';
    if (t === 'none') {
      type = 'none';
      count = 0;
    } else if (t === type) {
      count += 1;
    } else {
      type = t;
      count = 1;
    }
    if (type === 'win') longW = Math.max(longW, count);
    else if (type === 'loss') longL = Math.max(longL, count);
  }
  return {
    maxDrawdown: round2(maxDD),
    currentDrawdown: round2(peak - cum),
    currentStreak: { type, count },
    longestWinStreak: longW,
    longestLossStreak: longL,
  };
}

export interface KellySuggestion {
  /** Full Kelly fraction f* = W − (1−W)/b (can be negative when there's no edge). */
  fraction: number;
  /** Win/loss payoff ratio b = avgWin / |avgLoss|. */
  payoffRatio: number;
  /** Conservative suggestion: quarter-Kelly, clamped to [0, 3]% per trade. */
  suggestedRiskPct: number;
  sampleSize: number;
  /** Whether the sample is large enough (≥ 20 decisive trades) to lean on. */
  reliable: boolean;
}

/**
 * Position-size suggestion from realized edge (Kelly criterion). Needs both
 * winners and losers to estimate the payoff ratio. Kelly is aggressive and
 * assumes the historical edge persists, so we return a quarter-Kelly, capped at
 * 3% — a sane ceiling, not a recommendation.
 */
export function kellySuggestion(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  sampleSize: number,
): KellySuggestion | null {
  const w = winRate / 100;
  const loss = Math.abs(avgLoss);
  if (avgWin <= 0 || loss <= 0) return null;
  const b = avgWin / loss;
  const fraction = w - (1 - w) / b;
  const suggestedRiskPct = round2(Math.max(0, Math.min(3, fraction * 0.25 * 100)));
  return {
    fraction: round2(fraction),
    payoffRatio: round2(b),
    suggestedRiskPct,
    sampleSize,
    reliable: sampleSize >= 20,
  };
}

interface Acc {
  trades: number;
  wins: number;
  total: number;
  grossProfit: number;
  grossLoss: number; // stored positive, mirrors the top-level grossLoss convention
  rSum: number;
  rCount: number;
}

/** `r` is this trade's R-multiple (null if it never logged a stop) — same
 *  per-trade value the top-level avgR/rBuckets are computed from, just also
 *  folded into whichever group(s) this trade belongs to. */
function accumulate(map: Map<string, Acc>, key: string, pnl: number, r: number | null): void {
  const a = map.get(key) ?? { trades: 0, wins: 0, total: 0, grossProfit: 0, grossLoss: 0, rSum: 0, rCount: 0 };
  a.trades += 1;
  if (pnl > 0) {
    a.wins += 1;
    a.grossProfit += pnl;
  } else if (pnl < 0) {
    a.grossLoss += -pnl;
  }
  a.total += pnl;
  if (r !== null) {
    a.rSum += r;
    a.rCount += 1;
  }
  map.set(key, a);
}

function toGroupStats(map: Map<string, Acc>): GroupStat[] {
  return [...map.entries()].map(([key, a]) => ({
    key,
    trades: a.trades,
    wins: a.wins,
    winRate: a.trades ? round2((a.wins / a.trades) * 100) : 0,
    totalPnl: round2(a.total),
    avgPnl: a.trades ? round2(a.total / a.trades) : 0,
    profitFactor: a.grossLoss > 0 ? round2(a.grossProfit / a.grossLoss) : a.grossProfit > 0 ? null : 0,
    avgR: a.rCount ? round2(a.rSum / a.rCount) : null,
  }));
}

/** Which discipline bucket a closed trade falls into, from its saved checklist. */
function disciplineBucket(p: Position): string {
  if (!p.checklist || p.checklist.length === 0) return 'No checklist';
  return p.checklist.every((c) => c.checked) ? 'Followed all rules' : 'Skipped a rule';
}

// Timing breakdowns: which weekday a trade was closed on, and how long it was held.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOLD_BUCKETS: { label: string; max: number }[] = [
  { label: 'Intraday', max: 0 },
  { label: '1–3 days', max: 3 },
  { label: '4–10 days', max: 10 },
  { label: '11–30 days', max: 30 },
  { label: '30+ days', max: Infinity },
];
const HOLD_ORDER = HOLD_BUCKETS.map((b) => b.label);

/** Whole calendar days held (entry→last exit), clamped at 0 for same-day/bad
 *  data. Null when the entry date is unknown: Date.parse(null) is NaN, and a
 *  NaN would fall through holdBucket()'s find() into the LAST bucket, quietly
 *  filing every undated trade under "30+ days". Excluded is the honest answer. */
function holdDaysOf(p: Position, exitDate: string): number | null {
  if (p.entryDate === null) return null;
  return Math.max(0, Math.round((Date.parse(exitDate) - Date.parse(p.entryDate)) / 86_400_000));
}

function holdBucket(days: number): string {
  return (HOLD_BUCKETS.find((b) => days <= b.max) ?? HOLD_BUCKETS[HOLD_BUCKETS.length - 1]).label;
}

// Time-of-day sessions, by entry time (HH:MM, assumed US/Eastern). Only trades
// with a logged entry time contribute — answers "when in the day do I trade best?"
const SESSION_ORDER = ['Open', 'Late AM', 'Midday', 'Power hr', 'Extended'];
function sessionOf(time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins >= 570 && mins < 630) return 'Open'; // 9:30–10:30
  if (mins >= 630 && mins < 720) return 'Late AM'; // 10:30–12:00
  if (mins >= 720 && mins < 840) return 'Midday'; // 12:00–14:00
  if (mins >= 840 && mins <= 960) return 'Power hr'; // 14:00–16:00
  return 'Extended';
}

/**
 * The date a completed trade sits at on a timeline: its last exit, else its
 * entry. Null when neither is known — such a trade cannot be placed in time at
 * all, so every date-keyed breakdown leaves it out rather than guessing.
 */
export function tradeDateOf(p: Position): string | null {
  return lastExitDate(p) ?? p.entryDate;
}

/** Stats over CLOSED positions (each closed position = one completed trade). */
export function computeJournalStats(closed: Position[]): JournalStats {
  // Two populations, deliberately:
  //
  //   `withPnl` — EVERY closed trade. Win rate, expectancy, profit factor and
  //     the realized total need only a P&L, so a trade the broker never dated
  //     still belongs in them. It is a completed trade whose date we don't know,
  //     not a trade that didn't happen.
  //   `dated`   — the subset that can be placed on a timeline, in order. The
  //     equity curve, rolling expectancy, drawdown and streaks are all
  //     path-dependent: without a date there is no position in the sequence to
  //     put the trade in, so it is left out rather than guessed at.
  //
  // These were one population until 2026-07-26 — everything ran over `dated` —
  // which silently dropped undated trades from the headline numbers and made
  // wins + losses + breakeven disagree with totalClosed on screen. The R-multiple
  // stats below always used every closed trade, so the two halves of this
  // function contradicted each other about the same book.
  const withPnl = closed.map((p) => ({ date: tradeDateOf(p), pnl: round2(realizedPnlOf(p)) }));
  const dated = withPnl
    .filter((t): t is { date: string; pnl: number } => t.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const wins = withPnl.filter((t) => t.pnl > 0);
  const losses = withPnl.filter((t) => t.pnl < 0);
  const breakeven = withPnl.filter((t) => t.pnl === 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalRealized = withPnl.reduce((s, t) => s + t.pnl, 0);

  let cumulative = 0;
  const equityCurve = dated.map((t) => {
    cumulative = round2(cumulative + t.pnl);
    return { date: t.date, pnl: t.pnl, cumulative };
  });

  // Rolling expectancy: mean realized P&L over a trailing window ending at each
  // trade. Shows whether the edge is strengthening or decaying. Needs a few
  // trades to be meaningful, so it's empty below a small floor.
  const ROLL_WINDOW = 20;
  const ROLL_MIN = 8;
  const rollingExpectancy =
    dated.length >= ROLL_MIN
      ? dated.map((t, i) => {
          const window = dated.slice(Math.max(0, i - ROLL_WINDOW + 1), i + 1);
          return { date: t.date, value: round2(window.reduce((s, x) => s + x.pnl, 0) / window.length) };
        })
      : [];

  // Breakdowns: attribute each closed trade's realized P&L to its tags (a trade
  // counts once per distinct tag), its grade, discipline bucket, exit weekday,
  // and hold-time bucket.
  const tagMap = new Map<string, Acc>();
  const gradeMap = new Map<string, Acc>();
  const discMap = new Map<string, Acc>();
  const weekdayMap = new Map<string, Acc>();
  const holdMap = new Map<string, Acc>();
  const sessionMap = new Map<string, Acc>();
  for (const p of closed) {
    const pnl = round2(realizedPnlOf(p));
    const r = rMultipleOf(p, pnl);
    for (const tag of new Set(p.tags)) accumulate(tagMap, tag, pnl, r);
    accumulate(gradeMap, p.grade || 'Ungraded', pnl, r);
    accumulate(discMap, disciplineBucket(p), pnl, r);
    // Both of these need a real date. A trade with none is left out of the
    // breakdown entirely rather than bucketed on a guess — the same posture
    // byTimeOfDay already takes toward a missing entry TIME.
    const exitDate = tradeDateOf(p);
    if (exitDate !== null) {
      accumulate(weekdayMap, WEEKDAYS[new Date(`${exitDate}T00:00:00Z`).getUTCDay()], pnl, r);
      const held = holdDaysOf(p, exitDate);
      if (held !== null) accumulate(holdMap, holdBucket(held), pnl, r);
    }
    if (p.entryTime) {
      const s = sessionOf(p.entryTime);
      if (s) accumulate(sessionMap, s, pnl, r);
    }
  }
  const byTotalDesc = (a: GroupStat, b: GroupStat) => b.totalPnl - a.totalPnl;

  // Edge in R: closed trades that logged a stop, scored as realized P&L / initial risk.
  const rs = closed.map((p) => rMultipleOf(p, round2(realizedPnlOf(p)))).filter((r): r is number => r !== null);
  // System Quality Number (Van Tharp): edge ÷ consistency, scaled by sample size.
  // SQN = (mean R / sample-stdev R) × √N, with N capped at 100 so a long record
  // isn't flattered by size alone.
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const stdevR = rs.length >= 2 ? Math.sqrt(rs.reduce((s, r) => s + (r - meanR) ** 2, 0) / (rs.length - 1)) : null;
  const sqn = stdevR && stdevR > 0 ? round2((meanR / stdevR) * Math.sqrt(Math.min(rs.length, 100))) : null;

  const winRate = withPnl.length ? round2((wins.length / withPnl.length) * 100) : 0;
  const avgWin = wins.length ? round2(grossProfit / wins.length) : 0;
  const avgLoss = losses.length ? round2(-grossLoss / losses.length) : 0;
  // Kelly models a binary win/loss bet, so its win probability must be over
  // DECISIVE trades (break-evens excluded) to stay consistent with avgWin/avgLoss;
  // the displayed winRate above intentionally counts break-evens in the denominator.
  const decisive = wins.length + losses.length;
  const decisiveWinRate = decisive ? round2((wins.length / decisive) * 100) : 0;

  return {
    // wins + losses + breakeven === totalClosed, always. That identity is the
    // point: the UI puts them side by side, so a subtotal that doesn't add up
    // reads as a bug in the arithmetic rather than as a filtered population.
    totalClosed: withPnl.length,
    datedTrades: dated.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy: withPnl.length ? round2(totalRealized / withPnl.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    totalRealized: round2(totalRealized),
    bestTrade: withPnl.length ? round2(Math.max(...withPnl.map((t) => t.pnl))) : 0,
    worstTrade: withPnl.length ? round2(Math.min(...withPnl.map((t) => t.pnl))) : 0,
    equityCurve,
    rollingExpectancy,
    byTag: toGroupStats(tagMap).sort(byTotalDesc),
    byGrade: toGroupStats(gradeMap).sort((a, b) => a.key.localeCompare(b.key)),
    byDiscipline: toGroupStats(discMap).sort(byTotalDesc),
    byWeekday: toGroupStats(weekdayMap).sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key)),
    byTimeOfDay: toGroupStats(sessionMap).sort((a, b) => SESSION_ORDER.indexOf(a.key) - SESSION_ORDER.indexOf(b.key)),
    byHold: toGroupStats(holdMap).sort((a, b) => HOLD_ORDER.indexOf(a.key) - HOLD_ORDER.indexOf(b.key)),
    rTrades: rs.length,
    avgR: rs.length ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    bestR: rs.length ? Math.max(...rs) : null,
    worstR: rs.length ? Math.min(...rs) : null,
    stdevR: stdevR === null ? null : round2(stdevR),
    sqn,
    rBuckets: bucketRMultiples(rs),
    kelly: kellySuggestion(decisiveWinRate, avgWin, avgLoss, decisive),
    // Dated only, and necessarily: a drawdown is the path the equity took, and a
    // streak is a run of consecutive trades. Both are meaningless for a trade
    // with no place in the order. So `maxDrawdown` can be smaller than what an
    // undated loss would have produced — the UI's "N of M dated" badge on the
    // equity curve is what tells the reader this series is the shorter one.
    ...computeStreaksAndDrawdown(dated.map((t) => t.pnl)),
  };
}

/**
 * How many of `positions` were ENTERED on `etDate` — the count `maxTradesPerDay`
 * is judged against.
 *
 * One function because three places used to answer this and one of them was
 * silently wrong. riskCheck.ts's snapshot counted journal events whose action
 * was `order_placed`, an action **nothing has ever emitted** — the emitters are
 * named `paper_order_placed` / `live_order_placed`, and the consumer was never
 * updated when they were. Production's own events endpoint says so outright:
 * querying it returns `{"events":[],"actionsNeverSeen":["order_placed"]}`. The
 * effect was a permanent 0, so `max_trades_per_day` could never fail on the
 * preview endpoints that read that snapshot, while the two execution paths —
 * which counted position rows, like this — were right all along.
 *
 * Counting ROWS rather than events is the durable shape: a position that exists
 * is a trade that happened, and no rename can quietly zero it. Pass whichever
 * rows represent the book being asked about; an undated row (`entryDate` null —
 * see db/positions.ts on why that happens) is not counted, because a trade with
 * no date has no day to belong to.
 */
export function tradesEnteredOn(positions: { entryDate: string | null }[], etDate: string): number {
  return positions.filter((p) => p.entryDate === etDate).length;
}

export function lastExitDate(p: Position): string | null {
  if (p.exits.length === 0) return null;
  return p.exits
    .map((e) => e.exitDate)
    .sort()
    .slice(-1)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import { db } from './index';

// ---------------------------------------------------------------------------
// One row per trading session — see the DDL comment in db/index.ts for why
// there are two percentages and why several columns are nullable.
// ---------------------------------------------------------------------------

/** Which quantity stamped `goalReached` on a row. Null on a row recorded
 *  before the basis was tracked, and on every backfilled historical row. */
export type GoalBasis = 'strategy' | 'account' | null;

export interface DailyResult {
  etDate: string;
  /** The day's first-tick equity. Null for sessions before the baseline row
   *  existed — the backfill fills the strategy columns from the positions
   *  ledger and leaves these alone rather than inventing an opening equity. */
  baselineEquityUsd: number | null;
  closeEquityUsd: number | null;
  accountGainPct: number | null;
  /** Realized P&L of the autotrade loop's own live positions closed that day
   *  (stock + options). Always known: it comes from the ledger. */
  strategyPnlUsd: number;
  strategyGainPct: number | null;
  liveTrades: number;
  paperPnlUsd: number;
  goalReached: boolean;
  giveBackHalted: boolean;
  drawdownHalted: boolean;
  /** The account and the strategy disagree by more than 0.5% of equity.
   *
   *  It says THAT they disagree, never why. Called `manualTrading` until
   *  2026-09-16, when it fired on a day neither book traded: a -$193.50 broker
   *  settlement of the previous day's option expiry, posted at 04:03 ET into a
   *  day whose baseline was captured at ET midnight. A deposit, a withdrawal,
   *  hand trading, fees, interest, overnight settlement and the unrealized
   *  mark on anything still open at the close all land here, and the row
   *  cannot tell them apart — so it no longer claims to. */
  accountStrategyDiverged: boolean;
  /** Signed dollars: the account's move for the day minus the loop's realized
   *  P&L. The flag above is this figure against a threshold; without it a
   *  reader cannot tell a rounding-width gap from a deposit. Null when either
   *  side is unknown. */
  divergenceUsd: number | null;
  /** How much of the account's move landed BEFORE the opening bell, from the
   *  day-marks series — the single most common innocent explanation, because
   *  settlement and fees post overnight while the day's baseline is already
   *  captured. Null for a session with no samples. */
  preOpenMoveUsd: number | null;
  recordedAt: number;
  /** The risk % in force on this session. Null on a row recorded before the
   *  column existed and on every backfilled historical row — which is what
   *  makes it usable as the review's window test: a null cannot be mistaken
   *  for "this session ran the current sizing". */
  riskPerTradePct: number | null;
  /** Which quantity this session's daily-target evaluator MEASURED
   *  (2026-09-14; every session, not only reached ones, since 2026-09-16).
   *  'strategy' is the loop's own realized P&L; 'account' the whole brokerage
   *  account, which a deposit or a hand trade could move. Null means "ran
   *  before the basis was tracked" — read as the old, account-derived
   *  behaviour.
   *
   *  It describes the evaluator rather than the outcome, so a MISSED session
   *  carries it too. That is load-bearing: the review's goal rate uses it to
   *  decide which sessions its denominator may trust, and while it existed
   *  only on reached days that denominator dropped misses and kept reaches.
   *  See `recordGoalBasis`. */
  goalBasis: GoalBasis;
}

interface Row {
  et_date: string;
  baseline_equity_usd: number | null;
  close_equity_usd: number | null;
  account_gain_pct: number | null;
  strategy_pnl_usd: number;
  strategy_gain_pct: number | null;
  live_trades: number;
  paper_pnl_usd: number;
  goal_reached: number;
  give_back_halted: number;
  drawdown_halted: number;
  account_strategy_diverged: number;
  divergence_usd: number | null;
  pre_open_move_usd: number | null;
  recorded_at: number;
  risk_per_trade_pct: number | null;
  goal_basis: string | null;
}

const map = (r: Row): DailyResult => ({
  etDate: r.et_date,
  baselineEquityUsd: r.baseline_equity_usd,
  closeEquityUsd: r.close_equity_usd,
  accountGainPct: r.account_gain_pct,
  strategyPnlUsd: r.strategy_pnl_usd,
  strategyGainPct: r.strategy_gain_pct,
  liveTrades: r.live_trades,
  paperPnlUsd: r.paper_pnl_usd,
  goalReached: r.goal_reached === 1,
  giveBackHalted: r.give_back_halted === 1,
  drawdownHalted: r.drawdown_halted === 1,
  accountStrategyDiverged: r.account_strategy_diverged === 1,
  divergenceUsd: r.divergence_usd,
  preOpenMoveUsd: r.pre_open_move_usd,
  recordedAt: r.recorded_at,
  riskPerTradePct: r.risk_per_trade_pct,
  // Anything unrecognised reads as null — the conservative side, since null
  // means "assume the old basis" everywhere it is consumed.
  goalBasis: r.goal_basis === 'strategy' || r.goal_basis === 'account' ? r.goal_basis : null,
});

/**
 * Idempotent upsert. Re-recording a day REPLACES it: the recorder runs on
 * every tick after the close and a correction (`POST …/record?date=`) must be
 * able to overwrite a row written from a bad equity reading. Nothing here
 * merges, because a half-updated day is harder to reason about than a
 * re-derived one.
 */
export function saveDailyResult(r: DailyResult): void {
  db.prepare(
    `INSERT INTO autotrade_daily_results
       (et_date, baseline_equity_usd, close_equity_usd, account_gain_pct, strategy_pnl_usd,
        strategy_gain_pct, live_trades, paper_pnl_usd, goal_reached, give_back_halted,
        drawdown_halted, account_strategy_diverged, divergence_usd, pre_open_move_usd,
        recorded_at, risk_per_trade_pct, goal_basis)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(et_date) DO UPDATE SET
       baseline_equity_usd = excluded.baseline_equity_usd,
       close_equity_usd = excluded.close_equity_usd,
       account_gain_pct = excluded.account_gain_pct,
       strategy_pnl_usd = excluded.strategy_pnl_usd,
       strategy_gain_pct = excluded.strategy_gain_pct,
       live_trades = excluded.live_trades,
       paper_pnl_usd = excluded.paper_pnl_usd,
       goal_reached = excluded.goal_reached,
       give_back_halted = excluded.give_back_halted,
       drawdown_halted = excluded.drawdown_halted,
       account_strategy_diverged = excluded.account_strategy_diverged,
       divergence_usd = excluded.divergence_usd,
       pre_open_move_usd = excluded.pre_open_move_usd,
       recorded_at = excluded.recorded_at,
       risk_per_trade_pct = excluded.risk_per_trade_pct,
       goal_basis = excluded.goal_basis`,
  ).run(
    r.etDate,
    r.baselineEquityUsd,
    r.closeEquityUsd,
    r.accountGainPct,
    r.strategyPnlUsd,
    r.strategyGainPct,
    r.liveTrades,
    r.paperPnlUsd,
    r.goalReached ? 1 : 0,
    r.giveBackHalted ? 1 : 0,
    r.drawdownHalted ? 1 : 0,
    r.accountStrategyDiverged ? 1 : 0,
    r.divergenceUsd,
    r.preOpenMoveUsd,
    r.recordedAt,
    r.riskPerTradePct,
    r.goalBasis,
  );
}

/** Only the ACCOUNT half. The backfill writes strategy columns for sessions
 *  that predate the baseline row; a later real recording must be able to fill
 *  in the account half without discarding them — and vice versa. */
export function getDailyResult(etDate: string): DailyResult | null {
  const row = db.prepare('SELECT * FROM autotrade_daily_results WHERE et_date = ?').get(etDate) as Row | undefined;
  return row ? map(row) : null;
}

export function listDailyResults(from?: string, to?: string): DailyResult[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) {
    clauses.push('et_date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('et_date <= ?');
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (
    db.prepare(`SELECT * FROM autotrade_daily_results ${where} ORDER BY et_date ASC`).all(...params) as Row[]
  ).map(map);
}

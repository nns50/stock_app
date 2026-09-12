import { db } from './index';

// ---------------------------------------------------------------------------
// One row per trading session — see the DDL comment in db/index.ts for why
// there are two percentages and why several columns are nullable.
// ---------------------------------------------------------------------------

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
  /** The account and the strategy disagree by more than 0.5% of equity — a
   *  deposit, a withdrawal, or trading by hand. */
  manualTrading: boolean;
  recordedAt: number;
  /** The risk % in force on this session. Null on a row recorded before the
   *  column existed and on every backfilled historical row — which is what
   *  makes it usable as the review's window test: a null cannot be mistaken
   *  for "this session ran the current sizing". */
  riskPerTradePct: number | null;
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
  manual_trading: number;
  recorded_at: number;
  risk_per_trade_pct: number | null;
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
  manualTrading: r.manual_trading === 1,
  recordedAt: r.recorded_at,
  riskPerTradePct: r.risk_per_trade_pct,
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
        drawdown_halted, manual_trading, recorded_at, risk_per_trade_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       manual_trading = excluded.manual_trading,
       recorded_at = excluded.recorded_at,
       risk_per_trade_pct = excluded.risk_per_trade_pct`,
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
    r.manualTrading ? 1 : 0,
    r.recordedAt,
    r.riskPerTradePct,
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

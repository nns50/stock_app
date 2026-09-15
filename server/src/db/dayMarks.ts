import { db } from './index';

// ---------------------------------------------------------------------------
// One row per loop tick: what the day looked like at that moment.
// See the DDL comment in db/index.ts for why there are three quantities and
// why the mark deliberately excludes options.
// ---------------------------------------------------------------------------

export interface DayMark {
  etDate: string;
  at: number;
  baselineEquityUsd: number;
  /** What the loop has BANKED — the figure the day-level halts decide on. */
  realizedUsd: number;
  /** The mark on the loop's own open STOCK positions. Excludes options; see
   *  `openOptions` for whether that exclusion is empty or not. */
  unrealizedEquityUsd: number;
  /** The broker's net liquidation, or null when the read failed. */
  accountEquityUsd: number | null;
  openEquity: number;
  /** Open live options positions, which are NOT in `unrealizedEquityUsd`. A
   *  non-zero value here means the mark is partial, and a reader that treats it
   *  as the whole book is wrong by however much those contracts have moved. */
  openOptions: number;
}

interface Row {
  et_date: string;
  at: number;
  baseline_equity_usd: number;
  realized_usd: number;
  unrealized_equity_usd: number;
  account_equity_usd: number | null;
  open_equity: number;
  open_options: number;
}

const map = (r: Row): DayMark => ({
  etDate: r.et_date,
  at: r.at,
  baselineEquityUsd: r.baseline_equity_usd,
  realizedUsd: r.realized_usd,
  unrealizedEquityUsd: r.unrealized_equity_usd,
  accountEquityUsd: r.account_equity_usd,
  openEquity: r.open_equity,
  openOptions: r.open_options,
});

/** Idempotent on (etDate, at): a tick that somehow runs twice overwrites its
 *  own sample rather than doubling the series. */
export function saveDayMark(m: DayMark): void {
  db.prepare(
    `INSERT INTO autotrade_day_marks
       (et_date, at, baseline_equity_usd, realized_usd, unrealized_equity_usd,
        account_equity_usd, open_equity, open_options)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(et_date, at) DO UPDATE SET
       baseline_equity_usd = excluded.baseline_equity_usd,
       realized_usd = excluded.realized_usd,
       unrealized_equity_usd = excluded.unrealized_equity_usd,
       account_equity_usd = excluded.account_equity_usd,
       open_equity = excluded.open_equity,
       open_options = excluded.open_options`,
  ).run(
    m.etDate,
    m.at,
    m.baselineEquityUsd,
    m.realizedUsd,
    m.unrealizedEquityUsd,
    m.accountEquityUsd,
    m.openEquity,
    m.openOptions,
  );
}

export function listDayMarks(etDate: string): DayMark[] {
  const rows = db.prepare('SELECT * FROM autotrade_day_marks WHERE et_date = ? ORDER BY at ASC').all(etDate) as Row[];
  return rows.map(map);
}

/** The ET dates that have any samples, newest first — so a reader can find the
 *  sessions worth asking about without guessing. */
export function listDayMarkDates(limit = 30): string[] {
  const rows = db
    .prepare('SELECT DISTINCT et_date FROM autotrade_day_marks ORDER BY et_date DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 400)) as { et_date: string }[];
  return rows.map((r) => r.et_date);
}

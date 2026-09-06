import { Position, listPositions } from '../../db/positions';
import { LiveOptionsPosition, listLiveOptionsPositions, liveOptionsPnl } from '../../db/autotradeLiveOptionsPositions';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { realizedPnlOf, lastExitDate } from '../pnl';
import { etToday } from '../../util/marketDate';
import { FULL_HOLIDAYS } from '../trading/marketCalendar';

// ---------------------------------------------------------------------------
// Per-symbol loss cooldown (2026-08-22). The live ledger showed the loop has
// no memory of losing on a name: SOBR stopped it out twice in ONE day (-1R,
// then -1.97R on the re-entry), SKYQ twice in four days. Whatever made a
// symbol untradeable this week — a broken chart, a news overhang, chop that
// eats every stop — tends to persist longer than the 60s the loop waits
// before it can re-enter.
//
// Rule: once a symbol has taken `symbolCooldownLosses` LOSING closed trades
// within the trailing `symbolCooldownWindowDays` calendar days, its NEW live
// entries (stock AND options — a symbol is cooled as a symbol, whichever
// instrument lost) are skipped until `symbolCooldownDays` calendar days after
// the most recent qualifying loss.
//
// The threshold matters — the same ledger shows the counter-case (LVWR lost
// -0.98R at 12:30 and the same-day re-entry won +1.93R), so ONE loss must
// never trigger; the config floor keeps the trigger at ≥ 2. Wins and
// breakeven scratches never count.
//
// TRADING days, not calendar days (2026-09-06). It was calendar days, on the
// stated grounds that "the difference only stretches a cooldown across a
// weekend the market wasn't trading anyway" — and that is backwards. A weekend
// does not stretch the cooldown, it CONSUMES it while no session passes, so the
// same 3-day rule skipped anywhere from 3 sessions to none depending purely on
// which weekday the last loss landed on:
//
//   loss Mon or Tue -> 3 sessions skipped
//   loss Wed        -> 2
//   loss Thu or Fri -> 1
//
// The live case that surfaced it is the worst one. IOT and ORCL each took their
// second qualifying loss on Friday 2026-09-04; the cooldown ran to Monday
// 09-07, which was Labor Day; the next session was Tuesday 09-08. **Zero
// sessions skipped** — the two most-repeated names in the book, cooled for
// nothing, eligible again at the next open.
//
// Counting sessions makes symbolCooldownDays mean what its name and this
// header always claimed. The market calendar it needs already exists
// (services/trading/marketCalendar.ts, 2026-09-05), so a weekend or a holiday
// now costs the cooldown nothing instead of spending it.
//
// LIVE entries only. Paper deliberately keeps trading the cooled name — it
// stays the always-on sanity track, and its trades are the evidence that the
// name has started behaving again. Exits, scale-ins on an existing position,
// and everything else are untouched: this gates NEW real-money entries, only.
// ---------------------------------------------------------------------------

export interface SymbolCooldownState {
  symbol: string;
  /** Qualifying losses inside the window (≥ the configured trigger). */
  losses: number;
  /** ET date (YYYY-MM-DD) of the most recent qualifying loss. */
  lastLossDate: string;
  /** First ET date the symbol trades again — cooled while today < until. */
  until: string;
}

export type SymbolCooldownConfig = Pick<
  AutotradeConfig,
  'symbolCooldownLosses' | 'symbolCooldownWindowDays' | 'symbolCooldownDays'
>;

/** YYYY-MM-DD + n days, in pure date arithmetic (no timezone re-derivation —
 *  the inputs are already ET trading-day labels). Still calendar days: the
 *  LOOKBACK WINDOW (symbolCooldownWindowDays) is a "how recent is this loss"
 *  question, where calendar time is the right unit. Only the cooldown's own
 *  length moved to sessions. */
export function addDays(etDate: string, n: number): string {
  const [y, m, d] = etDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** True when this ET date is a day the US equity market actually trades. */
function isSession(etDate: string): boolean {
  const [y, m, d] = etDate.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !FULL_HOLIDAYS.has(etDate);
}

/**
 * The ET date `n` TRADING sessions after `etDate` — the last day the cooldown
 * still bites, so a comparison of `today <= until` skips exactly n sessions
 * whatever weekend or holiday falls inside it.
 *
 * Bounded rather than unbounded: a stale holiday table (see marketCalendar's
 * CALENDAR_THROUGH) can only ever make this scan longer, and a cooldown is not
 * worth an infinite loop. 40 calendar days covers any plausible n with room to
 * spare, and running out returns the last date reached — which shortens the
 * cooldown, the safe direction for a gate that BLOCKS trades.
 */
export function addSessions(etDate: string, n: number): string {
  if (n <= 0) return etDate;
  let cursor = etDate;
  let left = n;
  for (let i = 0; i < 40 && left > 0; i += 1) {
    cursor = addDays(cursor, 1);
    if (isSession(cursor)) left -= 1;
  }
  return cursor;
}

/** {symbol, lossDate} rows from both live books — the same two-source ledger
 *  methodSizing.ts reads (journal stocks + the live options book's own rows),
 *  filtered to REALIZED LOSSES only. */
function lossDates(closed: Position[], liveOptionsClosed: LiveOptionsPosition[]): { symbol: string; date: string }[] {
  const out: { symbol: string; date: string }[] = [];
  for (const p of closed) {
    const date = lastExitDate(p);
    if (date && realizedPnlOf(p) < 0) out.push({ symbol: p.symbol.toUpperCase(), date });
  }
  for (const p of liveOptionsClosed) {
    if (p.status !== 'closed' || p.exitPrice === null || p.exitAt === null) continue;
    if (liveOptionsPnl(p, p.exitPrice) < 0) {
      out.push({ symbol: p.symbol.toUpperCase(), date: etToday(p.exitAt) });
    }
  }
  return out;
}

/**
 * Active cooldowns as of `today`, keyed by symbol (uppercase). Pure. Empty
 * when the feature is off (`symbolCooldownLosses` 0) — and a trigger of 1 is
 * treated as off too (see the header: single-loss re-entries have won; the
 * feature exists for REPEATED losses).
 */
export function computeSymbolCooldowns(
  closed: Position[],
  liveOptionsClosed: LiveOptionsPosition[],
  cfg: SymbolCooldownConfig,
  today: string,
): Map<string, SymbolCooldownState> {
  const out = new Map<string, SymbolCooldownState>();
  if (cfg.symbolCooldownLosses < 2) return out;
  const windowStart = addDays(today, -(cfg.symbolCooldownWindowDays - 1));
  const bySymbol = new Map<string, string[]>();
  for (const { symbol, date } of lossDates(closed, liveOptionsClosed)) {
    if (date < windowStart || date > today) continue;
    const arr = bySymbol.get(symbol);
    if (arr) arr.push(date);
    else bySymbol.set(symbol, [date]);
  }
  for (const [symbol, dates] of bySymbol) {
    if (dates.length < cfg.symbolCooldownLosses) continue;
    const lastLossDate = dates.reduce((a, b) => (a > b ? a : b));
    const until = addSessions(lastLossDate, cfg.symbolCooldownDays);
    if (today < until) out.set(symbol, { symbol, losses: dates.length, lastLossDate, until });
  }
  return out;
}

/** Convenience for the live executors and the dashboard: fetch the same
 *  ledger both use everywhere else and compute today's active cooldowns. */
export function activeSymbolCooldowns(
  cfg: SymbolCooldownConfig,
  now: number = Date.now(),
): Map<string, SymbolCooldownState> {
  if (cfg.symbolCooldownLosses < 2) return new Map();
  const closed = listPositions({ status: 'closed' }).filter((p) => p.tags.includes('autotrade'));
  return computeSymbolCooldowns(closed, listLiveOptionsPositions({ status: 'closed' }), cfg, etToday(now));
}

/**
 * Journal an entry-skip AT MOST once per symbol per ET day. The loop re-emits
 * the same signal every ~60s tick, so journaling each skip would flood Recent
 * Activity with hundreds of identical lines (the exact failure mode the
 * halt-time options-exit fix already cleaned up once); one line per day per
 * symbol says everything the operator needs. Shared by the cooldown and the
 * finish-line ramp — any per-candidate skip the loop repeats.
 */
export function journalEntrySkipOncePerDay(
  symbol: string,
  action: string,
  detail: Record<string, unknown>,
  now: number = Date.now(),
  /** Journal stage. Defaults to 'execution' — every caller predating
   *  2026-09-02 is an execution-stage entry skip. The live options RISK
   *  refusal reuses this throttle but genuinely belongs in 'risk_check', and
   *  the dedupe read has to look in the same stage it writes to or the
   *  throttle silently never matches and re-journals every tick. */
  stage: 'execution' | 'risk_check' = 'execution',
): void {
  const today = etToday(now);
  const already = listAutotradeEvents({ stage, symbol, limit: 50 }).some(
    (e) => e.action === action && etToday(e.createdAt) === today,
  );
  if (already) return;
  logAutotradeEvent({ symbol, stage, action, detail });
}

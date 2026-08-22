import { Position, listPositions } from '../../db/positions';
import { LiveOptionsPosition, listLiveOptionsPositions, liveOptionsPnl } from '../../db/autotradeLiveOptionsPositions';
import { AutotradeConfig } from '../../db/autotradeConfig';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { realizedPnlOf, lastExitDate } from '../pnl';
import { etToday } from '../../util/marketDate';

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
// breakeven scratches never count. Calendar days, not trading days —
// documented, and the difference only stretches a cooldown across a weekend
// the market wasn't trading anyway.
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
 *  the inputs are already ET trading-day labels). */
export function addDays(etDate: string, n: number): string {
  const [y, m, d] = etDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
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
    const until = addDays(lastLossDate, cfg.symbolCooldownDays);
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
): void {
  const today = etToday(now);
  const already = listAutotradeEvents({ stage: 'execution', symbol, limit: 50 }).some(
    (e) => e.action === action && etToday(e.createdAt) === today,
  );
  if (already) return;
  logAutotradeEvent({ symbol, stage: 'execution', action, detail });
}

import { dispatchAutotradeNotification } from './notify';
import { getAutotradeDashboard } from './dashboard';
import { HaltPool, haltMarkerExists, writeDailyHaltMarker } from './dailyHaltMarker';

// ---------------------------------------------------------------------------
// Daily-drawdown-halt alerting.
//
// The other loop-driven alerts (kill switch engaged, a run of live-order
// rejections) push a notification the moment they happen; the daily-drawdown
// halt never did — it's recomputed fresh on every risk-check (riskCheck.ts's
// `daily_drawdown_halt`), not a persisted state with a "just tripped" moment
// to hook into. This closes that gap by treating "already alerted for
// TODAY" as the state to track, journaled the same restart-safe way
// liveFailureAlert.ts's throttle is.
//
// TWO POOLS, ONE PER HALT (2026-09-23). The halt level (one shared % of the
// day's opening equity) is applied against two independent daily P&Ls, and a
// bad day in one book must alert even if the other is fine. There used to be
// THREE pools, live stock and live options judged separately, and neither
// matched the halt the live book actually runs: both live risk checks compare
// stock PLUS options against the level (liveExecute.ts adds the options seed,
// liveOptionsExecute.ts adds the stock snapshot). So a day losing $1,500 on
// stock and $700 on options against a $2,000 level halted every live entry and
// pushed nothing, while options alone at -$2,100 on a +$500 stock day pushed
// "new live options entries are blocked" about a halt no check applied.
//
// The marker this writes is also the halt's only dated record, which the daily
// results row and the sizing review read. See dailyHaltMarker.ts.
// ---------------------------------------------------------------------------

const POOL_LABEL: Record<HaltPool, string> = { paper: 'Paper', live: 'LIVE' };

/** Today's date (YYYY-MM-DD) in US/Eastern — the same "trading day" convention
 *  riskCheck.ts's own etDateStr() uses, duplicated here for the same reason
 *  that file's header comment gives (avoids a circular import). */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Cached formatter instead of calling n.toLocaleString(locale, options) fresh
// every time — that re-parses the options and builds a new ICU formatter on
// EVERY call. Same output, reusing one Intl.NumberFormat via .format().
const usdFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usd(n: number): string {
  return `$${usdFormatter.format(n)}`;
}

/**
 * Check both pools against the daily-drawdown halt and alert once per
 * pool per (ET) trading day the first time it's found halted — reset
 * naturally the next day, no explicit "un-halt" notification (mirrors the
 * kill switch's own only-on-engage convention: the safe direction doesn't
 * need a push). Best-effort and never throws; `now` is injectable for tests.
 * Returns true iff anything dispatched.
 */
export async function maybeAlertDailyDrawdownHalt(now: number = Date.now()): Promise<boolean> {
  const dash = getAutotradeDashboard();
  // Equity unset -> dailyDrawdownHaltLevel is 0 (or -0), which would read
  // every pool as "at or below the halt" the instant equity is configured —
  // not a real halt, just an unset cap. Skip entirely until it's a genuine
  // negative level.
  if (dash.dailyDrawdownHaltLevel >= 0) return false;

  // Each figure is in dollars of realized P&L today, the unit the level is in.
  const pools: { pool: HaltPool; dailyPnl: number; split?: { stockPnl: number; optionsPnl: number } }[] = [
    { pool: 'paper', dailyPnl: dash.dailyPnl },
    {
      pool: 'live',
      dailyPnl: dash.liveDailyPnl + dash.liveOptionsDailyPnl,
      split: { stockPnl: dash.liveDailyPnl, optionsPnl: dash.liveOptionsDailyPnl },
    },
  ];

  const today = etDateStr(now);
  let dispatchedAny = false;
  for (const { pool, dailyPnl, split } of pools) {
    if (dailyPnl > dash.dailyDrawdownHaltLevel) continue; // not halted
    if (haltMarkerExists(pool, today)) continue;

    // Journal the marker BEFORE dispatching, same reasoning as
    // liveFailureAlert.ts — the journal is the throttle's source of truth
    // even if the dispatch is slow and another tick runs concurrently.
    writeDailyHaltMarker({ pool, date: today, dailyPnl, haltLevel: dash.dailyDrawdownHaltLevel, ...split });
    const label = POOL_LABEL[pool];
    const breakdown = split ? ` (stock ${usd(split.stockPnl)}, options ${usd(split.optionsPnl)})` : '';
    await dispatchAutotradeNotification('daily drawdown halt', [
      {
        title: `Autotrade daily-drawdown halt (${label})`,
        message:
          `${label} daily P&L (${usd(dailyPnl)})${breakdown} crossed the halt level (${usd(dash.dailyDrawdownHaltLevel)}) — ` +
          `new ${label.toLowerCase()} entries are blocked for the rest of today. Existing positions' stops/` +
          `targets keep working regardless.`,
      },
    ]);
    dispatchedAny = true;
  }
  return dispatchedAny;
}

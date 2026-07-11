import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';
import { getAutotradeDashboard } from './dashboard';

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
// Three independent pools, since the halt level (one shared % of equity) is
// applied against three independent daily P&Ls (dashboard.ts's own header
// comment on why paper/live/live-options are never combined) — a bad day in
// one book must alert even if the others are fine, and vice versa.
// ---------------------------------------------------------------------------

type HaltPool = 'paper' | 'live' | 'liveOptions';

const POOL_LABEL: Record<HaltPool, string> = { paper: 'Paper', live: 'LIVE', liveOptions: 'LIVE options' };

/** Our own "we alerted" marker, journaled so the once-per-day throttle
 *  survives a restart — mirrors liveFailureAlert.ts's ALERT_ACTION. */
const ALERT_ACTION = 'daily_halt_alerted';

interface AlertMarkerDetail {
  pool: HaltPool;
  /** ET calendar date (YYYY-MM-DD) this alert covers — see etDateStr below. */
  date: string;
}

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

function alreadyAlertedToday(pool: HaltPool, today: string): boolean {
  return listAutotradeEvents({ stage: 'config', actions: [ALERT_ACTION], limit: 50 }).some((e) => {
    if (!e.detail) return false;
    try {
      const detail = JSON.parse(e.detail) as AlertMarkerDetail;
      return detail.pool === pool && detail.date === today;
    } catch {
      return false;
    }
  });
}

/**
 * Check all three pools against the daily-drawdown halt and alert once per
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

  const pools: { pool: HaltPool; dailyPnl: number }[] = [
    { pool: 'paper', dailyPnl: dash.dailyPnl },
    { pool: 'live', dailyPnl: dash.liveDailyPnl },
    { pool: 'liveOptions', dailyPnl: dash.liveOptionsDailyPnl },
  ];

  const today = etDateStr(now);
  let dispatchedAny = false;
  for (const { pool, dailyPnl } of pools) {
    if (dailyPnl > dash.dailyDrawdownHaltLevel) continue; // not halted
    if (alreadyAlertedToday(pool, today)) continue;

    // Journal the marker BEFORE dispatching, same reasoning as
    // liveFailureAlert.ts — the journal is the throttle's source of truth
    // even if the dispatch is slow and another tick runs concurrently.
    logAutotradeEvent({
      stage: 'config',
      action: ALERT_ACTION,
      detail: { pool, date: today } satisfies AlertMarkerDetail,
    });
    const label = POOL_LABEL[pool];
    await dispatchNotifications([
      {
        title: `Autotrade daily-drawdown halt (${label})`,
        message:
          `${label} daily P&L (${usd(dailyPnl)}) crossed the halt level (${usd(dash.dailyDrawdownHaltLevel)}) — ` +
          `new ${label.toLowerCase()} entries are blocked for the rest of today. Existing positions' stops/` +
          `targets keep working regardless.`,
      },
    ]);
    dispatchedAny = true;
  }
  return dispatchedAny;
}

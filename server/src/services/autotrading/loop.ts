import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { runAutotradeScreen, ScreenCandidate } from './screen';
import { runAutotradeDecision } from './decide';
import { runPaperExecution, checkPaperExits } from './execute';
import { checkSessionWindow, checkVolatility, defaultVolatilityFilterConfig, getMarketAtrPct } from './executionGuards';

// ---------------------------------------------------------------------------
// The autonomous execution loop (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP):
// Research & Screen → Decision → Risk Check → Execution → Journal, on a
// recurring in-process interval. Mirrors alertScheduler.ts's self-scheduling
// setTimeout pattern exactly: on/off is read fresh from the DB every cycle
// (autotrade_config.enabled — no restart needed to toggle), one try/catch per
// tick so a single bad cycle can't kill the loop, and the timer is unref'd so
// it never keeps the process alive on its own.
//
// Currently paper-only (see execute.ts) — this loop can place a real order
// only once Phase 8 adds a live-capable execution path and the manual flag
// for it is flipped; nothing here calls that path.
// ---------------------------------------------------------------------------

const TICK_INTERVAL_SECONDS = 60;
/** "No new entries in the first/last N minutes of the session" (spec). */
const SESSION_BUFFER_MINUTES = 15;

export interface LoopTickSummary {
  ranEntries: boolean;
  skippedReason?: string;
  exitsChecked: number;
  exitsClosed: number;
  candidatesScreened: number;
  candidatesPassedVolatility: number;
  signalsGenerated: number;
  entriesOpened: number;
}

/** Ticker-level volatility pre-filter, applied between Screen and Decision —
 *  narrower than the general screener (which a human previewing candidates
 *  may want to see regardless of ATR), specific to what the autonomous loop
 *  is allowed to act on. Journals each exclusion so it's visible in the
 *  activity feed like every other screen-stage decision. */
function filterByVolatility(candidates: ScreenCandidate[], marketAtrPct: number | null): ScreenCandidate[] {
  const cfg = defaultVolatilityFilterConfig();
  return candidates.filter((c) => {
    const check = checkVolatility(c.indicators.atrPct, marketAtrPct, cfg);
    if (!check.ok) {
      logAutotradeEvent({
        symbol: c.symbol,
        stage: 'screen',
        action: 'excluded_volatility',
        detail: { reason: check.reason },
      });
    }
    return check.ok;
  });
}

/**
 * One full cycle. Exits are checked regardless of the session window (a
 * closed/near-the-bell market doesn't invalidate an already-known stop/target
 * level); new entries are skipped entirely outside the allowed window.
 * Exposed for tests and for a manual "run one cycle now" trigger.
 */
export async function runAutotradeLoopTick(): Promise<LoopTickSummary> {
  const exitOutcomes = await checkPaperExits();
  const summary: LoopTickSummary = {
    ranEntries: false,
    exitsChecked: exitOutcomes.length,
    exitsClosed: exitOutcomes.filter((o) => o.closed).length,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    entriesOpened: 0,
  };

  const session = checkSessionWindow(SESSION_BUFFER_MINUTES);
  if (!session.ok) {
    summary.skippedReason = session.reason;
    return summary;
  }

  const screenResult = await runAutotradeScreen();
  summary.candidatesScreened = screenResult.candidates.length;

  const volCfg = defaultVolatilityFilterConfig();
  const marketAtrPct = await getMarketAtrPct(volCfg.marketProxySymbol);
  const passedVolatility = filterByVolatility(screenResult.candidates, marketAtrPct);
  summary.candidatesPassedVolatility = passedVolatility.length;

  const decision = runAutotradeDecision(passedVolatility);
  summary.signalsGenerated = decision.signals.length;

  const outcomes = await runPaperExecution(decision.signals.map((signal) => ({ signal })));
  summary.entriesOpened = outcomes.filter((o) => o.ok).length;
  summary.ranEntries = true;
  return summary;
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  const config = getAutotradeConfig();
  if (config.enabled) {
    try {
      await runAutotradeLoopTick();
    } catch (e) {
      console.error('[autotrade-loop]', (e as Error).message);
    }
  }
  timer = setTimeout(() => void loop(), TICK_INTERVAL_SECONDS * 1000);
  timer.unref?.(); // don't keep the process alive on the timer alone
}

/** Start the loop (idempotent). Call once after the server starts. */
export function startAutotradeLoop(): void {
  if (started) return;
  started = true;
  timer = setTimeout(() => void loop(), 1000);
  timer.unref?.();
}

/** Stop the loop (tests / shutdown). */
export function stopAutotradeLoop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

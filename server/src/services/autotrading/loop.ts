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
// setTimeout pattern exactly: settings are read fresh from the DB every cycle
// (no restart needed to toggle), one try/catch per tick so a single bad cycle
// can't kill the loop, and the timer is unref'd so it never keeps the process
// alive on its own.
//
// The background timer ticks unconditionally — exit-checking (below) must run
// every cycle regardless of enabled/killSwitch, so the outer loop() no longer
// gates on those; runAutotradeLoopTick() does its own, more granular gating.
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

function emptySummary(skippedReason?: string): LoopTickSummary {
  return {
    ranEntries: false,
    skippedReason,
    exitsChecked: 0,
    exitsClosed: 0,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    entriesOpened: 0,
  };
}

/** True while a cycle is actively running. The self-rescheduling timer below
 *  can never overlap ITS OWN ticks (the next setTimeout is only armed after
 *  the current one settles), but `runAutotradeLoopTick` has a second, wholly
 *  independent caller — the manual "run one cycle now" route — which has no
 *  such serialization. Without this guard, a manual trigger landing while the
 *  background tick is mid-flight lets two runPaperExecution() batches each
 *  snapshot the paper portfolio independently, so neither sees the other's
 *  approvals — the same same-batch cap-busting bug class Phase 5's review
 *  found in the backtest engine, reintroduced via inter-call concurrency. */
let tickInFlight = false;

/**
 * One full cycle. Exits are checked regardless of the session window, the
 * master enabled switch, or the kill switch (a closed/near-the-bell market —
 * or a halted loop — doesn't invalidate an already-known stop/target level;
 * in paper mode this loop IS the only thing that can enforce one, so it must
 * keep running). New entries are skipped entirely when the kill switch is
 * engaged, when auto-trading is disabled, or outside the allowed session
 * window. Exposed for tests and for a manual "run one cycle now" trigger —
 * both callers get identical gating from this one function.
 */
export async function runAutotradeLoopTick(): Promise<LoopTickSummary> {
  if (tickInFlight) return emptySummary('A cycle is already running');
  tickInFlight = true;
  try {
    const exitOutcomes = await checkPaperExits();
    const summary: LoopTickSummary = {
      ...emptySummary(),
      exitsChecked: exitOutcomes.length,
      exitsClosed: exitOutcomes.filter((o) => o.closed).length,
    };

    const config = getAutotradeConfig();
    if (config.killSwitch) {
      summary.skippedReason = 'Kill switch is engaged — new entries halted';
      return summary;
    }
    if (!config.enabled) {
      summary.skippedReason = 'Auto-trading is disabled';
      return summary;
    }

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

    // Re-check right before executing: screening + deciding above is
    // network-bound (sector classification, market-ATR proxy) and can take
    // meaningful wall-clock time, so a kill switch engaged mid-cycle must
    // still stop THIS cycle's entries, not just the next one — the initial
    // gate check above only protects against it being engaged before a cycle
    // starts.
    const recheck = getAutotradeConfig();
    if (recheck.killSwitch || !recheck.enabled) {
      summary.skippedReason = recheck.killSwitch
        ? 'Kill switch engaged mid-cycle — entries aborted before execution'
        : 'Auto-trading was disabled mid-cycle — entries aborted before execution';
      return summary;
    }

    const outcomes = await runPaperExecution(decision.signals.map((signal) => ({ signal })));
    summary.entriesOpened = outcomes.filter((o) => o.ok).length;
    summary.ranEntries = true;
    return summary;
  } finally {
    tickInFlight = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  try {
    await runAutotradeLoopTick();
  } catch (e) {
    console.error('[autotrade-loop]', (e as Error).message);
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
  // Defensive: a tick genuinely in flight keeps running regardless (clearing
  // the timer doesn't cancel an in-progress await chain) — but resetting
  // this here means a test/shutdown path can never leave a stuck `true`
  // (e.g. from a failed assertion skipping a test's own cleanup) wedged
  // across whatever runs next. Today only tests and process shutdown call
  // this, and neither races a genuinely in-flight tick, so this is safe as
  // used. KNOWN GAP if that ever changes (e.g. a future "pause" route calling
  // this at an arbitrary moment): resetting the flag here doesn't stop the
  // in-flight tick itself, so it could still open a paper position after this
  // returns, concurrently with whatever runs next re-entering the guard as if
  // it were clear. Would need real cancellation (an AbortSignal threaded
  // through the tick) to close, not just this reset — deferred until there's
  // an actual caller that needs it.
  tickInFlight = false;
}

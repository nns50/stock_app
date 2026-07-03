import { config } from '../../config';
import { getAutotradeConfig, AutotradeConfig } from '../../db/autotradeConfig';
import { getTradingConfig } from '../../db/trading';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { runAutotradeScreen, ScreenCandidate } from './screen';
import { runAutotradeDecision } from './decide';
import { runOptionsDecision } from './optionsDecide';
import { runPaperExecution, checkPaperExits } from './execute';
import { runLiveExecution, reconcileLiveOrders } from './liveExecute';
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
// The background timer ticks unconditionally — exit-checking and live-order
// reconcile (below) must run every cycle regardless of any gate, so the outer
// loop() no longer gates on those; runAutotradeLoopTick() does its own, more
// granular gating.
//
// Phase 8: paper and live execution are INDEPENDENT — screening/deciding runs
// once per cycle whenever EITHER is active, then each of runPaperExecution()/
// runLiveExecution() is individually gated on its OWN still-active check, so
// disabling one doesn't stop the other. Paper only ever needs autotrade's own
// enabled/killSwitch (it never touches a broker); live additionally needs
// liveTradingEnabled AND the human Trade page's own enabled/killSwitch, since
// live orders share that same real broker account (see liveExecute.ts's
// buildLiveTradingConfig() for the identical combination logic used at
// guardrail-evaluation time — kept in sync deliberately, not by import, since
// this is a plain boolean gate and evaluateGuardrails() needs the full
// TradingConfig shape).
// ---------------------------------------------------------------------------

const TICK_INTERVAL_SECONDS = 60;
/** "No new entries in the first/last N minutes of the session" (spec). */
const SESSION_BUFFER_MINUTES = 15;

export interface LoopTickSummary {
  ranEntries: boolean;
  skippedReason?: string;
  exitsChecked: number;
  exitsClosed: number;
  /** Live order reconcile — always runs, regardless of any gate (read-only
   *  toward the broker; materializes fills the broker already produced). */
  liveOrdersReconciled: number;
  livePositionsClosed: number;
  candidatesScreened: number;
  candidatesPassedVolatility: number;
  signalsGenerated: number;
  /** Options signals generated this cycle (Phase 9) — read-only, like
   *  signalsGenerated: no risk-check or order exists for these yet. 0 when
   *  the configured provider doesn't support options, not just when none
   *  qualified. */
  optionsSignalsGenerated: number;
  /** Paper entries opened this cycle — 0 whenever paper wasn't active, same
   *  as always (unchanged from pre-Phase-8 behavior). */
  entriesOpened: number;
  /** Live entries opened this cycle — 0 whenever live wasn't active (never
   *  attempted), not "zero of some attempted". */
  liveEntriesOpened: number;
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
    liveOrdersReconciled: 0,
    livePositionsClosed: 0,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    optionsSignalsGenerated: 0,
    entriesOpened: 0,
    liveEntriesOpened: 0,
  };
}

/** Whether autotrade's live path is allowed to place NEW entries right now —
 *  the deploy-level TRADING_ENABLED env gate, autotrade's own
 *  liveTradingEnabled + killSwitch, AND the human Trade page's own
 *  enabled/killSwitch, since live orders share that same real broker
 *  account. Mirrors liveExecute.ts's buildLiveTradingConfig() (this is a
 *  cheap early check so the loop doesn't bother screening at all when live
 *  can't place anyway; attemptLiveEntry() re-checks TRADING_ENABLED itself
 *  as the authoritative, final gate — never rely on this one alone). */
function isLiveEntryActive(autotradeCfg: AutotradeConfig): boolean {
  const humanCfg = getTradingConfig();
  return (
    config.trading.placeEnabled &&
    autotradeCfg.liveTradingEnabled &&
    !autotradeCfg.killSwitch &&
    humanCfg.enabled &&
    !humanCfg.killSwitch
  );
}

function isPaperEntryActive(autotradeCfg: AutotradeConfig): boolean {
  return autotradeCfg.enabled && !autotradeCfg.killSwitch;
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
 * One full cycle. Exits and the live-order reconcile are checked regardless
 * of the session window or either gate (a closed/near-the-bell market — or a
 * halted loop — doesn't invalidate an already-known stop/target level; in
 * paper mode this loop IS the only thing that can enforce one, and the live
 * reconcile is read-only toward the broker, so both must keep running).
 *
 * New entries are skipped entirely (screening doesn't even run) when NEITHER
 * paper nor live is active, or outside the allowed session window. When at
 * least one is active, screening/deciding runs ONCE and each of paper/live
 * execution is independently gated on its OWN still-active check — disabling
 * one doesn't stop the other. Exposed for tests and for a manual "run one
 * cycle now" trigger — both callers get identical gating from this one
 * function.
 */
export async function runAutotradeLoopTick(): Promise<LoopTickSummary> {
  if (tickInFlight) return emptySummary('A cycle is already running');
  tickInFlight = true;
  try {
    const exitOutcomes = await checkPaperExits();
    const liveReconcileOutcomes = await reconcileLiveOrders();
    const summary: LoopTickSummary = {
      ...emptySummary(),
      exitsChecked: exitOutcomes.length,
      exitsClosed: exitOutcomes.filter((o) => o.closed).length,
      liveOrdersReconciled: liveReconcileOutcomes.length,
      livePositionsClosed: liveReconcileOutcomes.filter((o) => o.action === 'exit_filled').length,
    };

    const config = getAutotradeConfig();
    const paperActive = isPaperEntryActive(config);
    const liveActive = isLiveEntryActive(config);
    if (!paperActive && !liveActive) {
      summary.skippedReason = config.killSwitch
        ? 'Kill switch is engaged — new entries halted'
        : 'Neither paper nor live auto-trading is active';
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

    // Options decide (Phase 9) — same already-screened/volatility-filtered
    // candidates, run unconditionally alongside the equity decision (no
    // separate enable toggle yet, mirroring how equity decide itself has
    // none — Phase 10+ is where a risk-checked/executable options path, and
    // therefore something worth gating, will actually exist). This is also
    // how real IV-rank history accrues over time for anything the loop
    // screens, per the spec's own stated goal — skipping this call would
    // leave that coverage permanently bootstrapped.
    const optionsDecision = await runOptionsDecision(passedVolatility);
    summary.optionsSignalsGenerated = optionsDecision.signals.length;

    // Re-check right before executing: screening + deciding above is
    // network-bound (sector classification, market-ATR proxy) and can take
    // meaningful wall-clock time, so either gate changing mid-cycle must
    // still affect THIS cycle's entries, not just the next one — the initial
    // gate check above only protects against it being set before a cycle
    // starts. Each path is re-checked independently, not as a combined
    // all-or-nothing recheck: paper going inactive mid-cycle must not also
    // cancel an otherwise-still-active live cycle, and vice versa.
    const recheck = getAutotradeConfig();
    const paperStillActive = isPaperEntryActive(recheck);
    const liveStillActive = isLiveEntryActive(recheck);
    if (!paperStillActive && !liveStillActive) {
      summary.skippedReason = recheck.killSwitch
        ? 'Kill switch engaged mid-cycle — entries aborted before execution'
        : 'Auto-trading was disabled mid-cycle — entries aborted before execution';
      return summary;
    }

    if (paperStillActive) {
      const outcomes = await runPaperExecution(decision.signals.map((signal) => ({ signal })));
      summary.entriesOpened = outcomes.filter((o) => o.ok).length;
    }
    if (liveStillActive) {
      const liveOutcomes = await runLiveExecution(decision.signals.map((signal) => ({ signal })));
      summary.liveEntriesOpened = liveOutcomes.filter((o) => o.ok).length;
    }
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

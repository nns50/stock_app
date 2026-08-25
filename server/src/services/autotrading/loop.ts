import { config } from '../../config';
import { getAutotradeConfig, AutotradeConfig } from '../../db/autotradeConfig';
import { saveLastTick } from '../../db/autotradeLastTick';
import { getTradingConfig } from '../../db/trading';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { runAutotradeScreen, ScreenCandidate } from './screen';
import { computeMarketRegime } from '../marketRegime';
import { resolveScoringWeights } from './regimeWeights';
import { selectCorrelationAware } from './correlationSelection';
import { runAutotradeDecision } from './decide';
import { runOptionsDecision } from './optionsDecide';
import { runPaperExecution, checkPaperExits } from './execute';
import {
  runOptionsPaperExecution,
  checkOptionsPaperExits,
  getOptionsPaperPortfolioSnapshot,
  optionsSeedForEquity,
} from './optionsExecute';
import {
  runLiveExecution,
  reconcileLiveOrders,
  syncAccountEquityFromBroker,
  checkLiveEquityTimeExits,
  checkLiveEquityScaleOuts,
  checkLiveScaleIns,
  adoptOrphanedLivePositions,
  checkLiveBracketProtection,
} from './liveExecute';
import {
  runLiveOptionsExecution,
  checkLiveOptionsExits,
  reconcileLiveOptionsOrders,
  syncLiveOptionsPositionsFromBroker,
  liveOptionsSeedForEquity,
} from './liveOptionsExecute';
import { maybeAlertLiveOrderFailures, maybeAlertLiveAmbiguity } from './liveFailureAlert';
import { reanchorLiveCapsIfDrifted } from './liveCapsReanchor';
import { DailyTargetStatus, updateDailyTarget } from './dailyTarget';
import { hasExpiredLiveOptions, sweepExpiredLiveOptions } from './liveOptionsExpiry';
import { maybeAlertDailyDrawdownHalt } from './dailyHaltAlert';
import { maybeAutoTune } from './autoTune';
import {
  checkSessionWindow,
  checkMacroEventBlackout,
  checkVolatility,
  getMarketAtrPct,
  VolatilityFilterConfig,
} from './executionGuards';
import { listMacroEvents } from '../../db/macroEvents';
import { runWebullPositionsSync } from '../../providers/webull/positions';
import { processMoversForPromotion } from './moversPromotion';
import { checkForRecentSplits } from './splitCheck';

// ---------------------------------------------------------------------------
// The autonomous execution loop (docs/AUTOTRADING_SPEC.md — EXECUTION LOOP):
// Research & Screen → Decision → Risk Check → Execution → Journal, on a
// recurring in-process interval. Mirrors alertScheduler.ts's self-scheduling
// setTimeout pattern exactly: settings are read fresh from the DB every cycle
// (no restart needed to toggle), one try/catch per tick so a single bad cycle
// can't kill the loop, and the timer is unref'd so it never keeps the process
// alive on its own.
//
// The background timer ticks unconditionally — exit-checking, live-order
// reconcile, both live position-truth backstops (equity and options), and the
// equity sync from the broker (below) must run every cycle regardless of any
// gate, so the outer loop() no longer gates on those; runAutotradeLoopTick()
// does its own, more granular gating.
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

export interface LoopTickSummary {
  ranEntries: boolean;
  skippedReason?: string;
  exitsChecked: number;
  exitsClosed: number;
  /** Options paper positions checked/closed for the time-exit trigger this
   *  cycle (Phase 12) — like exitsChecked/exitsClosed, runs unconditionally
   *  regardless of any gate or session window (an approaching expiration
   *  doesn't wait for the market to be open, or for the kill switch to be
   *  off — see optionsExecute.ts's checkOptionsPaperExits()). */
  optionsExitsChecked: number;
  optionsExitsClosed: number;
  /** Live order reconcile — always runs, regardless of any gate (read-only
   *  toward the broker; materializes fills the broker already produced). */
  liveOrdersReconciled: number;
  livePositionsClosed: number;
  /** Live OPTIONS order reconcile (Task #70 Step D) — same always-runs,
   *  read-only-toward-the-broker posture as liveOrdersReconciled, over
   *  autotrade_live_options_orders instead. */
  liveOptionsOrdersReconciled: number;
  liveOptionsPositionsClosed: number;
  /** Live options closing orders newly PLACED this cycle (the time-exit
   *  trigger firing) — always runs, like exitsChecked/optionsExitsChecked.
   *  Unlike those, this counts orders actually REQUESTED, not every open
   *  position considered: checkLiveOptionsExits() only reports a position it
   *  actually attempted to close (already-in-flight and not-yet-triggered
   *  positions are silently skipped, not reported as a checked-but-not-closed
   *  outcome) — closing here is a broker round-trip, not instantaneous, so
   *  "closed" isn't known until a LATER liveOptionsPositionsClosed. */
  liveOptionsExitsRequested: number;
  /** Live EQUITY closing orders newly PLACED this cycle (maxHoldDays firing) —
   *  always runs. Mirrors liveOptionsExitsRequested's own semantics exactly:
   *  a count of orders actually REQUESTED (checkLiveEquityTimeExits() only
   *  reports a position it actually attempted to close), not "closed" —
   *  that's a later liveOrdersReconciled/livePositionsClosed. */
  liveTimeExitsRequested: number;
  /** Live scale-in add-ons actually placed at the broker this tick (0 unless
   *  liveScaleInEnabled and a position hit its add-on trigger). */
  liveScaleInsRequested: number;
  /** Live equity scale-out orders newly PLACED this tick (0 unless
   *  liveScaleOutEnabled and a position reached the R trigger). */
  liveScaleOutsRequested: number;
  candidatesScreened: number;
  candidatesPassedVolatility: number;
  signalsGenerated: number;
  /** Options signals generated this cycle (Phase 9) — read-only, like
   *  signalsGenerated: no risk-check or order exists for these yet. 0 when
   *  the configured provider doesn't support options, not just when none
   *  qualified. */
  optionsSignalsGenerated: number;
  /** Candidates actually passed to the options decision this cycle — a
   *  subset of candidatesPassedVolatility, restricted to discoverySource
   *  'universe' (see the note above the options decision call). Lets the
   *  Monitoring dashboard distinguish "0 options signals because nothing
   *  passed volatility" from "0 because every passing candidate was
   *  movers-sourced and never reached the options decision at all". */
  optionsCandidatesConsidered: number;
  /** Paper entries opened this cycle — 0 whenever paper wasn't active, same
   *  as always (unchanged from pre-Phase-8 behavior). */
  entriesOpened: number;
  /** Options paper entries opened this cycle (Phase 12) — 0 whenever paper
   *  wasn't active. There is no options-live path (Phase 12 is paper-only),
   *  so unlike equity this has no liveEntriesOpened counterpart. */
  optionsEntriesOpened: number;
  /** Live entries opened this cycle — 0 whenever live wasn't active (never
   *  attempted), not "zero of some attempted". */
  liveEntriesOpened: number;
  /** Live OPTIONS entries opened this cycle (Task #70 Step D) — 0 whenever
   *  live options wasn't active, mirroring liveEntriesOpened exactly. */
  liveOptionsEntriesOpened: number;
  /** Movers-sourced symbols newly added to the persistent universe this cycle
   *  (moversPromotion.ts) — always runs when autoPromoteMoversEnabled, same
   *  as candidatesScreened, independent of paper/live being active. Each
   *  promotion also gets its own 'universe_auto_promoted' journal entry with
   *  the occurrence/threshold detail; this is just the rollup count. */
  moversAutoPromoted: number;
}

/** Ticker-level volatility pre-filter, applied between Screen and Decision —
 *  narrower than the general screener (which a human previewing candidates
 *  may want to see regardless of ATR), specific to what the autonomous loop
 *  is allowed to act on. Journals each exclusion so it's visible in the
 *  activity feed like every other screen-stage decision. `cfg` comes from
 *  the caller (config-derived) rather than being re-derived here, so there's
 *  one source of truth for the cycle instead of two separate reads. */
function filterByVolatility(
  candidates: ScreenCandidate[],
  marketAtrPct: number | null,
  cfg: VolatilityFilterConfig,
): ScreenCandidate[] {
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
    optionsExitsChecked: 0,
    optionsExitsClosed: 0,
    liveOrdersReconciled: 0,
    livePositionsClosed: 0,
    liveOptionsOrdersReconciled: 0,
    liveOptionsPositionsClosed: 0,
    liveOptionsExitsRequested: 0,
    liveTimeExitsRequested: 0,
    liveScaleInsRequested: 0,
    liveScaleOutsRequested: 0,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    optionsSignalsGenerated: 0,
    optionsCandidatesConsidered: 0,
    entriesOpened: 0,
    optionsEntriesOpened: 0,
    liveEntriesOpened: 0,
    liveOptionsEntriesOpened: 0,
    moversAutoPromoted: 0,
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

/** Whether autotrade's LIVE OPTIONS path is allowed to place NEW entries
 *  right now — everything isLiveEntryActive() already requires, PLUS
 *  liveOptionsEnabled: it's a checkbox nested UNDER the master live gate
 *  (Task #70's confirmed design), not an independent toggle, so it can never
 *  be active while the equity live gate itself isn't. Because of that, the
 *  "should we even screen" checks below don't need a separate term for this —
 *  liveOptionsActive implies liveActive by construction. */
function isLiveOptionsEntryActive(autotradeCfg: AutotradeConfig): boolean {
  return isLiveEntryActive(autotradeCfg) && autotradeCfg.liveOptionsEnabled;
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

/** Set for the lifetime of one in-flight tick; aborted by stopAutotradeLoop()
 *  so a tick genuinely in progress stops short of placing new entries instead
 *  of just having tickInFlight reset out from under it (see stopAutotradeLoop's
 *  own comment — this is what closes that previously-documented gap). Not a
 *  hard interrupt (nothing here supports mid-await cancellation), just a flag
 *  checked at the one point between the network-bound screen/decide work and
 *  the execution calls that actually place risk. */
let tickAbortController: AbortController | null = null;

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
  const abortController = new AbortController();
  tickAbortController = abortController;
  // Declared here (not just inside the try below) so the finally block can
  // persist it regardless of which of the try block's several return points
  // actually ran — undefined only if something threw before it was ever
  // built, in which case there's nothing meaningful yet to persist.
  let summary: LoopTickSummary | undefined;
  try {
    const exitOutcomes = await checkPaperExits();
    const optionsExitOutcomes = await checkOptionsPaperExits();
    const liveReconcileOutcomes = await reconcileLiveOrders();
    // Backstop for the order-based reconcile just above: reconcileLiveOrders()
    // only detects an exit via the SPECIFIC bracket order it placed and is
    // tracking (webullOrderStatus() on that one order's idempotencyKey) — an
    // ambiguous broker response (both exit legs reporting FILLED) or a close
    // that happened some other way (e.g. Webull-side auto-liquidation) leaves
    // the position open rather than guessing, by design. This diffs autotrade's
    // OWN liveAccountId against Webull's actual live holdings the same way
    // webullPositionsScheduler.ts's background sync does for the Positions
    // page — reusing that exact, already-tested logic — so autotrade's live
    // positions tile stays accurate WITHOUT depending on that separate,
    // independently-configured Settings-page feature also being set up for
    // the same account (confirmed missing in practice: the two account-id
    // fields are entered independently and nothing keeps them in sync).
    // No-ops when liveAccountId isn't set; caught so a broker hiccup here
    // can't take down anything else in this tick.
    try {
      const liveCfg = getAutotradeConfig();
      if (liveCfg.liveAccountId) await runWebullPositionsSync(liveCfg.liveAccountId);
    } catch (e) {
      console.error('[autotrade-loop] live position-truth sync failed:', (e as Error).message);
    }
    // Runs right after the sync above so a position it just imported
    // untracked (tagged 'webull' only) gets a chance to be healed the SAME
    // tick, if it matches a pending autotrade entry — see the function's own
    // doc comment for why this exists (reconcileLiveOrders() missing a fill
    // before the sync above ran and imported it as an untagged orphan,
    // invisible to the Auto page's live-positions table and its own risk/P&L
    // accounting). Sync/DB-only, no broker calls of its own; caught so an
    // unexpected DB error here can't take down anything else in this tick.
    try {
      adoptOrphanedLivePositions();
    } catch (e) {
      console.error('[autotrade-loop] adopting orphaned live positions failed:', (e as Error).message);
    }
    // Runs after the reconcile/sync above for the same reason checkLiveOptionsExits
    // runs after ITS OWN reconcile/sync below: a position closed (or found
    // already closed) by either of those this same tick shouldn't also get a
    // wasted maxHoldDays cancel-and-close attempt here. Not wrapped in its own
    // try/catch, matching checkLiveOptionsExits' own call site below — an
    // unexpected throw here surfaces the same way an unexpected throw there
    // would (caught by this function's own outer try, below).
    // Does each bracketed live position still have a stop AT THE BROKER? The
    // bracket's exit legs are submitted with the entry and never verified, so
    // an entry Webull accepted while dropping its exits leaves a real position
    // naked while every screen here shows it protected. Read-only, one
    // open-orders pull, reports and never acts (see the function's own comment
    // for why auto-re-arming would be worse than the gap). Caught so a broker
    // hiccup here can't take down the rest of the tick.
    try {
      await checkLiveBracketProtection();
    } catch (e) {
      console.error('[autotrade-loop] bracket protection check failed:', (e as Error).message);
    }
    // Scale out of a live winner BEFORE the time exits below. Order matters:
    // a scale-out is skipped entirely once an exit order is working, so running
    // the exits first would mean a position that qualified for both never banks
    // anything — the timer would take the whole thing at whatever R it happened
    // to be. Reducing risk, so it needs no entry gate; it has its own
    // liveScaleOutEnabled flag and session check.
    let liveScaleOutOutcomes: Awaited<ReturnType<typeof checkLiveEquityScaleOuts>> = [];
    try {
      liveScaleOutOutcomes = await checkLiveEquityScaleOuts();
    } catch (e) {
      console.error('[autotrade-loop] live scale-out check failed:', (e as Error).message);
    }
    const liveEquityTimeExitOutcomes = await checkLiveEquityTimeExits();
    // Scale into winners on LIVE positions — gated like an ENTRY (it ADDS risk
    // to real money), so behind isLiveEntryActive (kill switch + master gates)
    // ON TOP OF checkLiveScaleIns' own liveScaleInEnabled/cap checks AND its
    // own session-window check. Market hours are NOT part of isLiveEntryActive
    // (this comment used to claim they were), and this call deliberately runs
    // before the tick's own checkSessionWindow below, so the session gate lives
    // inside checkLiveScaleIns where it cannot be bypassed by ordering. Unlike the time-exit above (which must fire even when entries are
    // halted, to close), a scale-in must NOT fire while entries are halted.
    // Fail-closed inside — one position's broker hiccup never crashes the loop.
    // First daily-target measurement of the tick — BEFORE scale-ins, which add
    // real risk and must respect a banked day. Reads the PREVIOUS tick's synced
    // equity (this tick's sync runs later); one tick of staleness is harmless
    // because the reach is sticky and re-measured below after the sync.
    let dailyTarget: DailyTargetStatus = {
      active: false,
      reached: false,
      giveBackArmed: false,
      giveBackHalted: false,
      entriesHalted: false,
    };
    try {
      dailyTarget = updateDailyTarget();
    } catch (e) {
      console.error('[autotrade-loop] daily-target check failed:', (e as Error).message);
    }
    const liveScaleInOutcomes =
      isLiveEntryActive(getAutotradeConfig()) && !dailyTarget.entriesHalted ? await checkLiveScaleIns() : [];
    // Reconcile before checking for NEW triggers: catches up on anything an
    // earlier cycle already placed (an entry that filled, an exit that
    // filled) so a position closed by reconcile this same tick is already
    // gone from listOpenLiveOptionsPositions() by the time checkLiveOptionsExits
    // runs, rather than raising a question of re-triggering it in the same pass.
    const liveOptionsReconcileOutcomes = await reconcileLiveOptionsOrders();
    // Backstop for reconcileLiveOptionsOrders() just above, mirroring the
    // equity backstop above it — but MORE necessary here: an options position
    // often has NO order watching it at all for most of its life (a closing
    // order only exists once checkLiveOptionsExits(), below, has actually
    // managed to place one), so there's frequently nothing for order-based
    // reconcile to even poll. Diffs each open live options position's leg(s)
    // against Webull's actual current holdings (see
    // syncLiveOptionsPositionsFromBroker's own doc comment for the full
    // reasoning, including why a debit spread only closes when BOTH legs are
    // confirmed gone). Runs before checkLiveOptionsExits() for the same
    // reason the comment above already applies to reconcile: a position this
    // just closed shouldn't also get a wasted new closing order placed for it
    // this same tick. No-ops without a liveAccountId; caught so a broker
    // hiccup here can't take down anything else in this tick.
    try {
      const liveOptionsCfg = getAutotradeConfig();
      if (liveOptionsCfg.liveAccountId) await syncLiveOptionsPositionsFromBroker(liveOptionsCfg.liveAccountId);
    } catch (e) {
      console.error('[autotrade-loop] live options position-truth sync failed:', (e as Error).message);
    }
    // An option held THROUGH expiry never produces a closing order, and neither
    // of the two mechanisms above can retire it: the reconcile has no order to
    // poll, and the sync confirms the contract is gone but then needs a price
    // to book the exit at — which for a past-expiration chain never comes back,
    // so its "retry next sync" never terminates. The row then counts against
    // combinedLiveOpenRisk() for BOTH books forever. Gated on there being
    // something expired so the common tick costs one indexed read and no
    // candle fetch. Caught like its neighbours: a market-data hiccup here must
    // not take down the rest of the tick.
    try {
      if (hasExpiredLiveOptions()) await sweepExpiredLiveOptions();
    } catch (e) {
      console.error('[autotrade-loop] expired live options sweep failed:', (e as Error).message);
    }
    const liveOptionsExitOutcomes = await checkLiveOptionsExits();
    // Keep accountEquityUsd fresh every tick instead of requiring the
    // Configuration tile's "Sync from Webull" button — read-only toward the
    // broker and, like the reconciles above, independent of every gate (see
    // syncAccountEquityFromBroker's own doc comment). Runs before `config` is
    // (re-)read below so this cycle's own risk sizing already sees the synced
    // value. No-ops via its own liveAccountId check when live trading isn't
    // configured; caught anyway (it isn't expected to throw) so a future
    // broker hiccup here can never take down exits/reconcile above or entries
    // below. log: false — mark-to-market drifts the balance on nearly every
    // once-a-minute check, so logging an equity_synced entry per tick would
    // flood Recent Activity's fixed window with noise (confirmed in practice);
    // the manual "Sync from Webull" button still journals every change.
    try {
      await syncAccountEquityFromBroker({ log: false });
    } catch (e) {
      console.error('[autotrade-loop] equity sync failed:', (e as Error).message);
    }
    // Right after the sync so it sees this tick's equity: re-derive the four
    // equity-scaled DOLLAR caps once equity has drifted ≥15% from the equity
    // they were tuned at — the percent caps re-scale themselves, but a stored
    // dollar cap silently loosens (relative to intent) as the account shrinks.
    // No-op until a tune has armed the anchor; hand-edited caps are never
    // touched. Pure math + at most one config write; caught so nothing here
    // can take down the tick.
    try {
      reanchorLiveCapsIfDrifted();
    } catch (e) {
      console.error('[autotrade-loop] live-caps re-anchor failed:', (e as Error).message);
    }
    // Re-measure the daily-gain goal with THIS tick's just-synced equity, so
    // the entry gates below see the freshest number (the first measurement
    // above ran before the sync, for the scale-in gate). Second call is safe:
    // the baseline rolls at most once per ET day and the reached event is
    // guarded by the persisted reached_at, so it can never double-journal.
    // Fails toward the earlier status — an error here must never halt entries
    // on a goal nobody could measure.
    try {
      dailyTarget = updateDailyTarget();
    } catch (e) {
      console.error('[autotrade-loop] daily-target refresh failed:', (e as Error).message);
    }
    // Detection only (never adjusts a position's own quantity/price) — see
    // splitCheck.ts's own header comment. Self-gated to once per ET day, so
    // this is a no-op (no network call) on every other tick; caught so a
    // Yahoo hiccup here can't take down anything else in this tick.
    try {
      await checkForRecentSplits();
    } catch (e) {
      console.error('[autotrade-loop] split check failed:', (e as Error).message);
    }
    summary = {
      ...emptySummary(),
      exitsChecked: exitOutcomes.length,
      exitsClosed: exitOutcomes.filter((o) => o.closed).length,
      optionsExitsChecked: optionsExitOutcomes.length,
      optionsExitsClosed: optionsExitOutcomes.filter((o) => o.closed).length,
      liveOrdersReconciled: liveReconcileOutcomes.length,
      livePositionsClosed: liveReconcileOutcomes.filter((o) => o.action === 'exit_filled').length,
      liveOptionsOrdersReconciled: liveOptionsReconcileOutcomes.length,
      liveOptionsPositionsClosed: liveOptionsReconcileOutcomes.filter((o) => o.action === 'exit_filled').length,
      liveOptionsExitsRequested: liveOptionsExitOutcomes.filter((o) => o.requested).length,
      liveTimeExitsRequested: liveEquityTimeExitOutcomes.filter((o) => o.requested).length,
      liveScaleInsRequested: liveScaleInOutcomes.filter((o) => o.requested).length,
      liveScaleOutsRequested: liveScaleOutOutcomes.filter((o) => o.requested).length,
    };

    const config = getAutotradeConfig();
    const paperActive = isPaperEntryActive(config);
    // A banked (or give-back-protected) day halts LIVE entries only: the
    // daily-gain goal is a % of the real account's value, so paper (which has
    // no real account) keeps trading — it stays the always-on sanity track
    // either way.
    const liveActive = isLiveEntryActive(config) && !dailyTarget.entriesHalted;
    if (!paperActive && !liveActive) {
      summary.skippedReason = config.killSwitch
        ? 'Kill switch is engaged — new entries halted'
        : dailyTarget.entriesHalted && isLiveEntryActive(config)
          ? dailyTarget.reached
            ? `Daily gain target reached (+${dailyTarget.gainPct}% ≥ ${dailyTarget.targetPct}%) — live entries banked for the day`
            : `Give-back guard fired (day gain fell back to ${dailyTarget.giveBackFloorPct}% after arming at ${dailyTarget.giveBackArmPct}%) — live entries protected for the day`
          : 'Neither paper nor live auto-trading is active';
      return summary;
    }

    const session = checkSessionWindow(config.sessionBufferMinutes);
    if (!session.ok) {
      summary.skippedReason = session.reason;
      return summary;
    }

    // Market-wide, same as checkSessionWindow just above — checked once per
    // cycle, never per-candidate (see executionGuards.ts's own doc comment).
    const macroBlackout = checkMacroEventBlackout(listMacroEvents(), config.macroEventBlackoutHours);
    if (!macroBlackout.ok) {
      summary.skippedReason = macroBlackout.reason;
      return summary;
    }

    // Market regime read (best-effort, cached ~1h in marketRegime.ts): used
    // two ways. (1) Regime-conditional weights (2026-07-24, default off):
    // when enabled, this tick scores with the regime's weight preset instead
    // of the fixed defaults — resolveScoringWeights itself checks the flag,
    // so reading the label unconditionally can't change scoring while the
    // flag is off. (2) At-entry context (2026-07-26): the label is stamped
    // on every position opened this tick, so realized outcomes can later be
    // sliced by the regime they were entered under — which is why the read
    // is no longer gated on the weights flag. A failed fetch resolves to
    // null (context stays empty, weights fall back to the fixed defaults)
    // and never blocks the tick.
    const regimeLabel: 'risk-on' | 'neutral' | 'risk-off' | null =
      (await computeMarketRegime().catch(() => null))?.label ?? null;
    if (config.regimeAdaptiveWeightsEnabled && regimeLabel) {
      logAutotradeEvent({
        stage: 'screen',
        action: 'regime_weights_applied',
        detail: { regime: regimeLabel },
      });
    }
    const screenResult = await runAutotradeScreen({
      config: {
        filters: {
          minRelVol: config.minRelVol,
          minChangePct: config.minChangePct,
          minPrice: config.minPrice,
          minAvgVolume: config.minAvgVolume,
          minScore: config.minSignalScore,
          requireWeeklyTrendAlignment: config.requireWeeklyTrendAlignment,
        },
        weights: resolveScoringWeights(config, regimeLabel),
        momentumIntradayOnly: config.momentumIntradayOnly,
        benchmarkSymbol: config.benchmarkSymbol,
        relativeStrengthLookbackDays: config.relativeStrengthLookbackDays,
      },
      earningsBlackoutDays: config.earningsBlackoutDays,
      minRelVolPace: config.minRelVolPace,
      directionMode: config.tradeDirection,
      moversEnabled: config.moversDiscoveryEnabled,
    });
    summary.candidatesScreened = screenResult.candidates.length;
    // Symbols the screen could not score at all this tick (provider errors —
    // in practice almost always rate limiting). Until 2026-08-24 this array
    // was collected by the screen and then DROPPED here: ~7% of a 560-symbol
    // universe was vanishing from every scan with nothing recorded, so a name
    // that would have qualified could be missed all session and leave no
    // trace. It is not treated as a failure (the tick's surviving candidates
    // are still perfectly valid) — but it IS recorded, once per tick, with the
    // symbols named, so incomplete coverage can never again look identical to
    // "nothing qualified". Sampled rather than dumped whole: the point is
    // visibility, not a 40-symbol wall in Recent Activity.
    if (screenResult.errors.length > 0) {
      logAutotradeEvent({
        stage: 'screen',
        action: 'screen_data_incomplete',
        detail: {
          unscored: screenResult.errors.length,
          scanned: screenResult.discovery.scannedCount,
          symbols: screenResult.errors.slice(0, 12).map((e) => e.symbol),
          sampleMessage: screenResult.errors[0]?.message,
          note: 'these symbols were not scored this tick — provider errors, usually rate limiting',
        },
        riskProfile: config.riskProfile,
      });
    }

    // Movers auto-promotion: runs against the full screened set (before the
    // volatility pre-filter below), since a symbol's own recurrence in movers
    // is independent of whether TODAY's overall market conditions happen to
    // be too choppy for the loop to actually enter anything — see
    // moversPromotion.ts's header comment. Own try/catch so a DB hiccup here
    // can't take down screening/decision/execution.
    try {
      const promotion = processMoversForPromotion(screenResult.candidates, config);
      summary.moversAutoPromoted = promotion.promoted.length;
    } catch (e) {
      console.error('[autotrade-loop] movers auto-promotion failed:', (e as Error).message);
    }

    const volCfg: VolatilityFilterConfig = {
      maxTickerAtrPct: config.maxTickerAtrPct,
      maxMarketAtrPct: config.maxMarketAtrPct,
      marketProxySymbol: 'SPY',
    };
    const marketAtrPct = await getMarketAtrPct(volCfg.marketProxySymbol);
    const passedVolatility = filterByVolatility(screenResult.candidates, marketAtrPct, volCfg);
    summary.candidatesPassedVolatility = passedVolatility.length;

    // Correlation-aware selection (2026-07-24, default off): re-rank the
    // score-sorted survivors so that among mutually-correlated names the
    // higher-scored one keeps its rank and the redundant lower one is demoted
    // to the back — diverse picks win the downstream caps instead of a
    // correlated huddle. Reorders only (never drops; the correlated-exposure
    // veto in risk-check stays the real backstop), and feeds BOTH the equity
    // decision and the options universeOnly filter below so the two stay in
    // sync. Own gate + no-op when disabled, so the default path does no extra
    // candle fetching.
    const selection = await selectCorrelationAware(passedVolatility, (c) => c.symbol, {
      enabled: config.correlationAwareSelectionEnabled,
      threshold: config.correlationThreshold,
      lookbackDays: config.correlationLookbackDays,
    });
    if (selection.demoted.length > 0) {
      logAutotradeEvent({
        stage: 'screen',
        action: 'correlation_demoted',
        detail: { count: selection.demoted.length, demoted: selection.demoted },
      });
    }
    const selectedCandidates = selection.ordered;

    const decision = runAutotradeDecision(selectedCandidates, {
      stopAtrMultiple: config.stopAtrMultiple,
      maxStopDistancePct: config.maxStopDistancePct,
      targetRMultiple: config.targetRMultiple,
    });
    summary.signalsGenerated = decision.signals.length;

    // Options decide (Phase 9) — run unconditionally alongside the equity
    // decision (no separate enable toggle yet, mirroring how equity decide
    // itself has none). UNLIKE equity, restricted to discoverySource
    // 'universe' — Webull's premarket movers/gainers are a essentially a
    // different set of speculative small-caps every day, so a mover-sourced
    // symbol almost never gets screened again; since real IV-rank history
    // (services/ivRank.ts) accrues one sample per CALENDAR DAY a symbol is
    // screened, a mover that never reappears can never accumulate the
    // history the options decision wants — a permanent, not temporary,
    // block. Confirmed 2026-07-09 against a real run where every rejected
    // candidate was mover-shaped. The persistent universe list IS screened
    // every cycle, so it's exactly where that history can actually compound
    // over time — equity autotrading keeps using movers for momentum/
    // breakout, unaffected.
    const universeOnly = selectedCandidates.filter((c) => c.discoverySource === 'universe');
    summary.optionsCandidatesConsidered = universeOnly.length;
    const optionsDecision = await runOptionsDecision(universeOnly, {
      strategyType: config.optionsStrategyType,
      maxIvRvRatio: config.optionsMaxIvRvRatio,
      entryConfig: {
        deltaMin: config.optionsDeltaMin,
        deltaMax: config.optionsDeltaMax,
        maxSpreadPct: config.optionsMaxSpreadPct,
        minOpenInterest: config.optionsMinOpenInterest,
        minVolume: config.optionsMinVolume,
        minDaysToExpiration: config.optionsMinDte,
        maxDaysToExpiration: config.optionsMaxDte,
        ivRankMax: config.optionsIvRankMax,
        ivRankMin: config.optionsIvRankMin,
      },
    });
    summary.optionsSignalsGenerated = optionsDecision.signals.length;

    // Re-check right before executing: screening + deciding above is
    // network-bound (sector classification, market-ATR proxy) and can take
    // meaningful wall-clock time, so either gate changing mid-cycle must
    // still affect THIS cycle's entries, not just the next one — the initial
    // gate check above only protects against it being set before a cycle
    // starts. Each path is re-checked independently, not as a combined
    // all-or-nothing recheck: paper going inactive mid-cycle must not also
    // cancel an otherwise-still-active live cycle, and vice versa.
    //
    // Also where stopAutotradeLoop()'s abort signal is honored — the SAME
    // network-bound window means a stop call can land after this tick already
    // started but before it's reached the point of actually placing anything.
    // This is real cancellation (not just stopAutotradeLoop() resetting
    // tickInFlight out from under an in-flight tick), closing the gap flagged
    // in that function's own comment.
    if (abortController.signal.aborted) {
      summary.skippedReason = 'Loop stopped mid-cycle — entries aborted before execution';
      return summary;
    }
    const recheck = getAutotradeConfig();
    const paperStillActive = isPaperEntryActive(recheck);
    // Same banked-day gate as `liveActive` above. dailyTarget is this tick's
    // pre-screen status — good enough for a mid-cycle recheck (the next tick
    // re-measures), and both halts are sticky so neither can flap back on
    // mid-cycle.
    const liveStillActive = isLiveEntryActive(recheck) && !dailyTarget.entriesHalted;
    const liveOptionsStillActive = isLiveOptionsEntryActive(recheck);
    if (!paperStillActive && !liveStillActive) {
      summary.skippedReason = recheck.killSwitch
        ? 'Kill switch engaged mid-cycle — entries aborted before execution'
        : 'Auto-trading was disabled mid-cycle — entries aborted before execution';
      return summary;
    }

    if (paperStillActive) {
      // Equity runs first, seeded with options' PRE-EXISTING snapshot (this
      // tick's options entries haven't happened yet); options runs second and
      // reads equity's book directly (optionsExecute.ts's own
      // getPaperPortfolioSnapshot() import), which by now already reflects
      // any equity fills just placed above — see optionsExecute.ts's header
      // comment for why this ordering makes the combined budget real without
      // a circular import between the two files.
      const seed = optionsSeedForEquity(getOptionsPaperPortfolioSnapshot());
      const outcomes = await runPaperExecution(
        decision.signals.map((signal) => ({ signal })),
        seed,
        marketAtrPct,
        regimeLabel,
      );
      summary.entriesOpened = outcomes.filter((o) => o.ok).length;

      const optionsOutcomes = await runOptionsPaperExecution(
        optionsDecision.signals.map((signal) => ({ signal })),
        marketAtrPct,
        regimeLabel,
      );
      summary.optionsEntriesOpened = optionsOutcomes.filter((o) => o.ok).length;
    }
    if (liveStillActive) {
      const liveOutcomes = await runLiveExecution(
        decision.signals.map((signal) => ({ signal })),
        marketAtrPct,
        // Cross-seed the live OPTIONS book's daily P&L / streak / trade count,
        // exactly as the paper batch is seeded from the options paper book just
        // above. The live options batch already folds equity in the other
        // direction; this closes the one-way gap.
        liveOptionsSeedForEquity(),
        regimeLabel,
      );
      summary.liveEntriesOpened = liveOutcomes.filter((o) => o.ok).length;
    }
    if (liveOptionsStillActive) {
      const liveOptionsOutcomes = await runLiveOptionsExecution(
        optionsDecision.signals.map((signal) => ({ signal })),
        marketAtrPct,
        regimeLabel,
      );
      summary.liveOptionsEntriesOpened = liveOptionsOutcomes.filter((o) => o.ok).length;
    }
    summary.ranEntries = true;
    return summary;
  } finally {
    tickInFlight = false;
    if (tickAbortController === abortController) tickAbortController = null;
    // Persist the "last completed tick" snapshot regardless of which return
    // path was taken (including the abort check further up) — undefined only
    // if something threw before `summary` was ever built (see its own
    // declaration comment above), in which case there's nothing meaningful
    // yet to overwrite the previous tick's snapshot with.
    if (summary) saveLastTick(summary);
    // Post-tick: surface a SYSTEMIC run of live-order rejections through the
    // notifier. In `finally` so it runs no matter which return path the tick
    // took — live-order failures are journaled by BOTH the exit/reconcile
    // stages (which run before every early return) and the entry stages.
    // Best-effort, throttled, and never throws.
    await maybeAlertLiveOrderFailures();
    // Same placement and same reasoning, for the other half of the anomaly
    // surface: the branches that resolved an UNKNOWN by deferring (an
    // unanswered placement, a fill the guards refused to book, a bracket whose
    // exit legs both claimed FILLED). Those paths all justify their
    // conservative choice as "loudly journaled for a human to notice", which
    // was only true of the journal itself — nothing pushed them anywhere.
    // Best-effort, throttled, and never throws.
    await maybeAlertLiveAmbiguity();
    // Same reasoning, same placement: the halt is recomputed from state that's
    // already current by this point regardless of which return path the tick
    // took above. Best-effort, throttled to once per pool per day, never throws.
    await maybeAlertDailyDrawdownHalt();
    // Same reasoning, same placement: a no-op unless explicitly enabled, and
    // throttled to once per (ET) trading day internally regardless of how
    // often this tick runs. Best-effort, never throws.
    await maybeAutoTune();
  }
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  try {
    await runAutotradeLoopTick();
  } catch (e) {
    // `instanceof` guard (not a cast): a non-Error throw would make a bare
    // `.message` access itself throw inside this catch, rejecting loop() —
    // an unhandled rejection that kills the process, since loop() is invoked
    // fire-and-forget from a timer.
    console.error('[autotrade-loop]', e instanceof Error ? e.message : e);
  }
  // stopAutotradeLoop() during an in-flight tick used to be undone right
  // here: clearTimeout only cancels the PENDING timer, and this line then
  // scheduled a fresh one. Shutdown/tests rely on stop meaning stopped.
  if (!started) return;
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

/** Stop the loop (tests / shutdown). Real cancellation, not just a flag
 *  reset: aborts a genuinely in-flight tick's own abort controller, so it
 *  stops short of placing new entries at the next checkpoint
 *  (runAutotradeLoopTick's own re-check-right-before-executing point) instead
 *  of racing ahead unaware this was called. Fixes a previously-documented gap
 *  where resetting tickInFlight here didn't stop an in-flight tick, so it
 *  could still open a position concurrently with whatever runs next
 *  re-entering the reentrancy guard as if it were clear. Not an instant
 *  interrupt — nothing here supports mid-await cancellation — but a tick
 *  already screening/deciding when this is called will now correctly skip
 *  its own execution step rather than run it anyway. */
export function stopAutotradeLoop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  tickAbortController?.abort();
  // Resetting this eagerly (not waiting for an in-flight tick's own `finally`)
  // means a test/shutdown path can never leave a stuck `true` (e.g. from a
  // failed assertion skipping a test's own cleanup) wedged across whatever
  // runs next — the abort signal above is what keeps that tick from placing
  // anything, this is just so the reentrancy guard itself doesn't stay stuck.
  tickInFlight = false;
}

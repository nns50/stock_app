import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { TradeSignal, convictionGrade } from './decide';
import {
  correlatedNotional,
  sectorNotional,
  buildSectorOf,
  evaluateRiskCheck,
  RiskCheckContext,
  RiskCheckResult,
} from './riskCheck';
import { computeStreaksAndDrawdown } from '../pnl';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import {
  closePaperPosition,
  hasOpenPaperPosition,
  listOpenPaperPositions,
  listPaperPositions,
  openPaperPosition,
  partialClosePaperPosition,
  paperRealizedPnl,
  paperRealizedR,
  ratchetPaperPositionStop,
  updatePaperPositionBestPrice,
  addToPaperPosition,
  PaperExitReason,
  PaperPosition,
} from '../../db/autotradePaperPositions';
import { computeScaleIn } from './scaleIn';
import { computeEquityCurveDerisk } from './equityCurveDerisk';
import { computeGradeExpectancyMultipliers } from './expectancySizing';
import { journalMethodMultipliers, methodOfEquitySignal } from './methodSizing';
import { getProvider } from '../../providers';
import { mapPool } from '../../util/async';
import { evaluateEndOfDayFlatten } from './endOfDayFlatten';

// ---------------------------------------------------------------------------
// The Execution stage of the Phase 6 paper loop (docs/AUTOTRADING_SPEC.md —
// EXECUTION LOOP, stage 4). Everything here is a LOCAL SIMULATION — no call
// in this file ever reaches the real Webull order pipeline (see the resolved
// decision on "what paper execution means" in the spec).
//
// The risk-check batch here is deliberately scoped to autotrade's OWN paper
// portfolio (autotrade_paper_positions), not the human's real positions
// table — paper trades carry zero real financial exposure, so combining them
// with real positions for cap purposes wouldn't add real safety, and would
// make this phase impossible to observe for anyone with real positions open
// (refines the "known interim scope" note from the Phase 4 risk-engine
// writeup, now that Phase 6 provides a concrete position marker to filter on).
// ---------------------------------------------------------------------------

export interface ExecutionOutcome {
  symbol: string;
  ok: boolean;
  reason?: string;
  position?: PaperPosition;
}

/** Today's date (YYYY-MM-DD) in US/Eastern, NOT UTC — the "trading day" this
 *  loop's daily P&L / consecutive-loss / trades-today figures are bucketed
 *  by. checkPaperExits() runs around the clock (not just during the
 *  session), and UTC midnight falls at 7-8pm ET (squarely inside typical
 *  after-hours activity) — bucketing by UTC date would split the same ET
 *  evening's exits across two different "days," corrupting the next
 *  morning's risk-check inputs (dailyPnl, consecutiveLosses). Mirrors
 *  executionGuards.ts's ET wall-clock parsing convention. */
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

/**
 * Attempt to open a paper position for an approved (already risk-checked)
 * signal. Idempotent: a symbol that already has an open paper position is
 * skipped, never stacked. Fills at a FRESH quote fetched right now, not the
 * signal's own screening-time price — this loop runs in real time, unlike
 * the backtest's next-day-open convention, so "now" IS the fill moment. A
 * quote fetch failure is reported, not silently guessed at (the closest
 * real-time analog to the spec's "explicit handling for... rejected orders,
 * and broker API errors").
 */
export async function attemptPaperEntry(
  signal: TradeSignal,
  riskResult: RiskCheckResult,
  riskProfile: RiskProfileName,
  /** Conviction grade (A/B/C) to stamp on the position, or null. Computed by the
   *  caller from the signal's score + the configured thresholds. */
  grade: string | null = null,
  /** At-entry context to stamp alongside the grade (2026-07-26): the market
   *  regime label + market ATR% the loop read this cycle. Both nullable —
   *  a failed best-effort regime read stamps nothing, never a guess. */
  marketRegime: string | null = null,
  marketAtrPct: number | null = null,
): Promise<ExecutionOutcome> {
  if (!riskResult.ok) return { symbol: signal.symbol, ok: false, reason: 'Risk check did not pass' };
  if (hasOpenPaperPosition(signal.symbol)) {
    return { symbol: signal.symbol, ok: false, reason: 'Already has an open paper position' };
  }

  let fillPrice: number;
  try {
    const quote = await getProvider().getQuote(signal.symbol);
    fillPrice = quote.last;
  } catch (err) {
    const reason = `Quote fetch failed: ${(err as Error).message}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
  }

  // A malformed quote (NaN/0/negative — seen from real providers, not just a
  // theoretical concern) would otherwise reach the DB as a NOT NULL REAL
  // insert and throw there instead, with a much less useful error message.
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    const reason = `Invalid quote price: ${fillPrice}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
  }

  let position: PaperPosition;
  try {
    position = openPaperPosition({
      symbol: signal.symbol,
      side: signal.side,
      quantity: riskResult.sizing.suggestedQuantity,
      entryPrice: fillPrice,
      // Sized off the signal's screening-time entry/stop (riskResult), not
      // this fill's actual price — the two are usually seconds apart within
      // the same cycle, but not reconciled if the quote moved meaningfully
      // in between. A known, documented approximation (see the backtest
      // engine's own header comment for the same kind of tradeoff), not
      // silently assumed accurate.
      stopPrice: signal.stop,
      targetPrice: signal.target,
      riskAmount: riskResult.approvedRiskAmount,
      riskProfile,
      rationale: signal.rationale,
      grade,
      entryScore: signal.score,
      entryComponents: signal.components ?? null,
      marketRegime,
      marketAtrPct,
    });
  } catch (err) {
    // A single candidate's persistence failure must not abort the rest of
    // this batch (runPaperExecution may still have more candidates to try) —
    // matches the "explicit handling for... rejected orders" the spec calls
    // for, and mirrors how the quote-fetch failure above is already handled
    // rather than left to throw.
    const reason = `Failed to record paper position: ${(err as Error).message}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
  }
  logAutotradeEvent({
    symbol: signal.symbol,
    stage: 'execution',
    action: 'paper_order_placed',
    detail: {
      side: signal.side,
      quantity: position.quantity,
      entryPrice: fillPrice,
      stop: signal.stop,
      target: signal.target,
    },
    riskProfile,
  });
  return { symbol: signal.symbol, ok: true, position };
}

export interface PaperPortfolioSnapshot {
  /** ET calendar date ("today") the figures below are bucketed by. */
  today: string;
  openPositions: PaperPosition[];
  /** $ sum(size × stop distance) across open paper positions. */
  openRisk: number;
  openPositionsCount: number;
  /** Realized P&L from paper positions closed today (ET); negative is a loss. */
  dailyPnl: number;
  /** Length of the current losing streak (0 if the last closed trade wasn't a loss). */
  consecutiveLosses: number;
  /** Paper positions opened today (ET) — open or closed. */
  tradesToday: number;
  /** Equity-curve de-risk decision from the paper book's own realized curve
   *  (2026-07-24) — false when disabled or above the average. */
  equityCurveDeriskActive: boolean;
  /** grade → sizing multiplier from the paper book's realized per-grade edge
   *  (2026-07-24); empty when expectancy weighting is off. */
  gradeExpectancyMultipliers: Record<string, number>;
}

/**
 * Current paper-portfolio state — open positions, today's (ET) realized P&L,
 * the consecutive-loss streak, and today's trade count. Shared by
 * runPaperExecution() (below, for its running risk-check batch) and the Phase
 * 7 monitoring dashboard (dashboard.ts), so both read the exact same
 * computation rather than two implementations that could quietly drift apart.
 */
export function getPaperPortfolioSnapshot(): PaperPortfolioSnapshot {
  const today = etDateStr();
  const openPositions = listOpenPaperPositions();
  const recent = listPaperPositions({ limit: 500 }); // open + closed, newest first — plenty for "today" stats
  const closedTodayChrono = recent
    .filter((p) => p.status === 'closed' && p.exitAt !== null && etDateStr(p.exitAt) === today)
    .sort((a, b) => a.exitAt! - b.exitAt!);
  // paperRealizedPnl, not the subtraction: `quantity` is what REMAINS after a
  // scale-out, so the open-coded version was the final leg alone and dropped
  // every banked partial (see db/autotradePaperPositions.ts).
  const closedPnlsChrono = closedTodayChrono.map((p) => paperRealizedPnl(p));
  const dailyPnl = closedPnlsChrono.reduce((s, p) => s + p, 0);
  const { currentStreak } = computeStreaksAndDrawdown(closedPnlsChrono);
  const consecutiveLosses = currentStreak.type === 'loss' ? currentStreak.count : 0;
  const tradesToday = recent.filter((p) => etDateStr(p.entryAt) === today).length;
  const openRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);

  // Equity-curve de-risk from the paper book's OWN full realized history (not
  // just today) — the multi-day curve the moving-average filter needs.
  const config = getAutotradeConfig();
  const closedHistory = recent
    .filter((p) => p.status === 'closed' && p.exitAt !== null && p.exitPrice !== null)
    .map((p) => ({
      date: etDateStr(p.exitAt as number),
      pnl: paperRealizedPnl(p),
    }));
  const equityCurveDeriskActive = computeEquityCurveDerisk(closedHistory, {
    enabled: config.equityCurveDeriskEnabled,
    lookbackDays: config.equityCurveLookbackDays,
    cutPct: config.equityCurveDeriskCutPct,
  }).active;

  // Per-grade expectancy multipliers from the paper book's OWN closed trades.
  const gradeExpectancyMultipliers = computeGradeExpectancyMultipliers(
    recent.flatMap((p) => {
      // paperRealizedR banks the partials. This is the site that mattered
      // most: it SIZES the paper book, and the partial only ever fires at a
      // profit, so the old reading was systematically pessimistic.
      const realizedR = p.status === 'closed' ? paperRealizedR(p) : null;
      return realizedR === null ? [] : [{ grade: p.grade, realizedR }];
    }),
    {
      enabled: config.expectancyWeightingEnabled,
      minTrades: config.expectancyMinTrades,
      minMultiplier: config.expectancyMinMultiplier,
      maxMultiplier: config.expectancyMaxMultiplier,
    },
  );

  return {
    today,
    openPositions,
    openRisk,
    openPositionsCount: openPositions.length,
    dailyPnl,
    consecutiveLosses,
    tradesToday,
    equityCurveDeriskActive,
    gradeExpectancyMultipliers,
  };
}

/** Extra running totals to seed a paper-execution batch with, on top of this
 *  book's own snapshot — how Phase 12 makes the "combined budget" real for
 *  options: `runOptionsPaperExecution()` reads this file's own
 *  getPaperPortfolioSnapshot() directly (a plain one-way import) to see
 *  equity's side, but equity can't import back from optionsExecute.ts
 *  without a cycle, so the loop (which already imports both) reads options'
 *  pre-existing snapshot and passes it in here instead. Every field defaults
 *  to a no-op (0 / empty) when omitted, so every existing caller/test that
 *  doesn't pass one gets EXACTLY today's equity-only behavior. */
export interface PaperPortfolioSeed {
  openRisk: number;
  openPositionsCount: number;
  dailyPnl: number;
  /** Combined via max(), not sum — a losing streak isn't additive across two
   *  books without merging their closed-trade timestamps chronologically,
   *  which step-down sizing doesn't need to be precise about: erring toward
   *  a MORE conservative (larger) streak after recent losses in EITHER book
   *  is the safe direction, not a correctness gap. */
  consecutiveLosses: number;
  tradesToday: number;
  /** 'long' for every seed position — this seed exists for the combined
   *  backtest's options-book cross-seeding (options positions are always
   *  "long the contract," see riskCheck.ts's correlatedNotional() doc
   *  comment on why call/put bullish/bearish direction-awareness is a
   *  separate, not-yet-built concern), so a fixed 'long' here reproduces
   *  the ORIGINAL always-additive correlatedNotional() math exactly. */
  positions: { symbol: string; notional: number; side: 'long' }[];
}

const EMPTY_SEED: PaperPortfolioSeed = {
  openRisk: 0,
  openPositionsCount: 0,
  dailyPnl: 0,
  consecutiveLosses: 0,
  tradesToday: 0,
  positions: [],
};

/**
 * Risk-check, then attempt to fill, a batch of already-decided signals —
 * sequentially against a RUNNING total (open paper positions + already-
 * approved earlier in this same call), mirroring backtest.ts's
 * simulateBacktest() batch pattern and riskCheck.ts's runAutotradeRiskCheck:
 * a batch of individually-fine signals can't jointly bust a cap none of them
 * would trip alone. `seed` optionally folds in another book's (options')
 * running totals — see PaperPortfolioSeed.
 */
export async function runPaperExecution(
  candidates: { signal: TradeSignal }[],
  seed: PaperPortfolioSeed = EMPTY_SEED,
  /** Regime-aware sizing (2026-07-16) — the SAME market-ATR% reading loop.ts
   *  already computes once per cycle for its own volatility hard-cutoff, not
   *  re-fetched here. Defaults to null (regime cut inactive) for any caller
   *  that doesn't have/need one, e.g. a direct test call. */
  marketAtrPct: number | null = null,
  /** Market regime label the loop read this cycle (2026-07-26) — stamped on
   *  each opened position as at-entry context, never used for sizing here.
   *  Defaults to null for callers without one. */
  marketRegime: string | null = null,
): Promise<ExecutionOutcome[]> {
  const config = getAutotradeConfig();
  const equity = config.accountEquityUsd ?? 0;
  // Per-method lean (methodSizing.ts), one journal read per batch — exactly as
  // runOptionsPaperExecution does it.
  //
  // ADDED 2026-09-05. This was the ONLY one of the four books that never
  // applied it: live equity reads it off getLivePortfolioSnapshot(), both
  // options books call journalMethodMultipliers() directly, and paper equity
  // simply left the field off its RiskCheckContext — where evaluateRiskCheck
  // defaults it to 1. Nothing failed; the sizing was just quietly unweighted.
  // runOptionsPaperExecution's own comment calls this "the same lean the
  // equity paths get from their snapshots", plural, which is the symmetry
  // that did not actually hold.
  //
  // It matters because paper is read as evidence for what live would have
  // done: with methodWeightingEnabled on, the two books sized the same signal
  // differently, so paper R was never quite live's R.
  //
  // Journal-sourced (live trades) in every book, deliberately — "which
  // instrument/direction earns" is one global question. Only the GRADE
  // expectancy multiplier below is per-book, because that one is a statement
  // about this book's own realized edge.
  const methodMultipliers = journalMethodMultipliers(config);

  const snapshot = getPaperPortfolioSnapshot();
  const dailyPnl = snapshot.dailyPnl + seed.dailyPnl;
  const consecutiveLosses = Math.max(snapshot.consecutiveLosses, seed.consecutiveLosses);
  const tradesToday = snapshot.tradesToday + seed.tradesToday;
  let runningRisk = snapshot.openRisk + seed.openRisk;
  let runningCount = snapshot.openPositionsCount + seed.openPositionsCount;
  const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = [
    ...snapshot.openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.entryPrice * p.quantity,
      side: (p.side === 'buy' ? 'long' : 'short') as 'long' | 'short',
    })),
    ...seed.positions,
  ];
  const skipSymbols = new Set(snapshot.openPositions.map((p) => p.symbol));
  const sectorOf = buildSectorOf();

  const outcomes: ExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open paper position' });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
      runningPositions,
      config.correlationLookbackDays,
      config.correlationThreshold,
    );
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      signal.side === 'buy' ? 'long' : 'short',
      runningPositions,
      sectorOf,
    );
    const ctx: RiskCheckContext = {
      equity,
      dailyPnl,
      tradesToday,
      consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      maxConcurrentPositions: config.maxConcurrentPositions,
      correlatedNotional: correlated,
      riskPerTradePct: config.riskPerTradePct,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
      stepDownAfterLosses: config.stepDownAfterLosses,
      stepDownSizeCutPct: config.stepDownSizeCutPct,
      maxAggregateOpenRiskPct: config.maxAggregateOpenRiskPct,
      maxCorrelatedExposurePct: config.maxCorrelatedExposurePct,
      maxTradesPerDay: config.maxTradesPerDay,
      correlationThreshold: config.correlationThreshold,
      sectorNotional: sectorAmount,
      maxSectorExposurePct: config.maxSectorExposurePct,
      candidateSector,
      marketAtrPct,
      regimeAtrThresholdPct: config.regimeAtrThresholdPct,
      regimeSizeCutPct: config.regimeSizeCutPct,
      equityCurveDeriskActive: snapshot.equityCurveDeriskActive,
      equityCurveDeriskCutPct: config.equityCurveDeriskCutPct,
      maxAdvParticipationPct: config.maxAdvParticipationPct,
      expectancyMultiplier:
        snapshot.gradeExpectancyMultipliers[
          convictionGrade(signal.score, {
            aMinScore: config.convictionGradeAMinScore,
            bMinScore: config.convictionGradeBMinScore,
          })
        ] ?? 1,
      methodMultiplier: methodMultipliers[methodOfEquitySignal(signal.side)] ?? 1,
    };
    const result = evaluateRiskCheck(signal, ctx);
    logAutotradeEvent({
      symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, quantity: result.sizing.suggestedQuantity },
    });
    if (!result.ok) {
      outcomes.push({ symbol, ok: false, reason: 'Risk check blocked' });
      continue;
    }

    const grade = convictionGrade(signal.score, {
      aMinScore: config.convictionGradeAMinScore,
      bMinScore: config.convictionGradeBMinScore,
    });
    const outcome = await attemptPaperEntry(signal, result, config.riskProfile, grade, marketRegime, marketAtrPct);
    outcomes.push(outcome);
    if (outcome.ok && outcome.position) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({
        symbol,
        notional: outcome.position.entryPrice * outcome.position.quantity,
        side: outcome.position.side === 'buy' ? 'long' : 'short',
      });
      skipSymbols.add(symbol);
    }
  }
  return outcomes;
}

export interface ExitCheckOutcome {
  symbol: string;
  closed: boolean;
  reason?: string;
  position?: PaperPosition;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Check every open paper position against a fresh quote for a stop/target
 * hit, closing (at the declared stop/target LEVEL, not the observed quote —
 * same convention as backtest.ts, so paper and backtest results stay
 * comparable) whichever fires. A live quote is a single point, not a
 * high/low range like a completed daily bar, so — unlike the backtest — a
 * long's stop (below entry) and target (above entry) can never both be
 * "hit" by the same quote; there's no tie to break.
 *
 * A third trigger, checked last (stop and target both take priority, same
 * as backtest.ts's own conservative ordering): maxHoldDays, if configured
 * (0 = disabled). Closes at the CURRENT quote, not a declared level — unlike
 * stop/target, a time-exit has no predetermined price to close at.
 *
 * When none of those three fire, applyPositionManagement (below) gets a
 * chance to scale out part of the position and/or ratchet its stop —
 * breakeven and trailing, PAPER only (see AutotradeConfig's own doc comment
 * on why LIVE equity positions don't get this).
 */
export async function checkPaperExits(): Promise<ExitCheckOutcome[]> {
  const cfg = getAutotradeConfig();
  const { maxHoldDays } = cfg;
  // END-OF-DAY FLATTEN, on the same clock and the same config field as live
  // (2026-09-05). The paper book used to have none, on the reasoning that
  // simulated positions carry no real overnight risk. True about risk, and
  // wrong about MEASUREMENT: with no flatten, every paper position opened late
  // in the session necessarily became an overnight hold, and the live book
  // never takes one.
  //
  // It is not a rounding difference. All twelve paper entries opened inside the
  // last 95 minutes were carried overnight -- not one closed same-day -- and
  // ten of the twelve stopped out — nine of those before noon the next
  // morning, on the opening gap the flatten exists to avoid — for
  // -6.03R against a whole-book total of -2.49R. The paper book's headline was
  // dominated by trades the live strategy could not have held, which is the
  // same disease as reading a scale-out's P&L without its banked slice: judging
  // a book with data that does not reflect what it actually does.
  //
  // Deliberately NOT paired with evaluateEntryCutoff, which stays live-only.
  // That asymmetry is the point: paper keeps opening late entries and now exits
  // them the way live would, so it is the control group for the one question
  // the live book cannot answer about itself -- whether a 95-minute cutoff is
  // buying anything, or just closing a quarter of the session.
  // ---------------------------------------------------------------------
  // WHAT PAPER DELIBERATELY DOES NOT COPY (written down 2026-09-05, resolving
  // a divergence that until now read as an omission).
  //
  // The rule is not "paper mirrors live". It is:
  //
  //   copy the exits that are STRUCTURAL — ones live applies to every position
  //   regardless of how the trade is going — and leave off the ones that ARE
  //   the open question.
  //
  // The flatten above is structural: it is a fact about the clock, not a
  // judgement about the trade, and without it paper could only ever produce
  // overnight holds live never takes.
  //
  // These two stay OFF, and that is the counterfactual, not an oversight:
  //
  //   - the STAGNATION EXIT (90 min / 0.5R). "Does scratching a slow position
  //     help?" is a live open question, and the live book cannot answer it
  //     about itself — it closed the trade, so what the trade would have done
  //     is unobservable there. A paper book that lets the same setups run to
  //     stop, target or the flatten is exactly that missing half. It only
  //     became a VALID counterfactual when the flatten landed; before that
  //     "ran on" meant "held overnight".
  //
  //   - the SYMBOL RE-ENTRY COOLDOWN (90 min). Same shape: whether refusing a
  //     re-entry protects anything is only answerable against a book that
  //     takes them.
  //
  // The live-only ENTRY gates (evaluateEntryCutoff, the finish-line score bar)
  // are off here for the same reason.
  //
  // So paper is live minus exactly three things, each of which is a question
  // someone is trying to answer. Anything else that diverges is a bug.
  // ---------------------------------------------------------------------
  const flatten = evaluateEndOfDayFlatten(cfg, Date.now());
  const open = listOpenPaperPositions();
  return mapPool(open, 6, async (pos): Promise<ExitCheckOutcome> => {
    let last: number;
    try {
      last = (await getProvider().getQuote(pos.symbol)).last;
    } catch (err) {
      return { symbol: pos.symbol, closed: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }

    const long = pos.side === 'buy';
    const stopHit = long ? last <= pos.stopPrice : last >= pos.stopPrice;
    const targetHit = long ? last >= pos.targetPrice : last <= pos.targetPrice;
    const timeHit = !stopHit && !targetHit && maxHoldDays > 0 && Date.now() - pos.entryAt >= maxHoldDays * MS_PER_DAY;
    // Last, so a stop or target that genuinely hit this tick still books as
    // itself: the flatten is what happens to a position nothing else closed.
    const flattenHit = !stopHit && !targetHit && !timeHit && flatten.active;
    if (!stopHit && !targetHit && !timeHit && !flattenHit) {
      applyPositionManagement(pos, last, cfg);
      return { symbol: pos.symbol, closed: false };
    }

    const exitReason: PaperExitReason = stopHit
      ? 'stop'
      : targetHit
        ? 'target'
        : // Both the hold-days cut and the flatten are the clock closing a
          // position nothing else did. The table's exit_reason CHECK allows
          // four values, so they share 'time_exit'; the journal detail below
          // carries which one it was.
          'time_exit';
    const exitPrice = stopHit ? pos.stopPrice : targetHit ? pos.targetPrice : last;
    const closed = closePaperPosition(pos.id, { exitPrice, exitReason });
    if (closed) {
      // paperRealizedPnl over the CLOSED row: the whole trade, partials
      // included. Deriving it from pos.quantity here would have journaled the
      // final leg alone, so a scaled-out winner read as a scratch in the
      // journal exactly as it did everywhere else.
      const pnl = paperRealizedPnl(closed);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'paper_position_closed',
        detail: {
          exitReason,
          exitPrice,
          pnl,
          realizedPartialPnl: closed.realizedPartialPnl,
          // Which clock closed it — 'time_exit' covers both.
          ...(flattenHit ? { closedBy: 'end_of_day_flatten', minutesLeft: flatten.minutesLeft } : {}),
        },
        riskProfile: pos.riskProfile,
      });
    }
    return { symbol: pos.symbol, closed: !!closed, position: closed ?? undefined };
  });
}

/**
 * Trailing stop / breakeven / partial profit-taking — only reached once
 * stop/target/time-exit have all already been ruled out for this cycle.
 * Unrealized gain is measured in R-multiples of the position's OWN
 * `initialStopPrice` (a snapshot frozen at open), never the current,
 * possibly-already-ratcheted `stopPrice` — otherwise a stop that's already
 * trailed partway would make every subsequent R-multiple reading larger
 * than it should be, since the "risk" denominator would keep shrinking as
 * the stop it's derived from moves. Silently a no-op for a row that
 * predates this feature (initialStopPrice/bestPriceSinceEntry null) or
 * whose stop distance is degenerate (zero) — nothing to ratchet against.
 */
function applyPositionManagement(pos: PaperPosition, last: number, cfg: ReturnType<typeof getAutotradeConfig>): void {
  if (pos.initialStopPrice == null) return;
  const long = pos.side === 'buy';
  const initialStopDistance = Math.abs(pos.entryPrice - pos.initialStopPrice);
  if (!(initialStopDistance > 0)) return;

  const rMultiple = long
    ? (last - pos.entryPrice) / initialStopDistance
    : (pos.entryPrice - last) / initialStopDistance;

  // Partial exit — one-time, checked first (a scale-out is the "bigger"
  // action; breakeven/trailing below just adjust where the remainder's stop
  // sits). partialExitTaken guards against re-firing every cycle once done.
  let partialFired = false;
  if (cfg.partialExitRMultiple > 0 && !pos.partialExitTaken && rMultiple >= cfg.partialExitRMultiple) {
    const closeQty = Math.floor(pos.quantity * (cfg.partialExitPct / 100));
    // Skip (retried next cycle) rather than force an edge case: 0 rounds to
    // nothing to close; the full quantity belongs to a real exit, not a
    // scale-out that's supposed to leave a remainder running.
    if (closeQty > 0 && closeQty < pos.quantity) {
      const updated = partialClosePaperPosition(pos.id, { quantity: closeQty, exitPrice: last });
      if (updated) {
        partialFired = true;
        // Read the banked figure back rather than deriving it a second time.
        // This journal line and the row's own P&L used to be two independent
        // computations of the same dollars; only one of them was ever read
        // again, and it was the one thrown away.
        const pnl = updated.realizedPartialPnl - pos.realizedPartialPnl;
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'paper_partial_exit',
          detail: { quantity: closeQty, exitPrice: last, pnl, rMultiple },
          riskProfile: pos.riskProfile,
        });
      }
    }
  }

  // Best price seen since entry — the high-water (long) / low-water (short)
  // mark trailing ratchets against. Cheap bookkeeping; no journal entry.
  const priorBest = pos.bestPriceSinceEntry ?? pos.entryPrice;
  const bestPrice = long ? Math.max(priorBest, last) : Math.min(priorBest, last);
  if (bestPrice !== priorBest) updatePaperPositionBestPrice(pos.id, bestPrice);

  // Breakeven and trailing both just propose a candidate stop; only the
  // MOST favorable of {current stop, breakeven candidate, trailing
  // candidate} ever gets written — this is what guarantees neither one can
  // ever loosen the stop, without needing separate "already applied" flags.
  let candidateStop = pos.stopPrice;
  if (cfg.breakevenTriggerRMultiple > 0 && rMultiple >= cfg.breakevenTriggerRMultiple) {
    candidateStop = long ? Math.max(candidateStop, pos.entryPrice) : Math.min(candidateStop, pos.entryPrice);
  }
  if (cfg.trailStartRMultiple > 0 && cfg.trailStopRMultiple > 0 && rMultiple >= cfg.trailStartRMultiple) {
    const trailDistance = cfg.trailStopRMultiple * initialStopDistance;
    const trailingCandidate = long ? bestPrice - trailDistance : bestPrice + trailDistance;
    candidateStop = long ? Math.max(candidateStop, trailingCandidate) : Math.min(candidateStop, trailingCandidate);
  }
  if (candidateStop !== pos.stopPrice) {
    ratchetPaperPositionStop(pos.id, candidateStop);
    logAutotradeEvent({
      symbol: pos.symbol,
      stage: 'execution',
      action: 'paper_stop_ratcheted',
      detail: { from: pos.stopPrice, to: candidateStop, rMultiple },
      riskProfile: pos.riskProfile,
    });
  }

  // Scale into a winner (pyramiding) — last, and never in the same cycle as a
  // partial scale-OUT (they'd fight over the same quantity). Uses the stop as
  // it stands AFTER any ratchet above (candidateStop), so the add can only
  // raise it further, never undo a trail. See services/autotrading/scaleIn.ts.
  if (!partialFired) {
    const add = computeScaleIn(
      {
        side: pos.side,
        entryPrice: pos.entryPrice,
        initialStopPrice: pos.initialStopPrice,
        stopPrice: candidateStop,
        quantity: pos.quantity,
        addOnsTaken: pos.addOnsTaken,
      },
      last,
      cfg,
    );
    if (add) {
      const updated = addToPaperPosition(pos.id, {
        addQty: add.addQty,
        blendedEntry: add.blendedEntry,
        newInitialStopPrice: add.newInitialStopPrice,
        newStopPrice: add.newStopPrice,
      });
      if (updated) {
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'paper_scaled_in',
          detail: {
            addQty: add.addQty,
            addPrice: last,
            blendedEntry: add.blendedEntry,
            newStop: add.newStopPrice,
            addOnsTaken: updated.addOnsTaken,
            rMultiple: add.rMultiple,
          },
          riskProfile: pos.riskProfile,
        });
      }
    }
  }
}

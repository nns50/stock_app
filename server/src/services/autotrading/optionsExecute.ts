import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from './optionsRiskCheck';
import { correlatedNotional, RiskCheckContext } from './riskCheck';
import { getPaperPortfolioSnapshot, PaperPortfolioSeed } from './execute';
import { computeStreaksAndDrawdown } from '../pnl';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import {
  closeOptionsPaperPosition,
  hasOpenOptionsPaperPosition,
  listOpenOptionsPaperPositions,
  listOptionsPaperPositions,
  openOptionsPaperPosition,
  OptionsPaperExitReason,
  OptionsPaperPosition,
} from '../../db/autotradeOptionsPaperPositions';
import { defaultExitConfig, evaluateExit } from '../../options/exitRules';
import { getProvider } from '../../providers';
import { mapPool } from '../../util/async';

// ---------------------------------------------------------------------------
// The options counterpart to execute.ts (docs/AUTOTRADING_SPEC.md, phase 12)
// — a deliberate PARALLEL implementation, not a shared/refactored core,
// mirroring this codebase's established convention for every other
// equity/options split. Everything here is a LOCAL SIMULATION exactly like
// execute.ts — no call in this file ever reaches a real broker.
//
// The combined budget (phase 10) is made REAL here, not just preview: this
// file reads execute.ts's getPaperPortfolioSnapshot() directly (a one-way
// import — execute.ts never imports back from here) to fold equity's
// CURRENT paper book into every options risk-check, and runAutotradeLoopTick
// (loop.ts) passes options' own pre-existing snapshot into
// runPaperExecution() as a PaperPortfolioSeed so equity sees options' side
// too. Together this makes "an approved options signal's risk counts against
// the next equity OR options candidate's cap, and vice versa" true for the
// actual unattended loop, not just the phase 10 preview route.
//
// Close-only automated exit (the confirmed design default): the only rule
// wired here is options/exitRules.ts's timeExitDaysBeforeExpiry — "I do not
// want the automated system holding options through expiration." A long
// option has no numeric stop/target price the way a stock paper position
// does (phase 10: sized by full premium paid, worst case = expires
// worthless), so there is no P&L-based automated exit to mirror
// checkPaperExits()'s stop/target check with — take-profit/stop-loss/
// delta-drift stay human-review-only (services/positionExits.ts), matching
// this codebase's established default (defaultExitConfig()) rather than a
// new number guessed for this phase.
// ---------------------------------------------------------------------------

/** The only exit rule this phase automates. Reuses exitRules.ts's own
 *  default (7 days) rather than the human page's per-user `optionExitConfig`
 *  setting (services/positionExits.ts) — the automated system's threshold is
 *  a deliberate, explicit safety choice (like defaultAutotradeEntryConfig()'s
 *  ivRankMax), not something that should silently follow a preference scoped
 *  to a human reviewing their OWN real positions. */
const AUTOTRADE_TIME_EXIT_DAYS = defaultExitConfig().timeExitDaysBeforeExpiry ?? 7;

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

/** Realized P&L. Single-leg: (exit - entry) premium per share x contracts x
 *  100 — no buy/sell sign flip, since a single-leg position is long the
 *  contract itself, matching phase 10's sizing convention. Debit spread: the
 *  spread is one unit whose "price" is long premium minus short premium —
 *  P&L is (netCreditAtExit - netDebitAtEntry) x spreads x 100. shortExitPrice
 *  defaults to the row's own (already-persisted) value, so callers computing
 *  P&L from an already-closed row (e.g. the portfolio snapshot) can omit it;
 *  checkOptionsPaperExits() passes it explicitly since it computes P&L from a
 *  freshly-fetched mark just BEFORE the row is closed. */
function optionsPnl(
  p: OptionsPaperPosition,
  exitPrice: number,
  shortExitPrice: number | null = p.shortExitPrice,
): number {
  if (p.kind === 'debit_spread') {
    const netDebitAtEntry = p.entryPrice - (p.shortEntryPrice ?? 0);
    const netCreditAtExit = exitPrice - (shortExitPrice ?? 0);
    return (netCreditAtExit - netDebitAtEntry) * p.quantity * 100;
  }
  return (exitPrice - p.entryPrice) * p.quantity * 100;
}

export interface OptionsExecutionOutcome {
  symbol: string;
  ok: boolean;
  reason?: string;
  position?: OptionsPaperPosition;
}

/** Fetch a fresh mark for one contract by re-fetching its chain and matching
 *  strike + side — the same (symbol, expiration) chain-fetch-then-match
 *  pattern services/quotes.ts's resolveOptionMarks uses for real positions,
 *  just keyed off an autotrade signal/position instead of a human Position.
 *  Exported: services/autotrading/liveOptionsExecute.ts (Task #70) reuses this
 *  exact provider-fetch primitive for live fills rather than a second
 *  implementation — unlike the paper/live DECISION and EXECUTION logic
 *  elsewhere in this codebase (deliberately kept parallel, never shared), a
 *  chain-fetch-then-match has no reason to behave differently for a paper vs
 *  a live fill, so sharing it carries no drift risk the parallel convention
 *  is meant to avoid. */
export async function fetchContractMark(
  symbol: string,
  expiration: string,
  strike: number,
  side: 'call' | 'put',
): Promise<number> {
  const chain = await getProvider().getOptionsChain(symbol, expiration);
  const pool = side === 'call' ? chain.calls : chain.puts;
  const match = pool.find((c) => Math.abs(c.strike - strike) < 1e-6);
  const mark = match?.mark ?? match?.last;
  if (mark === undefined) throw new Error(`No current quote for ${symbol} ${strike}${side === 'call' ? 'C' : 'P'}`);
  return mark;
}

/** Shared "log + return failure" for an entry attempt, so both the single-leg
 *  and debit-spread paths report a failed entry identically. */
function entryFailure(symbol: string, riskProfile: RiskProfileName, reason: string): OptionsExecutionOutcome {
  logAutotradeEvent({
    symbol,
    stage: 'execution',
    action: 'options_paper_entry_failed',
    detail: { reason },
    riskProfile,
  });
  return { symbol, ok: false, reason };
}

export function validPremium(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

/**
 * Attempt to open an options paper position for an approved (already
 * risk-checked) signal. Idempotent per underlying: a symbol that already has
 * an open options paper position is skipped, never stacked (single-leg or
 * spread — one options position per underlying either way). Fills at
 * FRESHLY-fetched contract mark(s), not the signal's own screening-time
 * premium(s) — same "now IS the fill moment" reasoning as attemptPaperEntry().
 *
 * A debit spread fills BOTH legs or neither: if either leg's quote fetch
 * fails, or the net debit has vanished/inverted between screening and fill
 * (stale quotes), the whole entry is rejected — there is no partial-spread
 * position.
 */
export async function attemptOptionsPaperEntry(
  signal: OptionsTradeSignal,
  riskResult: OptionsRiskCheckResult,
  riskProfile: RiskProfileName,
): Promise<OptionsExecutionOutcome> {
  if (!riskResult.ok) return { symbol: signal.symbol, ok: false, reason: 'Risk check did not pass' };
  if (hasOpenOptionsPaperPosition(signal.symbol)) {
    return { symbol: signal.symbol, ok: false, reason: 'Already has an open options paper position' };
  }

  if (signal.kind === 'debit_spread') {
    let longFill: number;
    let shortFill: number;
    try {
      [longFill, shortFill] = await Promise.all([
        fetchContractMark(signal.symbol, signal.expiration, signal.longStrike, signal.side),
        fetchContractMark(signal.symbol, signal.expiration, signal.shortStrike, signal.side),
      ]);
    } catch (err) {
      return entryFailure(signal.symbol, riskProfile, `Quote fetch failed: ${(err as Error).message}`);
    }
    if (!validPremium(longFill) || !validPremium(shortFill)) {
      return entryFailure(signal.symbol, riskProfile, `Invalid premium: long=${longFill} short=${shortFill}`);
    }
    if (longFill <= shortFill) {
      return entryFailure(
        signal.symbol,
        riskProfile,
        `Net debit vanished at fill (long ${longFill} <= short ${shortFill})`,
      );
    }

    const quantity = 'suggestedContracts' in riskResult.sizing ? riskResult.sizing.suggestedContracts : 0;
    let position: OptionsPaperPosition;
    try {
      position = openOptionsPaperPosition({
        symbol: signal.symbol,
        side: signal.side,
        kind: 'debit_spread',
        contractSymbol: signal.longContractSymbol,
        strike: signal.longStrike,
        shortContractSymbol: signal.shortContractSymbol,
        shortStrike: signal.shortStrike,
        shortEntryPrice: shortFill,
        expiration: signal.expiration,
        quantity,
        entryPrice: longFill,
        riskAmount: riskResult.approvedRiskAmount,
        riskProfile,
        rationale: signal.rationale,
      });
    } catch (err) {
      return entryFailure(
        signal.symbol,
        riskProfile,
        `Failed to record options paper position: ${(err as Error).message}`,
      );
    }
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'options_paper_order_placed',
      detail: {
        kind: 'debit_spread',
        side: signal.side,
        longContractSymbol: signal.longContractSymbol,
        longStrike: signal.longStrike,
        shortContractSymbol: signal.shortContractSymbol,
        shortStrike: signal.shortStrike,
        expiration: signal.expiration,
        quantity: position.quantity,
        netDebit: longFill - shortFill,
      },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: true, position };
  }

  let fillPremium: number;
  try {
    fillPremium = await fetchContractMark(signal.symbol, signal.expiration, signal.strike, signal.side);
  } catch (err) {
    return entryFailure(signal.symbol, riskProfile, `Quote fetch failed: ${(err as Error).message}`);
  }

  if (!validPremium(fillPremium)) {
    return entryFailure(signal.symbol, riskProfile, `Invalid premium: ${fillPremium}`);
  }

  // riskResult.sizing is RiskSizingResult here — signal.kind === 'single_leg',
  // and evaluateOptionsRiskCheck always sizes a single-leg signal via
  // computeRiskSizing().
  const quantity = 'suggestedQuantity' in riskResult.sizing ? riskResult.sizing.suggestedQuantity : 0;
  let position: OptionsPaperPosition;
  try {
    position = openOptionsPaperPosition({
      symbol: signal.symbol,
      side: signal.side,
      contractSymbol: signal.contractSymbol,
      strike: signal.strike,
      expiration: signal.expiration,
      quantity,
      entryPrice: fillPremium,
      riskAmount: riskResult.approvedRiskAmount,
      riskProfile,
      rationale: signal.rationale,
    });
  } catch (err) {
    return entryFailure(
      signal.symbol,
      riskProfile,
      `Failed to record options paper position: ${(err as Error).message}`,
    );
  }
  logAutotradeEvent({
    symbol: signal.symbol,
    stage: 'execution',
    action: 'options_paper_order_placed',
    detail: {
      side: signal.side,
      contractSymbol: signal.contractSymbol,
      strike: signal.strike,
      expiration: signal.expiration,
      quantity: position.quantity,
      entryPrice: fillPremium,
    },
    riskProfile,
  });
  return { symbol: signal.symbol, ok: true, position };
}

export interface OptionsPaperPortfolioSnapshot {
  today: string;
  openPositions: OptionsPaperPosition[];
  /** $ sum(riskAmount) across open options paper positions. */
  openRisk: number;
  openPositionsCount: number;
  /** Realized P&L from options paper positions closed today (ET). */
  dailyPnl: number;
  consecutiveLosses: number;
  /** Options paper positions opened today (ET) — open or closed. */
  tradesToday: number;
}

/** Current options paper-portfolio state — mirrors execute.ts's
 *  getPaperPortfolioSnapshot() exactly, over autotrade_options_paper_positions
 *  instead. Shared by runOptionsPaperExecution() (below) and by loop.ts,
 *  which reads this to seed EQUITY's own batch (see PaperPortfolioSeed). */
export function getOptionsPaperPortfolioSnapshot(): OptionsPaperPortfolioSnapshot {
  const today = etDateStr();
  const openPositions = listOpenOptionsPaperPositions();
  const recent = listOptionsPaperPositions({ limit: 500 });
  const closedTodayChrono = recent
    .filter((p) => p.status === 'closed' && p.exitAt !== null && etDateStr(p.exitAt) === today)
    .sort((a, b) => a.exitAt! - b.exitAt!);
  const closedPnlsChrono = closedTodayChrono.map((p) => optionsPnl(p, p.exitPrice!));
  const dailyPnl = closedPnlsChrono.reduce((s, p) => s + p, 0);
  const { currentStreak } = computeStreaksAndDrawdown(closedPnlsChrono);
  const consecutiveLosses = currentStreak.type === 'loss' ? currentStreak.count : 0;
  const tradesToday = recent.filter((p) => etDateStr(p.entryAt) === today).length;
  const openRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);

  return {
    today,
    openPositions,
    openRisk,
    openPositionsCount: openPositions.length,
    dailyPnl,
    consecutiveLosses,
    tradesToday,
  };
}

/** What to seed EQUITY's runPaperExecution() with, from options' pre-existing
 *  book — the "vice versa" half of the combined budget. Correlation notional
 *  for an open options position is its stored riskAmount (= premium paid),
 *  matching optionsRiskCheck.ts's own "notional here is the premium paid"
 *  convention, not a fresh entryPrice x quantity computation. */
export function optionsSeedForEquity(
  snapshot: OptionsPaperPortfolioSnapshot = getOptionsPaperPortfolioSnapshot(),
): PaperPortfolioSeed {
  return {
    openRisk: snapshot.openRisk,
    openPositionsCount: snapshot.openPositionsCount,
    dailyPnl: snapshot.dailyPnl,
    consecutiveLosses: snapshot.consecutiveLosses,
    tradesToday: snapshot.tradesToday,
    positions: snapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount, side: 'long' as const })),
  };
}

/**
 * Risk-check, then attempt to fill, a batch of already-decided options
 * signals — sequentially against a RUNNING total combining THIS book's own
 * open positions with equity's CURRENT paper book (read directly via
 * execute.ts's getPaperPortfolioSnapshot(), which by the time this runs
 * already reflects any equity fills from this same loop tick — see loop.ts's
 * call order). Mirrors execute.ts's runPaperExecution() batch pattern.
 */
export async function runOptionsPaperExecution(
  candidates: { signal: OptionsTradeSignal }[],
): Promise<OptionsExecutionOutcome[]> {
  const config = getAutotradeConfig();
  const equity = config.accountEquityUsd ?? 0;

  const optSnapshot = getOptionsPaperPortfolioSnapshot();
  const eqSnapshot = getPaperPortfolioSnapshot();

  const dailyPnl = optSnapshot.dailyPnl + eqSnapshot.dailyPnl;
  const tradesToday = optSnapshot.tradesToday + eqSnapshot.tradesToday;
  const consecutiveLosses = Math.max(optSnapshot.consecutiveLosses, eqSnapshot.consecutiveLosses);
  let runningRisk = optSnapshot.openRisk + eqSnapshot.openRisk;
  let runningCount = optSnapshot.openPositionsCount + eqSnapshot.openPositionsCount;
  // Options positions are always 'long' (this app only ever buys premium —
  // see riskCheck.ts's correlatedNotional() doc comment); equity positions
  // folded in here carry their REAL side so an options candidate (always
  // effectively a 'long' bet, per candidateSide below) correctly nets
  // against — rather than piles onto — an existing SHORT equity position in
  // the same/correlated name.
  const runningPositions: { symbol: string; notional: number; side: 'long' | 'short' }[] = [
    ...optSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount, side: 'long' as const })),
    ...eqSnapshot.openPositions.map((p) => ({
      symbol: p.symbol,
      notional: p.entryPrice * p.quantity,
      side: (p.side === 'buy' ? 'long' : 'short') as 'long' | 'short',
    })),
  ];
  const skipSymbols = new Set(optSnapshot.openPositions.map((p) => p.symbol));

  const outcomes: OptionsExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open options paper position' });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(
      signal.symbol,
      'long', // options candidates are always a long-the-contract bet
      runningPositions,
      config.correlationLookbackDays,
      config.correlationThreshold,
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
    };
    const result = evaluateOptionsRiskCheck(signal, ctx);
    const contracts =
      'suggestedContracts' in result.sizing ? result.sizing.suggestedContracts : result.sizing.suggestedQuantity;
    logAutotradeEvent({
      symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, contracts },
    });
    if (!result.ok) {
      outcomes.push({ symbol, ok: false, reason: 'Risk check blocked' });
      continue;
    }

    const outcome = await attemptOptionsPaperEntry(signal, result, config.riskProfile);
    outcomes.push(outcome);
    if (outcome.ok && outcome.position) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol, notional: result.approvedNotional, side: 'long' });
      skipSymbols.add(symbol);
    }
  }
  return outcomes;
}

export interface OptionsExitCheckOutcome {
  symbol: string;
  closed: boolean;
  reason?: string;
  position?: OptionsPaperPosition;
}

/**
 * Check every open options paper position for the time-exit trigger
 * (days-to-expiration <= AUTOTRADE_TIME_EXIT_DAYS) and close whichever fires
 * at a freshly-fetched contract mark. The ONLY automated exit rule this
 * phase wires (close-only, per the confirmed design default — no roll).
 * Unlike checkPaperExits()'s stop/target check, this needs no live quote to
 * evaluate the trigger itself (days-to-expiration is a pure function of the
 * expiration date and wall-clock time) — a quote is only fetched once a
 * position is confirmed about to be closed, to record a fair exit price.
 * A quote-fetch failure at that point leaves the position open for the next
 * cycle to retry, exactly like checkPaperExits() does for its own stop/
 * target checks — not closed at a synthetic/fallback price.
 */
export async function checkOptionsPaperExits(): Promise<OptionsExitCheckOutcome[]> {
  const open = listOpenOptionsPaperPositions();
  return mapPool(open, 6, async (pos): Promise<OptionsExitCheckOutcome> => {
    const ev = evaluateExit(
      { entryPrice: pos.entryPrice, currentPrice: null, side: 'long', expiration: pos.expiration },
      { timeExitDaysBeforeExpiry: AUTOTRADE_TIME_EXIT_DAYS },
    );
    if (!ev.triggered) return { symbol: pos.symbol, closed: false };

    // A spread closes BOTH legs together or not at all — either quote
    // fetch failing leaves the whole position open for the next cycle's
    // retry, same as a single leg's own quote-fetch failure.
    let exitPrice: number;
    let shortExitPrice: number | undefined;
    try {
      if (pos.kind === 'debit_spread') {
        [exitPrice, shortExitPrice] = await Promise.all([
          fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side),
          fetchContractMark(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
        ]);
      } else {
        exitPrice = await fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side);
      }
    } catch (err) {
      return { symbol: pos.symbol, closed: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }

    const exitReason: OptionsPaperExitReason = 'time_exit';
    const closed = closeOptionsPaperPosition(pos.id, { exitPrice, shortExitPrice, exitReason });
    if (closed) {
      const pnl = optionsPnl(pos, exitPrice, shortExitPrice ?? null);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'options_paper_position_closed',
        detail: { exitReason, exitPrice, shortExitPrice, pnl, dte: ev.dte },
        riskProfile: pos.riskProfile,
      });
    }
    return { symbol: pos.symbol, closed: !!closed, position: closed ?? undefined };
  });
}

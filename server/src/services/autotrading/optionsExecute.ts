import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { RISK_PROFILES } from './riskProfiles';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck } from './optionsRiskCheck';
import { correlatedNotional, RiskCheckContext, RiskCheckResult } from './riskCheck';
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

/** A long option's realized P&L: (exit - entry) premium per share x
 *  contracts x 100 — no buy/sell sign flip, since every options paper
 *  position is long the contract itself (call or put), matching phase 10's
 *  sizing convention. */
function optionsPnl(p: OptionsPaperPosition, exitPrice: number): number {
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
 *  just keyed off an autotrade signal/position instead of a human Position. */
async function fetchContractMark(
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

/**
 * Attempt to open an options paper position for an approved (already
 * risk-checked) signal. Idempotent per underlying: a symbol that already has
 * an open options paper position is skipped, never stacked. Fills at a
 * FRESHLY-fetched contract mark, not the signal's own screening-time
 * premium — same "now IS the fill moment" reasoning as attemptPaperEntry().
 */
export async function attemptOptionsPaperEntry(
  signal: OptionsTradeSignal,
  riskResult: RiskCheckResult,
  riskProfile: RiskProfileName,
): Promise<OptionsExecutionOutcome> {
  if (!riskResult.ok) return { symbol: signal.symbol, ok: false, reason: 'Risk check did not pass' };
  if (hasOpenOptionsPaperPosition(signal.symbol)) {
    return { symbol: signal.symbol, ok: false, reason: 'Already has an open options paper position' };
  }

  let fillPremium: number;
  try {
    fillPremium = await fetchContractMark(signal.symbol, signal.expiration, signal.strike, signal.side);
  } catch (err) {
    const reason = `Quote fetch failed: ${(err as Error).message}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'options_paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
  }

  if (!Number.isFinite(fillPremium) || fillPremium <= 0) {
    const reason = `Invalid premium: ${fillPremium}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'options_paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
  }

  let position: OptionsPaperPosition;
  try {
    position = openOptionsPaperPosition({
      symbol: signal.symbol,
      side: signal.side,
      contractSymbol: signal.contractSymbol,
      strike: signal.strike,
      expiration: signal.expiration,
      quantity: riskResult.sizing.suggestedQuantity,
      entryPrice: fillPremium,
      riskAmount: riskResult.approvedRiskAmount,
      riskProfile,
      rationale: signal.rationale,
    });
  } catch (err) {
    const reason = `Failed to record options paper position: ${(err as Error).message}`;
    logAutotradeEvent({
      symbol: signal.symbol,
      stage: 'execution',
      action: 'options_paper_entry_failed',
      detail: { reason },
      riskProfile,
    });
    return { symbol: signal.symbol, ok: false, reason };
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
    positions: snapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount })),
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
  const profile = RISK_PROFILES[config.riskProfile];
  const equity = config.accountEquityUsd ?? 0;

  const optSnapshot = getOptionsPaperPortfolioSnapshot();
  const eqSnapshot = getPaperPortfolioSnapshot();

  const dailyPnl = optSnapshot.dailyPnl + eqSnapshot.dailyPnl;
  const tradesToday = optSnapshot.tradesToday + eqSnapshot.tradesToday;
  const consecutiveLosses = Math.max(optSnapshot.consecutiveLosses, eqSnapshot.consecutiveLosses);
  let runningRisk = optSnapshot.openRisk + eqSnapshot.openRisk;
  let runningCount = optSnapshot.openPositionsCount + eqSnapshot.openPositionsCount;
  const runningPositions: { symbol: string; notional: number }[] = [
    ...optSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.riskAmount })),
    ...eqSnapshot.openPositions.map((p) => ({ symbol: p.symbol, notional: p.entryPrice * p.quantity })),
  ];
  const skipSymbols = new Set(optSnapshot.openPositions.map((p) => p.symbol));

  const outcomes: OptionsExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open options paper position' });
      continue;
    }
    const { amount: correlated } = await correlatedNotional(signal.symbol, runningPositions);
    const ctx: RiskCheckContext = {
      equity,
      dailyPnl,
      tradesToday,
      consecutiveLosses,
      openRisk: runningRisk,
      openPositionsCount: runningCount,
      correlatedNotional: correlated,
    };
    const result = evaluateOptionsRiskCheck(signal, ctx, profile);
    logAutotradeEvent({
      symbol,
      stage: 'risk_check',
      riskProfile: config.riskProfile,
      action: result.ok ? 'passed' : 'blocked',
      detail: { checks: result.checks, contracts: result.sizing.suggestedQuantity },
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
      runningPositions.push({ symbol, notional: result.approvedNotional });
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

    let exitPrice: number;
    try {
      exitPrice = await fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side);
    } catch (err) {
      return { symbol: pos.symbol, closed: false, reason: `Quote fetch failed: ${(err as Error).message}` };
    }

    const exitReason: OptionsPaperExitReason = 'time_exit';
    const closed = closeOptionsPaperPosition(pos.id, { exitPrice, exitReason });
    if (closed) {
      const pnl = optionsPnl(pos, exitPrice);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'options_paper_position_closed',
        detail: { exitReason, exitPrice, pnl, dte: ev.dte },
        riskProfile: pos.riskProfile,
      });
    }
    return { symbol: pos.symbol, closed: !!closed, position: closed ?? undefined };
  });
}

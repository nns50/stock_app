import { AutotradeConfig, getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { convictionGrade } from './decide';
import { OptionsTradeSignal } from './optionsDecide';
import { evaluateOptionsRiskCheck, OptionsRiskCheckResult } from './optionsRiskCheck';
import { journalMethodMultipliers, methodOfOptionsSignal } from './methodSizing';
import { correlatedNotional, sectorNotional, buildSectorOf, RiskCheckContext } from './riskCheck';
import { getPaperPortfolioSnapshot, PaperPortfolioSeed } from './execute';
import { computeStreaksAndDrawdown } from '../pnl';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import {
  closeOptionsPaperPosition,
  hasOpenOptionsPaperPosition,
  listOpenOptionsPaperPositions,
  listOptionsPaperPositions,
  openOptionsPaperPosition,
  partialCloseOptionsPaperPosition,
  ratchetOptionsPaperPositionStopFloor,
  updateOptionsPaperPositionBestBasis,
  OptionsPaperExitReason,
  OptionsPaperPosition,
} from '../../db/autotradeOptionsPaperPositions';
import { defaultExitConfig, evaluateExit, unrealizedReturnPct } from '../../options/exitRules';
import { evaluateShortDatedExit } from './shortDatedOptionsExit';
import { minutesUntilClose } from './endOfDayFlatten';
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
// Close-only automated exit: originally just options/exitRules.ts's
// timeExitDaysBeforeExpiry — "I do not want the automated system holding
// options through expiration" — since a long option has no numeric stop/
// target price the way a stock paper position does (phase 10: sized by full
// premium paid, worst case = expires worthless). 2026-07-16 follow-up:
// AutotradeConfig.optionsStopLossPct/optionsTakeProfitPct add a %-of-premium
// P&L rule on top (0/unset disables each, so the original time-only
// behavior is still the default) — see checkOptionsPaperExits() below for
// the mechanics. Delta-drift stays human-review-only (services/
// positionExits.ts) — no delta feed is wired into this automated loop.
// ---------------------------------------------------------------------------

/** The only exit rule this phase automates. Reuses exitRules.ts's own
 *  default (7 days) rather than the human page's per-user `optionExitConfig`
 *  setting (services/positionExits.ts) — the automated system's threshold is
 *  a deliberate, explicit safety choice (like defaultAutotradeEntryConfig()'s
 *  ivRankMax), not something that should silently follow a preference scoped
 *  to a human reviewing their OWN real positions. */
const AUTOTRADE_TIME_EXIT_DAYS = defaultExitConfig().timeExitDaysBeforeExpiry ?? 7;

/** The single most expensive thing to get wrong on this path, and the reason
 *  the ladder and this constant must never ship in separate changes: with
 *  short-dated on, the configured DTE band is 0-2, and a 7-day time-exit
 *  fires `time-exit` on the very first cycle after the fill. The loop would
 *  buy a 0DTE contract and sell it seconds later, paying the round-trip
 *  spread, every single time. Mirrors liveOptionsExecute.ts's own
 *  timeExitDaysFor() exactly. */
function timeExitDaysFor(cfg: AutotradeConfig): number {
  return cfg.shortDatedOptionsEnabled ? 0 : AUTOTRADE_TIME_EXIT_DAYS;
}

/** The underlying's last price, or null if it can't be read. A failed quote
 *  must disable only the rules that need it — never the hard clock, which is
 *  the one rule whose cost is certain. try/catch rather than .catch(): a
 *  provider with no getQuote at all throws SYNCHRONOUSLY, before any promise
 *  exists, so a rejection handler never sees it and the whole exit sweep
 *  dies (found on the live path by a test provider stubbing only
 *  getOptionsChain). */
async function underlyingQuoteOrNull(symbol: string): Promise<number | null> {
  try {
    return (await getProvider().getQuote(symbol)).last;
  } catch {
    return null;
  }
}

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
  return (await fetchContractQuote(symbol, expiration, strike, side)).price;
}

export interface ContractQuote {
  price: number;
  /** True when `price` is the contract's LAST TRADE, not a two-sided mark —
   *  i.e. the chain had no usable bid/ask and this is the only number
   *  available. See fetchContractQuote for why callers should care. */
  fromLastTrade: boolean;
}

/**
 * The same lookup as fetchContractMark, but saying WHICH number came back.
 *
 * `mark` is (bid + ask) / 2 — a live, two-sided quote describing where the
 * contract can actually trade right now. `last` is the price of the most recent
 * TRADE, which on an illiquid contract can be hours or days old. Collapsing
 * them with `mark ?? last` (as this function's own caller fetchContractMark
 * still does, for the paper and backtest paths whose behavior must not shift)
 * means a stale print is indistinguishable from a live quote at every call
 * site, and the "No current quote" error only fires when BOTH are missing —
 * so "current" was never a claim the return value could support.
 *
 * That distinction is worth surfacing because the two failure directions are
 * not symmetric for a real order. Pricing an ENTRY off a stale-low print gives
 * a limit under the market that simply won't fill; pricing an EXIT off a
 * stale-HIGH print gives a sell limit above where the contract can be sold, so
 * the close never fills and the position drifts to expiration — precisely the
 * outcome the time-exit exists to prevent, reached silently.
 */
export async function fetchContractQuote(
  symbol: string,
  expiration: string,
  strike: number,
  side: 'call' | 'put',
): Promise<ContractQuote> {
  const chain = await getProvider().getOptionsChain(symbol, expiration);
  const pool = side === 'call' ? chain.calls : chain.puts;
  const match = pool.find((c) => Math.abs(c.strike - strike) < 1e-6);
  if (match?.mark !== undefined) return { price: match.mark, fromLastTrade: false };
  if (match?.last !== undefined) return { price: match.last, fromLastTrade: true };
  throw new Error(`No current quote for ${symbol} ${strike}${side === 'call' ? 'C' : 'P'}`);
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
  /** Conviction grade (A/B/C) from the underlying's screener score, or null.
   *  Computed by the caller from the configured thresholds — mirrors
   *  execute.ts's attemptPaperEntry. */
  grade: string | null = null,
  /** At-entry context to stamp alongside the grade (2026-07-26) — the market
   *  regime label + market ATR% the loop read this cycle. Both nullable. */
  marketRegime: string | null = null,
  marketAtrPct: number | null = null,
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
        grade,
        entryScore: signal.score,
        ivRank: signal.ivRank,
        marketRegime,
        marketAtrPct,
        underlyingAtEntry: signal.underlyingPrice,
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
      grade,
      entryScore: signal.score,
      ivRank: signal.ivRank,
      marketRegime,
      marketAtrPct,
      underlyingAtEntry: signal.underlyingPrice,
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
  /** Regime-aware sizing (2026-07-16) — same market-ATR% reading loop.ts
   *  already computed once this cycle for its volatility hard-cutoff, not
   *  re-fetched here. Defaults to null (regime cut inactive) for any caller
   *  that doesn't have/need one, e.g. a direct test call. */
  marketAtrPct: number | null = null,
  /** Market regime label the loop read this cycle (2026-07-26) — stamped on
   *  each opened position as at-entry context, never used for sizing here. */
  marketRegime: string | null = null,
): Promise<OptionsExecutionOutcome[]> {
  const config = getAutotradeConfig();
  const equity = config.accountEquityUsd ?? 0;
  // One journal read per batch, not per signal — the same recent-window
  // per-method lean the equity paths get from their snapshots (methodSizing.ts).
  const methodMultipliers = journalMethodMultipliers(config);

  const optSnapshot = getOptionsPaperPortfolioSnapshot();
  const eqSnapshot = getPaperPortfolioSnapshot();

  const dailyPnl = optSnapshot.dailyPnl + eqSnapshot.dailyPnl;
  const tradesToday = optSnapshot.tradesToday + eqSnapshot.tradesToday;
  const consecutiveLosses = Math.max(optSnapshot.consecutiveLosses, eqSnapshot.consecutiveLosses);
  let runningRisk = optSnapshot.openRisk + eqSnapshot.openRisk;
  // Slot budget. Options and equity share ONE combined risk pool by design
  // (phase 12) — sound for money, ruinous for slots at a small cap: equity
  // runs first in the loop tick, and on 2026-08-27 it held both of the two
  // slots all session while 184 options signals produced zero orders, every
  // one refused "2 open vs cap 2". With optionsMaxConcurrentPositions set,
  // this book counts only its OWN open positions against its own number.
  // runningRisk below is deliberately NOT split: that budget is about money,
  // and money genuinely is shared.
  const ownSlots = config.optionsMaxConcurrentPositions > 0;
  const slotCap = ownSlots ? config.optionsMaxConcurrentPositions : config.maxConcurrentPositions;
  let runningCount = ownSlots
    ? optSnapshot.openPositionsCount
    : optSnapshot.openPositionsCount + eqSnapshot.openPositionsCount;
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
  const sectorOf = buildSectorOf();

  // --- Short-dated entry gates (docs/SHORT_DATED_OPTIONS_SPEC.md) ----------
  // The paper twin of runLiveOptionsExecution()'s pair. Both are batch-level:
  // neither depends on which candidate is being looked at, so evaluating them
  // per-candidate would just repeat the same answer.
  if (config.shortDatedOptionsEnabled && config.optionsNoEntryMinutesBeforeClose > 0) {
    const left = minutesUntilClose(Date.now());
    if (left !== null && left <= config.optionsNoEntryMinutesBeforeClose) {
      // A short-dated contract opened this late has too little time for the
      // move to arrive, against a decay headwind that steepens all the way in:
      // flat premium is already -63% by 13:30 and -82% by 14:30. And the hard
      // 14:00 exit would close it almost immediately anyway.
      const reason = `${left}m to the close — past the ${config.optionsNoEntryMinutesBeforeClose}m short-dated entry cutoff`;
      logAutotradeEvent({
        stage: 'execution',
        action: 'short_dated_entry_window_closed',
        detail: { book: 'paper', reason, left },
      });
      return candidates.map(({ signal }) => ({ symbol: signal.symbol.toUpperCase(), ok: false, reason }));
    }
  }
  // One short-dated position at a time. Tighter than the shared concurrent cap
  // on purpose: two 0DTE positions can both go to zero inside the same half
  // hour on a single adverse market move — a correlation stock positions do
  // not have. Counted against THIS book's own open positions, matching how
  // paper and live each risk-check their own pool.
  if (config.shortDatedOptionsEnabled && optSnapshot.openPositionsCount >= 1) {
    const reason = 'a short-dated options position is already open (max 1 at a time)';
    // Journaled because a pre-committed tuning rule COUNTS these: the plan's F7
    // fires when this gate refuses >=5 candidates in a week. Returning silently
    // made that rule unmeasurable -- there was no event to count, so a gate that
    // was throttling the book would have looked identical to one that never
    // fired (found 2026-08-27). `refused` is per-candidate, matching how F7 is
    // phrased; one event per tick keeps the feed honest without a row each.
    logAutotradeEvent({
      stage: 'execution',
      action: 'short_dated_position_already_open',
      detail: { book: 'paper', reason, refused: candidates.length, openPositions: optSnapshot.openPositionsCount },
    });
    return candidates.map(({ signal }) => ({ symbol: signal.symbol.toUpperCase(), ok: false, reason }));
  }

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
    const { amount: sectorAmount, sector: candidateSector } = sectorNotional(
      signal.symbol,
      'long',
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
      maxConcurrentPositions: slotCap,
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
      methodMultiplier: methodMultipliers[methodOfOptionsSignal(signal.side)] ?? 1,
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

    const grade = convictionGrade(signal.score, {
      aMinScore: config.convictionGradeAMinScore,
      bMinScore: config.convictionGradeBMinScore,
    });
    const outcome = await attemptOptionsPaperEntry(
      signal,
      result,
      config.riskProfile,
      grade,
      marketRegime,
      marketAtrPct,
    );
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

/** Maps exitRules.ts's own kebab-case ExitTrigger.rule strings to this
 *  table's snake_case exit_reason values — the same mapping convention
 *  'time-exit' -> 'time_exit' already established. 'delta-drift' is never
 *  reachable here (this phase never sets deltaMin/deltaMax), but is mapped
 *  defensively rather than left to throw. */
function exitReasonFor(activeRule: string): OptionsPaperExitReason {
  switch (activeRule) {
    case 'stop-loss':
      return 'stop_loss';
    case 'take-profit':
      return 'take_profit';
    default:
      return 'time_exit';
  }
}

/** Fetches the fresh mark(s) needed to price a close, single-leg or spread.
 *  Shared by the up-front fetch (only attempted when a price-based rule is
 *  actually configured — see checkOptionsPaperExits) and the on-trigger
 *  fetch (the original design's "quote only once we know we're closing"). */
async function fetchExitMarks(pos: OptionsPaperPosition): Promise<{ exitPrice: number; shortExitPrice?: number }> {
  if (pos.kind === 'debit_spread') {
    const [exitPrice, shortExitPrice] = await Promise.all([
      fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side),
      fetchContractMark(pos.symbol, pos.expiration, pos.shortStrike!, pos.side),
    ]);
    return { exitPrice, shortExitPrice };
  }
  return { exitPrice: await fetchContractMark(pos.symbol, pos.expiration, pos.strike, pos.side) };
}

/**
 * Check every open options paper position for the time-exit trigger
 * (days-to-expiration <= AUTOTRADE_TIME_EXIT_DAYS) plus the configured
 * stop-loss %/take-profit % (AutotradeConfig.optionsStopLossPct/
 * optionsTakeProfitPct, 0/unset disables each — added 2026-07-16, PAPER only,
 * mirroring checkPaperExits()'s equity stop/target and reusing the SAME
 * exitRules.ts engine the human Options page's manual review already uses).
 * A stop/take-profit rule needs a live mark to evaluate, unlike the DTE-only
 * time-exit rule — so a fresh contract quote is fetched UP FRONT, every
 * cycle, but ONLY when at least one price-based rule is actually configured
 * (optionsStopLossPct/optionsTakeProfitPct nonzero). Left at their 0 default,
 * this function is byte-for-byte the original design: no provider call at
 * all until the quote-free time-exit trigger fires, then one fetch to price
 * the close — so leaving these fields untouched changes nothing, including
 * provider load. When a price rule IS configured but that cycle's mark fetch
 * fails, evaluation degrades to quote-free/time-only for that position (the
 * safety net still works; retried next cycle) rather than leaving an
 * about-to-expire position stuck open just because a mark was momentarily
 * unavailable. For a debit spread, both P&L rules are evaluated against the
 * NET DEBIT (long leg premium minus short leg premium, at entry and now) —
 * the same basis optionsPnl() already sizes P&L from — not the long leg's
 * raw premium alone. Closing itself is unchanged: a spread closes both legs
 * together or not at all.
 */
export async function checkOptionsPaperExits(): Promise<OptionsExitCheckOutcome[]> {
  const open = listOpenOptionsPaperPositions();
  const cfg = getAutotradeConfig();
  // Trailing/breakeven/partial-exit need a fresh mark every cycle too (to
  // keep the best-basis-seen ratchet current), same "up front, only when
  // actually needed" gate as the stop-loss/take-profit rules — leaving all
  // five fields at 0/disabled changes nothing, including provider load.
  const priceRulesActive =
    cfg.optionsStopLossPct > 0 ||
    cfg.optionsTakeProfitPct > 0 ||
    cfg.optionsBreakevenTriggerPct > 0 ||
    cfg.optionsTrailStartPct > 0 ||
    cfg.optionsPartialExitTriggerPct > 0 ||
    // The short-dated ladder needs a mark every cycle for a different reason
    // than the rules above: its give-back trail is only as good as the peak
    // it has seen, and a peak recorded only on the cycles something fires is
    // measuring the wrong thing.
    cfg.shortDatedOptionsEnabled;
  return mapPool(open, 6, async (pos): Promise<OptionsExitCheckOutcome> => {
    let marks: { exitPrice: number; shortExitPrice?: number } | undefined;
    if (priceRulesActive) {
      marks = await fetchExitMarks(pos).catch(() => undefined);
    }

    const entryBasis = pos.kind === 'debit_spread' ? pos.entryPrice - (pos.shortEntryPrice ?? 0) : pos.entryPrice;
    const currentBasis = !marks
      ? null
      : pos.kind === 'debit_spread'
        ? marks.exitPrice - (marks.shortExitPrice ?? 0)
        : marks.exitPrice;

    // --- SHORT-DATED ladder (docs/SHORT_DATED_OPTIONS_SPEC.md) ------------
    // Ahead of the DTE/stop/take-profit rules below, because on a 0-2 DTE
    // contract those are the wrong instrument entirely: a %-of-premium stop
    // measures theta rather than the thesis (the premium is already -11% at
    // 10:30 and -63% at 13:30 with the underlying perfectly still), and the
    // DTE time-exit has nothing left to say once timeExitDaysFor() has moved
    // it to 0. Inert with the flag off, so the original rules stand unchanged.
    //
    // The same six rules, in the same order, as the live book runs — the one
    // real difference is where the high-water mark lives: paper already had
    // best_basis_since_entry tracking exactly this net basis for its trailing
    // stop, so it is reused rather than duplicated into a peak_premium twin.
    if (cfg.shortDatedOptionsEnabled) {
      const underlying = await underlyingQuoteOrNull(pos.symbol.toUpperCase());
      const sd = evaluateShortDatedExit(
        {
          side: pos.side,
          kind: pos.kind,
          entryPrice: pos.entryPrice,
          shortEntryPrice: pos.shortEntryPrice,
          entryAt: pos.entryAt,
          underlyingAtEntry: pos.underlyingAtEntry,
          peakPremium: pos.bestBasisSinceEntry,
        },
        currentBasis,
        underlying,
        cfg,
        Date.now(),
      );
      if (sd.peakPremium !== null && sd.peakPremium !== pos.bestBasisSinceEntry) {
        updateOptionsPaperPositionBestBasis(pos.id, sd.peakPremium);
      }
      if (sd.exit) {
        // The close needs a mark. priceRulesActive is true whenever this
        // branch runs, so one was already attempted — but it can have failed,
        // and hard_time in particular fires deliberately WITHOUT a quote. Fetch
        // once more before giving up: being stuck in a decaying contract past
        // 14:00 because a mark was momentarily unavailable is the exact
        // failure this rule exists to prevent.
        let exitMarks = marks;
        if (!exitMarks) {
          exitMarks = await fetchExitMarks(pos).catch(() => undefined);
        }
        if (!exitMarks) {
          return { symbol: pos.symbol, closed: false, reason: 'Quote fetch failed pricing a short-dated exit' };
        }
        // The six rules collapse onto this table's four stored reasons; the
        // precise rule lives in the journal below, which is what the daily
        // read joins on — same mapping the live path uses.
        const sdReason: OptionsPaperExitReason =
          sd.rule === 'take_profit' || sd.rule === 'give_back'
            ? 'take_profit'
            : sd.rule === 'underlying_stop' || sd.rule === 'disaster_stop'
              ? 'stop_loss'
              : 'time_exit';
        const sdClosed = closeOptionsPaperPosition(pos.id, {
          exitPrice: exitMarks.exitPrice,
          shortExitPrice: exitMarks.shortExitPrice,
          exitReason: sdReason,
        });
        if (sdClosed) {
          logAutotradeEvent({
            symbol: pos.symbol,
            stage: 'execution',
            action: 'short_dated_options_exit',
            detail: {
              positionId: pos.id,
              book: 'paper',
              rule: sd.rule,
              reason: sd.detail,
              premiumGainPct: sd.premiumGainPct,
              underlyingMovePct: sd.underlyingMovePct,
              expiration: pos.expiration,
              exitReason: sdReason,
              exitPrice: exitMarks.exitPrice,
              shortExitPrice: exitMarks.shortExitPrice,
              pnl: optionsPnl(pos, exitMarks.exitPrice, exitMarks.shortExitPrice ?? null),
            },
            riskProfile: pos.riskProfile,
          });
        }
        return { symbol: pos.symbol, closed: !!sdClosed, position: sdClosed ?? undefined };
      }
    }

    // Once a breakeven/trailing event has ratcheted stopFloorPct, it
    // OVERRIDES the live cfg.optionsStopLossPct for this position (mirrors
    // autotradePaperPositions.ts's own stopPrice, position-specific once
    // ratcheted) — null means nothing has ratcheted yet, so behavior is
    // byte-for-byte unchanged from before this feature existed.
    // With the short-dated ladder in charge the %-of-premium rules below must
    // go quiet — the ladder owns them, and leaving them live alongside it
    // reintroduces exactly the failure the ladder exists to prevent. At the
    // configured optionsStopLossPct of 40, a stop on the PREMIUM fires on a
    // FLAT tape by early afternoon (the premium is -11% at 10:30 and -63% at
    // 13:30 with the underlying perfectly still), pre-empting the underlying
    // stop that was supposed to be the real one and turning the whole
    // priority order in the spec into a fiction. The ladder's own disaster
    // backstop (optionsDisasterStopPct, ~70) is the premium floor instead.
    // Take-profit goes quiet with it because the ladder already reads
    // optionsTakeProfitPct itself — one rule set, not two racing.
    const stopLossPct = cfg.shortDatedOptionsEnabled
      ? undefined
      : pos.stopFloorPct != null
        ? -pos.stopFloorPct
        : cfg.optionsStopLossPct || undefined;
    const ev = evaluateExit(
      { entryPrice: entryBasis, currentPrice: currentBasis, side: 'long', expiration: pos.expiration },
      {
        timeExitDaysBeforeExpiry: timeExitDaysFor(cfg),
        stopLossPct,
        takeProfitPct: cfg.shortDatedOptionsEnabled ? undefined : cfg.optionsTakeProfitPct || undefined,
      },
    );
    if (!ev.triggered) {
      // Only reached once stop/take-profit/time-exit have all been ruled
      // out — mirrors applyPositionManagement's own place in checkPaperExits.
      // Needs a fresh mark, same as the trigger check above; a cycle whose
      // fetch failed (or wasn't attempted) just skips management this time,
      // retried next cycle.
      if (marks && currentBasis !== null) {
        applyOptionsPositionManagement(pos, entryBasis, currentBasis, marks, cfg);
      }
      return { symbol: pos.symbol, closed: false };
    }

    // Triggered without an up-front fetch (priceRulesActive was false, or it
    // failed) -- fetch now, exactly like the original design's "quote only
    // once we know we're closing."
    if (!marks) {
      try {
        marks = await fetchExitMarks(pos);
      } catch (err) {
        return { symbol: pos.symbol, closed: false, reason: `Quote fetch failed: ${(err as Error).message}` };
      }
    }

    const exitReason = exitReasonFor(ev.activeRule!);
    const closed = closeOptionsPaperPosition(pos.id, {
      exitPrice: marks.exitPrice,
      shortExitPrice: marks.shortExitPrice,
      exitReason,
    });
    if (closed) {
      const pnl = optionsPnl(pos, marks.exitPrice, marks.shortExitPrice ?? null);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'options_paper_position_closed',
        detail: {
          exitReason,
          exitPrice: marks.exitPrice,
          shortExitPrice: marks.shortExitPrice,
          pnl,
          dte: ev.dte,
          unrealizedPct: ev.unrealizedPct,
        },
        riskProfile: pos.riskProfile,
      });
    }
    return { symbol: pos.symbol, closed: !!closed, position: closed ?? undefined };
  });
}

/**
 * Trailing stop / breakeven / partial profit-taking — only reached once
 * stop-loss/take-profit/time-exit have all already been ruled out for this
 * cycle. The options counterpart to execute.ts's own applyPositionManagement,
 * adapted to options' %-of-premium model: unrealized gain is measured as a
 * percentage of entryBasis (net debit, for a spread), not an R-multiple of a
 * price-based stop distance — a long option/spread has no ATR-based stop to
 * measure R against. `entryBasis`/`currentBasis` are the SAME net-debit-aware
 * basis checkOptionsPaperExits() already computed for the trigger check
 * (single fetch, reused here — no extra provider call). Every autotrade
 * options position is opened LONG, so best-basis-since-entry is always a
 * running MAX, never a long/short branch.
 */
function applyOptionsPositionManagement(
  pos: OptionsPaperPosition,
  entryBasis: number,
  currentBasis: number,
  marks: { exitPrice: number; shortExitPrice?: number },
  cfg: ReturnType<typeof getAutotradeConfig>,
): void {
  const gainPct = unrealizedReturnPct(entryBasis, currentBasis, 'long');
  if (gainPct === null) return;

  // Partial exit — one-time, checked first (a scale-out is the "bigger"
  // action; breakeven/trailing below just adjust where the remainder's
  // floor sits). partialExitTaken guards against re-firing every cycle.
  if (cfg.optionsPartialExitTriggerPct > 0 && !pos.partialExitTaken && gainPct >= cfg.optionsPartialExitTriggerPct) {
    const closeQty = Math.floor(pos.quantity * (cfg.optionsPartialExitPct / 100));
    if (closeQty > 0 && closeQty < pos.quantity) {
      const updated = partialCloseOptionsPaperPosition(pos.id, {
        quantity: closeQty,
        exitPrice: marks.exitPrice,
        shortExitPrice: marks.shortExitPrice,
      });
      if (updated) {
        const pnl = optionsPnl({ ...pos, quantity: closeQty }, marks.exitPrice, marks.shortExitPrice ?? null);
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'options_paper_partial_exit',
          detail: {
            quantity: closeQty,
            exitPrice: marks.exitPrice,
            shortExitPrice: marks.shortExitPrice,
            pnl,
            gainPct,
          },
          riskProfile: pos.riskProfile,
        });
      }
    }
  }

  // Best basis seen since entry — the running peak the trailing calculation
  // ratchets against. Cheap bookkeeping; no journal entry.
  const priorBest = pos.bestBasisSinceEntry ?? entryBasis;
  const bestBasis = Math.max(priorBest, currentBasis);
  if (bestBasis !== priorBest) updateOptionsPaperPositionBestBasis(pos.id, bestBasis);
  const bestGainPct = unrealizedReturnPct(entryBasis, bestBasis, 'long') ?? gainPct;

  // Breakeven and trailing both just propose a candidate floor; only the
  // MOST protective (highest) of {prior floor, breakeven candidate, trailing
  // candidate} ever gets written — guarantees neither can ever loosen the
  // floor, without needing separate "already applied" flags. A candidate is
  // only computed when its OWN trigger actually fires this cycle — the prior
  // floor (or the live config, if nothing has ratcheted yet) is never
  // persisted on its own, or every position would freeze at the live config's
  // value on its very first check.
  let candidateFloor: number | null = null;
  if (cfg.optionsBreakevenTriggerPct > 0 && gainPct >= cfg.optionsBreakevenTriggerPct) {
    candidateFloor = candidateFloor === null ? 0 : Math.max(candidateFloor, 0);
  }
  if (cfg.optionsTrailStartPct > 0 && cfg.optionsTrailStopPct > 0 && gainPct >= cfg.optionsTrailStartPct) {
    const trailingCandidate = bestGainPct - cfg.optionsTrailStopPct;
    candidateFloor = candidateFloor === null ? trailingCandidate : Math.max(candidateFloor, trailingCandidate);
  }
  if (candidateFloor !== null) {
    const priorFloor = pos.stopFloorPct ?? (cfg.optionsStopLossPct > 0 ? -cfg.optionsStopLossPct : null);
    const newFloor = priorFloor === null ? candidateFloor : Math.max(priorFloor, candidateFloor);
    if (newFloor !== pos.stopFloorPct) {
      ratchetOptionsPaperPositionStopFloor(pos.id, newFloor);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'options_paper_stop_ratcheted',
        detail: { from: pos.stopFloorPct, to: newFloor, gainPct },
        riskProfile: pos.riskProfile,
      });
    }
  }
}

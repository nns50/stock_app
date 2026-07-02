import { getAutotradeConfig, RiskProfileName } from '../../db/autotradeConfig';
import { RISK_PROFILES } from './riskProfiles';
import { TradeSignal } from './decide';
import { correlatedNotional, evaluateRiskCheck, RiskCheckContext, RiskCheckResult } from './riskCheck';
import { computeStreaksAndDrawdown } from '../pnl';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import {
  closePaperPosition,
  hasOpenPaperPosition,
  listOpenPaperPositions,
  listPaperPositions,
  openPaperPosition,
  PaperExitReason,
  PaperPosition,
} from '../../db/autotradePaperPositions';
import { getProvider } from '../../providers';
import { mapPool } from '../../util/async';

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

function todayUtcStr(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
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

  const position = openPaperPosition({
    symbol: signal.symbol,
    side: signal.side,
    quantity: riskResult.sizing.suggestedQuantity,
    entryPrice: fillPrice,
    stopPrice: signal.stop,
    targetPrice: signal.target,
    riskAmount: riskResult.approvedRiskAmount,
    riskProfile,
    rationale: signal.rationale,
  });
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

/**
 * Risk-check, then attempt to fill, a batch of already-decided signals —
 * sequentially against a RUNNING total (open paper positions + already-
 * approved earlier in this same call), mirroring backtest.ts's
 * simulateBacktest() batch pattern and riskCheck.ts's runAutotradeRiskCheck:
 * a batch of individually-fine signals can't jointly bust a cap none of them
 * would trip alone.
 */
export async function runPaperExecution(candidates: { signal: TradeSignal }[]): Promise<ExecutionOutcome[]> {
  const config = getAutotradeConfig();
  const profile = RISK_PROFILES[config.riskProfile];
  const equity = config.accountEquityUsd ?? 0;
  const today = todayUtcStr();

  const openPositions = listOpenPaperPositions();
  const recent = listPaperPositions({ limit: 500 }); // open + closed, newest first — plenty for "today" stats
  const closedTodayChrono = recent
    .filter((p) => p.status === 'closed' && p.exitAt !== null && todayUtcStr(p.exitAt) === today)
    .sort((a, b) => a.exitAt! - b.exitAt!);
  const closedPnlsChrono = closedTodayChrono.map(
    (p) => (p.exitPrice! - p.entryPrice) * p.quantity * (p.side === 'buy' ? 1 : -1),
  );
  const dailyPnl = closedPnlsChrono.reduce((s, p) => s + p, 0);
  const { currentStreak } = computeStreaksAndDrawdown(closedPnlsChrono);
  const consecutiveLosses = currentStreak.type === 'loss' ? currentStreak.count : 0;
  const tradesToday = recent.filter((p) => todayUtcStr(p.entryAt) === today).length;

  let runningRisk = openPositions.reduce((s, p) => s + p.riskAmount, 0);
  let runningCount = openPositions.length;
  const runningPositions: { symbol: string; notional: number }[] = openPositions.map((p) => ({
    symbol: p.symbol,
    notional: p.entryPrice * p.quantity,
  }));
  const skipSymbols = new Set(openPositions.map((p) => p.symbol));

  const outcomes: ExecutionOutcome[] = [];
  for (const { signal } of candidates) {
    const symbol = signal.symbol.toUpperCase();
    if (skipSymbols.has(symbol)) {
      outcomes.push({ symbol, ok: false, reason: 'Already has an open paper position' });
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
    const result = evaluateRiskCheck(signal, ctx, profile);
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

    const outcome = await attemptPaperEntry(signal, result, config.riskProfile);
    outcomes.push(outcome);
    if (outcome.ok && outcome.position) {
      runningRisk += result.approvedRiskAmount;
      runningCount += 1;
      runningPositions.push({ symbol, notional: outcome.position.entryPrice * outcome.position.quantity });
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

/**
 * Check every open paper position against a fresh quote for a stop/target
 * hit, closing (at the declared stop/target LEVEL, not the observed quote —
 * same convention as backtest.ts, so paper and backtest results stay
 * comparable) whichever fires. A live quote is a single point, not a
 * high/low range like a completed daily bar, so — unlike the backtest — a
 * long's stop (below entry) and target (above entry) can never both be
 * "hit" by the same quote; there's no tie to break.
 */
export async function checkPaperExits(): Promise<ExitCheckOutcome[]> {
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
    if (!stopHit && !targetHit) return { symbol: pos.symbol, closed: false };

    const exitReason: PaperExitReason = stopHit ? 'stop' : 'target';
    const exitPrice = stopHit ? pos.stopPrice : pos.targetPrice;
    const closed = closePaperPosition(pos.id, { exitPrice, exitReason });
    if (closed) {
      const pnl = (exitPrice - pos.entryPrice) * pos.quantity * (long ? 1 : -1);
      logAutotradeEvent({
        symbol: pos.symbol,
        stage: 'execution',
        action: 'paper_position_closed',
        detail: { exitReason, exitPrice, pnl },
        riskProfile: pos.riskProfile,
      });
    }
    return { symbol: pos.symbol, closed: !!closed, position: closed ?? undefined };
  });
}

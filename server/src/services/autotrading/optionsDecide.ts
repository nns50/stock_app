import { getProvider, getProviderStatus } from '../../providers';
import { defaultEntryConfig, EntryStrategyConfig, scanEntries } from '../../options/entryRules';
import { daysToExpiration } from '../../options/blackScholes';
import { analyzeStrategy } from '../../options/optionStrategy';
import { atmIvOfChain, computeIvContext } from '../ivRank';
import { getIvHistory, recordAtmIv } from '../../db/ivHistory';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { mapPool } from '../../util/async';
import { Direction } from '../../indicators/screener';
import { ScreenCandidate } from './screen';

// ---------------------------------------------------------------------------
// The options counterpart to decide.ts (docs/AUTOTRADING_SPEC.md, phase 9).
// Takes the SAME already-screened, real-estate-excluded candidates equities'
// decide.ts consumes and produces an options-shaped signal alongside the
// stock one — reusing entryRules.ts's scanEntries() (already built for the
// human Options page) rather than a parallel scoring engine, and
// optionStrategy.ts's analyzeStrategy() as a structural, code-level backstop
// against ever approving an undefined-risk structure.
//
// Unlike decide.ts (pure, synchronous — everything it needs is already on the
// candidate), this stage needs real I/O per candidate: an option chain from
// the market-data provider, plus reading/writing this app's own IV-rank
// history. It's still read-only toward the BROKER (no risk-check, no orders)
// — the I/O here is a data fetch and a journal write, not an order.
//
// First cut, deliberately scoped down from the spec's full "long call, long
// put, or debit spread": only single-leg long calls/puts are produced here.
// A debit spread's short leg has no strike-selection logic anywhere in this
// codebase to reuse (computeSpreadSizing() in Phase 10 only SIZES an
// already-defined spread, it doesn't construct one) — building that from
// scratch is a real, additional strategy surface the user hasn't weighed in
// on, unlike everything else here which reuses existing, already-shipped
// logic. Single-leg long options are the strictly more conservative subset
// (uncapped upside, one fewer decision), so shipping this first and adding
// spread construction later — if wanted — mirrors this codebase's own
// established convention of gating anything with more scope/complexity
// behind an explicit, separate opt-in (AGGRESSIVE vs MODERATE, undefined-risk
// strategies).
// ---------------------------------------------------------------------------

export type OptionsSignalSide = 'call' | 'put';

export interface OptionsDecisionConfig {
  direction: Direction;
  /** Merged onto defaultAutotradeEntryConfig(side) — same override shape as
   *  decide.ts's DecisionConfig patch convention. */
  entryConfig?: Partial<EntryStrategyConfig>;
}

export function defaultOptionsDecisionConfig(): OptionsDecisionConfig {
  return { direction: 'long' };
}

/** entryRules.ts's own default plus the confirmed autotrade-specific IV-rank
 *  ceiling (docs/AUTOTRADING_SPEC.md "Resolved decisions" — ivRankMax: 70).
 *  The human Options page's defaultEntryConfig() leaves ivRankMax unset since
 *  it serves both buying and selling strategies (where "high IV" cuts the
 *  opposite way); this system only ever buys premium, so guarding the one
 *  direction that matters here is autotrade-specific, not a page-wide default. */
export function defaultAutotradeEntryConfig(side: OptionsSignalSide): EntryStrategyConfig {
  return { ...defaultEntryConfig(side), ivRankMax: 70 };
}

export interface OptionsTradeSignal {
  symbol: string;
  side: OptionsSignalSide;
  /** Provider contract symbol (e.g. OCC code) — what an eventual order (Phase
   *  12) would actually reference. */
  contractSymbol: string;
  strike: number;
  expiration: string;
  dte: number;
  /** Entry price per share (the contract's mark). */
  premium: number;
  delta: number | null;
  ivRank: number;
  /** Dollars at risk for ONE contract (100 × premium) — a positive $ amount,
   *  matching this codebase's risk-amount convention (services/pnl.ts,
   *  riskCheck.ts). Derived from analyzeStrategy()'s maxLoss, not computed
   *  independently, so it can never silently drift from the same structural
   *  check that approved this signal in the first place. */
  maxLossPerContract: number;
  rationale: string;
  /** The underlying's screener score, carried over — same convention as
   *  TradeSignal.score (decide.ts): sorting/comparison across DIFFERENT
   *  underlyings uses the equity screen's score, not this contract's own
   *  liquidity/delta-fit ranking (entryRules.ts's EntryCandidate.score),
   *  which only ranks contracts WITHIN one underlying's own chain. */
  score: number;
}

export type OptionsSignalResult = { ok: true; signal: OptionsTradeSignal } | { ok: false; reason: string };

/**
 * Build an options-shaped signal for one already-screened candidate, or a
 * reason it was skipped. Fails closed at every stage — no expiration in the
 * configured DTE window, a chain fetch failure, insufficient REAL (not
 * hv-estimate) IV-rank history, no contract passing entryRules.ts's rules, or
 * a structural defined-risk failure all skip the candidate rather than
 * approximate an answer.
 */
export async function generateOptionsSignal(
  candidate: ScreenCandidate,
  cfg: OptionsDecisionConfig = defaultOptionsDecisionConfig(),
): Promise<OptionsSignalResult> {
  const symbol = candidate.symbol.toUpperCase();
  const side: OptionsSignalSide = cfg.direction === 'long' ? 'call' : 'put';
  const entryCfg: EntryStrategyConfig = { ...defaultAutotradeEntryConfig(side), ...cfg.entryConfig, side };
  const provider = getProvider();
  const now = new Date();

  let expirations: string[];
  try {
    expirations = await provider.getOptionsExpirations(symbol);
  } catch (err) {
    return { ok: false, reason: `Failed to fetch option expirations: ${(err as Error).message}` };
  }

  const minDte = entryCfg.minDaysToExpiration ?? -Infinity;
  const maxDte = entryCfg.maxDaysToExpiration ?? Infinity;
  const inWindow = expirations
    .slice()
    .sort() // "YYYY-MM-DD" sorts lexicographically = chronologically
    .filter((exp) => {
      const dte = daysToExpiration(exp, now);
      return dte >= minDte && dte <= maxDte;
    });
  const expiration = inWindow[0];
  if (!expiration) {
    return { ok: false, reason: `No expiration within the configured DTE window [${minDte}, ${maxDte}] days` };
  }

  let chain;
  try {
    chain = await provider.getOptionsChain(symbol, expiration);
  } catch (err) {
    return { ok: false, reason: `Failed to fetch option chain: ${(err as Error).message}` };
  }

  // Accrue IV history the same way the human Options page does (routes/
  // options.ts's ivContextFor) — the loop screening a symbol should grow real
  // 'history'-method coverage over time even before a human ever views its
  // chain, per the spec's own stated goal.
  const atmIv = atmIvOfChain(chain);
  if (atmIv !== undefined) recordAtmIv(chain.underlying, atmIv);
  const history = getIvHistory(chain.underlying);
  // No candles fetched for an hv-estimate fallback here (unlike the human
  // page's ivContextFor) — deliberately: the fail-closed policy below never
  // uses that proxy, so fetching candles for it would just be a wasted call.
  const ivContext = computeIvContext(atmIv, history, []);
  if (ivContext.method !== 'history' || ivContext.ivRank === null) {
    return {
      ok: false,
      reason:
        `Insufficient real IV-rank history for ${chain.underlying} ` +
        `(${ivContext.samples} sample${ivContext.samples === 1 ? '' : 's'}, need 15) — ` +
        `skipped rather than scored on a cruder proxy`,
    };
  }

  const entries = scanEntries(chain, entryCfg, now, ivContext.ivRank);
  const best = entries.find((e) => e.passed);
  if (!best) {
    return { ok: false, reason: 'No contract passed entry rules (liquidity/spread/delta/IV band)' };
  }

  const premium = best.metrics.mark ?? 0;
  const analysis = analyzeStrategy({
    underlyingPrice: chain.underlyingPrice ?? candidate.price,
    dte: best.metrics.dte,
    legs: [
      {
        type: side,
        action: 'buy',
        strike: best.contract.strike,
        quantity: 1,
        premium,
        iv: best.metrics.iv ?? undefined,
      },
    ],
  });
  // Structural backstop (docs/AUTOTRADING_SPEC.md): never approve anything
  // analyzeStrategy() itself reports as unbounded-loss or non-finite max
  // loss. A single long call/put is defined-risk by construction, so this
  // should always pass — but checking it in code, not just assuming the
  // invariant, is exactly what the spec calls for.
  if (analysis.unboundedLoss || analysis.maxLoss === null || !Number.isFinite(analysis.maxLoss)) {
    return { ok: false, reason: 'Structural defined-risk check failed (unbounded or non-finite max loss)' };
  }

  const rationale =
    `Long ${side} on ${symbol}: strike ${best.contract.strike}, exp ${best.contract.expiration} ` +
    `(${best.metrics.dte.toFixed(0)}d), premium ${premium.toFixed(2)}, ` +
    `Δ ${best.metrics.delta === null ? 'n/a' : best.metrics.delta.toFixed(2)}, IV rank ${ivContext.ivRank.toFixed(0)}`;

  return {
    ok: true,
    signal: {
      symbol,
      side,
      contractSymbol: best.contract.symbol,
      strike: best.contract.strike,
      expiration: best.contract.expiration,
      dte: best.metrics.dte,
      premium,
      delta: best.metrics.delta,
      ivRank: ivContext.ivRank,
      // analysis.maxLoss is a P&L figure (negative); flip to a positive $-at-risk amount.
      maxLossPerContract: Math.abs(analysis.maxLoss),
      rationale,
      score: candidate.total,
    },
  };
}

export interface OptionsDecisionResult {
  signals: OptionsTradeSignal[];
  skipped: { symbol: string; reason: string }[];
}

/** Options counterpart to runAutotradeDecision — same already-screened
 *  candidates, journaling each outcome under the same 'decision' stage
 *  equities' own decide.ts already uses (a new action vocabulary, not a new
 *  stage). Bounded concurrency (mirrors screen.ts's own provider fan-out)
 *  since each candidate now costs two real provider round-trips. */
export async function runOptionsDecision(
  candidates: ScreenCandidate[],
  configPatch?: Partial<OptionsDecisionConfig>,
): Promise<OptionsDecisionResult> {
  const cfg = { ...defaultOptionsDecisionConfig(), ...configPatch };
  const signals: OptionsTradeSignal[] = [];
  const skipped: { symbol: string; reason: string }[] = [];

  if (!getProviderStatus().capabilities.options) {
    for (const c of candidates)
      skipped.push({ symbol: c.symbol, reason: 'Options data not available from the configured provider' });
    return { signals, skipped };
  }

  const results = await mapPool(candidates, 6, (candidate) => generateOptionsSignal(candidate, cfg));
  candidates.forEach((candidate, i) => {
    const result = results[i];
    if (result.ok) {
      signals.push(result.signal);
      logAutotradeEvent({
        symbol: candidate.symbol,
        stage: 'decision',
        action: 'options_signal_generated',
        detail: {
          side: result.signal.side,
          strike: result.signal.strike,
          expiration: result.signal.expiration,
          premium: result.signal.premium,
          ivRank: result.signal.ivRank,
          maxLossPerContract: result.signal.maxLossPerContract,
          rationale: result.signal.rationale,
        },
      });
    } else {
      skipped.push({ symbol: candidate.symbol, reason: result.reason });
      logAutotradeEvent({
        symbol: candidate.symbol,
        stage: 'decision',
        action: 'no_options_signal',
        detail: { reason: result.reason },
      });
    }
  });

  return { signals, skipped };
}

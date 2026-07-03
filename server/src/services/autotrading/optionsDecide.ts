import { getProvider, getProviderStatus } from '../../providers';
import { defaultEntryConfig, EntryStrategyConfig, scanEntries } from '../../options/entryRules';
import { daysToExpiration } from '../../options/blackScholes';
import { analyzeStrategy } from '../../options/optionStrategy';
import { atmIvOfChain, computeIvContext } from '../ivRank';
import { getIvHistory, recordAtmIv } from '../../db/ivHistory';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { OptionsStrategyType } from '../../db/autotradeConfig';
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
// against ever approving an undefined-risk (or, for a spread, undefined-
// reward) structure.
//
// Unlike decide.ts (pure, synchronous — everything it needs is already on the
// candidate), this stage needs real I/O per candidate: an option chain from
// the market-data provider, plus reading/writing this app's own IV-rank
// history. It's still read-only toward the BROKER (no risk-check, no orders)
// — the I/O here is a data fetch and a journal write, not an order.
//
// Two strategy shapes, gated by db/autotradeConfig.ts's OptionsStrategyType
// (default 'single_leg' — a deliberate, explicit opt-in to switch, not
// something the loop picks based on market conditions):
//   - 'single_leg': a long call/put — uncapped upside, the simplest structure
//     and the strictly more conservative default (one fewer decision).
//   - 'debit_spread': the same long leg, PLUS a short leg further
//     out-of-the-money (found by reusing scanEntries() a second time with a
//     shifted, further-OTM delta band — see SHORT_LEG_DELTA_BAND), which caps
//     both max loss AND max gain — a genuinely different risk/reward trade.
// Both shapes reuse the same entryRules.ts/optionStrategy.ts building blocks;
// computeSpreadSizing() (services/riskSizing.ts, Phase 10) is what actually
// sizes an approved spread signal (see optionsRiskCheck.ts) — this file only
// constructs and structurally validates the spread itself.
// ---------------------------------------------------------------------------

export type OptionsSignalSide = 'call' | 'put';

export interface OptionsDecisionConfig {
  direction: Direction;
  /** Merged onto defaultAutotradeEntryConfig(side) — same override shape as
   *  decide.ts's DecisionConfig patch convention. */
  entryConfig?: Partial<EntryStrategyConfig>;
  /** 'single_leg' (default) or 'debit_spread' — see db/autotradeConfig.ts's
   *  OptionsStrategyType doc comment. Changes WHICH contract(s)
   *  generateOptionsSignal() builds; entryConfig still governs the long
   *  leg's own scan either way. */
  strategyType?: OptionsStrategyType;
  /** Short-leg overrides for a debit spread, merged onto the long leg's own
   *  resolved entryCfg plus SHORT_LEG_DELTA_BAND's further-OTM default (so
   *  liquidity/spread/OI/volume/IV-rank gates stay identical for both legs
   *  unless explicitly overridden here). Ignored when strategyType is
   *  'single_leg'. */
  shortLegEntryConfig?: Partial<EntryStrategyConfig>;
}

export function defaultOptionsDecisionConfig(): OptionsDecisionConfig {
  return { direction: 'long', strategyType: 'single_leg' };
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

/** Short leg of a debit spread targets a delta band further OTM than the long
 *  leg's own band (defaultAutotradeEntryConfig: 0.30-0.60) — sell a
 *  further-OTM strike to collect some premium back, capping both max loss
 *  and max gain. Everything else (liquidity/spread/OI/volume/IV-rank gates)
 *  is inherited from the long leg's own resolved entryCfg (see
 *  generateOptionsSignal) so both legs are held to the identical
 *  contract-quality bar — only delta differs. */
const SHORT_LEG_DELTA_BAND: Pick<EntryStrategyConfig, 'deltaMin' | 'deltaMax'> = { deltaMin: 0.15, deltaMax: 0.25 };

interface OptionsSignalBase {
  symbol: string;
  side: OptionsSignalSide;
  expiration: string;
  dte: number;
  ivRank: number;
  rationale: string;
  /** The underlying's screener score, carried over — same convention as
   *  TradeSignal.score (decide.ts): sorting/comparison across DIFFERENT
   *  underlyings uses the equity screen's score, not this contract's own
   *  liquidity/delta-fit ranking (entryRules.ts's EntryCandidate.score),
   *  which only ranks contracts WITHIN one underlying's own chain. */
  score: number;
}

export interface SingleLegOptionsSignal extends OptionsSignalBase {
  kind: 'single_leg';
  /** Provider contract symbol (e.g. OCC code) — what an eventual order
   *  actually references. */
  contractSymbol: string;
  strike: number;
  /** Entry price per share (the contract's mark). */
  premium: number;
  delta: number | null;
  /** Dollars at risk for ONE contract (100 × premium) — a positive $ amount,
   *  matching this codebase's risk-amount convention (services/pnl.ts,
   *  riskCheck.ts). Derived from analyzeStrategy()'s maxLoss, not computed
   *  independently, so it can never silently drift from the same structural
   *  check that approved this signal in the first place. */
  maxLossPerContract: number;
}

export interface DebitSpreadOptionsSignal extends OptionsSignalBase {
  kind: 'debit_spread';
  /** Long leg — closer to the money (entryCfg's own delta band, e.g. 0.30-0.60). */
  longContractSymbol: string;
  longStrike: number;
  longPremium: number;
  longDelta: number | null;
  /** Short leg — further OTM (SHORT_LEG_DELTA_BAND), caps both loss and gain. */
  shortContractSymbol: string;
  shortStrike: number;
  shortPremium: number;
  shortDelta: number | null;
  /** |shortStrike - longStrike|, per share. */
  width: number;
  /** Net debit PAID per share (longPremium - shortPremium), always > 0 — a
   *  signal where the short leg would net a credit is rejected before this
   *  type is ever constructed (see generateOptionsSignal). */
  netDebit: number;
  /** $ at risk for ONE spread (100 × netDebit) — derived from
   *  analyzeStrategy()'s maxLoss, same non-independent-drift reasoning as
   *  the single-leg field of the same name. */
  maxLossPerContract: number;
  /** $ max profit for ONE spread (100 × (width - netDebit)) — meaningful for
   *  a spread (unlike a single long leg, whose upside is uncapped), derived
   *  from analyzeStrategy()'s maxProfit. */
  maxProfitPerContract: number;
}

export type OptionsTradeSignal = SingleLegOptionsSignal | DebitSpreadOptionsSignal;

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
  const strategyType: OptionsStrategyType = cfg.strategyType ?? 'single_leg';
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

  const underlyingPrice = chain.underlyingPrice ?? candidate.price;
  const premium = best.metrics.mark ?? 0;

  if (strategyType === 'single_leg') {
    const analysis = analyzeStrategy({
      underlyingPrice,
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
        kind: 'single_leg',
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

  // strategyType === 'debit_spread': pick a short leg further OTM than the
  // long leg just chosen above, by reusing scanEntries() again with
  // SHORT_LEG_DELTA_BAND merged onto the SAME resolved entryCfg (so
  // liquidity/spread/OI/volume/IV-rank gates match the long leg exactly).
  const shortLegCfg: EntryStrategyConfig = {
    ...entryCfg,
    ...SHORT_LEG_DELTA_BAND,
    ...cfg.shortLegEntryConfig,
    side,
  };
  const longStrike = best.contract.strike;
  const shortEntries = scanEntries(chain, shortLegCfg, now, ivContext.ivRank);
  const bestShort = shortEntries.find(
    (e) => e.passed && (side === 'call' ? e.contract.strike > longStrike : e.contract.strike < longStrike),
  );
  if (!bestShort) {
    return {
      ok: false,
      reason: 'No short-leg contract passed entry rules further out-of-the-money than the long leg',
    };
  }

  const shortPremium = bestShort.metrics.mark ?? 0;
  const netDebit = premium - shortPremium;
  if (netDebit <= 0) {
    return { ok: false, reason: 'Short leg premium ≥ long leg premium — not a net debit, skipped' };
  }

  const analysis = analyzeStrategy({
    underlyingPrice,
    dte: best.metrics.dte,
    legs: [
      { type: side, action: 'buy', strike: longStrike, quantity: 1, premium, iv: best.metrics.iv ?? undefined },
      {
        type: side,
        action: 'sell',
        strike: bestShort.contract.strike,
        quantity: 1,
        premium: shortPremium,
        iv: bestShort.metrics.iv ?? undefined,
      },
    ],
  });
  // Structural backstop, extended for a spread: a debit vertical (same
  // underlying/expiration/type, opposite actions, equal quantity) is defined-
  // risk AND defined-reward by construction — verify BOTH bounds in code
  // rather than assume the invariant, same reasoning as the single-leg check.
  if (
    analysis.unboundedLoss ||
    analysis.unboundedProfit ||
    analysis.maxLoss === null ||
    analysis.maxProfit === null ||
    !Number.isFinite(analysis.maxLoss) ||
    !Number.isFinite(analysis.maxProfit)
  ) {
    return {
      ok: false,
      reason: 'Structural defined-risk/reward check failed (unbounded or non-finite max loss/profit)',
    };
  }

  const width = Math.abs(bestShort.contract.strike - longStrike);
  const rationale =
    `${side === 'call' ? 'Call' : 'Put'} debit spread on ${symbol}: long ${longStrike}/short ${bestShort.contract.strike}, ` +
    `exp ${best.contract.expiration} (${best.metrics.dte.toFixed(0)}d), net debit ${netDebit.toFixed(2)}, ` +
    `width ${width}, IV rank ${ivContext.ivRank.toFixed(0)}`;

  return {
    ok: true,
    signal: {
      kind: 'debit_spread',
      symbol,
      side,
      expiration: best.contract.expiration,
      dte: best.metrics.dte,
      ivRank: ivContext.ivRank,
      longContractSymbol: best.contract.symbol,
      longStrike,
      longPremium: premium,
      longDelta: best.metrics.delta,
      shortContractSymbol: bestShort.contract.symbol,
      shortStrike: bestShort.contract.strike,
      shortPremium,
      shortDelta: bestShort.metrics.delta,
      width,
      netDebit,
      // analysis.maxLoss/maxProfit are P&L figures; flip to positive $ amounts.
      maxLossPerContract: Math.abs(analysis.maxLoss),
      maxProfitPerContract: Math.abs(analysis.maxProfit),
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
      const signal = result.signal;
      logAutotradeEvent({
        symbol: candidate.symbol,
        stage: 'decision',
        action: 'options_signal_generated',
        detail:
          signal.kind === 'single_leg'
            ? {
                kind: signal.kind,
                side: signal.side,
                strike: signal.strike,
                expiration: signal.expiration,
                premium: signal.premium,
                ivRank: signal.ivRank,
                maxLossPerContract: signal.maxLossPerContract,
                rationale: signal.rationale,
              }
            : {
                kind: signal.kind,
                side: signal.side,
                longStrike: signal.longStrike,
                shortStrike: signal.shortStrike,
                expiration: signal.expiration,
                netDebit: signal.netDebit,
                width: signal.width,
                ivRank: signal.ivRank,
                maxLossPerContract: signal.maxLossPerContract,
                maxProfitPerContract: signal.maxProfitPerContract,
                rationale: signal.rationale,
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

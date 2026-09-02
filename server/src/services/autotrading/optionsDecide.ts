import { getProvider, getProviderStatus } from '../../providers';
import { defaultEntryConfig, EntryStrategyConfig, scanEntries } from '../../options/entryRules';
import { calendarDaysToExpiration } from '../../options/blackScholes';
import { analyzeStrategy } from '../../options/optionStrategy';
import { atmIvOfChain, computeIvContext, realizedVolSeries } from '../ivRank';
import { getIvHistory, recordAtmIv } from '../../db/ivHistory';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { OptionsStrategyType } from '../../db/autotradeConfig';
import { mapPool } from '../../util/async';
import { ScreenCandidate } from './screen';
import { Candle } from '../../providers/types';

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
//
// A third config value, 'auto' (2026-07-18), resolves to one of the two
// SHAPES above per candidate, from that candidate's own IV rank — the one
// deliberate exception to "the loop never picks based on market conditions"
// above, since classic options theory runs the other way for a net-premium
// BUYER (which this app always is): rich premium (high IV rank) favors
// capping the cost with a spread; cheap premium (low IV rank) favors the
// single leg's uncapped upside, since there's little rebate worth collecting
// by selling a further-OTM leg. See AUTO_STRATEGY_IV_RANK_THRESHOLD below —
// still a human's one-time opt-in into 'auto' itself, same as choosing
// 'debit_spread' outright.
// ---------------------------------------------------------------------------

export type OptionsSignalSide = 'call' | 'put';

export interface OptionsDecisionConfig {
  /** Merged onto defaultAutotradeEntryConfig(side) — same override shape as
   *  decide.ts's DecisionConfig patch convention. */
  entryConfig?: Partial<EntryStrategyConfig>;
  /** 'single_leg' (default), 'debit_spread', or 'auto' — see
   *  db/autotradeConfig.ts's OptionsStrategyType doc comment. Changes WHICH
   *  contract(s) generateOptionsSignal() builds; entryConfig still governs
   *  the long leg's own scan either way. 'auto' resolves to one of the other
   *  two PER CANDIDATE (see AUTO_STRATEGY_IV_RANK_THRESHOLD below). */
  strategyType?: OptionsStrategyType;
  /** Short-leg overrides for a debit spread, merged onto the long leg's own
   *  resolved entryCfg plus SHORT_LEG_DELTA_BAND's further-OTM default (so
   *  liquidity/spread/OI/volume/IV-rank gates stay identical for both legs
   *  unless explicitly overridden here). Ignored when strategyType resolves
   *  to 'single_leg' (directly, or via 'auto'). */
  shortLegEntryConfig?: Partial<EntryStrategyConfig>;
  /** Cheapness gate: max ATM-IV / 20-day-realized-vol ratio for an entry —
   *  see AutotradeConfig.optionsMaxIvRvRatio (the field this is threaded
   *  from). 0/undefined disables. Lives here rather than on
   *  EntryStrategyConfig because it gates the UNDERLYING (one ratio per
   *  candidate), not any individual contract — same altitude as
   *  strategyType, one level above entryRules' per-contract rules. */
  maxIvRvRatio?: number;
}

export function defaultOptionsDecisionConfig(): OptionsDecisionConfig {
  return { strategyType: 'single_leg' };
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
 *  contract-quality bar — only delta differs. Exported for reuse by
 *  optionsBacktest.ts's debit-spread simulation, so backtest and live never
 *  drift on this threshold. */
export const SHORT_LEG_DELTA_BAND: Pick<EntryStrategyConfig, 'deltaMin' | 'deltaMax'> = {
  deltaMin: 0.15,
  deltaMax: 0.25,
};

/** Cutoff for strategyType: 'auto' (see the file header comment above) — a
 *  candidate's IV rank at or above this resolves to 'debit_spread', below it
 *  resolves to 'single_leg'. 50 is the midpoint of the 0-100 IV rank scale,
 *  the simplest possible boundary and consistent with how this codebase
 *  already treats 50 as "elevated vs. not" elsewhere (docs/AUTOTRADING_SPEC.md
 *  regime sizing). Exported so optionsBacktest.ts/combinedBacktest.ts's
 *  'auto' simulation can never drift from the live path's own threshold. */
export const AUTO_STRATEGY_IV_RANK_THRESHOLD = 50;

interface OptionsSignalBase {
  symbol: string;
  side: OptionsSignalSide;
  expiration: string;
  dte: number;
  ivRank: number;
  rationale: string;
  /** The underlying's price at decision time. Recorded on the entry order and
   *  carried to the position, where an underlying-based stop measures against
   *  it (docs/SHORT_DATED_OPTIONS_SPEC.md). Nothing else on the signal can
   *  stand in: strike and premium say where the contract sits, not where the
   *  stock was when the thesis was formed. */
  underlyingPrice: number;
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
 * configured DTE window, a chain fetch failure, an IV rank that's neither
 * real history nor a realized-vol estimate (both insufficient), an IV/RV
 * cheapness gate that's on but can't compute realized vol (or finds premium
 * rich), no contract passing entryRules.ts's rules, or a structural
 * defined-risk failure all skip the candidate rather than approximate an
 * answer. IV rank itself DOES
 * accept the realized-vol estimate as a fallback (2026-07-09, by request —
 * see the comment above computeIvContext's call site) when real history is
 * still short; a signal built from that fallback says so in its rationale.
 *
 * Call vs put is read straight off `candidate.direction` (2026-07-16) — a
 * long candidate gets a call, a short candidate gets a put — the exact same
 * per-candidate read decide.ts's equity generateSignal() uses, not a
 * separate options-only setting. Since both equity and options decisions
 * consume the SAME already-screened ScreenCandidate[] in one run (loop.ts,
 * routes/autotrade.ts's /decide), a batch scored with tradeDirection:'both'
 * naturally produces a mix of calls and puts here too, with no extra wiring.
 */
export async function generateOptionsSignal(
  candidate: ScreenCandidate,
  cfg: OptionsDecisionConfig = defaultOptionsDecisionConfig(),
): Promise<OptionsSignalResult> {
  const symbol = candidate.symbol.toUpperCase();
  const side: OptionsSignalSide = candidate.direction === 'long' ? 'call' : 'put';
  const configuredStrategyType: OptionsStrategyType = cfg.strategyType ?? 'single_leg';
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
      // CALENDAR days, not fractional time-to-expiry (2026-09-02). minDte/
      // maxDte are whole-day settings; measuring them against a fraction meant
      // a 0-2 window rejected every Friday contract on a Wednesday (2.27 > 2),
      // and only Thursday and Friday could ever open a position on a
      // weekly-expiry name. See calendarDaysToExpiration's own comment.
      const dte = calendarDaysToExpiration(exp, now);
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
  // Same hv-estimate fallback the human Options page already uses (routes/
  // options.ts's ivContextFor), now wired into autotrade too (2026-07-09,
  // by request — real IV-rank history takes 15 CALENDAR DAYS to accumulate
  // one sample at a time, which was blocking every candidate; realized vol
  // is computed from historical candles that already exist, so it doesn't
  // have that ramp-up). Only fetched when real history is short, same
  // lazy-only-when-needed condition as the human path. Still clearly a
  // labeled proxy (ivContext.method), never silently presented as real
  // history — see the rationale string below.
  let candles: Candle[] = [];
  // A FAILED candle fetch is not the same fact as a symbol with a short price
  // history, and the two used to be indistinguishable here: `.catch(() => [])`
  // discarded the reason, and the skip message below then asserted "not enough
  // price history" for names that have decades of it. Measured 2026-09-02 —
  // TXN, AMD, INTC, NOW and PLTR all reported it inside a 20-symbol batch while
  // /api/candles returned 200 daily bars for every one of them, and each
  // cleared the gate when decided alone. The cause was provider rate limiting
  // under batch load; the message named the wrong thing and sent the
  // investigation after missing data that was never missing.
  let candlesError: string | null = null;
  const fetchDailyCandles = async (): Promise<Candle[]> => {
    try {
      return await provider.getCandles(symbol, 'daily', { limit: 260 });
    } catch (e) {
      candlesError = e instanceof Error ? e.message : String(e);
      return [];
    }
  };
  if (history.length < 15 && atmIv !== undefined) {
    candles = await fetchDailyCandles();
  }
  const ivContext = computeIvContext(atmIv, history, candles);
  if (ivContext.ivRank === null) {
    const samples = `${ivContext.samples} real IV-rank sample${ivContext.samples === 1 ? '' : 's'} (need 15)`;
    return {
      ok: false,
      reason: candlesError
        ? `Insufficient IV data for ${chain.underlying} — ${samples}, and the daily-candle fetch for the ` +
          `realized-volatility fallback FAILED (${candlesError}) — this is a data-availability problem, not a ` +
          `short price history; it usually clears on the next cycle`
        : `Insufficient IV data for ${chain.underlying} — ${samples} and not enough price history for a realized-` +
          `volatility estimate either — skipped rather than guessed`,
    };
  }
  const ivRankNote = ivContext.method === 'hv-estimate' ? ' (estimated from realized volatility)' : '';

  // Cheapness gate (2026-07-27): implied vs. REALIZED vol, the direction the
  // variance-risk-premium evidence actually supports for a premium BUYER —
  // IV rank only locates implied within its own range; this asks whether it
  // overprices the underlying's actual recent movement. Fails closed, like
  // every other stage here: gate on + no computable realized vol = skip.
  const maxIvRv = cfg.maxIvRvRatio ?? 0;
  let ivRvNote = '';
  if (maxIvRv > 0) {
    // The candles fetch above is lazy (only when real IV history is short) —
    // the gate needs the daily series regardless, so top it up here.
    if (!candles.length) {
      candles = await fetchDailyCandles();
    }
    const rvSeries = realizedVolSeries(candles);
    const realizedVol = rvSeries.length ? rvSeries[rvSeries.length - 1] : undefined;
    if (atmIv === undefined || realizedVol === undefined || realizedVol <= 0) {
      // Same distinction as the IV-rank skip above: blaming "insufficient
      // daily price history" for what is actually a failed fetch sends the
      // reader after data that is not missing.
      return {
        ok: false,
        reason: candlesError
          ? `IV/RV cheapness gate is on but the daily-candle fetch FAILED (${candlesError}) — a data-` +
            `availability problem, not a short price history; it usually clears on the next cycle`
          : 'IV/RV cheapness gate is on but the 20-day realized volatility could not be computed ' +
            '(insufficient daily price history) — skipped rather than guessed',
      };
    }
    const ratio = atmIv / realizedVol;
    if (ratio > maxIvRv) {
      return {
        ok: false,
        reason:
          `IV/RV ${ratio.toFixed(2)} above max ${maxIvRv} — implied ${(atmIv * 100).toFixed(0)}% vs ` +
          `20-day realized ${(realizedVol * 100).toFixed(0)}%: premium is rich relative to actual movement`,
      };
    }
    ivRvNote = `, IV/RV ${ratio.toFixed(2)}`;
  }

  // 'auto' resolves per-candidate here, now that ivContext.ivRank is known
  // (guaranteed non-null by the early return above) — see
  // AUTO_STRATEGY_IV_RANK_THRESHOLD's doc comment for the rationale.
  const strategyType: 'single_leg' | 'debit_spread' =
    configuredStrategyType === 'auto'
      ? ivContext.ivRank >= AUTO_STRATEGY_IV_RANK_THRESHOLD
        ? 'debit_spread'
        : 'single_leg'
      : configuredStrategyType;
  const autoNote = configuredStrategyType === 'auto' ? 'Auto-selected (IV rank-based) — ' : '';

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
      `${autoNote}Long ${side} on ${symbol}: strike ${best.contract.strike}, exp ${best.contract.expiration} ` +
      `(${best.metrics.dte.toFixed(0)}d), premium ${premium.toFixed(2)}, ` +
      `Δ ${best.metrics.delta === null ? 'n/a' : best.metrics.delta.toFixed(2)}, ` +
      `IV rank ${ivContext.ivRank.toFixed(0)}${ivRankNote}${ivRvNote}`;

    return {
      ok: true,
      signal: {
        kind: 'single_leg',
        symbol,
        side,
        underlyingPrice,
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
    `${autoNote}${side === 'call' ? 'Call' : 'Put'} debit spread on ${symbol}: long ${longStrike}/short ${bestShort.contract.strike}, ` +
    `exp ${best.contract.expiration} (${best.metrics.dte.toFixed(0)}d), net debit ${netDebit.toFixed(2)}, ` +
    `width ${width}, IV rank ${ivContext.ivRank.toFixed(0)}${ivRankNote}${ivRvNote}`;

  return {
    ok: true,
    signal: {
      kind: 'debit_spread',
      symbol,
      side,
      underlyingPrice,
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

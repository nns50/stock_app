// ---------------------------------------------------------------------------
// The counterfactual MFE ledger (2026-09-08): what the ML regime target
// tighten cost or saved, measured LIVE, without a control group.
//
// Paper and live both run the overlay, so once it is on nothing trades the
// untightened target beside it — the tighten's effect cannot be read as a
// difference between two books the way the live conviction floor's can. But
// every closed stock trade's favorable excursion is already measured
// (services/excursion.ts, mfeR), and a tightened target's untightened twin is
// arithmetic: the regime_target_factor stamped at entry divides it back out.
// So per trade the question "would the FULL target have been reached?" has
// an answer that is recorded rather than argued — mfeR ≥ fullTargetR — and
// the ledger is a BOUNDED counterfactual:
//
//   counterfactualR = fullReached ? fullTargetR : realizedR
//
// the most optimistic case for the full target, on both branches. Reached →
// it assumes the untightened trade banked the full target with no reversal
// after MFE. Not reached → it assumes the untightened trade did exactly as
// well as the tightened one, although a tightened hit whose MFE never touched
// the full target (a `bankedWin`) would in truth have stayed in and exited by
// some other rule at no better than MFE. Both assumptions favour the full
// target, so the reading is pre-committed in one direction only
// (docs/AUTOTRADING_SPEC.md): an optimistic counterfactual that beats
// realized R with a bootstrap CI excluding zero means the tighten has a real
// cost; one that cannot is strong evidence the tighten stays. The reverse
// inference — "the counterfactual lost, so the tighten helped by that much" —
// is never drawn, because the bound only ever leans one way.
//
// Pure: rows in, ledger out. The route (routes/journal.ts, /regime-tighten)
// collects the stamped rows from both books and fetches each excursion; the
// dashboard counts the same population through the same predicate.
// ---------------------------------------------------------------------------

import { ExcursionResolution } from '../excursion';
import { computeSignificanceStats } from './significance';

/** Which book a tightened trade was taken in. */
export type LedgerBook = 'paper' | 'live';

/** The pre-committed reading needs this many measured tightened trades. */
export const MIN_LEDGER_TRADES = 30;

/**
 * The regime_target_factor stamp of a trade whose target was actually
 * tightened at entry. 1 (or NULL, predating the column) is untightened; 0
 * cannot occur (regimeTargets.ts floors the factor at 0.1) and would make the
 * full target infinite, so it is excluded rather than divided by.
 * db/autotradePaperPositions.ts's TIGHTENED_FACTOR_SQL is this predicate in
 * SQL, for the paper COUNT and list — dbAutotradePaperPositions.test.ts pins
 * the two to the same boundary set.
 */
export function isTightenedFactor(factor: number | null | undefined): factor is number {
  return factor != null && Number.isFinite(factor) && factor > 0 && factor < 1;
}

/** The live book's slice of the population — closed STOCK rows of the
 *  journal's positions table with a tightened stamp. One function, called by
 *  the route (the rows) and the dashboard (the count), so the two cannot
 *  describe different populations. */
export function tightenedStockPositions<T extends { assetType: string; regimeTargetFactor: number | null }>(
  rows: T[],
): T[] {
  return rows.filter((p) => p.assetType === 'stock' && isTightenedFactor(p.regimeTargetFactor));
}

export interface TightenedTradeInput {
  positionId: number;
  symbol: string;
  book: LedgerBook;
  side: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  /** The FROZEN stop (initialStopPrice ?? stopPrice) — the same R denominator
   *  the excursion was measured against, so the target's R and the
   *  excursion's R share one unit by construction. */
  stopPrice: number | null;
  /** The target AS TRADED — already tightened. */
  targetPrice: number | null;
  /** regime_target_factor stamped at entry. */
  factor: number | null;
  /** The trade's best favorable run, in R of the same frozen stop
   *  (excursion.ts — the quantity cancels, so this is exact per share). */
  mfeR: number | null;
  /** The trade's realized R by the book's own definition: the excursion's
   *  for a journal (live) position, paperRealizedR for a paper one — P&L
   *  over the ORIGINAL risk, so a scaled-out trade's remaining quantity
   *  never inflates it. */
  realizedR: number | null;
  resolution: ExcursionResolution;
}

export interface TightenedTradeRow {
  positionId: number;
  symbol: string;
  book: LedgerBook;
  side: 'long' | 'short';
  entryDate: string;
  factor: number;
  /** The target as traded, in R of the frozen stop. */
  tightenedTargetR: number;
  /** tightenedTargetR ÷ factor — the untightened bracket this trade would
   *  have carried. */
  fullTargetR: number;
  mfeR: number;
  realizedR: number;
  /** MFE reached the tightened target. */
  tightenedReached: boolean;
  /** MFE reached the FULL target — the untightened bracket would have
   *  filled, assuming no reversal between. */
  fullReached: boolean;
  /** A tightened hit whose MFE never reached the full target: a win the
   *  tighten banked that the full target would have missed. */
  bankedWin: boolean;
  /** fullReached ? fullTargetR : realizedR — see the header. */
  counterfactualR: number;
  /** A same-session trade measured on a DAILY bar carries that whole day's
   *  high, so its MFE — and with it fullReached — is an upper bound. */
  resolution: ExcursionResolution;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * A tightened trade's ledger row, or null when it cannot be one: no tightened
 * stamp, no frozen stop, no target, a target on the wrong side of the entry,
 * or no R to compare (the excursion had no stop to measure against either).
 */
export function tightenedTradeRow(t: TightenedTradeInput): TightenedTradeRow | null {
  if (!isTightenedFactor(t.factor)) return null;
  if (t.stopPrice == null || t.targetPrice == null || !(t.entryPrice > 0)) return null;
  if (t.mfeR == null || t.realizedR == null) return null;
  const risk = Math.abs(t.entryPrice - t.stopPrice);
  if (!(risk > 0)) return null;
  const sign = t.side === 'long' ? 1 : -1;
  const tightenedTargetR = round4(((t.targetPrice - t.entryPrice) * sign) / risk);
  if (!(tightenedTargetR > 0)) return null;
  const fullTargetR = round4(tightenedTargetR / t.factor);
  const tightenedReached = t.mfeR >= tightenedTargetR;
  const fullReached = t.mfeR >= fullTargetR;
  return {
    positionId: t.positionId,
    symbol: t.symbol,
    book: t.book,
    side: t.side,
    entryDate: t.entryDate,
    factor: t.factor,
    tightenedTargetR,
    fullTargetR,
    mfeR: t.mfeR,
    realizedR: t.realizedR,
    tightenedReached,
    fullReached,
    bankedWin: tightenedReached && !fullReached,
    counterfactualR: fullReached ? fullTargetR : t.realizedR,
    resolution: t.resolution,
  };
}

/** 'insufficient' below MIN_LEDGER_TRADES; otherwise the pre-committed rule:
 *  'tighten_costs' when the optimistic counterfactual beats realized R with a
 *  bootstrap 95% CI excluding zero, 'tighten_holds' when it cannot. */
export type TightenReading = 'insufficient' | 'tighten_costs' | 'tighten_holds';

export interface RegimeTightenCoverage {
  /** Closed stock trades stamped with a tightened target, both books — the
   *  population before any filtering. */
  tightenedTrades: number;
  /** Skipped: an excursion walks candles from the entry, so it needs a date. */
  undated: number;
  /** Dropped by the per-request cap, most recent trades kept. */
  overCap: number;
  /** Attempted but unusable — no candles in the window, no frozen stop, no
   *  target, or no R. */
  unavailable: number;
  /** Closed OPTIONS trades (paper + live) stamped with a tightened target.
   *  Their excursion would be on the underlying, not the premium, so the
   *  ledger cannot measure them — counted so the population it cannot see
   *  stays visible. Outside the identity below. */
  optionsExcluded: number;
}

export interface RegimeTightenLedger {
  /** Trades measured — the rows below. n + undated + overCap + unavailable
   *  === coverage.tightenedTrades. */
  n: number;
  byBook: { paper: number; live: number };
  tightenedReached: number;
  fullReached: number;
  bankedWins: number;
  meanRealizedR: number | null;
  meanCounterfactualR: number | null;
  /** counterfactualR − realizedR per trade: the tighten's cost under the most
   *  optimistic full-target assumption, with its bootstrap 95% percentile CI
   *  (significance.ts). */
  difference: { meanR: number | null; ciLow: number | null; ciHigh: number | null; resamples: number };
  reading: TightenReading;
  /** The rule in words, with the numbers that produced the reading. */
  readingDetail: string;
  minTrades: number;
  rows: TightenedTradeRow[];
  coverage: RegimeTightenCoverage;
  /** Rows measured on intraday vs daily bars — a daily-bar row for a
   *  same-session trade is an upper bound, so the split is worth showing. */
  resolutionMix: { intraday: number; daily: number };
}

const fmtR = (n: number | null): string => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`);

function mean(xs: number[]): number | null {
  return xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

/**
 * `coverage` defaults to "these rows were the whole population" — true for a
 * direct call, false for the route, which passes its real counts (the same
 * convention as aggregateExcursions).
 */
export function buildRegimeTightenLedger(
  rows: TightenedTradeRow[],
  coverage?: Partial<RegimeTightenCoverage>,
  opts: { rng?: () => number; resamples?: number } = {},
): RegimeTightenLedger {
  const n = rows.length;
  const stats = computeSignificanceStats(
    rows.map((r) => ({ pnl: round4(r.counterfactualR - r.realizedR) })),
    { rng: opts.rng, resamples: opts.resamples },
  );
  const difference = { meanR: stats.expectancy, ciLow: stats.ciLow, ciHigh: stats.ciHigh, resamples: stats.resamples };

  let reading: TightenReading;
  let readingDetail: string;
  if (n < MIN_LEDGER_TRADES) {
    reading = 'insufficient';
    readingDetail =
      `${n} of ${MIN_LEDGER_TRADES} tightened trades measured — the pre-committed reading waits for ` +
      `${MIN_LEDGER_TRADES}.`;
  } else if (difference.meanR !== null && difference.ciLow !== null && difference.meanR > 0 && difference.ciLow > 0) {
    reading = 'tighten_costs';
    readingDetail =
      `The optimistic full-target counterfactual beats realized R by ${fmtR(difference.meanR)} per trade ` +
      `(95% CI ${fmtR(difference.ciLow)} to ${fmtR(difference.ciHigh)}, ${n} trades) — by the written rule the ` +
      `tighten has a real cost: set it to 0 for this regime and re-run the walk-forward grid.`;
  } else {
    reading = 'tighten_holds';
    readingDetail =
      `An optimistic full-target counterfactual cannot beat realized R (${fmtR(difference.meanR)} per trade, ` +
      `95% CI ${fmtR(difference.ciLow)} to ${fmtR(difference.ciHigh)} includes zero, ${n} trades) — the tighten ` +
      `stays.`;
  }

  return {
    n,
    byBook: {
      paper: rows.filter((r) => r.book === 'paper').length,
      live: rows.filter((r) => r.book === 'live').length,
    },
    tightenedReached: rows.filter((r) => r.tightenedReached).length,
    fullReached: rows.filter((r) => r.fullReached).length,
    bankedWins: rows.filter((r) => r.bankedWin).length,
    meanRealizedR: mean(rows.map((r) => r.realizedR)),
    meanCounterfactualR: mean(rows.map((r) => r.counterfactualR)),
    difference,
    reading,
    readingDetail,
    minTrades: MIN_LEDGER_TRADES,
    rows,
    coverage: {
      tightenedTrades: n,
      undated: 0,
      overCap: 0,
      unavailable: 0,
      optionsExcluded: 0,
      ...coverage,
    },
    resolutionMix: {
      intraday: rows.filter((r) => r.resolution === 'intraday').length,
      daily: rows.filter((r) => r.resolution !== 'intraday').length,
    },
  };
}

import { describe, it, expect } from 'vitest';
import {
  buildRegimeTightenLedger,
  isTightenedFactor,
  MIN_LEDGER_TRADES,
  tightenedStockPositions,
  tightenedTradeRow,
  TightenedTradeInput,
  TightenedTradeRow,
} from '../src/services/autotrading/regimeTightenLedger';

// ---------------------------------------------------------------------------
// The counterfactual MFE ledger (2026-09-08). With both books under the
// overlay nothing trades the untightened target beside it, so the tighten's
// effect is read per trade from the favorable excursion: did the FULL target
// get reached? The counterfactual is a BOUND — the most optimistic case for
// the full target on both branches — and the reading is pre-committed in one
// direction only. These tests pin the arithmetic, the bound, and the rule.
// ---------------------------------------------------------------------------

/** mulberry32 — the same seeded RNG significance.test.ts uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 100 / 95 / 107 at 0.7: 1.4R as traded, 2R untightened. */
const input = (over: Partial<TightenedTradeInput> = {}): TightenedTradeInput => ({
  positionId: 1,
  symbol: 'AAA',
  book: 'paper',
  side: 'long',
  entryDate: '2026-09-01',
  entryPrice: 100,
  stopPrice: 95,
  targetPrice: 107,
  factor: 0.7,
  mfeR: 2.4,
  realizedR: 1.4,
  resolution: 'intraday',
  ...over,
});

const rowFrom = (over: Partial<TightenedTradeInput> = {}): TightenedTradeRow => {
  const row = tightenedTradeRow(input(over));
  if (!row) throw new Error(`fixture produced no row: ${JSON.stringify(over)}`);
  return row;
};

describe('tightenedTradeRow — one trade’s bounded counterfactual', () => {
  it('derives the tightened and full targets in R of the frozen stop: 100/95/107 at 0.7 → 1.4R traded, 2R untightened', () => {
    const row = rowFrom();
    expect(row.tightenedTargetR).toBe(1.4);
    expect(row.fullTargetR).toBe(2);
    expect(row.factor).toBe(0.7);
  });

  it('full target reached: the counterfactual is the FULL target, not what was realized', () => {
    const row = rowFrom({ mfeR: 2.4, realizedR: 1.4 });
    expect(row).toMatchObject({ tightenedReached: true, fullReached: true, bankedWin: false, counterfactualR: 2 });
  });

  it('a banked win: the tightened target was hit but MFE never reached the full one — counterfactual = realized', () => {
    // The bound leans toward the full target here too: in truth the
    // untightened trade would have stayed in and exited at no better than
    // 1.6R by some other rule; the ledger credits it with the 1.4R actually
    // banked.
    const row = rowFrom({ mfeR: 1.6, realizedR: 1.4 });
    expect(row).toMatchObject({ tightenedReached: true, fullReached: false, bankedWin: true, counterfactualR: 1.4 });
  });

  it('a stop-out: nothing reached, counterfactual equals realized', () => {
    const row = rowFrom({ mfeR: 0.3, realizedR: -1 });
    expect(row).toMatchObject({ tightenedReached: false, fullReached: false, bankedWin: false, counterfactualR: -1 });
  });

  it('the boundary is inclusive — an MFE exactly at a target counts as reached', () => {
    expect(rowFrom({ mfeR: 1.4 }).tightenedReached).toBe(true);
    expect(rowFrom({ mfeR: 1.39 }).tightenedReached).toBe(false);
    expect(rowFrom({ mfeR: 2 }).fullReached).toBe(true);
  });

  it('a short mirrors the arithmetic: 100 / 105 / 93 at 0.7 → 1.4R / 2R', () => {
    const row = rowFrom({ side: 'short', stopPrice: 105, targetPrice: 93 });
    expect(row.tightenedTargetR).toBe(1.4);
    expect(row.fullTargetR).toBe(2);
  });

  it('keeps the resolution — a daily-bar row for a same-session trade is an upper bound', () => {
    expect(rowFrom({ resolution: 'daily' }).resolution).toBe('daily');
  });

  it('is null without a tightened stamp, a stop, a target, a target on the wrong side, or an R to compare', () => {
    expect(tightenedTradeRow(input({ factor: 1 }))).toBeNull();
    expect(tightenedTradeRow(input({ factor: null }))).toBeNull();
    expect(tightenedTradeRow(input({ factor: 0 }))).toBeNull();
    expect(tightenedTradeRow(input({ stopPrice: null }))).toBeNull();
    expect(tightenedTradeRow(input({ stopPrice: 100 }))).toBeNull(); // no risk
    expect(tightenedTradeRow(input({ targetPrice: null }))).toBeNull();
    expect(tightenedTradeRow(input({ targetPrice: 96 }))).toBeNull(); // below the entry on a long
    expect(tightenedTradeRow(input({ mfeR: null }))).toBeNull();
    expect(tightenedTradeRow(input({ realizedR: null }))).toBeNull();
  });
});

describe('buildRegimeTightenLedger', () => {
  // Three trades: reached the full target (cf 2 vs 1.4 realized), a banked
  // win (cf = realized 1.4), and a stop-out (cf = realized −1).
  const three = [
    rowFrom({ positionId: 1, book: 'live', mfeR: 2.4, realizedR: 1.4 }),
    rowFrom({ positionId: 2, book: 'paper', mfeR: 1.6, realizedR: 1.4, resolution: 'daily' }),
    rowFrom({ positionId: 3, book: 'paper', mfeR: 0.3, realizedR: -1 }),
  ];

  it('counts the outcomes and books, and averages realized against the counterfactual', () => {
    const l = buildRegimeTightenLedger(three, undefined, { rng: mulberry32(7), resamples: 500 });
    expect(l.n).toBe(3);
    expect(l.byBook).toEqual({ paper: 2, live: 1 });
    expect(l.tightenedReached).toBe(2);
    expect(l.fullReached).toBe(1);
    expect(l.bankedWins).toBe(1);
    expect(l.meanRealizedR).toBeCloseTo(0.6, 2); // (1.4 + 1.4 − 1) / 3
    expect(l.meanCounterfactualR).toBeCloseTo(0.8, 2); // (2 + 1.4 − 1) / 3
    expect(l.difference.meanR).toBeCloseTo(0.2, 2); // [0.6, 0, 0]
    expect(l.difference.resamples).toBe(500);
    // A percentile CI of a resampled mean stays inside the sample's own range.
    expect(l.difference.ciLow).toBeGreaterThanOrEqual(0);
    expect(l.difference.ciHigh).toBeLessThanOrEqual(0.6);
    expect(l.resolutionMix).toEqual({ intraday: 2, daily: 1 });
    expect(l.minTrades).toBe(MIN_LEDGER_TRADES);
  });

  it('defaults coverage to "these rows were the whole population" and lets the route override it', () => {
    expect(buildRegimeTightenLedger(three, undefined, { resamples: 10 }).coverage).toEqual({
      tightenedTrades: 3,
      undated: 0,
      overCap: 0,
      unavailable: 0,
      optionsExcluded: 0,
    });
    const c = buildRegimeTightenLedger(
      three,
      { tightenedTrades: 7, unavailable: 4, optionsExcluded: 2 },
      { resamples: 10 },
    ).coverage;
    expect(c).toEqual({ tightenedTrades: 7, undated: 0, overCap: 0, unavailable: 4, optionsExcluded: 2 });
  });

  it('is honest about an empty ledger — nulls, never a fabricated zero', () => {
    const l = buildRegimeTightenLedger([], undefined, { resamples: 10 });
    expect(l.n).toBe(0);
    expect(l.meanRealizedR).toBeNull();
    expect(l.meanCounterfactualR).toBeNull();
    expect(l.difference).toEqual({ meanR: null, ciLow: null, ciHigh: null, resamples: 0 });
    expect(l.reading).toBe('insufficient');
  });

  describe('the pre-committed reading', () => {
    const reached = (id: number) => rowFrom({ positionId: id, mfeR: 2.4, realizedR: 1.4 }); // difference 0.6
    const banked = (id: number) => rowFrom({ positionId: id, mfeR: 1.6, realizedR: 1.4 }); // difference 0

    it('waits for MIN_LEDGER_TRADES, whatever the numbers say', () => {
      const rows = Array.from({ length: MIN_LEDGER_TRADES - 1 }, (_, i) => reached(i));
      const l = buildRegimeTightenLedger(rows, undefined, { rng: mulberry32(1), resamples: 200 });
      expect(l.reading).toBe('insufficient');
      expect(l.readingDetail).toMatch(/29 of 30 tightened trades/);
    });

    it('reads "tighten costs" when the optimistic counterfactual beats realized R with a CI excluding zero', () => {
      const rows = [
        ...Array.from({ length: 20 }, (_, i) => reached(i)),
        ...Array.from({ length: 10 }, (_, i) => banked(100 + i)),
      ];
      const l = buildRegimeTightenLedger(rows, undefined, { rng: mulberry32(1), resamples: 500 });
      expect(l.reading).toBe('tighten_costs');
      expect(l.difference.meanR).toBeCloseTo(0.4, 2);
      expect(l.difference.ciLow).toBeGreaterThan(0);
      expect(l.readingDetail).toMatch(/beats realized R by \+0\.40R per trade/);
      expect(l.readingDetail).toMatch(/set it to 0 for this regime and re-run the walk-forward grid/);
    });

    it('reads "tighten holds" when it cannot — an optimistic counterfactual that still loses keeps the tighten', () => {
      const rows = Array.from({ length: MIN_LEDGER_TRADES }, (_, i) => banked(i));
      const l = buildRegimeTightenLedger(rows, undefined, { rng: mulberry32(1), resamples: 500 });
      expect(l.reading).toBe('tighten_holds');
      expect(l.difference.meanR).toBe(0);
      expect(l.readingDetail).toMatch(/cannot beat realized R/);
      expect(l.readingDetail).toMatch(/the tighten stays/);
    });

    it('never draws the reverse inference — a negative difference still reads "holds", never "helped by that much"', () => {
      // A trade that reached the full target yet realized MORE than it (a
      // trailing exit past the bracket): the bound says the untightened trade
      // would have stopped at the full target.
      const rows = Array.from({ length: MIN_LEDGER_TRADES }, (_, i) =>
        rowFrom({ positionId: i, mfeR: 2.6, realizedR: 2.5 }),
      );
      const l = buildRegimeTightenLedger(rows, undefined, { rng: mulberry32(1), resamples: 200 });
      expect(l.difference.meanR).toBeCloseTo(-0.5, 2);
      expect(l.reading).toBe('tighten_holds');
    });
  });
});

describe('the population predicate', () => {
  it('isTightenedFactor accepts only a stamp strictly between 0 and 1', () => {
    expect(isTightenedFactor(0.7)).toBe(true);
    expect(isTightenedFactor(0.999)).toBe(true);
    expect(isTightenedFactor(1)).toBe(false);
    expect(isTightenedFactor(0)).toBe(false);
    expect(isTightenedFactor(1.2)).toBe(false);
    expect(isTightenedFactor(null)).toBe(false);
    expect(isTightenedFactor(undefined)).toBe(false);
    expect(isTightenedFactor(Number.NaN)).toBe(false);
  });

  it('tightenedStockPositions keeps closed STOCK rows with a tightened stamp — the one filter the route and the dashboard share', () => {
    const rows = [
      { id: 1, assetType: 'stock', regimeTargetFactor: 0.7 },
      { id: 2, assetType: 'stock', regimeTargetFactor: 1 },
      { id: 3, assetType: 'stock', regimeTargetFactor: null },
      { id: 4, assetType: 'option', regimeTargetFactor: 0.7 },
    ];
    expect(tightenedStockPositions(rows).map((r) => r.id)).toEqual([1]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/autotrading/historicalData', () => ({ getHistoricalBars: vi.fn() }));

import { getHistoricalBars } from '../src/services/autotrading/historicalData';
import { simulateCombinedBacktest, CombinedBacktestConfig } from '../src/services/autotrading/combinedBacktest';
import { OptionContractRef } from '../src/services/autotrading/polygonOptionsClient';
import { Candle } from '../src/providers/types';
import { bsPrice } from '../src/options/blackScholes';

const mockGetHistoricalBars = vi.mocked(getHistoricalBars);

const STARTING_EQUITY = 100_000;
const RISK_FREE_RATE = 0.04; // must match combinedBacktest.ts's own constant

function d(base: string, offsetDays: number): string {
  const dt = new Date(`${base}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

const RELAXED = { filters: { minPrice: 0, minAvgVolume: 0, minRelVol: 0 } };

function equityBar(day: string, overrides: Partial<Omit<Candle, 'time'>> = {}): Candle {
  return {
    time: Date.parse(`${day}T00:00:00Z`),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 500_000,
    ...overrides,
  };
}

/** 60 flat warmup days ending the day before `signalDay`, then the signal
 *  day itself — same convention as backtestSimulate.test.ts/
 *  optionsBacktestSimulate.test.ts's own warmupThrough(). */
function warmupThrough(signalDay: string): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 1; i--) days.push(equityBar(d(signalDay, -i)));
  days.push(equityBar(signalDay));
  return days;
}

/** A steady 60-day trend ending the day before `signalDay`, then the signal
 *  day itself — same convention as backtestSimulate.test.ts's/
 *  optionsBacktestSimulate.test.ts's own trendThrough(), needed (unlike
 *  warmupThrough's flat series) to make scoreSymbolBothDirections()
 *  genuinely prefer one side over the other. */
function trendThrough(signalDay: string, dir: 'up' | 'down'): Candle[] {
  const step = dir === 'up' ? 0.5 : -0.5;
  let price = 100;
  const days: Candle[] = [];
  for (let i = 60; i >= 0; i--) {
    days.push(equityBar(d(signalDay, -i), { open: price, high: price + 1, low: price - 1, close: price }));
    if (i > 0) price += step;
  }
  return days;
}

function baseConfig(overrides: Partial<CombinedBacktestConfig> = {}): CombinedBacktestConfig {
  return {
    symbols: ['AAA', 'BBB'],
    from: '2024-03-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: STARTING_EQUITY,
    maxConcurrentPositions: 2,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

const CALL_TICKER = 'O:BBB-CALL';
/** Comfortably in the [0.30, 0.60] delta band and inside the [7,60] DTE
 *  window for a $100 underlying — same convention as
 *  optionsBacktestSimulate.test.ts. */
const DTE_DAYS = 30;
const TARGET_SIGMA = 0.3;
const STRIKE = 102;

function contractRef(
  ticker: string,
  strike: number,
  expiration: string,
  contractType: 'call' | 'put' = 'call',
  underlying = 'BBB',
): OptionContractRef {
  return { ticker, underlying, contractType, strike, expiration };
}

function optionBar(day: string, premium: number, overrides: Partial<Omit<Candle, 'time'>> = {}): Candle {
  return {
    time: Date.parse(`${day}T00:00:00Z`),
    open: premium,
    high: premium,
    low: premium,
    close: premium,
    volume: 500,
    ...overrides,
  };
}

function premiumFor(S: number, K: number, T: number, sigma = TARGET_SIGMA): number {
  return bsPrice({ type: 'call', S, K, T, r: RISK_FREE_RATE, sigma });
}

function premiumForSide(type: 'call' | 'put', S: number, K: number, T: number, sigma = TARGET_SIGMA): number {
  return bsPrice({ type, S, K, T, r: RISK_FREE_RATE, sigma });
}

function yearsFor(days: number): number {
  return days / 365;
}

beforeEach(() => {
  mockGetHistoricalBars.mockReset();
});

function mockContractBars(bySeries: Record<string, Candle[]>): void {
  mockGetHistoricalBars.mockImplementation(async (ticker: string) => bySeries[ticker] ?? []);
}

describe('simulateCombinedBacktest', () => {
  it('returns an empty report for empty history/contracts', async () => {
    const report = await simulateCombinedBacktest(new Map(), new Map(), baseConfig());
    expect(report.equityTrades).toEqual([]);
    expect(report.optionsTrades).toEqual([]);
    expect(report.finalEquity).toBe(STARTING_EQUITY);
  });

  it('opens and force-closes an equity-only position (no contract data at all) — the equity leg is unaffected by combining', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const historyBySymbol = new Map([['AAA', [...warmupThrough(signalDay), equityBar(entryDay)]]]);
    const report = await simulateCombinedBacktest(
      historyBySymbol,
      new Map(), // no contract data for ANY symbol
      baseConfig({ symbols: ['AAA'], from: signalDay, to: entryDay }),
    );
    expect(report.equityTrades).toHaveLength(1);
    expect(report.equityTrades[0].symbol).toBe('AAA');
    expect(report.equityTrades[0].entryDate).toBe(entryDay);
    expect(report.optionsTrades).toEqual([]);
  });

  it('force-closes an EQUITY leg position at the bar close once maxHoldDays elapses with neither stop nor target hit', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const day2 = d(signalDay, 2); // 1 calendar day since entry — not enough yet (maxHoldDays: 2)
    const day3 = d(signalDay, 3); // 2 calendar days since entry — triggers
    const historyBySymbol = new Map([
      [
        'AAA',
        [
          ...warmupThrough(signalDay),
          equityBar(entryDay),
          equityBar(day2, { open: 100, high: 101, low: 99, close: 100 }),
          equityBar(day3, { open: 100, high: 101, low: 99, close: 101 }),
        ],
      ],
    ]);
    const report = await simulateCombinedBacktest(
      historyBySymbol,
      new Map(),
      baseConfig({ symbols: ['AAA'], from: signalDay, to: day3, maxHoldDays: 2 }),
    );
    expect(report.equityTrades).toHaveLength(1);
    expect(report.equityTrades[0].exitReason).toBe('time_exit');
    expect(report.equityTrades[0].exitDate).toBe(day3);
    expect(report.equityTrades[0].exitPrice).toBe(101);
    expect(report.optionsTrades).toEqual([]);
  });

  it('moves the EQUITY leg stop to breakeven once the trigger R-multiple is reached, provable via a later stop-hit at the new level', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const day2 = d(signalDay, 2); // close 104 -> ~1.33R, past the 1R breakeven trigger
    const day3 = d(signalDay, 3); // low 99 -- would NOT hit the original stop (97) but WOULD hit a breakeven stop (100)
    const historyBySymbol = new Map([
      [
        'AAA',
        [
          ...warmupThrough(signalDay),
          equityBar(entryDay),
          equityBar(day2, { open: 101, high: 105, low: 100, close: 104 }),
          equityBar(day3, { open: 100, high: 101, low: 99, close: 99.5 }),
        ],
      ],
    ]);
    const report = await simulateCombinedBacktest(
      historyBySymbol,
      new Map(),
      baseConfig({ symbols: ['AAA'], from: signalDay, to: day3, breakevenTriggerRMultiple: 1 }),
    );
    expect(report.equityTrades).toHaveLength(1);
    expect(report.equityTrades[0].exitReason).toBe('stop');
    expect(report.equityTrades[0].exitPrice).toBe(100); // the RATCHETED (breakeven) stop, not the original 97
    expect(report.optionsTrades).toEqual([]);
  });

  it('opens and force-closes an options-only position — the options leg is unaffected by combining', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const signalDayPremium = premiumFor(100, STRIKE, T);
    const entryOpenPremium = signalDayPremium + 0.5;
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, signalDayPremium),
        optionBar(entryDay, entryOpenPremium, { open: entryOpenPremium }),
      ],
    });
    const historyBySymbol = new Map([['BBB', [...warmupThrough(signalDay), equityBar(entryDay)]]]);
    const contractsBySymbol = new Map([['BBB', [contractRef(CALL_TICKER, STRIKE, expiration)]]]);
    const report = await simulateCombinedBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ symbols: ['BBB'], from: signalDay, to: entryDay }),
    );
    expect(report.optionsTrades).toHaveLength(1);
    expect(report.optionsTrades[0].entryPremium).toBe(entryOpenPremium);
    // BBB's own equity signal ALSO fires (same warmup bars as AAA elsewhere) —
    // both instrument types on the same underlying are independent, not mutually
    // exclusive, matching the live system's own per-book "already open" checks.
    expect(report.equityTrades).toHaveLength(1);
    expect(report.equityTrades[0].symbol).toBe('BBB');
  });

  describe('CRITICAL: the combined aggregate-risk budget crosses instrument types', () => {
    // Generous on every other cap (via the riskCaps() overrides threaded into
    // baseConfig() at each call site below) so max_aggregate_open_risk is
    // unambiguously the one doing the blocking. maxConcurrentPositions is a
    // separate CombinedBacktestConfig field, set independently at each site.
    const riskCaps = {
      maxCorrelatedExposurePct: 100,
      maxDailyDrawdownPct: 100,
      maxTradesPerDay: 100,
      maxAggregateOpenRiskPct: 1.5, // one ~1%-risk position fits; two don't
    };

    it("an already-open EQUITY position's risk blocks a NEW options candidate once the combined total would exceed the cap", async () => {
      const day0 = '2024-03-01'; // AAA's equity signal day
      const day1 = d(day0, 1); // AAA's equity fill day
      const day2 = d(day0, 2); // BBB's options signal+fill day (AAA already open by then)
      const day3 = d(day0, 3); // one more day so BBB's fill (if wrongly approved) would show up

      // AAA: standard equity signal on day0, fills day1, stays open (far
      // stop/target so it never closes within this short window).
      const aaaHistory = [...warmupThrough(day0), equityBar(day1), equityBar(day2), equityBar(day3)];

      // BBB: its OPTIONS entry only becomes viable on day2 — no contract bar
      // exists for day0/day1 (skipped: "no historical price for the reference
      // contract"), so its options signal can't fire before AAA's equity
      // position is already open and consuming the shared budget. Its OWN
      // equity signal is left to fire/fill normally too (harmless — the point
      // under test is the OPTIONS side, not whether BBB's equity gets blocked
      // by the same tight cap).
      const expiration = d(day0, DTE_DAYS + 3);
      const T2 = yearsFor(DTE_DAYS + 1);
      const day2Premium = premiumFor(100, STRIKE, T2);
      const day3Premium = day2Premium; // stays open at period end either way
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(day2, day2Premium),
          optionBar(day3, day3Premium, { open: day2Premium }), // day2's signal fills at day3's open
        ],
      });
      const bbbHistory = [...warmupThrough(day0), equityBar(day1), equityBar(day2), equityBar(day3)];

      const historyBySymbol = new Map([
        ['AAA', aaaHistory],
        ['BBB', bbbHistory],
      ]);
      const contractsBySymbol = new Map([['BBB', [contractRef(CALL_TICKER, STRIKE, expiration)]]]);

      const report = await simulateCombinedBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ symbols: ['AAA', 'BBB'], from: day0, to: day3, maxConcurrentPositions: 100, ...riskCaps }),
      );

      // AAA's equity position opened successfully (it's the FIRST approval,
      // 0 + ~1% <= 1.5%).
      expect(report.equityTrades.some((t) => t.symbol === 'AAA')).toBe(true);
      // BBB's options candidate on day2 is blocked — AAA's already-open risk
      // (~1%) plus BBB's own options risk (~1%) would exceed the 1.5% cap.
      expect(report.optionsTrades).toEqual([]);
      const blocked = report.optionsSkipped.find((s) => s.symbol === 'BBB' && s.date === day2);
      expect(blocked?.reason).toMatch(/risk check blocked.*max_aggregate_open_risk/i);
    });

    it("an already-open OPTIONS position's risk blocks a NEW equity candidate once the combined total would exceed the cap", async () => {
      const day0 = '2024-03-01'; // BBB's options signal day
      const day1 = d(day0, 1); // BBB's options fill day
      const day2 = d(day0, 2); // AAA's equity signal+fill day (BBB's option already open by then)
      const day3 = d(day0, 3);

      const expiration = d(day0, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const day0Premium = premiumFor(100, STRIKE, T);
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(day0, day0Premium),
          optionBar(day1, day0Premium, { open: day0Premium }), // fills day1's open
          optionBar(day2, day0Premium),
          optionBar(day3, day0Premium),
        ],
      });
      // BBB: perfectly flat underlying bars (high=low=close) — ATR settles at
      // 0, so generateSignal() returns null (no EQUITY signal for BBB, unlike
      // the earlier test in this file where BBB fires both). Isolates the
      // scenario to "BBB's OWN options position vs. a DIFFERENT symbol's
      // equity candidate" — with normal (nonzero-ATR) bars, BBB's OWN equity
      // fill would ALSO compete for this same tight budget and mask what's
      // under test here. Options entry doesn't depend on ATR at all (only the
      // contract's own price/IV/delta), so this doesn't affect BBB's options side.
      const flatBar = (day: string): Candle => ({
        time: Date.parse(`${day}T00:00:00Z`),
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 500_000,
      });
      const bbbWarmup: Candle[] = [];
      for (let i = 60; i >= 1; i--) bbbWarmup.push(flatBar(d(day0, -i)));
      const bbbHistory = [...bbbWarmup, flatBar(day0), flatBar(day1), flatBar(day2), flatBar(day3)];

      // AAA: no equity-qualifying data until day2 — warmupThrough(day2)'s own
      // 60-day lookback would otherwise ALSO include day0/day1 (they're only
      // 2 days before day2), giving AAA a bar — and therefore a candidacy
      // attempt — on those days too. Explicitly drop day0/day1 so AAA has NO
      // bar (no candidate, per scoresToday's "needs a bar dated exactly
      // today" rule) until day2, by which time BBB's option is already open.
      const aaaHistory = [...warmupThrough(day2), equityBar(day3)].filter(
        (bar) => bar.time !== Date.parse(`${day0}T00:00:00Z`) && bar.time !== Date.parse(`${day1}T00:00:00Z`),
      );

      const historyBySymbol = new Map([
        ['BBB', bbbHistory],
        ['AAA', aaaHistory],
      ]);
      const contractsBySymbol = new Map([['BBB', [contractRef(CALL_TICKER, STRIKE, expiration)]]]);

      const report = await simulateCombinedBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ symbols: ['BBB', 'AAA'], from: day0, to: day3, maxConcurrentPositions: 100, ...riskCaps }),
      );

      expect(report.optionsTrades.some((t) => t.symbol === 'BBB')).toBe(true);
      // AAA's equity candidate on day2 is blocked — BBB's already-open
      // options risk (~1%) plus AAA's own equity risk (~1%) exceeds 1.5%.
      expect(report.equityTrades.some((t) => t.symbol === 'AAA')).toBe(false);
    });
  });

  it('reports ONE combined equity curve reflecting P&L from both books, not two separate series', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const exitDay = d(signalDay, 2);
    // AAA: a long that hits its target the day after entry.
    const aaaHistory = [
      ...warmupThrough(signalDay),
      equityBar(entryDay),
      equityBar(exitDay, { high: 200 }), // comfortably clears any plausible target
    ];
    const historyBySymbol = new Map([['AAA', aaaHistory]]);
    const report = await simulateCombinedBacktest(
      historyBySymbol,
      new Map(),
      baseConfig({ symbols: ['AAA'], from: signalDay, to: exitDay }),
    );
    expect(report.equityTrades).toHaveLength(1);
    expect(report.equityTrades[0].exitReason).toBe('target');
    expect(report.equityTrades[0].pnl).toBeGreaterThan(0);
    // One equity-curve point per simulated day, ending at finalEquity.
    expect(report.equityCurve).toHaveLength(3); // signalDay, entryDay, exitDay
    expect(report.equityCurve[report.equityCurve.length - 1].equity).toBe(report.finalEquity);
    expect(report.finalEquity).toBeGreaterThan(report.startingEquity);
  });

  describe('debit spreads (Task #69) — the shared optionsBacktest.ts helpers wired into the combined engine', () => {
    // K=102 -> delta ~0.44 (long leg's [0.30,0.60] band); K=107 -> delta
    // ~0.24 (SHORT_LEG_DELTA_BAND's [0.15,0.25]) at S=100, sigma=0.3, 30d DTE
    // — same values already confirmed numerically in optionsBacktestSimulate.test.ts.
    const LONG_STRIKE = 102;
    const SHORT_STRIKE = 107;
    const LONG_TICKER = 'O:BBB-LONG';
    const SHORT_TICKER = 'O:BBB-SHORT';

    /** Perfectly flat underlying bars so BBB's OWN equity signal never fires
     *  (see the "already-open OPTIONS position" test above for the same
     *  isolation trick) — isolates this test to the options side alone. */
    function flatBar(day: string): Candle {
      return { time: Date.parse(`${day}T00:00:00Z`), open: 100, high: 100, low: 100, close: 100, volume: 500_000 };
    }
    function flatHistory(signalDay: string, extraDays: string[]): Candle[] {
      const days: Candle[] = [];
      for (let i = 60; i >= 1; i--) days.push(flatBar(d(signalDay, -i)));
      days.push(flatBar(signalDay), ...extraDays.map(flatBar));
      return days;
    }

    it('opens a debit spread through the combined engine, netting both legs at fill', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longEntry = premiumFor(100, LONG_STRIKE, T);
      const shortEntry = premiumFor(100, SHORT_STRIKE, T);
      mockContractBars({
        [LONG_TICKER]: [optionBar(signalDay, longEntry), optionBar(entryDay, longEntry, { open: longEntry })],
        [SHORT_TICKER]: [optionBar(signalDay, shortEntry), optionBar(entryDay, shortEntry, { open: shortEntry })],
      });
      const historyBySymbol = new Map([['BBB', flatHistory(signalDay, [entryDay])]]);
      const contractsBySymbol = new Map([
        [
          'BBB',
          [contractRef(LONG_TICKER, LONG_STRIKE, expiration), contractRef(SHORT_TICKER, SHORT_STRIKE, expiration)],
        ],
      ]);

      const report = await simulateCombinedBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({
          symbols: ['BBB'],
          from: signalDay,
          to: entryDay,
          optionsDecisionConfig: { strategyType: 'debit_spread' },
        }),
      );
      expect(report.equityTrades).toEqual([]); // flat bars -> no equity signal for BBB
      expect(report.optionsTrades).toHaveLength(1);
      const t = report.optionsTrades[0];
      expect(t.kind).toBe('debit_spread');
      expect(t.contractTicker).toBe(LONG_TICKER);
      expect(t.strike).toBe(LONG_STRIKE);
      expect(t.shortContractTicker).toBe(SHORT_TICKER);
      expect(t.shortStrike).toBe(SHORT_STRIKE);
      expect(t.entryPremium).toBe(longEntry);
      expect(t.shortEntryPremium).toBe(shortEntry);
      // Force-closed at period end (entryDay is also the last day) at the
      // SAME premiums it entered at -> net value unchanged -> zero P&L.
      expect(t.pnl).toBeCloseTo(0, 5);
    });

    it("a debit spread's net-debit riskAmount feeds the SAME shared ledger equity positions use", async () => {
      // Generous on every other cap (via baseConfig's overrides below) so
      // max_aggregate_open_risk is unambiguously the one doing the blocking
      // (same convention as the "CRITICAL" describe block above).
      const day0 = '2024-03-01';
      const day1 = d(day0, 1);
      // AAA: an ordinary equity long already at ~1% of equity risk.
      const aaaHistory = [...warmupThrough(day0), equityBar(day1)];
      // BBB: flat (isolates to its options side only), same day as AAA.
      const bbbHistory = flatHistory(day0, [day1]);
      const historyBySymbol = new Map([
        ['AAA', aaaHistory],
        ['BBB', bbbHistory],
      ]);
      const expiration = d(day0, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      // Natural, self-consistent BS pricing for both legs (same sigma
      // already confirmed to land each leg's delta in its own band, see
      // optionsBacktestSimulate.test.ts) sizes to several contracts at
      // ~$913 total risk — stacked on AAA's already-open ~1%/$1000 equity
      // risk, the running total exceeds the 1.5%/$1500 cap, proving the
      // spread's riskAmount (net debit x contracts x 100), not some other
      // figure, is what the shared ledger actually sees.
      const longEntry = premiumFor(100, LONG_STRIKE, T);
      const shortEntry = premiumFor(100, SHORT_STRIKE, T);
      mockContractBars({
        [LONG_TICKER]: [optionBar(day0, longEntry), optionBar(day1, longEntry, { open: longEntry })],
        [SHORT_TICKER]: [optionBar(day0, shortEntry), optionBar(day1, shortEntry, { open: shortEntry })],
      });
      const contractsBySymbol = new Map([
        [
          'BBB',
          [contractRef(LONG_TICKER, LONG_STRIKE, expiration), contractRef(SHORT_TICKER, SHORT_STRIKE, expiration)],
        ],
      ]);

      const report = await simulateCombinedBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({
          symbols: ['AAA', 'BBB'],
          from: day0,
          to: day1,
          maxConcurrentPositions: 100,
          maxCorrelatedExposurePct: 100,
          maxDailyDrawdownPct: 100,
          maxTradesPerDay: 100,
          maxAggregateOpenRiskPct: 1.5,
          optionsDecisionConfig: { strategyType: 'debit_spread' },
        }),
      );
      expect(report.equityTrades.some((t) => t.symbol === 'AAA')).toBe(true); // AAA's own ~1% fits alone
      expect(report.optionsTrades).toEqual([]); // BBB's spread risk on top of AAA's exceeds the 1.5% cap
      expect(report.optionsSkipped.some((s) => s.symbol === 'BBB' && s.reason.includes('Risk check blocked'))).toBe(
        true,
      );
    });
  });

  describe('directionMode', () => {
    it("'both' produces a BUY equity signal + CALL options signal on an uptrending underlying, and a SELL equity signal + PUT options signal on a downtrending one — sharing ONE combined run", async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const UP_TICKER = 'O:UP-CALL';
      const DOWN_TICKER = 'O:DOWN-PUT';
      // Must match trendThrough's own signal-day close exactly (100 +/- 60 *
      // 0.5) — the candidate is scored (and its underlyingClose captured) on
      // signalDay itself, not on the later entryDay fill.
      const upSpot = 130;
      const upStrike = 132;
      const downSpot = 70;
      const downStrike = 68;
      const upPremium = premiumForSide('call', upSpot, upStrike, T);
      const downPremium = premiumForSide('put', downSpot, downStrike, T);
      mockContractBars({
        [UP_TICKER]: [optionBar(signalDay, upPremium), optionBar(entryDay, upPremium, { open: upPremium })],
        [DOWN_TICKER]: [optionBar(signalDay, downPremium), optionBar(entryDay, downPremium, { open: downPremium })],
      });
      const historyBySymbol = new Map([
        ['UP', [...trendThrough(signalDay, 'up'), equityBar(entryDay)]],
        ['DOWN', [...trendThrough(signalDay, 'down'), equityBar(entryDay)]],
      ]);
      const contractsBySymbol = new Map([
        ['UP', [contractRef(UP_TICKER, upStrike, expiration, 'call', 'UP')]],
        ['DOWN', [contractRef(DOWN_TICKER, downStrike, expiration, 'put', 'DOWN')]],
      ]);

      const report = await simulateCombinedBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({
          symbols: ['UP', 'DOWN'],
          from: signalDay,
          to: entryDay,
          directionMode: 'both',
          maxConcurrentPositions: 10,
          maxCorrelatedExposurePct: 100,
          maxDailyDrawdownPct: 100,
          maxTradesPerDay: 100,
          maxAggregateOpenRiskPct: 100,
          // A real (non-flat) trend has genuine realized volatility, unlike
          // warmupThrough's deliberately zero-variance series — irrelevant
          // to what this test is proving (per-candidate side selection for
          // BOTH legs), so the ceiling is relaxed here only.
          optionsDecisionConfig: { entryConfig: { ivRankMax: 100 } },
        }),
      );

      expect(report.equityTrades).toHaveLength(2);
      const upEquity = report.equityTrades.find((t) => t.symbol === 'UP')!;
      const downEquity = report.equityTrades.find((t) => t.symbol === 'DOWN')!;
      expect(upEquity.side).toBe('buy');
      expect(downEquity.side).toBe('sell');

      expect(report.optionsTrades).toHaveLength(2);
      const upOption = report.optionsTrades.find((t) => t.symbol === 'UP')!;
      const downOption = report.optionsTrades.find((t) => t.symbol === 'DOWN')!;
      expect(upOption.side).toBe('call');
      expect(downOption.side).toBe('put');
    });
  });
});

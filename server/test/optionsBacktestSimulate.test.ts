import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/autotrading/historicalData', () => ({ getHistoricalBars: vi.fn() }));

import { getHistoricalBars } from '../src/services/autotrading/historicalData';
import { simulateOptionsBacktest, OptionsBacktestConfig } from '../src/services/autotrading/optionsBacktest';
import { OptionContractRef } from '../src/services/autotrading/polygonOptionsClient';
import { Candle } from '../src/providers/types';
import { bsPrice } from '../src/options/blackScholes';

const mockGetHistoricalBars = vi.mocked(getHistoricalBars);

const STARTING_EQUITY = 100_000;
const RISK_FREE_RATE = 0.04; // must match optionsBacktest.ts's own constant

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
 *  day itself — same convention as backtestSimulate.test.ts's own
 *  warmupThrough(), so scoreSymbol() passes under RELAXED filters and
 *  computeIvContext()'s hv-estimate fallback sees a zero-variance (rank 50)
 *  underlying by default. */
function warmupThrough(signalDay: string): Candle[] {
  const days: Candle[] = [];
  for (let i = 60; i >= 1; i--) days.push(equityBar(d(signalDay, -i)));
  days.push(equityBar(signalDay));
  return days;
}

/** A steady 60-day trend ending the day before `signalDay`, then the signal
 *  day itself — same convention as backtestSimulate.test.ts's own
 *  trendThrough(), needed (unlike warmupThrough's flat series) to make
 *  scoreSymbolBothDirections() genuinely prefer one side over the other. */
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

function baseConfig(overrides: Partial<OptionsBacktestConfig> = {}): OptionsBacktestConfig {
  return {
    symbols: ['TEST'],
    from: '2024-03-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: STARTING_EQUITY,
    maxConcurrentPositions: 2,
    screenerConfig: RELAXED,
    ...overrides,
  };
}

const CALL_TICKER = 'O:TEST-CALL';
const PUT_TICKER = 'O:TEST-PUT';
/** Comfortably in the [0.30, 0.60] delta band and inside the [7,60] DTE
 *  window (30 days) for a $100 underlying — same S/T/sigma feed both the
 *  fixture's price AND the assertions, so this stays self-consistent
 *  without needing to hand-verify Black-Scholes numbers. */
const DTE_DAYS = 30;
const TARGET_SIGMA = 0.3;
const STRIKE = 102;

function contractRef(
  ticker: string,
  contractType: 'call' | 'put',
  strike: number,
  expiration: string,
  underlying = 'TEST',
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

/** Premium that recovers ~TARGET_SIGMA via impliedVol() when S/K/T/r match. */
function premiumFor(type: 'call' | 'put', S: number, K: number, T: number, sigma = TARGET_SIGMA): number {
  return bsPrice({ type, S, K, T, r: RISK_FREE_RATE, sigma });
}

function yearsFor(days: number): number {
  return days / 365;
}

beforeEach(() => {
  mockGetHistoricalBars.mockReset();
});

/** Wires the mock to serve per-ticker bar series from `bySeries` for any
 *  requested range (this simulator always requests the same wide, padded
 *  range regardless of what's actually needed day to day). */
function mockContractBars(bySeries: Record<string, Candle[]>): void {
  mockGetHistoricalBars.mockImplementation(async (ticker: string) => bySeries[ticker] ?? []);
}

describe('simulateOptionsBacktest', () => {
  it('returns an empty report for empty history/contracts', async () => {
    const report = await simulateOptionsBacktest(new Map(), new Map(), baseConfig());
    expect(report.trades).toEqual([]);
    expect(report.finalEquity).toBe(STARTING_EQUITY);
  });

  it("enters at the NEXT day's contract OPEN, not the signal day's price (no lookahead)", async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const signalDayPremium = premiumFor('call', 100, STRIKE, T);
    const entryOpenPremium = signalDayPremium + 0.5; // distinct value, so we can prove entryPremium != signal-day price
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, signalDayPremium),
        optionBar(entryDay, entryOpenPremium, { open: entryOpenPremium }),
      ],
    });
    const historyBySymbol = new Map([['TEST', [...warmupThrough(signalDay), equityBar(entryDay)]]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay }),
    );
    expect(report.trades).toHaveLength(1); // force-closed at entryDay's own close (also the last day)
    expect(report.trades[0].entryDate).toBe(entryDay);
    expect(report.trades[0].entryPremium).toBe(entryOpenPremium);
    expect(report.trades[0].signalDate).toBe(signalDay);
    expect(report.trades[0].side).toBe('call');
  });

  it("exits via the time-exit trigger once DTE drops to the configured threshold, at that day's CLOSE", async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    // Expiration close enough that DTE crosses the default 7-day time-exit
    // threshold a few days after entry. daysToExpiration is FRACTIONAL
    // (anchored at expiration's own T20:00:00Z, per blackScholes.ts) — DTE
    // from day+3 (2024-03-04) is 7.83 (not yet <= 7), from day+4
    // (2024-03-05) it's 6.83 (first day <= 7) — the trigger fires there,
    // not on a naive integer-day expectation.
    const expiration = d(signalDay, 10);
    const T = yearsFor(10);
    const entryPremium = premiumFor('call', 100, STRIKE, T);
    const exitDay = d(signalDay, 4);
    const exitPremium = entryPremium + 1;
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, entryPremium),
        optionBar(entryDay, entryPremium, { open: entryPremium }),
        optionBar(d(signalDay, 2), entryPremium),
        optionBar(d(signalDay, 3), entryPremium),
        optionBar(exitDay, exitPremium),
      ],
    });
    const historyBySymbol = new Map([
      [
        'TEST',
        [
          ...warmupThrough(signalDay),
          equityBar(entryDay),
          equityBar(d(signalDay, 2)),
          equityBar(d(signalDay, 3)),
          equityBar(exitDay),
        ],
      ],
    ]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: exitDay }),
    );
    expect(report.trades).toHaveLength(1);
    const t = report.trades[0];
    expect(t.exitReason).toBe('time_exit');
    expect(t.exitDate).toBe(exitDay);
    expect(t.exitPremium).toBe(exitPremium);
    expect(t.pnl).toBeCloseTo((exitPremium - entryPremium) * t.contracts * 100, 5);
  });

  describe('stop-loss / take-profit (2026-07-16)', () => {
    it('closes via stop-loss once unrealized loss reaches the configured %, well before the time-exit window', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45); // far out -- time-exit can't fire
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const exitDay = d(signalDay, 2); // first day eligible (not the entry day itself)
      const exitPremium = entryPremium * 0.4; // -60%, past a -50% stop
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(exitDay, exitPremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(exitDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: exitDay, optionsStopLossPct: 50 }),
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('stop_loss');
      expect(report.trades[0].exitDate).toBe(exitDay);
    });

    it('closes via take-profit once unrealized gain reaches the configured %, well before the time-exit window', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const exitDay = d(signalDay, 2);
      const exitPremium = entryPremium * 1.6; // +60%, past a +50% target
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(exitDay, exitPremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(exitDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: exitDay, optionsTakeProfitPct: 50 }),
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('take_profit');
    });

    it('leaves 0/omitted stop-loss and take-profit fully disabled — same trades as before this feature existed', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(45);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const exitDay = d(signalDay, 2);
      const exitPremium = entryPremium * 0.4; // a -60% move that WOULD trigger a stop if one were configured
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(exitDay, exitPremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(exitDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: exitDay }), // no optionsStopLossPct/optionsTakeProfitPct
      );
      // Still force-closes at period end (exitDay is the last simulated day)
      // -- the point is that neither price rule fired despite the big move,
      // matching pre-feature behavior exactly (only 'end_of_period' could
      // have closed it, not 'stop_loss').
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('end_of_period');
    });

    it('treats an EXPLICIT 0 the same as omitted, not a 0%-loss/gain threshold that fires immediately', async () => {
      // A route handler passes `optionsStopLossPct: body.optionsStopLossPct`
      // through verbatim (routes/autotrade.ts), so a client explicitly
      // sending 0 is a real, reachable input -- not just "field absent".
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(45);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const exitDay = d(signalDay, 2);
      const exitPremium = entryPremium * 0.4; // a -60% move that WOULD trigger a stop if 0 meant "any loss"
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(exitDay, exitPremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(exitDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: exitDay, optionsStopLossPct: 0, optionsTakeProfitPct: 0 }),
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('end_of_period');
    });
  });

  describe('trailing stop / breakeven / partial profit-taking (2026-07-17)', () => {
    it('ratchets the floor to breakeven, then closes on a later pullback below it', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45); // far out -- time-exit can't fire
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const ratchetDay = d(signalDay, 2); // first eligible day -- gain past the breakeven trigger
      const ratchetPremium = entryPremium * 1.3; // +30%, past a 20% breakeven trigger
      const closeDay = d(signalDay, 3); // pulls back below the now-ratcheted 0% floor
      const closePremium = entryPremium * 0.95; // -5%
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(ratchetDay, ratchetPremium),
          optionBar(closeDay, closePremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(ratchetDay), equityBar(closeDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: closeDay, optionsBreakevenTriggerPct: 20 }),
      );
      expect(report.trades).toHaveLength(1);
      // Closed at the ratcheted 0% floor (a -5% move), not end_of_period --
      // proves the breakeven ratchet from ratchetDay carried into closeDay's check.
      expect(report.trades[0].exitReason).toBe('stop_loss');
      expect(report.trades[0].exitDate).toBe(closeDay);
    });

    it('trails the floor behind the best gain seen, then closes once price gives back too much', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const peakDay = d(signalDay, 2);
      const peakPremium = entryPremium * 1.3; // +30% -- past the 20% trailing-start trigger; floor becomes 30-10=20%
      const closeDay = d(signalDay, 3);
      const closePremium = entryPremium * 1.1; // +10%, below the ratcheted 20% floor
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(peakDay, peakPremium),
          optionBar(closeDay, closePremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(peakDay), equityBar(closeDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: closeDay, optionsTrailStartPct: 20, optionsTrailStopPct: 10 }),
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('stop_loss');
      expect(report.trades[0].exitDate).toBe(closeDay);
    });

    it('records a partial-exit trade once the trigger % is reached, and the remainder keeps running', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const partialDay = d(signalDay, 2);
      const partialPremium = entryPremium * 1.3; // +30%, past a 20% partial-exit trigger
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(partialDay, partialPremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(partialDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      // A larger account pushes risk-based sizing well past 1 contract, so
      // the 50%-of-position partial-exit has something to actually close
      // (floor(1 * 0.5) would otherwise round to 0 and silently no-op).
      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({
          from: signalDay,
          to: partialDay,
          startingEquity: 1_000_000,
          optionsPartialExitTriggerPct: 20,
          optionsPartialExitPct: 50,
        }),
      );
      const partial = report.trades.find((t) => t.exitReason === 'partial_exit');
      expect(partial).toBeDefined();
      expect(partial!.exitDate).toBe(partialDay);
      expect(partial!.contracts).toBeGreaterThan(0);
      expect(partial!.pnl).toBeGreaterThan(0); // premium rose
      // The remainder force-closes at period end (partialDay is also the last
      // simulated day). closeQty = floor(original * 0.5), so for a 50% split
      // the closed slice can never exceed what's left running.
      const remainder = report.trades.find((t) => t.exitReason === 'end_of_period');
      expect(remainder).toBeDefined();
      expect(remainder!.contracts).toBeGreaterThan(0);
      expect(partial!.contracts).toBeLessThanOrEqual(remainder!.contracts);
    });

    it('leaves 0/omitted trailing fields fully disabled -- same trades as before this feature existed', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 45);
      const T = yearsFor(60);
      const entryPremium = premiumFor('call', 100, STRIKE, T);
      const closeDay = d(signalDay, 2);
      const closePremium = entryPremium * 1.3; // +30% -- would ratchet/close under any of the new fields if configured
      mockContractBars({
        [CALL_TICKER]: [
          optionBar(signalDay, entryPremium),
          optionBar(entryDay, entryPremium, { open: entryPremium }),
          optionBar(closeDay, closePremium),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(closeDay)]],
      ]);
      const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        baseConfig({ from: signalDay, to: closeDay }), // no trailing fields at all
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('end_of_period');
    });
  });

  it('does not immediately re-exit a position on its own entry day, even if DTE is already at the exit threshold', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    // Expiration exactly 7 days after ENTRY day -> DTE on entryDay itself is
    // already <= the default 7-day time-exit threshold. Must NOT exit same-day.
    const expiration = d(entryDay, 7);
    const T = yearsFor(8); // as of signalDay
    const premium = premiumFor('call', 100, STRIKE, T);
    const nextDay = d(entryDay, 1);
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, premium),
        optionBar(entryDay, premium, { open: premium }),
        optionBar(nextDay, premium + 2), // if wrongly exited on entryDay, this bar is never reached
      ],
    });
    const historyBySymbol = new Map([['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(nextDay)]]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: nextDay }),
    );
    expect(report.trades).toHaveLength(1);
    // If it had wrongly exited same-day as entry, exitDate would equal entryDate.
    expect(report.trades[0].exitDate).not.toBe(report.trades[0].entryDate);
  });

  it('force-closes at the last available contract close at period end', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const lastDay = d(signalDay, 2);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const entryPremium = premiumFor('call', 100, STRIKE, T);
    const lastPremium = entryPremium + 3;
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, entryPremium),
        optionBar(entryDay, entryPremium, { open: entryPremium }),
        optionBar(lastDay, lastPremium),
      ],
    });
    const historyBySymbol = new Map([['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(lastDay)]]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: lastDay }),
    );
    expect(report.trades).toHaveLength(1);
    const t = report.trades[0];
    expect(t.exitReason).toBe('end_of_period');
    expect(t.exitDate).toBe(lastDay);
    expect(t.exitPremium).toBe(lastPremium);
  });

  it('does not open a second options position while one is already open in the same underlying', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const nextDay = d(signalDay, 2);
    const thirdDay = d(signalDay, 3);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const premium = premiumFor('call', 100, STRIKE, T);
    mockContractBars({
      [CALL_TICKER]: [
        optionBar(signalDay, premium),
        optionBar(entryDay, premium, { open: premium }),
        optionBar(nextDay, premium),
        optionBar(thirdDay, premium),
      ],
    });
    const historyBySymbol = new Map([
      ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(nextDay), equityBar(thirdDay)]],
    ]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: thirdDay }),
    );
    expect(report.trades).toHaveLength(1); // never a second, concurrent position
  });

  it('skips a candidate with no contract inside the confirmed DTE window', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const tooSoonExpiration = d(signalDay, 3); // < minDaysToExpiration (7)
    const historyBySymbol = new Map([['TEST', warmupThrough(signalDay)]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, tooSoonExpiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay }),
    );
    expect(report.trades).toEqual([]);
    expect(report.skipped.some((s) => s.reason.includes('DTE window'))).toBe(true);
  });

  it('skips a candidate whose reference contract volume is below minVolume', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const premium = premiumFor('call', 100, STRIKE, T);
    mockContractBars({ [CALL_TICKER]: [optionBar(signalDay, premium, { volume: 1 })] }); // minVolume default is 10
    const historyBySymbol = new Map([['TEST', warmupThrough(signalDay)]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay }),
    );
    expect(report.trades).toEqual([]);
    expect(report.skipped.some((s) => s.reason.includes('Volume'))).toBe(true);
  });

  it('skips a candidate whose derived delta falls outside the [0.30, 0.60] band', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    // Deep OTM strike -> delta well below 0.30.
    const deepOtmStrike = 200;
    const premium = premiumFor('call', 100, deepOtmStrike, T);
    mockContractBars({ [CALL_TICKER]: [optionBar(signalDay, premium)] });
    const historyBySymbol = new Map([['TEST', warmupThrough(signalDay)]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', deepOtmStrike, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay }),
    );
    expect(report.trades).toEqual([]);
    expect(report.skipped.some((s) => s.reason.includes('delta'))).toBe(true);
  });

  it('skips a candidate whose IV rank is above the confirmed ivRankMax: 70 (hv-estimate fallback)', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    // computeIvContext()'s hv-estimate fallback needs a REAL (non-degenerate)
    // realized-vol range to rank against — a perfectly flat close series (like
    // warmupThrough()'s own fixture) has zero variance in every rolling
    // window, which rankFrom() special-cases to an unconditional rank of 50
    // regardless of the target sigma. This series has small noise in its
    // first ~30 days and much larger noise in the last ~30, so different
    // 20-day rolling windows produce genuinely different realized vol.
    const closes: number[] = [];
    for (let i = 60; i >= 0; i--) {
      const amplitude = i > 30 ? 0.05 : 0.5;
      closes.push(100 + (i % 2 === 0 ? 1 : -1) * amplitude);
    }
    const underlyingCandles: Candle[] = closes.map((close, idx) => {
      const day = d(signalDay, -(60 - idx));
      return {
        time: Date.parse(`${day}T00:00:00Z`),
        open: close,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 500_000,
      };
    });
    const lastClose = closes[closes.length - 1]; // 100.5 — the candidate's own underlyingClose
    // A LARGE target sigma relative to that derived hv range clamps the rank to 100, above 70.
    const highSigma = 0.9;
    const premium = premiumFor('call', lastClose, STRIKE, T, highSigma);
    mockContractBars({ [CALL_TICKER]: [optionBar(signalDay, premium)] });
    const historyBySymbol = new Map([['TEST', underlyingCandles]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay }),
    );
    expect(report.trades).toEqual([]);
    expect(report.skipped.some((s) => s.reason.includes('IV rank'))).toBe(true);
  });

  it('selects a PUT reference contract when direction is short', async () => {
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const putStrike = 98; // OTM put, delta magnitude in range
    const premium = premiumFor('put', 100, putStrike, T);
    mockContractBars({
      [PUT_TICKER]: [optionBar(signalDay, premium), optionBar(entryDay, premium, { open: premium })],
    });
    const historyBySymbol = new Map([['TEST', [...warmupThrough(signalDay), equityBar(entryDay)]]]);
    const contractsBySymbol = new Map([['TEST', [contractRef(PUT_TICKER, 'put', putStrike, expiration)]]]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({ from: signalDay, to: entryDay, directionMode: 'short' }),
    );
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0].side).toBe('put');
    expect(report.trades[0].contractTicker).toBe(PUT_TICKER);
  });

  it("directionMode:'both' produces a CALL on an uptrending underlying and a PUT on a downtrending one in the SAME run", async () => {
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
    const upPremium = premiumFor('call', upSpot, upStrike, T);
    const downPremium = premiumFor('put', downSpot, downStrike, T);
    mockContractBars({
      [UP_TICKER]: [optionBar(signalDay, upPremium), optionBar(entryDay, upPremium, { open: upPremium })],
      [DOWN_TICKER]: [optionBar(signalDay, downPremium), optionBar(entryDay, downPremium, { open: downPremium })],
    });
    const historyBySymbol = new Map([
      ['UP', [...trendThrough(signalDay, 'up'), equityBar(entryDay)]],
      ['DOWN', [...trendThrough(signalDay, 'down'), equityBar(entryDay)]],
    ]);
    const contractsBySymbol = new Map([
      ['UP', [contractRef(UP_TICKER, 'call', upStrike, expiration, 'UP')]],
      ['DOWN', [contractRef(DOWN_TICKER, 'put', downStrike, expiration, 'DOWN')]],
    ]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({
        symbols: ['UP', 'DOWN'],
        from: signalDay,
        to: entryDay,
        directionMode: 'both',
        // A real (non-flat) trend has genuine realized volatility, unlike
        // warmupThrough's deliberately zero-variance series (rank 50 "by
        // convention") — irrelevant to what this test is proving (per-
        // candidate side selection), so the ceiling is relaxed here only.
        optionsDecisionConfig: { entryConfig: { ivRankMax: 100 } },
      }),
    );
    expect(report.trades).toHaveLength(2);
    const up = report.trades.find((t) => t.symbol === 'UP')!;
    const down = report.trades.find((t) => t.symbol === 'DOWN')!;
    expect(up.side).toBe('call');
    expect(down.side).toBe('put');
  });

  it('accumulates risk sequentially across a same-day batch — a later candidate can be blocked by earlier same-day approvals', async () => {
    // Each position's OWN risk is capped at riskPerTradePct (1%) of equity by
    // construction (computeRiskSizing floors contracts to stay within that
    // budget), so two such positions can at most sum to exactly 2x that
    // per-trade cap — never strictly over it. Proving the running total
    // actually blocks something therefore needs a THIRD candidate (mirrors
    // backtest.ts's own equivalent test for the exact same reason) — with
    // the aggregate cap narrowed (via baseConfig below) so the arithmetic
    // lands cleanly without depending on hand-tuning the premium to hit a
    // precise number.
    const signalDay = '2024-03-01';
    const entryDay = d(signalDay, 1);
    const expiration = d(signalDay, DTE_DAYS);
    const T = yearsFor(DTE_DAYS);
    const premium = premiumFor('call', 100, STRIKE, T, 0.6); // ~$611/contract risk at 1% of $100k
    mockContractBars({
      [CALL_TICKER]: [optionBar(signalDay, premium), optionBar(entryDay, premium, { open: premium })],
    });
    const historyBySymbol = new Map([
      ['AAA', [...warmupThrough(signalDay), equityBar(entryDay)]],
      ['MMM', [...warmupThrough(signalDay), equityBar(entryDay)]],
      ['ZZZ', [...warmupThrough(signalDay), equityBar(entryDay)]],
    ]);
    const contractsBySymbol = new Map([
      ['AAA', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]],
      ['MMM', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]],
      ['ZZZ', [contractRef(CALL_TICKER, 'call', STRIKE, expiration)]],
    ]);

    const report = await simulateOptionsBacktest(
      historyBySymbol,
      contractsBySymbol,
      baseConfig({
        symbols: ['AAA', 'MMM', 'ZZZ'],
        from: signalDay,
        to: entryDay,
        maxAggregateOpenRiskPct: 1.5, // $1500 cap
      }),
    );
    // AAA and MMM (tied score, alphabetical) each pass on their own 1%
    // budget (~$611, running 611 then 1222 <= $1500 cap); ZZZ's identical
    // ~$611 risk on top of the running 1222 (-> 1833) exceeds the $1500
    // cap — proving the running total, not a stale per-candidate snapshot,
    // is what the THIRD candidate in the batch actually sees.
    expect(report.trades.map((t) => t.symbol)).toEqual(['AAA', 'MMM']);
    expect(report.skipped.some((s) => s.symbol === 'ZZZ' && s.reason.includes('Risk check blocked'))).toBe(true);
  });

  describe('debit spreads', () => {
    // K=102 -> delta ~0.44 (inside the long leg's [0.30,0.60] band); K=107 ->
    // delta ~0.24 (inside SHORT_LEG_DELTA_BAND's [0.15,0.25]) at S=100,
    // sigma=0.3, T=30d — confirmed numerically via bsGreeks() directly.
    const LONG_STRIKE = 102;
    const SHORT_STRIKE = 107;
    const LONG_TICKER = 'O:TEST-LONG';
    const SHORT_TICKER = 'O:TEST-SHORT';

    function spreadConfig(overrides: Partial<OptionsBacktestConfig> = {}): OptionsBacktestConfig {
      return baseConfig({ optionsDecisionConfig: { strategyType: 'debit_spread' }, ...overrides });
    }

    it("opens both legs at the NEXT day's own OPEN, sized by suggestedContracts", async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longSignalPremium = premiumFor('call', 100, LONG_STRIKE, T);
      const shortSignalPremium = premiumFor('call', 100, SHORT_STRIKE, T);
      const longEntryOpen = longSignalPremium + 0.3;
      const shortEntryOpen = shortSignalPremium + 0.1;
      mockContractBars({
        [LONG_TICKER]: [
          optionBar(signalDay, longSignalPremium),
          optionBar(entryDay, longEntryOpen, { open: longEntryOpen }),
        ],
        [SHORT_TICKER]: [
          optionBar(signalDay, shortSignalPremium),
          optionBar(entryDay, shortEntryOpen, { open: shortEntryOpen }),
        ],
      });
      const historyBySymbol = new Map([['TEST', [...warmupThrough(signalDay), equityBar(entryDay)]]]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', SHORT_STRIKE, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: entryDay }),
      );
      expect(report.trades).toHaveLength(1); // force-closed at entryDay (also the last day)
      const t = report.trades[0];
      expect(t.kind).toBe('debit_spread');
      expect(t.contractTicker).toBe(LONG_TICKER);
      expect(t.strike).toBe(LONG_STRIKE);
      expect(t.shortContractTicker).toBe(SHORT_TICKER);
      expect(t.shortStrike).toBe(SHORT_STRIKE);
      expect(t.entryPremium).toBe(longEntryOpen);
      expect(t.shortEntryPremium).toBe(shortEntryOpen);
      expect(t.contracts).toBeGreaterThan(0);
    });

    it('nets both legs for P&L at the time-exit trigger: (netCreditAtExit - netDebitAtEntry) x contracts x 100', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, 10);
      const T = yearsFor(10);
      // A shorter DTE than the main SHORT_STRIKE (107) was calibrated for —
      // at only 10 days out, delta decays faster with distance, so K=104
      // (not 107) is what lands in SHORT_LEG_DELTA_BAND's [0.15,0.25] here
      // (confirmed numerically via bsGreeks at T=10/365).
      const shortStrike10d = 104;
      const longEntry = premiumFor('call', 100, LONG_STRIKE, T);
      const shortEntry = premiumFor('call', 100, shortStrike10d, T);
      const exitDay = d(signalDay, 4); // same DTE-crossing day as the single-leg time-exit test above
      const longExit = longEntry + 2;
      const shortExit = shortEntry + 0.5;
      mockContractBars({
        [LONG_TICKER]: [
          optionBar(signalDay, longEntry),
          optionBar(entryDay, longEntry, { open: longEntry }),
          optionBar(d(signalDay, 2), longEntry),
          optionBar(d(signalDay, 3), longEntry),
          optionBar(exitDay, longExit),
        ],
        [SHORT_TICKER]: [
          optionBar(signalDay, shortEntry),
          optionBar(entryDay, shortEntry, { open: shortEntry }),
          optionBar(d(signalDay, 2), shortEntry),
          optionBar(d(signalDay, 3), shortEntry),
          optionBar(exitDay, shortExit),
        ],
      });
      const historyBySymbol = new Map([
        [
          'TEST',
          [
            ...warmupThrough(signalDay),
            equityBar(entryDay),
            equityBar(d(signalDay, 2)),
            equityBar(d(signalDay, 3)),
            equityBar(exitDay),
          ],
        ],
      ]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', shortStrike10d, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: exitDay }),
      );
      expect(report.trades).toHaveLength(1);
      const t = report.trades[0];
      expect(t.exitReason).toBe('time_exit');
      expect(t.exitPremium).toBe(longExit);
      expect(t.shortExitPremium).toBe(shortExit);
      const netDebitAtEntry = longEntry - shortEntry;
      const netCreditAtExit = longExit - shortExit;
      expect(t.pnl).toBeCloseTo((netCreditAtExit - netDebitAtEntry) * t.contracts * 100, 5);
    });

    it('skips the candidate when no short-leg contract further OTM passes the delta band', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longPremium = premiumFor('call', 100, LONG_STRIKE, T);
      // Only the long-leg contract exists in this expiration — no candidate
      // strike further OTM at all, so the short-leg scan finds nothing.
      mockContractBars({ [LONG_TICKER]: [optionBar(signalDay, longPremium)] });
      const historyBySymbol = new Map([['TEST', warmupThrough(signalDay)]]);
      const contractsBySymbol = new Map([['TEST', [contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration)]]]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: entryDay }),
      );
      expect(report.trades).toEqual([]);
      expect(report.skipped.some((s) => s.reason.includes('short-leg'))).toBe(true);
    });

    it('skips the candidate when the short leg is not strictly further OTM (no net debit)', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      // Each leg's implied vol is reverse-solved independently from its OWN
      // historical price (real historical data can have genuinely different
      // implied vols per strike/liquidity, unlike a single shared sigma) —
      // long at a LOW vol (0.15) keeps its delta (~0.36) inside the long
      // leg's [0.30,0.60] band at a LOW premium; short at a HIGHER vol (0.3)
      // keeps its delta (~0.24) inside SHORT_LEG_DELTA_BAND's [0.15,0.25] but
      // at a premium that happens to be HIGHER than the long leg's — a
      // genuine "no net debit" data anomaly the guard must still catch, both
      // confirmed numerically via bsPrice/bsGreeks.
      const longPremium = premiumFor('call', 100, LONG_STRIKE, T, 0.15); // ~1.02
      const shortPremium = premiumFor('call', 100, SHORT_STRIKE, T, 0.3); // ~1.17, >= longPremium
      mockContractBars({
        [LONG_TICKER]: [optionBar(signalDay, longPremium)],
        [SHORT_TICKER]: [optionBar(signalDay, shortPremium)],
      });
      const historyBySymbol = new Map([['TEST', warmupThrough(signalDay)]]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', SHORT_STRIKE, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: entryDay }),
      );
      expect(report.trades).toEqual([]);
      expect(report.skipped.some((s) => s.reason.includes('net debit'))).toBe(true);
    });

    it('keeps a spread pending until BOTH legs land on the same fill day', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const laterDay = d(signalDay, 2);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longPremium = premiumFor('call', 100, LONG_STRIKE, T);
      const shortPremium = premiumFor('call', 100, SHORT_STRIKE, T);
      mockContractBars({
        [LONG_TICKER]: [
          optionBar(signalDay, longPremium),
          optionBar(entryDay, longPremium, { open: longPremium }), // ready on entryDay
          optionBar(laterDay, longPremium),
        ],
        [SHORT_TICKER]: [
          optionBar(signalDay, shortPremium),
          // no bar on entryDay at all -> short leg isn't ready yet
          optionBar(laterDay, shortPremium, { open: shortPremium }),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(laterDay)]],
      ]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', SHORT_STRIKE, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: laterDay }),
      );
      expect(report.trades).toHaveLength(1);
      // Filled on laterDay (the first day BOTH legs had a bar), not entryDay.
      expect(report.trades[0].entryDate).toBe(laterDay);
      expect(report.trades[0].entryPremium).toBe(longPremium);
      expect(report.trades[0].shortEntryPremium).toBe(shortPremium);
    });

    it('force-closes both legs independently at period end', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      const lastDay = d(signalDay, 2);
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longEntry = premiumFor('call', 100, LONG_STRIKE, T);
      const shortEntry = premiumFor('call', 100, SHORT_STRIKE, T);
      const longLast = longEntry + 3;
      const shortLast = shortEntry + 1;
      mockContractBars({
        [LONG_TICKER]: [
          optionBar(signalDay, longEntry),
          optionBar(entryDay, longEntry, { open: longEntry }),
          optionBar(lastDay, longLast),
        ],
        [SHORT_TICKER]: [
          optionBar(signalDay, shortEntry),
          optionBar(entryDay, shortEntry, { open: shortEntry }),
          optionBar(lastDay, shortLast),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(lastDay)]],
      ]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', SHORT_STRIKE, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: lastDay }),
      );
      expect(report.trades).toHaveLength(1);
      const t = report.trades[0];
      expect(t.exitReason).toBe('end_of_period');
      expect(t.exitPremium).toBe(longLast);
      expect(t.shortExitPremium).toBe(shortLast);
    });

    it('evaluates stop-loss/take-profit against the NET DEBIT, not the long leg premium alone', async () => {
      const signalDay = '2024-03-01';
      const entryDay = d(signalDay, 1);
      // DTE_DAYS (30d), not a longer expiration -- LONG_STRIKE/SHORT_STRIKE
      // are calibrated for T=30d specifically (see this describe block's own
      // header comment); a longer T drifts the short leg's delta outside
      // SHORT_LEG_DELTA_BAND. 30 days is still comfortably far from the
      // 7-day time-exit threshold for this test's purposes.
      const expiration = d(signalDay, DTE_DAYS);
      const T = yearsFor(DTE_DAYS);
      const longEntry = premiumFor('call', 100, LONG_STRIKE, T);
      const shortEntry = premiumFor('call', 100, SHORT_STRIKE, T);
      const exitDay = d(signalDay, 2);
      // Net debit at entry: longEntry - shortEntry. A long-leg-only read of
      // the long leg's own entry/exit would see only a small move; the
      // correct net-debit read moves the spread's own value by +60%, past a
      // +50% take-profit. Short leg held steady (a safely-positive, already-
      // known price) and the long leg solved for, rather than deriving the
      // short leg's exit price algebraically — avoids risking a non-positive
      // mock premium that impliedVol() can't solve.
      const netDebitAtEntry = longEntry - shortEntry;
      const shortExit = shortEntry;
      const longExit = shortExit + netDebitAtEntry * 1.6;
      mockContractBars({
        [LONG_TICKER]: [
          optionBar(signalDay, longEntry),
          optionBar(entryDay, longEntry, { open: longEntry }),
          optionBar(exitDay, longExit),
        ],
        [SHORT_TICKER]: [
          optionBar(signalDay, shortEntry),
          optionBar(entryDay, shortEntry, { open: shortEntry }),
          optionBar(exitDay, shortExit),
        ],
      });
      const historyBySymbol = new Map([
        ['TEST', [...warmupThrough(signalDay), equityBar(entryDay), equityBar(exitDay)]],
      ]);
      const contractsBySymbol = new Map([
        [
          'TEST',
          [
            contractRef(LONG_TICKER, 'call', LONG_STRIKE, expiration),
            contractRef(SHORT_TICKER, 'call', SHORT_STRIKE, expiration),
          ],
        ],
      ]);

      const report = await simulateOptionsBacktest(
        historyBySymbol,
        contractsBySymbol,
        spreadConfig({ from: signalDay, to: exitDay, optionsTakeProfitPct: 50 }),
      );
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0].exitReason).toBe('take_profit');
    });
  });
});

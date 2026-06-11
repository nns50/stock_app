import { describe, it, expect } from 'vitest';
import { OptionContract, OptionsChain } from '../src/providers/types';
import { defaultEntryConfig, scanEntries } from '../src/options/entryRules';
import { evaluateExit } from '../src/options/exitRules';

function call(over: Partial<OptionContract> & { strike: number }): OptionContract {
  const bid = over.bid ?? 4.9;
  const ask = over.ask ?? 5.1;
  return {
    symbol: `T${over.strike}C`,
    underlying: 'T',
    type: 'call',
    expiration: '2026-07-01',
    bid,
    ask,
    mark: over.mark ?? (bid + ask) / 2,
    volume: over.volume ?? 100,
    openInterest: over.openInterest ?? 500,
    greeks: { delta: 0.5, iv: 0.4, computed: false, ...over.greeks },
    ...over,
  };
}

const NOW = new Date('2026-06-01T00:00:00Z'); // ~30 DTE to 2026-07-01

describe('scanEntries', () => {
  const cfg = defaultEntryConfig('call'); // delta 0.3..0.6, spread<=10, OI>=100, vol>=10, DTE 7..60

  const chain: OptionsChain = {
    underlying: 'T',
    expiration: '2026-07-01',
    underlyingPrice: 100,
    calls: [
      call({ strike: 100, greeks: { delta: 0.5, iv: 0.4 } }), // A: passes
      call({ strike: 110, greeks: { delta: 0.2, iv: 0.4 } }), // B: delta below band
      call({ strike: 95, bid: 6, ask: 7, greeks: { delta: 0.55, iv: 0.4 } }), // C: spread ~15%
      call({ strike: 105, openInterest: 50, greeks: { delta: 0.4, iv: 0.4 } }), // D: OI below min
    ],
    puts: [],
  };

  const ranked = scanEntries(chain, cfg, NOW);

  it('passes only the contract meeting every rule', () => {
    const passed = ranked.filter((c) => c.passed);
    expect(passed).toHaveLength(1);
    expect(passed[0].contract.strike).toBe(100);
  });

  it('orders passing candidates ahead of failing ones', () => {
    expect(ranked[0].passed).toBe(true);
    expect(ranked[ranked.length - 1].passed).toBe(false);
  });

  it('reports a transparent rule breakdown', () => {
    const b = ranked.find((c) => c.contract.strike === 110)!;
    const deltaRule = b.rules.find((r) => r.rule === 'delta band')!;
    expect(deltaRule.passed).toBe(false);
    expect(deltaRule.detail).toContain('0.20');
  });

  it('fails the spread rule for a wide market', () => {
    const c = ranked.find((x) => x.contract.strike === 95)!;
    expect(c.rules.find((r) => r.rule === 'max spread %')!.passed).toBe(false);
  });
});

describe('evaluateExit', () => {
  const far = { expiration: '2026-07-01', side: 'long' as const };
  const cfg = { takeProfitPct: 50, stopLossPct: 50, timeExitDaysBeforeExpiry: 7 };

  it('triggers take-profit when up past the threshold', () => {
    const r = evaluateExit({ entryPrice: 5, currentPrice: 8, ...far }, cfg, NOW); // +60%
    expect(r.triggered).toBe(true);
    expect(r.activeRule).toBe('take-profit');
    expect(r.unrealizedPct).toBeCloseTo(60);
  });

  it('prioritizes stop-loss (risk) over other rules', () => {
    const r = evaluateExit({ entryPrice: 5, currentPrice: 2, ...far }, cfg, NOW); // -60%
    expect(r.activeRule).toBe('stop-loss');
  });

  it('triggers the time-based exit near expiration', () => {
    const r = evaluateExit(
      { entryPrice: 5, currentPrice: 5.2, side: 'long', expiration: '2026-06-04' },
      { timeExitDaysBeforeExpiry: 7 },
      NOW,
    );
    expect(r.activeRule).toBe('time-exit');
    expect(r.dte).toBeLessThan(7);
  });

  it('triggers delta-drift when |delta| leaves the band', () => {
    const r = evaluateExit(
      { entryPrice: 5, currentPrice: 5, side: 'long', expiration: '2026-07-01', currentDelta: 0.1 },
      { deltaMin: 0.3, deltaMax: 0.6 },
      NOW,
    );
    expect(r.activeRule).toBe('delta-drift');
  });

  it('holds (no trigger) inside all thresholds', () => {
    const r = evaluateExit({ entryPrice: 5, currentPrice: 5.5, ...far }, cfg, NOW); // +10%, ~30 DTE
    expect(r.triggered).toBe(false);
    expect(r.activeRule).toBeNull();
  });

  it('flips the sign of return for short positions', () => {
    const r = evaluateExit({ entryPrice: 5, currentPrice: 2, side: 'short', expiration: '2026-07-01' }, cfg, NOW);
    expect(r.unrealizedPct).toBeCloseTo(60); // short profits as premium falls (5 -> 2)
    expect(r.activeRule).toBe('take-profit');
  });
});

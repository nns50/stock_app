import { describe, it, expect } from 'vitest';
import { normalizeRuinParams, simulateRiskOfRuin } from '../src/services/riskOfRuin';

/** mulberry32 — deterministic RNG so the Monte Carlo is reproducible in tests. */
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

describe('normalizeRuinParams', () => {
  it('clamps junk into sane ranges and applies defaults', () => {
    const p = normalizeRuinParams({ winRate: 250, riskPct: -3, trades: 1e9 });
    expect(p.winRate).toBe(99);
    expect(p.riskPct).toBe(0.1);
    expect(p.trades).toBe(5000);
    expect(p.payoffRatio).toBe(1.5); // default
  });
});

describe('simulateRiskOfRuin', () => {
  it('reports much higher ruin risk for reckless sizing than conservative', () => {
    const base = { winRate: 50, payoffRatio: 1.2, ruinThresholdPct: 50, trades: 200, sims: 3000 };
    const conservative = simulateRiskOfRuin({ ...base, riskPct: 1 }, mulberry32(1));
    const reckless = simulateRiskOfRuin({ ...base, riskPct: 25 }, mulberry32(1));
    expect(reckless.riskOfRuinPct).toBeGreaterThan(conservative.riskOfRuinPct);
    expect(conservative.riskOfRuinPct).toBeLessThan(20);
    // percentile band is ordered
    expect(reckless.p5ReturnPct).toBeLessThanOrEqual(reckless.p95ReturnPct);
  });

  it('a strong edge with small risk almost never ruins', () => {
    const r = simulateRiskOfRuin(
      { winRate: 60, payoffRatio: 2, riskPct: 1, ruinThresholdPct: 50, trades: 200, sims: 3000 },
      mulberry32(7),
    );
    expect(r.riskOfRuinPct).toBe(0);
    expect(r.medianReturnPct).toBeGreaterThan(0);
  });
});

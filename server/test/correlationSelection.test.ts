import { describe, it, expect } from 'vitest';
import { reorderByCorrelation } from '../src/services/autotrading/correlationSelection';

// Hand-built return series with EXACT, deterministic Pearson r so the re-rank's
// threshold behavior is unambiguous:
//   SAME  ≡ SAME   → r = +1
//   SAME  vs NEG   → r = −1   (|r| = 1, still "correlated")
//   SAME  vs ORTHO → r =  0   (uncorrelated)
const SAME = [1, -1, 1, -1];
const NEG = [-1, 1, -1, 1];
const ORTHO = [1, 1, -1, -1];

const cfg = { enabled: true, threshold: 0.7, lookbackDays: 30 };

type C = { symbol: string };
const cand = (symbol: string): C => ({ symbol });
const symbolOf = (c: C) => c.symbol;
const order = (r: { ordered: C[] }) => r.ordered.map((c) => c.symbol);

describe('reorderByCorrelation', () => {
  it('is the identity when disabled (no fetching, no reordering)', () => {
    const candidates = [cand('A'), cand('B')];
    const returns = new Map([
      ['A', SAME],
      ['B', SAME],
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, { ...cfg, enabled: false });
    expect(order(result)).toEqual(['A', 'B']);
    expect(result.demoted).toEqual([]);
  });

  it('is the identity with fewer than two candidates', () => {
    const result = reorderByCorrelation([cand('A')], symbolOf, new Map([['A', SAME]]), cfg);
    expect(order(result)).toEqual(['A']);
    expect(result.demoted).toEqual([]);
  });

  it('demotes the lower-scored member of a correlated pair behind a diverse pick', () => {
    // Input order is score-descending: A (top), B (≡A), D (uncorrelated).
    const candidates = [cand('A'), cand('B'), cand('D')];
    const returns = new Map([
      ['A', SAME],
      ['B', SAME], // r(A,B) = 1 → B is redundant, demote it
      ['D', ORTHO], // r(A,D) = 0 → keep
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['A', 'D', 'B']);
    expect(result.demoted).toEqual([{ symbol: 'B', correlatedWith: 'A', r: 1 }]);
  });

  it('treats strong NEGATIVE correlation as correlated too (|r| ≥ threshold)', () => {
    const candidates = [cand('A'), cand('E'), cand('D')];
    const returns = new Map([
      ['A', SAME],
      ['E', NEG], // r(A,E) = −1 → |r| = 1 ≥ 0.7 → demote
      ['D', ORTHO], // r(A,D) = 0 → keep
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['A', 'D', 'E']);
    expect(result.demoted).toEqual([{ symbol: 'E', correlatedWith: 'A', r: -1 }]);
  });

  it('keeps an uncorrelated candidate in place (below threshold)', () => {
    const candidates = [cand('A'), cand('D')];
    const returns = new Map([
      ['A', SAME],
      ['D', ORTHO], // r = 0 < 0.7 → nothing demoted
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['A', 'D']);
    expect(result.demoted).toEqual([]);
  });

  it('never demotes a candidate whose returns are unresolved (never a fake correlation)', () => {
    // U has no entry in the returns map (fetch failed) — must be kept, not demoted.
    const candidates = [cand('A'), cand('U'), cand('B')];
    const returns = new Map([
      ['A', SAME],
      ['B', SAME], // r(A,B) = 1 → demote B
      // 'U' absent
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['A', 'U', 'B']);
    expect(result.demoted).toEqual([{ symbol: 'B', correlatedWith: 'A', r: 1 }]);
  });

  it('demotes every redundant member of a cluster but keeps the diverse ones in order', () => {
    // A (top), D (diverse), B ≡ A, C ≡ A. Keep A and D; demote B and C behind them.
    const candidates = [cand('A'), cand('D'), cand('B'), cand('C')];
    const returns = new Map([
      ['A', SAME],
      ['D', ORTHO],
      ['B', SAME],
      ['C', SAME],
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['A', 'D', 'B', 'C']);
    expect(result.demoted).toEqual([
      { symbol: 'B', correlatedWith: 'A', r: 1 },
      { symbol: 'C', correlatedWith: 'A', r: 1 },
    ]);
  });

  it('matches a demoted candidate against the FIRST kept pick it correlates with', () => {
    // D (top, diverse), then B ≡ (nothing yet)… actually B correlates with A which
    // is lower — but re-rank only looks BACKWARD at already-kept higher picks.
    const candidates = [cand('D'), cand('A'), cand('B')];
    const returns = new Map([
      ['D', ORTHO],
      ['A', SAME], // r(D,A)=0 → A kept
      ['B', SAME], // r(D,B)=0, r(A,B)=1 → correlated with A (kept), demote
    ]);
    const result = reorderByCorrelation(candidates, symbolOf, returns, cfg);
    expect(order(result)).toEqual(['D', 'A', 'B']);
    expect(result.demoted).toEqual([{ symbol: 'B', correlatedWith: 'A', r: 1 }]);
  });
});

// Risk-of-ruin Monte Carlo. Given a realized edge (win rate + payoff ratio) and a
// fixed-fractional risk per trade, simulate many trade sequences to estimate the
// chance of a deep drawdown ("ruin") and the spread of outcomes. Decision-support
// only — it assumes the edge is stationary and trades are independent.

export interface RuinParams {
  winRate: number; // %
  payoffRatio: number; // avg win / avg loss (in $ or R)
  riskPct: number; // % of equity risked per trade
  ruinThresholdPct: number; // drawdown from start that counts as ruin, e.g. 50
  trades: number;
  sims: number;
}

export interface RuinResult {
  riskOfRuinPct: number; // % of simulations that breached the ruin threshold
  medianReturnPct: number; // median final return over `trades`
  p5ReturnPct: number;
  p95ReturnPct: number;
  medianMaxDrawdownPct: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Value at the given percentile (0..100) of an unsorted sample. */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Clamp params into sane ranges so a bad request can't blow up the sim. */
export function normalizeRuinParams(p: Partial<RuinParams>): RuinParams {
  const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v as number)) : dflt;
  return {
    winRate: clamp(p.winRate, 1, 99, 50),
    payoffRatio: clamp(p.payoffRatio, 0.1, 20, 1.5),
    riskPct: clamp(p.riskPct, 0.1, 100, 1),
    ruinThresholdPct: clamp(p.ruinThresholdPct, 5, 99, 50),
    trades: Math.round(clamp(p.trades, 1, 5000, 100)),
    sims: Math.round(clamp(p.sims, 100, 50000, 5000)),
  };
}

export function simulateRiskOfRuin(p: RuinParams, rng: () => number = Math.random): RuinResult {
  const w = p.winRate / 100;
  const f = p.riskPct / 100;
  const winMult = 1 + f * p.payoffRatio; // win: gain risk × payoff of current equity
  const lossMult = 1 - f; // loss: lose the risked fraction
  const ruinLevel = 1 - p.ruinThresholdPct / 100; // equity floor that counts as ruin

  const finals: number[] = [];
  const drawdowns: number[] = [];
  let ruined = 0;

  for (let s = 0; s < p.sims; s++) {
    let eq = 1;
    let peak = 1;
    let maxDD = 0;
    let hitRuin = false;
    for (let t = 0; t < p.trades; t++) {
      eq *= rng() < w ? winMult : lossMult;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
      if (eq <= ruinLevel) hitRuin = true;
    }
    if (hitRuin) ruined += 1;
    finals.push((eq - 1) * 100);
    drawdowns.push(maxDD * 100);
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return {
    riskOfRuinPct: round2((ruined / p.sims) * 100),
    medianReturnPct: round2(percentile(finals, 50)),
    p5ReturnPct: round2(percentile(finals, 5)),
    p95ReturnPct: round2(percentile(finals, 95)),
    medianMaxDrawdownPct: round2(percentile(drawdowns, 50)),
  };
}

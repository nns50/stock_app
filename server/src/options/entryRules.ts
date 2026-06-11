import { OptionContract, OptionsChain } from '../providers/types';
import { daysToExpiration } from './blackScholes';

// ---------------------------------------------------------------------------
// Strategy-based option ENTRY screening. Given a chain + a configurable rule
// set (delta band, max spread %, min OI/volume, IV band, DTE window), evaluate
// every contract, mark pass/fail per rule, and rank the passing candidates with
// a transparent score breakdown.
// ---------------------------------------------------------------------------

export interface EntryRankWeights {
  /** Tighter bid/ask spread scores higher. */
  spread: number;
  /** Higher open interest + volume scores higher. */
  liquidity: number;
  /** Delta closer to the middle of the target band scores higher. */
  deltaFit: number;
}

export interface EntryStrategyConfig {
  side: 'call' | 'put';
  /** Absolute delta band, e.g. 0.30..0.60 for a directional long. */
  deltaMin: number;
  deltaMax: number;
  /** Max (ask-bid)/mid * 100. */
  maxSpreadPct: number;
  minOpenInterest: number;
  minVolume: number;
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  /** Implied-vol band (decimal, e.g. 0.20..0.80). */
  ivMin?: number;
  ivMax?: number;
  weights?: EntryRankWeights;
}

export interface EntryRuleResult {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface EntryCandidate {
  contract: OptionContract;
  passed: boolean;
  score: number; // 0..100 (ranking among evaluated candidates)
  rules: EntryRuleResult[];
  metrics: {
    spreadPct: number | null;
    delta: number | null;
    iv: number | null;
    dte: number;
    openInterest: number | null;
    volume: number | null;
    mark: number | null;
  };
}

export function defaultEntryConfig(side: 'call' | 'put' = 'call'): EntryStrategyConfig {
  return {
    side,
    deltaMin: 0.3,
    deltaMax: 0.6,
    maxSpreadPct: 10,
    minOpenInterest: 100,
    minVolume: 10,
    minDaysToExpiration: 7,
    maxDaysToExpiration: 60,
    weights: { spread: 1, liquidity: 1, deltaFit: 1 },
  };
}

function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function spreadPctOf(c: OptionContract): number | null {
  if (c.bid === undefined || c.ask === undefined) return null;
  const mid = c.mark ?? (c.bid + c.ask) / 2;
  if (!mid) return null;
  return ((c.ask - c.bid) / mid) * 100;
}

/** Evaluate one contract against the strategy rules (pure, deterministic). */
function evaluateContract(c: OptionContract, cfg: EntryStrategyConfig, now: Date): EntryCandidate {
  const absDelta = c.greeks?.delta !== undefined ? Math.abs(c.greeks.delta) : null;
  const iv = c.greeks?.iv ?? null;
  const dte = daysToExpiration(c.expiration, now);
  const spreadPct = spreadPctOf(c);
  const oi = c.openInterest ?? null;
  const vol = c.volume ?? null;
  const mark = c.mark ?? null;

  const rules: EntryRuleResult[] = [];
  const add = (rule: string, passed: boolean, detail: string) => rules.push({ rule, passed, detail });

  add(
    'delta band',
    absDelta !== null && absDelta >= cfg.deltaMin && absDelta <= cfg.deltaMax,
    `|Δ| ${absDelta === null ? '—' : absDelta.toFixed(2)} in [${cfg.deltaMin}, ${cfg.deltaMax}]`,
  );
  add(
    'max spread %',
    spreadPct !== null && spreadPct <= cfg.maxSpreadPct,
    `spread ${spreadPct === null ? '—' : spreadPct.toFixed(1) + '%'} ≤ ${cfg.maxSpreadPct}%`,
  );
  add('min open interest', (oi ?? 0) >= cfg.minOpenInterest, `OI ${oi ?? 0} ≥ ${cfg.minOpenInterest}`);
  add('min volume', (vol ?? 0) >= cfg.minVolume, `vol ${vol ?? 0} ≥ ${cfg.minVolume}`);
  if (cfg.minDaysToExpiration !== undefined)
    add('min DTE', dte >= cfg.minDaysToExpiration, `${dte.toFixed(0)}d ≥ ${cfg.minDaysToExpiration}d`);
  if (cfg.maxDaysToExpiration !== undefined)
    add('max DTE', dte <= cfg.maxDaysToExpiration, `${dte.toFixed(0)}d ≤ ${cfg.maxDaysToExpiration}d`);
  if (cfg.ivMin !== undefined)
    add('min IV', iv !== null && iv >= cfg.ivMin, `IV ${iv === null ? '—' : (iv * 100).toFixed(0) + '%'} ≥ ${(cfg.ivMin * 100).toFixed(0)}%`);
  if (cfg.ivMax !== undefined)
    add('max IV', iv !== null && iv <= cfg.ivMax, `IV ${iv === null ? '—' : (iv * 100).toFixed(0) + '%'} ≤ ${(cfg.ivMax * 100).toFixed(0)}%`);

  const passed = rules.every((r) => r.passed);

  // Ranking score (only meaningful for passing contracts, but computed for all).
  const w = cfg.weights ?? { spread: 1, liquidity: 1, deltaFit: 1 };
  const target = (cfg.deltaMin + cfg.deltaMax) / 2;
  const bandHalf = Math.max(0.01, (cfg.deltaMax - cfg.deltaMin) / 2);
  const deltaFit = absDelta === null ? 0 : clamp(1 - Math.abs(absDelta - target) / bandHalf);
  const spreadScore = spreadPct === null ? 0 : clamp(1 - spreadPct / Math.max(0.01, cfg.maxSpreadPct));
  const liquidityScore = clamp(Math.log10((oi ?? 0) + (vol ?? 0) + 1) / 5); // ~1e5 -> full
  const wSum = w.spread + w.liquidity + w.deltaFit || 1;
  const score = ((spreadScore * w.spread + liquidityScore * w.liquidity + deltaFit * w.deltaFit) / wSum) * 100;

  return {
    contract: c,
    passed,
    score: Math.round(score * 10) / 10,
    rules,
    metrics: { spreadPct, delta: c.greeks?.delta ?? null, iv, dte, openInterest: oi, volume: vol, mark },
  };
}

/** Rank entry candidates from a chain. Passing candidates first, by score. */
export function scanEntries(
  chain: OptionsChain,
  cfg: EntryStrategyConfig,
  now: Date = new Date(),
): EntryCandidate[] {
  const contracts = cfg.side === 'call' ? chain.calls : chain.puts;
  const evaluated = contracts.map((c) => evaluateContract(c, cfg, now));
  return evaluated.sort((a, b) => {
    if (a.passed !== b.passed) return a.passed ? -1 : 1;
    return b.score - a.score;
  });
}

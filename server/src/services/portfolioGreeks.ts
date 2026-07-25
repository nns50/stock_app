import { resolveOptionGreeks, GreeksLookupItem, ContractGreeks } from './quotes';
import { OptionsPaperPosition } from '../db/autotradeOptionsPaperPositions';
import { LiveOptionsPosition } from '../db/autotradeLiveOptionsPositions';

// ---------------------------------------------------------------------------
// Aggregate options Greeks across a whole book of positions — "am I net long
// or short the market right now, and how much am I bleeding/collecting in
// time decay today" — one number each, instead of only ever seeing Greeks
// per-position (Options page's chain browser). Every position in this app is
// a long-the-contract bet EXCEPT a debit spread's own short leg (this app
// never writes naked calls/puts — see riskCheck.ts's correlatedNotional() doc
// comment) — the short leg's Greeks are subtracted, not added, since being
// short a contract has the opposite directional/time-decay exposure of being
// long one.
// ---------------------------------------------------------------------------

const MULTIPLIER = 100; // standard US equity-option contract size — hardcoded
// the same way optionsExecute.ts's own P&L math already does (no stored
// per-position multiplier column exists for options, unlike equities).

export interface GreeksPosition {
  key: string;
  quantity: number;
  /** True for a debit spread's SHORT leg — negates this leg's contribution. */
  short: boolean;
}

export interface PortfolioGreeks {
  /** $ change in portfolio value per $1 move in the underlying(s), summed
   *  across every leg. */
  netDelta: number;
  /** $ change in portfolio value per day, holding everything else constant
   *  (typically negative — long options bleed time value). */
  netTheta: number;
  /** $ change in portfolio value per 1-point move in implied volatility. */
  netVega: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure aggregator — sums each leg's per-contract Greek × quantity ×
 *  MULTIPLIER, negated for a short leg. A leg with no resolved Greeks
 *  (chain fetch failed, or the provider has no options capability) is
 *  excluded from the sum, not assumed zero-risk — same "unknown, not
 *  assumed" reasoning riskCheck.ts's correlatedNotional() uses for a
 *  candle-fetch failure. */
export function computePortfolioGreeks(
  positions: GreeksPosition[],
  greeksByKey: Map<string, ContractGreeks>,
): PortfolioGreeks {
  let netDelta = 0;
  let netTheta = 0;
  let netVega = 0;
  for (const p of positions) {
    const g = greeksByKey.get(p.key);
    if (!g) continue;
    const scale = (p.short ? -1 : 1) * p.quantity * MULTIPLIER;
    if (g.delta != null) netDelta += g.delta * scale;
    if (g.theta != null) netTheta += g.theta * scale;
    if (g.vega != null) netVega += g.vega * scale;
  }
  return { netDelta: round2(netDelta), netTheta: round2(netTheta), netVega: round2(netVega) };
}

function legsOf(
  p: OptionsPaperPosition | LiveOptionsPosition,
  keyPrefix: string,
): { items: GreeksLookupItem[]; positions: GreeksPosition[] } {
  const longKey = `${keyPrefix}${p.id}`;
  const items: GreeksLookupItem[] = [
    { key: longKey, symbol: p.symbol, optionType: p.side, strike: p.strike, expiration: p.expiration },
  ];
  const positions: GreeksPosition[] = [{ key: longKey, quantity: p.quantity, short: false }];
  if (p.shortContractSymbol != null && p.shortStrike != null) {
    const shortKey = `${keyPrefix}${p.id}-short`;
    items.push({
      key: shortKey,
      symbol: p.symbol,
      optionType: p.side,
      strike: p.shortStrike,
      expiration: p.expiration,
    });
    positions.push({ key: shortKey, quantity: p.quantity, short: true });
  }
  return { items, positions };
}

/** Async orchestrator: resolves current Greeks (one chain fetch per distinct
 *  (symbol, expiration) across BOTH pools, via resolveOptionGreeks's own
 *  batching) for autotrade's own combined open options book — paper + live,
 *  the same two pools dashboard.ts already reads elsewhere — and aggregates
 *  them. Best-effort: a fetch failure for one (symbol, expiration) group
 *  excludes just those legs, exactly like resolveOptionGreeks/
 *  correlatedNotional already do; never throws. */
export async function computeAutotradeOptionsGreeks(
  paperOptions: OptionsPaperPosition[],
  liveOptions: LiveOptionsPosition[],
): Promise<PortfolioGreeks> {
  const allItems: GreeksLookupItem[] = [];
  const allPositions: GreeksPosition[] = [];
  for (const p of paperOptions) {
    const { items, positions } = legsOf(p, 'paper-');
    allItems.push(...items);
    allPositions.push(...positions);
  }
  for (const p of liveOptions) {
    const { items, positions } = legsOf(p, 'live-');
    allItems.push(...items);
    allPositions.push(...positions);
  }
  if (allItems.length === 0) return { netDelta: 0, netTheta: 0, netVega: 0 };
  const greeksByKey = await resolveOptionGreeks(allItems);
  return computePortfolioGreeks(allPositions, greeksByKey);
}

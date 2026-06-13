// Proactive exit monitoring: evaluate OPEN option positions against the exit
// rules (take-profit / stop-loss / time / delta-drift) so the alert poller can
// surface positions that have hit an exit condition — turning the otherwise
// on-demand exit-check into a background signal. Decision-support only.

import { listPositions, Position } from '../db/positions';
import { resolveOptionMarks, resolveStockPrices } from './quotes';
import { defaultExitConfig, evaluateExit, ExitRulesConfig, unrealizedReturnPct } from '../options/exitRules';
import { getSetting } from '../db/settings';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PositionExitAlert {
  positionId: number;
  symbol: string;
  rule: string; // take-profit | stop-loss | time-exit | delta-drift
  unrealizedPct: number | null;
  message: string;
}

function label(p: Position): string {
  if (p.assetType === 'option') {
    return `${p.symbol} ${p.strike}${p.optionType === 'call' ? 'C' : 'P'}`;
  }
  return p.symbol;
}

/** Pure: turn open positions + their resolved marks into triggered-exit alerts. */
export function buildPositionExitAlerts(
  positions: Position[],
  markOf: (p: Position) => { mark: number | null; delta: number | null },
  cfg: ExitRulesConfig,
  now: Date,
): PositionExitAlert[] {
  const out: PositionExitAlert[] = [];
  for (const p of positions) {
    const { mark, delta } = markOf(p);
    const ev = evaluateExit(
      {
        entryPrice: p.entryPrice,
        currentPrice: mark,
        side: p.side,
        expiration: p.expiration ?? '',
        currentDelta: delta,
      },
      cfg,
      now,
    );
    if (!ev.triggered || !ev.activeRule) continue;
    const pct = ev.unrealizedPct;
    const pctText = pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    out.push({
      positionId: p.id,
      symbol: p.symbol,
      rule: ev.activeRule,
      unrealizedPct: pct,
      message: `${label(p)}: ${ev.activeRule}${pctText}`,
    });
  }
  return out;
}

/** Pure: alert when a position's price crosses its own planned stop or target. */
export function buildStopTargetAlerts(
  positions: Position[],
  priceOf: (p: Position) => number | null,
): PositionExitAlert[] {
  const out: PositionExitAlert[] = [];
  for (const p of positions) {
    const price = priceOf(p);
    if (price === null) continue;
    const pct = unrealizedReturnPct(p.entryPrice, price, p.side);
    const pctText = pct === null ? '' : ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    if (p.stopPrice != null) {
      const hit = p.side === 'long' ? price <= p.stopPrice : price >= p.stopPrice;
      if (hit) {
        out.push({
          positionId: p.id,
          symbol: p.symbol,
          rule: 'stop-hit',
          unrealizedPct: pct,
          message: `${label(p)}: stop $${p.stopPrice} hit @ $${round2(price)}${pctText}`,
        });
      }
    }
    if (p.targetPrice != null) {
      const hit = p.side === 'long' ? price >= p.targetPrice : price <= p.targetPrice;
      if (hit) {
        out.push({
          positionId: p.id,
          symbol: p.symbol,
          rule: 'target-hit',
          unrealizedPct: pct,
          message: `${label(p)}: target $${p.targetPrice} reached @ $${round2(price)}${pctText}`,
        });
      }
    }
  }
  return out;
}

/**
 * Evaluate the whole open book for exit signals: option exit-rules (TP/SL/time/
 * delta) plus per-position stop/target levels (stocks and options). Each
 * (position, rule) is reported once.
 */
export async function evaluateOpenPositionExits(now: Date = new Date()): Promise<PositionExitAlert[]> {
  const open = listPositions({ status: 'open' });
  if (!open.length) return [];
  const cfg: ExitRulesConfig = { ...defaultExitConfig(), ...(getSetting<ExitRulesConfig>('optionExitConfig') ?? {}) };
  const stocks = open.filter((p) => p.assetType === 'stock');
  const options = open.filter((p) => p.assetType === 'option');

  const priceOf = new Map<number, number | null>();
  const markDelta = new Map<number, { mark: number | null; delta: number | null }>();

  if (stocks.length) {
    const prices = await resolveStockPrices(stocks.map((p) => p.symbol)).catch(
      () => new Map<string, { price: number | null }>(),
    );
    for (const p of stocks) priceOf.set(p.id, prices.get(p.symbol.toUpperCase())?.price ?? null);
  }
  if (options.length) {
    const marks = await resolveOptionMarks(options).catch(
      () => new Map<number, { mark: number | null; delta: number | null }>(),
    );
    for (const p of options) {
      const m = marks.get(p.id) ?? { mark: null, delta: null };
      markDelta.set(p.id, m);
      priceOf.set(p.id, m.mark);
    }
  }

  const exitRuleAlerts = buildPositionExitAlerts(
    options,
    (p) => markDelta.get(p.id) ?? { mark: null, delta: null },
    cfg,
    now,
  );
  const stopTargetAlerts = buildStopTargetAlerts(open, (p) => priceOf.get(p.id) ?? null);

  const seen = new Set<string>();
  return [...exitRuleAlerts, ...stopTargetAlerts].filter((a) => {
    const key = `${a.positionId}:${a.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

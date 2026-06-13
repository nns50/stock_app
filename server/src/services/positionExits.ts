// Proactive exit monitoring: evaluate OPEN option positions against the exit
// rules (take-profit / stop-loss / time / delta-drift) so the alert poller can
// surface positions that have hit an exit condition — turning the otherwise
// on-demand exit-check into a background signal. Decision-support only.

import { listPositions, Position } from '../db/positions';
import { resolveOptionMarks } from './quotes';
import { defaultExitConfig, evaluateExit, ExitRulesConfig } from '../options/exitRules';
import { getSetting } from '../db/settings';

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

/** Resolve marks for open option positions and return those hitting an exit rule. */
export async function evaluateOpenPositionExits(now: Date = new Date()): Promise<PositionExitAlert[]> {
  const open = listPositions({ status: 'open', assetType: 'option' });
  if (!open.length) return [];
  const cfg: ExitRulesConfig = { ...defaultExitConfig(), ...(getSetting<ExitRulesConfig>('optionExitConfig') ?? {}) };
  const marks = await resolveOptionMarks(open).catch(
    () => new Map<number, { mark: number | null; delta: number | null }>(),
  );
  return buildPositionExitAlerts(open, (p) => marks.get(p.id) ?? { mark: null, delta: null }, cfg, now);
}

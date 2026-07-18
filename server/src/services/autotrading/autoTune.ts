import { listPositions } from '../../db/positions';
import { getIntents } from '../../db/orders';
import { computeSlippage, groupSlippageBySymbol, SlippageRow } from '../slippage';
import { computeJournalStats } from '../pnl';
import { getAutotradeConfig, setAutotradeConfig } from '../../db/autotradeConfig';
import { addExclusion, isExcluded } from '../../db/autotradeExclusions';
import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';

// ---------------------------------------------------------------------------
// Auto-tune from realized edge (2026-07-18 follow-up to the Journal page's
// pre-existing analytics — see AutotradeConfig.autoTuneEnabled's own doc
// comment for the full design). Off unless explicitly enabled; runs at most
// once per (ET) trading day, gated the same "journal a marker, check for it
// next time" way dailyHaltAlert.ts's own once-per-day throttle is, so it
// survives a restart without needing a separate persisted timestamp.
// ---------------------------------------------------------------------------

/** Today's date (YYYY-MM-DD) in US/Eastern — same "trading day" convention
 *  riskCheck.ts's own etDateStr() uses, duplicated here for the same reason
 *  dailyHaltAlert.ts's copy gives (avoids a circular import). */
function etDateStr(ms: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const RAN_ACTION = 'auto_tune_ran';
interface RanMarkerDetail {
  date: string;
}

function alreadyRanToday(today: string): boolean {
  return listAutotradeEvents({ stage: 'config', actions: [RAN_ACTION], limit: 10 }).some((e) => {
    if (!e.detail) return false;
    try {
      return (JSON.parse(e.detail) as RanMarkerDetail).date === today;
    } catch {
      return false;
    }
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every live-traded fill (entry or exit) that traces back to an order with a
 *  persisted limit price — same scope and shape as routes/journal.ts's own
 *  '/slippage' route, batching the order_intents lookup (getIntents) instead
 *  of that route's one-by-one getIntent() calls, since this walks the WHOLE
 *  journal rather than serving a single on-demand request. */
function buildSlippageRows(): SlippageRow[] {
  const positions = listPositions();
  const ids = new Set<number>();
  for (const p of positions) {
    if (p.sourceIntentId != null) ids.add(p.sourceIntentId);
    for (const e of p.exits) if (e.sourceIntentId != null) ids.add(e.sourceIntentId);
  }
  const intents = getIntents(Array.from(ids));

  const rows: SlippageRow[] = [];
  for (const p of positions) {
    if (p.sourceIntentId != null) {
      const intent = intents.get(p.sourceIntentId);
      if (intent?.limitPrice != null) {
        rows.push(
          computeSlippage({
            positionId: p.id,
            symbol: p.symbol,
            kind: 'entry',
            side: intent.side,
            date: p.entryDate,
            limitPrice: intent.limitPrice,
            fillPrice: p.entryPrice,
            quantity: p.quantity,
            multiplier: p.multiplier,
          }),
        );
      }
    }
    for (const e of p.exits) {
      if (e.sourceIntentId == null) continue;
      const intent = intents.get(e.sourceIntentId);
      if (intent?.limitPrice == null) continue;
      rows.push(
        computeSlippage({
          positionId: p.id,
          symbol: p.symbol,
          kind: 'exit',
          side: intent.side,
          date: e.exitDate,
          limitPrice: intent.limitPrice,
          fillPrice: e.exitPrice,
          quantity: e.quantity,
          multiplier: p.multiplier,
        }),
      );
    }
  }
  return rows;
}

export interface AutoTuneResult {
  /** False when disabled or already run today — everything below is
   *  meaningless in that case. */
  ran: boolean;
  riskAdjusted: boolean;
  symbolsExcluded: string[];
}

/**
 * Runs (at most once per ET trading day) when AutotradeConfig.autoTuneEnabled
 * is on:
 *  - Nudges riskPerTradePct toward the Journal page's own Kelly suggestion,
 *    once there are at least autoTuneMinTrades decisive closed trades,
 *    clamped to at most autoTuneMaxStepPct percentage points of change for
 *    the day.
 *  - Auto-excludes (db/autotradeExclusions.ts) any symbol whose average
 *    live-fill slippage is at or above autoTuneSlippageExcludePct over at
 *    least autoTuneMinTrades fills.
 * Every adjustment is journaled (autotrade_events) so it's visible on Recent
 * Activity. Best-effort — never throws; the caller (loop.ts) treats this the
 * same as every other post-tick best-effort check.
 */
export async function maybeAutoTune(now: number = Date.now()): Promise<AutoTuneResult> {
  const config = getAutotradeConfig();
  if (!config.autoTuneEnabled) return { ran: false, riskAdjusted: false, symbolsExcluded: [] };

  const today = etDateStr(now);
  if (alreadyRanToday(today)) return { ran: false, riskAdjusted: false, symbolsExcluded: [] };

  // Journal the marker BEFORE acting — same reasoning as dailyHaltAlert.ts's
  // own once-per-day throttle: the journal is the source of truth even if
  // this runs slowly and another tick starts concurrently.
  logAutotradeEvent({ stage: 'config', action: RAN_ACTION, detail: { date: today } satisfies RanMarkerDetail });

  let riskAdjusted = false;
  const stats = computeJournalStats(listPositions({ status: 'closed' }));
  if (stats.kelly && stats.kelly.sampleSize >= config.autoTuneMinTrades) {
    const target = stats.kelly.suggestedRiskPct;
    const current = config.riskPerTradePct;
    const delta = Math.max(-config.autoTuneMaxStepPct, Math.min(config.autoTuneMaxStepPct, target - current));
    const next = round2(Math.max(0, current + delta));
    if (Math.abs(next - current) > 1e-9) {
      setAutotradeConfig({ riskPerTradePct: next });
      logAutotradeEvent({
        stage: 'config',
        action: 'auto_tune_risk_adjusted',
        detail: { from: current, to: next, kellySuggested: target, sampleSize: stats.kelly.sampleSize },
      });
      riskAdjusted = true;
    }
  }

  const symbolsExcluded: string[] = [];
  const bySymbol = groupSlippageBySymbol(buildSlippageRows());
  for (const g of bySymbol) {
    if (g.trades < config.autoTuneMinTrades) continue;
    if (g.avgPct < config.autoTuneSlippageExcludePct) continue;
    if (isExcluded(g.symbol)) continue;
    addExclusion(
      g.symbol,
      `Auto-excluded: avg slippage ${g.avgPct}% over ${g.trades} fill${g.trades === 1 ? '' : 's'} ` +
        `(>= ${config.autoTuneSlippageExcludePct}% threshold)`,
    );
    logAutotradeEvent({
      symbol: g.symbol,
      stage: 'config',
      action: 'auto_tune_symbol_excluded',
      detail: { avgPct: g.avgPct, trades: g.trades, thresholdPct: config.autoTuneSlippageExcludePct },
    });
    symbolsExcluded.push(g.symbol);
  }

  return { ran: true, riskAdjusted, symbolsExcluded };
}

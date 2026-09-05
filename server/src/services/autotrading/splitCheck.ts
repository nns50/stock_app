import { getRecentSplits } from '../splits';
import { listOpenPaperPositions } from '../../db/autotradePaperPositions';
import { listOpenOptionsPaperPositions } from '../../db/autotradeOptionsPaperPositions';
import { listOpenLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { listAutotradeLivePositions } from './liveExecute';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchAutotradeNotification } from './notify';

// ---------------------------------------------------------------------------
// Recent stock-split detection for autotrade's own open positions (paper +
// live, equity + options) — services/splits.ts does the actual Yahoo lookup;
// this just decides WHO to check it for, WHEN, and what to do with a hit.
//
// Checked at most once per ET calendar day (splits are rare — there's no
// value in re-running this every 60-second loop tick the way stop/target
// checks need to). DETECTION ONLY: journals + best-effort notifies, never
// touches the position's own quantity/price — see docs/AUTOTRADING_SPEC.md
// for why auto-adjustment is a separate, larger, not-yet-built piece.
//
// Fixed 7-day lookback, not user-configurable — this is a narrow, low-risk
// notification feature, not a trading-behavior knob; a config field for it
// would be more ceremony than the feature's own value justifies.
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 7;

let lastCheckedEtDate: string | null = null;

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

/** Every symbol with an open autotrade position right now, paper or live,
 *  equity or options (the options tables' own `symbol` field is always the
 *  UNDERLYING, never the contract). */
function openAutotradeSymbols(): string[] {
  const symbols = new Set<string>();
  for (const p of listOpenPaperPositions()) symbols.add(p.symbol);
  for (const p of listOpenOptionsPaperPositions()) symbols.add(p.symbol);
  for (const p of listAutotradeLivePositions({ status: 'open' })) symbols.add(p.symbol);
  for (const p of listOpenLiveOptionsPositions()) symbols.add(p.symbol);
  return Array.from(symbols);
}

/**
 * Once per ET calendar day, check every symbol with an open autotrade
 * position for a split in the last 7 days, journaling and best-effort
 * notifying any hit. A no-op (returns immediately, no network call) if
 * already checked today or if nothing is open — this is meant to be called
 * every loop tick like the other checks, not scheduled separately.
 */
export async function checkForRecentSplits(): Promise<void> {
  const today = etDateStr();
  if (lastCheckedEtDate === today) return;

  const symbols = openAutotradeSymbols();
  if (symbols.length === 0) {
    lastCheckedEtDate = today; // still "checked" — nothing to check today
    return;
  }

  const splitsBySymbol = await getRecentSplits(symbols, LOOKBACK_DAYS);
  lastCheckedEtDate = today;

  for (const [symbol, splits] of splitsBySymbol) {
    for (const split of splits) {
      logAutotradeEvent({
        symbol,
        stage: 'execution',
        action: 'split_detected',
        detail: { date: split.date, splitRatio: split.splitRatio },
      });
    }
  }
  const hits = Array.from(splitsBySymbol.entries()).filter(([, splits]) => splits.length > 0);
  if (hits.length > 0) {
    await dispatchAutotradeNotification(
      'split check',
      hits.flatMap(([symbol, splits]) =>
        splits.map((split) => ({
          title: symbol,
          message: `${symbol} split ${split.splitRatio} on ${split.date} — an open autotrade position's quantity/price may no longer reflect reality; review it manually.`,
        })),
      ),
    );
  }
}

/** Test-only reset. */
export function resetSplitCheckState(): void {
  lastCheckedEtDate = null;
}

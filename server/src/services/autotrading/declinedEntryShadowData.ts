import { buildLiveSlippageRows } from './autoTune';
import { isStockEntrySlippage } from '../slippage';
import type { ShadowOptions } from './declinedEntryShadow';
import { MARKETABLE_LIMIT_BUFFER_PCT, meanBufferConsumedPct } from './marketableLimit';
import { directionReaderSince } from './marketDirectionIndex';
import { countLiveAddOns, entryIntentIdForPosition, getLiveOrder } from '../../db/autotradeLiveOrders';
import { getPosition } from '../../db/positions';
import { etDateTimeToMs, etToday } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// The declined-entry replay's fill inputs, read from the database (2026-09-26,
// replay version 2 — declinedEntryShadow.ts). Every record built on the replay
// — the short shadow record, the re-entry record, the Journal's route — reads
// them through this one function, so no two of them can charge a different
// entry or replay a different gate.
// ---------------------------------------------------------------------------

/**
 * A live entry whose fill measures the loop's marketable limit (2026-09-25, on
 * the second review): its entry order is the loop's own FIRST entry for the
 * position, and the position has had no add-on.
 *
 * A hand order from the Trade page carries a limit the user typed, not the
 * loop's buffer. And once a scale-in or a second lot fills, the position's
 * entry price is a blend while the entry-order lookup returns the NEWEST entry
 * row, the add-on's: a blended 100.67 read against the add-on's 102.51 limit
 * is -1.8%, and one such position among nine that paid 0.1% took the
 * concession to 0.
 */
export function isLoopFirstEntry(positionId: number): boolean {
  const position = getPosition(positionId);
  if (!position) return false;
  const intentId = entryIntentIdForPosition(position);
  if (intentId === null) return false;
  const order = getLiveOrder(intentId);
  return order !== undefined && order.addonOfPositionId === null && countLiveAddOns(positionId) === 0;
}

/**
 * The share of the marketable-limit buffer live entries actually pay. The
 * same measure as the leak scan's `meanEntryBufferConsumedPct`
 * (meanBufferConsumedPct over stock entry slippage), and deliberately not the
 * same number: the scan reads its session window and does not clamp; this
 * reads every fill there is, only the loop's own first entries
 * (isLoopFirstEntry), and is kept inside [0, buffer]: a limit order cannot
 * fill beyond its limit, and the measurement cannot justify charging less
 * than nothing. The whole buffer when no live entry has been measured: the
 * most a live entry can pay.
 */
export function liveEntryConcessionPct(): number {
  // Stock entries only (2026-09-24, on review). An option reaches these rows
  // as a hand order from the Trade page (the reconcile links it by
  // source_intent_id); its limit sits at the ask x 1.05, so one filled at the
  // ask would read about -4.8% against a 0.5% stock buffer and drag the mean
  // toward "no concession". None had on 2026-09-24 (0 of 142 entry rows).
  const entrySlippage = buildLiveSlippageRows()
    .filter(isStockEntrySlippage)
    .filter((r) => isLoopFirstEntry(r.positionId))
    .map((r) => r.pct);
  const consumed = meanBufferConsumedPct(entrySlippage, MARKETABLE_LIMIT_BUFFER_PCT);
  if (consumed === null) return MARKETABLE_LIMIT_BUFFER_PCT;
  return Math.min(MARKETABLE_LIMIT_BUFFER_PCT, Math.max(0, consumed));
}

/** The concession and the market-direction readings since `since`. The
 *  readings start at the ET midnight of `since`'s day (2026-09-25, on the
 *  second review): windows are "now minus N days" at the time of day, so a
 *  reading journaled earlier on the window's first day was missing, and that
 *  day's rows replayed with no gate. */
export function shadowFillInputs(since: number): Pick<ShadowOptions, 'entryConcessionPct' | 'directionAt'> {
  const dayStart = etDateTimeToMs(etToday(since), '00:00');
  return {
    entryConcessionPct: liveEntryConcessionPct(),
    directionAt: directionReaderSince(dayStart === null ? since : Math.min(since, dayStart)),
  };
}

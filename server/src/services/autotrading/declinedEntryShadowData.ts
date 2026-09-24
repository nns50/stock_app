import { buildLiveSlippageRows } from './autoTune';
import type { ShadowOptions } from './declinedEntryShadow';
import { MARKETABLE_LIMIT_BUFFER_PCT, meanBufferConsumedPct } from './marketableLimit';
import { directionReaderSince } from './marketDirectionIndex';

// ---------------------------------------------------------------------------
// The declined-entry replay's fill inputs, read from the database (2026-09-26,
// replay version 2 — declinedEntryShadow.ts). Every record built on the replay
// — the short shadow record, the re-entry record, the Journal's route — reads
// them through this one function, so no two of them can charge a different
// entry or replay a different gate.
// ---------------------------------------------------------------------------

/**
 * The share of the marketable-limit buffer live entries actually pay: the
 * leak scan's own `meanEntryBufferConsumedPct`, over every live entry fill.
 * Kept inside [0, buffer]: a limit order cannot fill beyond its limit, and the
 * measurement cannot justify charging less than nothing. The whole buffer when
 * no live entry has been measured: the most a live entry can pay.
 */
export function liveEntryConcessionPct(): number {
  const entrySlippage = buildLiveSlippageRows()
    .filter((r) => r.kind === 'entry')
    .map((r) => r.pct);
  const consumed = meanBufferConsumedPct(entrySlippage, MARKETABLE_LIMIT_BUFFER_PCT);
  if (consumed === null) return MARKETABLE_LIMIT_BUFFER_PCT;
  return Math.min(MARKETABLE_LIMIT_BUFFER_PCT, Math.max(0, consumed));
}

/** The concession and the market-direction readings since `since`. */
export function shadowFillInputs(since: number): Pick<ShadowOptions, 'entryConcessionPct' | 'directionAt'> {
  return { entryConcessionPct: liveEntryConcessionPct(), directionAt: directionReaderSince(since) };
}

import { etToday } from '../../util/marketDate';
import { isAfterSessionClose } from '../trading/marketHours';
import { liveHaltMarkerOn, liveHaltRetractionOnFile, writeDailyHaltRetraction } from './dailyHaltMarker';
import { DayLineReading, liveDayAgainstLine } from './liveDayCloses';
import { recordDailyResult } from './dailyResults';
import type { DailyResult } from '../../db/dailyResults';

// ---------------------------------------------------------------------------
// Withdrawing a halt that tripped on a booking error (2026-09-23).
//
// The halt is recomputed on every risk check from the day's realized P&L, so
// correcting the ledger changes what the NEXT check sees. But the day's marker,
// the daily results row and the sizing review all keep the halt that already
// fired. That is right for a real halt and wrong for one a phantom loss
// produced. This module is the one way a halt stops counting.
//
// It agrees only when the corrected ledger shows the day's running total never
// at or under the line, at any point in the session (liveDayCloses.ts). Asking
// only about the moment the halt fired was not enough. The alert marks once a
// day, so a day that crossed the line again later, on its own losses, has no
// second marker to show for it.
// ---------------------------------------------------------------------------

export type RetractHaltOutcome =
  | {
      ok: true;
      /** True when a retraction that still holds was already on file. */
      alreadyRetracted: boolean;
      date: string;
      markerPnl: number | null;
      haltLevel: number;
      reading: DayLineReading;
      dailyResult: DailyResult;
    }
  | { ok: false; status: 404 | 409; error: string; reading?: DayLineReading };

/**
 * Retract the live halt on `date`, if the corrected ledger shows it was never
 * earned. Refuses (409) while that session is still open (a halt withdrawn
 * mid-session could trip again uncounted, since the alert marks once a day) and
 * whenever the corrected day reaches the line at any point.
 *
 * On success the day is re-recorded, so the daily results row and the sizing
 * review read the retraction at once rather than at the next close. The
 * retraction keeps being re-checked after that (liveDrawdownHaltRetracted).
 */
export function retractDailyHalt(input: { date: string; reason: string; now?: number }): RetractHaltOutcome {
  const { date, reason } = input;
  const now = input.now ?? Date.now();
  const marker = liveHaltMarkerOn(date);
  if (marker === null) return { ok: false, status: 404, error: `No live daily halt was recorded on ${date}.` };

  const today = etToday(now);
  if (date > today || (date === today && !isAfterSessionClose(now))) {
    return {
      ok: false,
      status: 409,
      error: `The ${date} session has not closed. A halt is retracted after the close, once the day is over.`,
    };
  }

  const haltLevel = marker.detail.haltLevel;
  if (typeof haltLevel !== 'number' || !Number.isFinite(haltLevel)) {
    return { ok: false, status: 409, error: `The ${date} halt marker carries no halt level to judge it against.` };
  }
  const reading = liveDayAgainstLine(date, haltLevel);
  if (reading === null) return { ok: false, status: 409, error: `${date} is not a date the ledger can be read for.` };
  // The risk checks halt at `pnl <= level`, so a day whose running total ever
  // stood at or under it earned a halt, whatever else the correction changed.
  if (reading.reached) {
    return {
      ok: false,
      status: 409,
      error:
        `The corrected ledger puts ${date} at ${reading.lowest.toFixed(2)} at its lowest, at or below its line ` +
        `of ${haltLevel.toFixed(2)}. That halt was earned; it stays.`,
      reading,
    };
  }

  const alreadyRetracted = liveHaltRetractionOnFile(date);
  if (!alreadyRetracted) {
    writeDailyHaltRetraction({
      pool: 'live',
      date,
      reason,
      markerPnl: marker.detail.dailyPnl ?? null,
      haltLevel,
      lowestPnl: reading.lowest,
      totalPnl: reading.total,
      stockPnl: reading.stockPnl,
      optionsPnl: reading.optionsPnl,
      untimedCloses: reading.untimed,
      markerAt: marker.createdAt,
    });
  }
  return {
    ok: true,
    alreadyRetracted,
    date,
    markerPnl: marker.detail.dailyPnl ?? null,
    haltLevel,
    reading,
    dailyResult: recordDailyResult(date, now),
  };
}

import { getAutotradeConfig } from '../../db/autotradeConfig';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { etDayAndMinute, isRegularSessionMinute } from '../../util/marketDate';
import { isTradingSession } from '../trading/marketCalendar';
import type { MlRegime } from '../regimeModel';
import { SHOCK_SHADOW_ACTION, SHOCK_SHADOW_LEVELS, SHOCK_SHADOW_PROXY } from '../shockNowcast';
import { getMarketAtrPct, getMarketRangePct } from './executionGuards';
import { claimOncePerDay } from './oncePerDayEvents';

// ---------------------------------------------------------------------------
// The shock nowcast, MEASURED with its trigger off (2026-09-26; the evidence
// and its rule are in ../shockNowcast.ts).
//
// Every in-session tick reads SPY's range so far ÷ its 14-day ATR through the
// same two functions regimeTriggers reads (executionGuards.ts), so the number
// is exactly what the trigger would have seen, and journals the first time each
// ET day it reaches each level: 0 (the session's first reading, the coverage
// marker), 1, 1.5, 2, 2.5 and 3. The range so far only grows through a session,
// so a day's highest level is its peak, and a restart that forgets the day's
// claims only repeats a level at a later time, which the reader drops.
//
// It runs whatever the trigger's setting, the overlay flag, the kill switch or
// the session buffer: the question is about the market, not the book. Nothing
// sizes, gates or stamps on it. The quote and candles come through the
// provider's caches (15 s and 60 s), which the tick's own SPY reads share.
// ---------------------------------------------------------------------------

export interface ShockShadowReading {
  day: string;
  rangePct: number;
  marketAtrPct: number;
  ratio: number;
  /** The levels journaled on this tick (first reached today). */
  journaled: number[];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * One tick's measurement. Null outside a regular session (weekends, full
 * holidays, before 09:30, from the day's own close — 13:00 on a half day) and
 * whenever the range or the ATR cannot be read, when the trigger would read
 * nothing either. `modelRegime` is the tick's actionable reading, recorded for
 * context only; the evidence pairs each day with the persisted readings.
 */
export async function recordShockShadow(
  modelRegime: MlRegime | null,
  now: number = Date.now(),
): Promise<ShockShadowReading | null> {
  const { day, minute } = etDayAndMinute(now);
  if (!isTradingSession(day) || !isRegularSessionMinute(day, minute)) return null;
  const [rangePct, marketAtrPct] = await Promise.all([
    getMarketRangePct(SHOCK_SHADOW_PROXY),
    getMarketAtrPct(SHOCK_SHADOW_PROXY),
  ]);
  if (rangePct === null || marketAtrPct === null || !(marketAtrPct > 0)) return null;
  const ratio = rangePct / marketAtrPct;
  if (!Number.isFinite(ratio)) return null;

  const journaled: number[] = [];
  for (const level of SHOCK_SHADOW_LEVELS) {
    if (ratio < level) break;
    if (claimOncePerDay(SHOCK_SHADOW_ACTION, String(level), now)) journaled.push(level);
  }
  if (journaled.length > 0) {
    const cfg = getAutotradeConfig();
    const triggerOn = cfg.mlRegimeEnabled && cfg.regimeShockRangeRatio > 0;
    for (const level of journaled) {
      logAutotradeEvent({
        stage: 'screen',
        action: SHOCK_SHADOW_ACTION,
        detail: {
          date: day,
          level,
          at: hhmm(minute),
          ratio: round3(ratio),
          rangePct: round3(rangePct),
          marketAtrPct: round3(marketAtrPct),
          triggerRatio: cfg.regimeShockRangeRatio,
          overlayOn: cfg.mlRegimeEnabled,
          modelRegime: modelRegime ?? 'unknown',
          note:
            level === 0
              ? `the session's first reading of ${SHOCK_SHADOW_PROXY}'s range so far ÷ its ATR — measurement only`
              : `${SHOCK_SHADOW_PROXY}'s range so far reached ${level} × its ATR; the shock trigger is ${
                  triggerOn ? `on at ${cfg.regimeShockRangeRatio}×` : 'off'
                } — measurement only, read against the model's next-session label (docs/MARKET_REGIME_MODEL.md)`,
        },
        riskProfile: cfg.riskProfile,
      });
    }
  }
  return { day, rangePct, marketAtrPct, ratio, journaled };
}

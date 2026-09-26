import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/services/autotrading/executionGuards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/autotrading/executionGuards')>();
  return { ...actual, getMarketRangePct: vi.fn(), getMarketAtrPct: vi.fn() };
});

import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { getMarketAtrPct, getMarketRangePct } from '../src/services/autotrading/executionGuards';
import { recordShockShadow } from '../src/services/autotrading/shockShadow';
import { SHOCK_SHADOW_ACTION } from '../src/services/shockNowcast';

// ---------------------------------------------------------------------------
// The shock nowcast measured with its trigger off (2026-09-26). The trigger
// journals `market_shock_detected` only when it fires, which it cannot do at
// its production ratio of 0, so the gate that would let it on had no evidence
// to read. The measurement reads the same two inputs every in-session tick
// whatever the trigger's setting, and journals each level once a day.
// Every instant here is pinned: the session test must never read the clock.
// ---------------------------------------------------------------------------

const range = vi.mocked(getMarketRangePct);
const atr = vi.mocked(getMarketAtrPct);

/** An ET wall-clock instant; September dates are EDT (UTC-4), November EST. */
const et = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00${date >= '2026-11-01' ? '-05:00' : '-04:00'}`);
const MONDAY = '2026-09-28';

function rows(): Record<string, unknown>[] {
  return listAutotradeEvents({ actions: [SHOCK_SHADOW_ACTION], limit: 100 })
    .reverse()
    .map((e) => ({ stage: e.stage, ...(JSON.parse(e.detail ?? '{}') as Record<string, unknown>) }));
}

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events');
  range.mockReset();
  atr.mockReset().mockResolvedValue(1);
});

describe('recordShockShadow — the measurement', () => {
  it('journals each level the range reaches the first time it reaches it that day, with the trigger off', async () => {
    setAutotradeConfig({ mlRegimeEnabled: false, regimeShockRangeRatio: 0 });
    range.mockResolvedValue(2.2);
    const first = await recordShockShadow(null, et(MONDAY, '10:15'));
    expect(first).toMatchObject({ day: MONDAY, ratio: 2.2, journaled: [0, 1, 1.5, 2] });
    expect(range).toHaveBeenCalledWith('SPY');
    expect(atr).toHaveBeenCalledWith('SPY');
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toMatchObject({
      stage: 'screen',
      date: MONDAY,
      level: 2,
      at: '10:15',
      ratio: 2.2,
      rangePct: 2.2,
      marketAtrPct: 1,
      triggerRatio: 0,
      overlayOn: false,
      modelRegime: 'unknown',
    });
    expect(String(rows()[3].note)).toMatch(/shock trigger is off/);

    // The range only grows through a session: a later tick adds the next level
    // alone, and a quieter reading adds nothing.
    range.mockResolvedValue(2.6);
    expect((await recordShockShadow('sideways', et(MONDAY, '11:40')))?.journaled).toEqual([2.5]);
    range.mockResolvedValue(1.2);
    expect((await recordShockShadow('sideways', et(MONDAY, '12:00')))?.journaled).toEqual([]);
    expect(rows().map((r) => r.level)).toEqual([0, 1, 1.5, 2, 2.5]);
    expect(rows()[4]).toMatchObject({ at: '11:40', modelRegime: 'sideways' });

    // The next session starts again from its first reading.
    range.mockResolvedValue(0.3);
    expect((await recordShockShadow(null, et('2026-09-29', '09:31')))?.journaled).toEqual([0]);
  });

  it('says the trigger is on when it is, and measures the same way', async () => {
    setAutotradeConfig({ mlRegimeEnabled: true, regimeShockRangeRatio: 2 });
    range.mockResolvedValue(1.1);
    expect((await recordShockShadow('low_vol_bullish', et(MONDAY, '15:59')))?.journaled).toEqual([0, 1]);
    expect(rows()[1]).toMatchObject({ level: 1, triggerRatio: 2, overlayOn: true, modelRegime: 'low_vol_bullish' });
    expect(String(rows()[1].note)).toMatch(/on at 2×/);
    setAutotradeConfig({ mlRegimeEnabled: false, regimeShockRangeRatio: 0 });
  });

  it.each([
    ['before the open', et(MONDAY, '09:29')],
    ['at the close', et(MONDAY, '16:00')],
    ['on a Saturday', et('2026-09-26', '11:00')],
    ['on Thanksgiving', et('2026-11-26', '11:00')],
    ["after a half day's 13:00 close", et('2026-11-27', '13:05')],
  ])('reads nothing %s', async (_label, now) => {
    range.mockResolvedValue(3);
    expect(await recordShockShadow(null, now)).toBeNull();
    expect(range).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('records nothing when the range or the ATR cannot be read, as the trigger would read nothing', async () => {
    range.mockResolvedValue(null);
    expect(await recordShockShadow(null, et(MONDAY, '10:00'))).toBeNull();
    range.mockResolvedValue(2);
    atr.mockResolvedValue(null);
    expect(await recordShockShadow(null, et(MONDAY, '10:01'))).toBeNull();
    atr.mockResolvedValue(0);
    expect(await recordShockShadow(null, et(MONDAY, '10:02'))).toBeNull();
    expect(rows()).toHaveLength(0);
    // A half day is still a session before its close.
    atr.mockResolvedValue(1);
    expect((await recordShockShadow(null, et('2026-11-27', '12:55')))?.journaled).toEqual([0, 1, 1.5, 2]);
  });
});

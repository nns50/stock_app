import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/providers/types';
import { computeSessionVwap, indexLegsFromBars } from '../src/services/autotrading/vwap';

// A fixed instant inside the session: 2026-08-21 14:00 UTC = 10:00 ET (Friday).
const NOW = Date.parse('2026-08-21T14:00:00Z');
/** A 5-min bar starting at hh:mm ET on 2026-08-21 (EDT = UTC-4). */
function bar(hhmm: string, close: number, volume: number, over: Partial<Candle> = {}): Candle {
  const [h, m] = hhmm.split(':').map(Number);
  return {
    time: Date.parse(`2026-08-21T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`),
    open: close,
    high: close,
    low: close,
    close,
    volume,
    ...over,
  };
}

describe('computeSessionVwap', () => {
  it('volume-weights typical price across the session bars', () => {
    // Flat bars so typical price == close: (100×100 + 110×300) / 400 = 107.5.
    const v = computeSessionVwap([bar('09:30', 100, 100), bar('09:35', 110, 300)], NOW);
    expect(v).toBe(107.5);
  });

  it('uses (H+L+C)/3 as each bar’s price, not the close alone', () => {
    // H 106, L 100, C 103 → typical 103, on a single bar.
    expect(computeSessionVwap([bar('09:30', 103, 500, { high: 106, low: 100 })], NOW)).toBe(103);
  });

  it('drops pre-market, after-hours, other-day, and zero-volume bars', () => {
    const v = computeSessionVwap(
      [
        bar('09:25', 50, 1_000_000), // pre-market print — excluded
        bar('16:00', 50, 1_000_000), // after the close — excluded
        bar('09:30', 100, 100), // the one real session bar
        bar('10:00', 999, 0), // zero volume — excluded
        { ...bar('09:30', 50, 1_000_000), time: Date.parse('2026-08-20T13:30:00Z') }, // yesterday
      ],
      NOW,
    );
    expect(v).toBe(100);
  });

  it('returns null when nothing usable — never an invented number', () => {
    expect(computeSessionVwap([], NOW)).toBeNull();
    expect(computeSessionVwap([bar('09:25', 100, 500)], NOW)).toBeNull(); // pre-market only
    expect(computeSessionVwap([bar('09:30', 100, 0)], NOW)).toBeNull(); // zero volume only
  });
});

// The tape score's index references (2026-09-26; marketTape.ts): one fetch of
// 5-minute bars gives the session VWAP, the session's opening bar and the
// price 30 minutes ago, never from a bar outside today's session or after now.
describe('indexLegsFromBars — the tape score’s bar references', () => {
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return Date.parse(`2026-08-21T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  };
  // 09:30..10:40, one bar every 5 minutes, closes 100, 101, 102, ...
  const session = Array.from({ length: 15 }, (_, i) => {
    const m = 30 + i * 5;
    const hhmm = `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return bar(hhmm, 100 + i, 1000, { open: 99.5 + i });
  });

  it('reads the opening bar, the VWAP and the close of the bar that ended 30 minutes ago', () => {
    const ctx = indexLegsFromBars(session, at('10:42'));
    expect(ctx.sessionOpen).toBe(99.5);
    // 10:42 - 30 = 10:12: the latest bar ENDED by then is 10:05-10:10 (close 107).
    expect(ctx.closeThirtyMinAgo).toBe(107);
    expect(ctx.vwap).toBe(computeSessionVwap(session, at('10:42')));
  });

  it('ignores a premarket bar, another day, and a bar starting after now', () => {
    const ctx = indexLegsFromBars(
      [
        bar('08:00', 50, 1_000_000, { open: 50 }),
        { ...bar('09:30', 70, 1000, { open: 70 }), time: Date.parse('2026-08-20T13:30:00Z') },
        ...session,
      ],
      at('10:02'),
    );
    expect(ctx.sessionOpen).toBe(99.5);
    // 10:02 - 30 = 09:32: no session bar had ended by then.
    expect(ctx.closeThirtyMinAgo).toBeNull();
    // Only the bars that started by 10:02 (09:30..10:00) go into the VWAP.
    expect(ctx.vwap).toBe(computeSessionVwap(session.slice(0, 7), at('10:02')));
  });

  it('is all null with no session bars', () => {
    expect(indexLegsFromBars([], at('10:42'))).toEqual({ vwap: null, sessionOpen: null, closeThirtyMinAgo: null });
  });
});

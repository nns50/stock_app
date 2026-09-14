import { describe, it, expect } from 'vitest';
import { evaluateAbsorbedPrice, type AbsorbedPriceInput } from '../src/services/autotrading/absorbedPrice';

/** The production defaults, so a change to them fails a test rather than
 *  silently re-scoring every case below. */
const input = (over: Partial<AbsorbedPriceInput> = {}): AbsorbedPriceInput => ({
  sessionRangeUsd: 10,
  atr: 10,
  relVolume: 1,
  minutesIntoSession: 120,
  minRelVolume: 3,
  maxRangeAtrFraction: 0.5,
  minMinutesIntoSession: 30,
  ...over,
});

// The measured session, 2026-09-14. BWIN is the only name that qualifies, and
// the margin on both axes is what the defaults are chosen from.
const SESSION = [
  { symbol: 'BWIN', relVolume: 9.88, atr: 1.133, range: 0.24 },
  { symbol: 'NOW', relVolume: 1.84, atr: 6.554, range: 4.47 },
  { symbol: 'COIN', relVolume: 1.2, atr: 11.32, range: 9.15 },
  { symbol: 'TER', relVolume: 0.64, atr: 17.441, range: 14.93 },
  { symbol: 'VRT', relVolume: 1.16, atr: 13.562, range: 11.94 },
  { symbol: 'CRWD', relVolume: 1.42, atr: 13.369, range: 22.51 },
  { symbol: 'DFTX', relVolume: 2.11, atr: 1.88, range: 3.96 },
];

describe('evaluateAbsorbedPrice', () => {
  it('catches the BWIN shape: heavy volume inside a collapsed range', () => {
    // 9.88x its own average volume, and a $0.24 session range against a $1.133
    // ATR — two hours of tape for thirteen cents of movement, pinned at a
    // buyout price while the screener scored it 85.2.
    const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: 0.24, atr: 1.133, relVolume: 9.88 }));
    expect(out.verdict).toBe('absorbed');
    expect(out.rangeAtrRatio).toBeCloseTo(0.212, 3);
    expect(out.reason).toContain('absorbed at a level');
  });

  it('clears every OTHER name the loop looked at that session', () => {
    // The gate is worth nothing if it also refuses the trades that worked.
    // COIN, NOW and CRWD were the day's three real entries.
    for (const s of SESSION.filter((s) => s.symbol !== 'BWIN')) {
      const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: s.range, atr: s.atr, relVolume: s.relVolume }));
      expect(out.verdict, `${s.symbol} (relVol ${s.relVolume}, range/ATR ${(s.range / s.atr).toFixed(2)})`).toBe(
        'free',
      );
    }
  });

  it('leaves a QUIET name alone — a coil is not an absorption', () => {
    // This is the distinction the volume leg exists for. Light volume in a
    // collapsed range is an ordinary coil that may still break; refusing it
    // would cost the book real breakouts. Same range as BWIN, ordinary volume.
    const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: 0.24, atr: 1.133, relVolume: 1.1 }));
    expect(out.verdict).toBe('free');
  });

  it('leaves a BUSY name alone when it is actually moving', () => {
    // The other half: heavy volume is only damning when the range is dead.
    const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: 1.2, atr: 1.133, relVolume: 9.88 }));
    expect(out.verdict).toBe('free');
  });

  it('refuses to block early in the session, when every name looks collapsed', () => {
    // Range accumulates through the day. Without this guard the gate refuses
    // the whole open — the part of the session the book's edge lives in — and
    // it would have blocked COIN and NOW, which were entered at 09:37.
    const out = evaluateAbsorbedPrice(
      input({ sessionRangeUsd: 0.24, atr: 1.133, relVolume: 9.88, minutesIntoSession: 12 }),
    );
    expect(out.verdict).toBe('too_early');
    // The ratio is still reported, so an early row can be fitted later rather
    // than being a hole in the record.
    expect(out.rangeAtrRatio).toBeCloseTo(0.212, 3);
  });

  it('fires the moment the guard expires, not a tick later', () => {
    const at = (minutesIntoSession: number) =>
      evaluateAbsorbedPrice(input({ sessionRangeUsd: 0.24, atr: 1.133, relVolume: 9.88, minutesIntoSession })).verdict;
    expect(at(29)).toBe('too_early');
    expect(at(30)).toBe('absorbed');
  });

  it('fails OPEN on a missing session range rather than reading it as collapsed', () => {
    // A provider hiccup must not refuse every entry for as long as the feed is
    // unhappy. Unmeasured is not zero.
    expect(evaluateAbsorbedPrice(input({ sessionRangeUsd: null, relVolume: 9.88 })).verdict).toBe('unmeasured');
    expect(evaluateAbsorbedPrice(input({ atr: null, relVolume: 9.88 })).verdict).toBe('unmeasured');
    expect(evaluateAbsorbedPrice(input({ atr: 0, relVolume: 9.88 })).verdict).toBe('unmeasured');
    expect(evaluateAbsorbedPrice(input({ relVolume: null })).verdict).toBe('unmeasured');
  });

  it('switches off entirely when either threshold is 0', () => {
    // The same "0 = off" idiom maxRiskAtrFraction uses, so the two
    // reachability gates are disabled the same way.
    const absorbing = { sessionRangeUsd: 0.24, atr: 1.133, relVolume: 9.88 };
    expect(evaluateAbsorbedPrice(input({ ...absorbing, minRelVolume: 0 })).verdict).toBe('unmeasured');
    expect(evaluateAbsorbedPrice(input({ ...absorbing, maxRangeAtrFraction: 0 })).verdict).toBe('unmeasured');
  });

  it('treats a dead-flat range as absorbed rather than dividing to nothing', () => {
    const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: 0, atr: 1.133, relVolume: 9.88 }));
    expect(out.verdict).toBe('absorbed');
    expect(out.rangeAtrRatio).toBe(0);
  });

  it('names both numbers in the reason, so the skip is auditable without the config', () => {
    const out = evaluateAbsorbedPrice(input({ sessionRangeUsd: 0.24, atr: 1.133, relVolume: 9.88 }));
    expect(out.reason).toContain('9.88x');
    expect(out.reason).toContain('0.21x');
  });
});

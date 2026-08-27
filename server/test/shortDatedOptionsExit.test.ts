import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  evaluateShortDatedExit,
  ShortDatedExitConfig,
  ShortDatedExitPosition,
} from '../src/services/autotrading/shortDatedOptionsExit';

const cfg: ShortDatedExitConfig = {
  shortDatedOptionsEnabled: true,
  optionsHardExitMinutesBeforeClose: 120, // 14:00 ET
  optionsUnderlyingStopPct: 0.5,
  optionsGiveBackArmPct: 40,
  optionsGiveBackPct: 50,
  optionsTakeProfitPct: 60,
  optionsStagnationMinutes: 30,
  optionsStagnationMinMovePct: 0.3,
  optionsDisasterStopPct: 70,
};

/** 11:00 ET on Wednesday 2026-08-26 — mid-session, well clear of the 14:00 cut. */
const MID = Date.parse('2026-08-26T15:00:00Z');
/** 14:30 ET the same day — inside the hard-exit window. */
const LATE = Date.parse('2026-08-26T18:30:00Z');

/** A 0DTE call: underlying 100 at entry, premium 0.41, opened 5 minutes ago. */
const pos = (over: Partial<ShortDatedExitPosition> = {}): ShortDatedExitPosition => ({
  side: 'call',
  kind: 'single_leg',
  entryPrice: 0.41,
  shortEntryPrice: null,
  entryAt: MID - 5 * 60_000,
  underlyingAtEntry: 100,
  peakPremium: 0.41,
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('evaluateShortDatedExit', () => {
  it('is off unless its own flag is set', () => {
    const d = evaluateShortDatedExit(pos(), 0.9, 101, { ...cfg, shortDatedOptionsEnabled: false }, MID);
    expect(d.exit).toBe(false);
    expect(d.detail).toMatch(/off/);
  });

  it('holds a position that is doing nothing wrong', () => {
    // +0.2% underlying, small premium gain, 5 minutes in: no rule applies.
    const d = evaluateShortDatedExit(pos(), 0.46, 100.2, cfg, MID);
    expect(d.exit).toBe(false);
    expect(d.underlyingMovePct).toBe(0.2);
  });

  describe('1. the hard time exit outranks everything', () => {
    it('fires inside the window regardless of how well the trade is doing', () => {
      // Up +120% and still cut. Past ~14:00 a correct thesis stops paying:
      // the same contract at +1% underlying is +15% at 13:30 and -15% at 14:30.
      const d = evaluateShortDatedExit(pos(), 0.9, 101, cfg, LATE);
      expect(d).toMatchObject({ exit: true, rule: 'hard_time' });
    });

    it('fires even with NO quote at all — the clock cannot depend on the provider', () => {
      // Every other rule needs a premium or an underlying. This one must not:
      // a quote outage near the close is exactly when being stuck is worst.
      const d = evaluateShortDatedExit(pos(), null, null, cfg, LATE);
      expect(d).toMatchObject({ exit: true, rule: 'hard_time' });
    });

    it('does nothing mid-session, and can be disabled', () => {
      expect(evaluateShortDatedExit(pos(), 0.45, 100.1, cfg, MID).exit).toBe(false);
      // Disabled at LATE. The position must also be freshly opened here: at
      // 14:30 a position entered at 11:00 is 215 minutes old and flat, so
      // STAGNATION would fire and the assertion would pass for the wrong
      // reason. Anchoring the entry to LATE isolates the clock rule.
      const fresh = pos({ entryAt: LATE - 5 * 60_000 });
      expect(
        evaluateShortDatedExit(fresh, 0.45, 100.1, { ...cfg, optionsHardExitMinutesBeforeClose: 0 }, LATE).exit,
      ).toBe(false);
    });
  });

  describe('2. the stop is on the underlying, not the premium', () => {
    it('cuts on an adverse underlying move', () => {
      const d = evaluateShortDatedExit(pos(), 0.24, 99.4, cfg, MID); // -0.6%
      expect(d).toMatchObject({ exit: true, rule: 'underlying_stop' });
      expect(d.underlyingMovePct).toBe(-0.6);
    });

    it('does NOT cut when only theta has moved the premium — the whole point', () => {
      // Underlying perfectly still, premium down 27% on decay alone. A 40%
      // premium stop would be minutes from firing here on nothing at all;
      // this one correctly sees a thesis that has not been disproved.
      const d = evaluateShortDatedExit(pos(), 0.3, 100.0, cfg, MID);
      expect(d.exit).toBe(false);
      expect(d.premiumGainPct).toBeLessThan(-25);
      expect(d.underlyingMovePct).toBe(0);
    });

    it('means the same thing at every hour, which a premium % never can', () => {
      // Identical underlying move, wildly different premium levels because of
      // decay — the rule fires on both, as it must.
      const early = evaluateShortDatedExit(pos(), 0.3, 99.4, cfg, MID);
      const later = evaluateShortDatedExit(pos({ entryAt: MID - 3 * 3600_000 }), 0.12, 99.4, cfg, MID);
      expect(early.rule).toBe('underlying_stop');
      expect(later.rule).toBe('underlying_stop');
    });

    it('mirrors for a put — a fall is in its favour', () => {
      const put = pos({ side: 'put' });
      // Underlying DOWN 1% is +1% for a put, so the stop must not fire. It
      // does exit — on take-profit, since the premium is up 119% — so assert
      // the rule rather than merely that something happened.
      const helped = evaluateShortDatedExit(put, 0.9, 99.0, cfg, MID);
      expect(helped.underlyingMovePct).toBe(1);
      expect(helped.rule).not.toBe('underlying_stop');
      // Underlying UP is against a put.
      expect(evaluateShortDatedExit(put, 0.2, 100.6, cfg, MID)).toMatchObject({
        exit: true,
        rule: 'underlying_stop',
      });
    });
  });

  describe('3. the give-back trail banks a fading winner', () => {
    it('exits when half the peak gain has evaporated', () => {
      // Peaked at +62% (the spec's worked case), now +25%: 37 points given
      // back, more than half of 62. Held to the 60% target it would have kept
      // fading toward -9%.
      const d = evaluateShortDatedExit(pos({ peakPremium: 0.664 }), 0.5125, 100.4, cfg, MID);
      expect(d).toMatchObject({ exit: true, rule: 'give_back' });
      expect(d.detail).toMatch(/gave back/);
    });

    it('stays armed only above the arm threshold', () => {
      // Peaked +20%, now +5%: a 75% retrace, but of a gain too small to call a
      // fade rather than noise.
      const d = evaluateShortDatedExit(pos({ peakPremium: 0.492 }), 0.4305, 100.1, cfg, MID);
      expect(d.exit).toBe(false);
    });

    it('outranks take-profit, so a fading winner is banked rather than chased', () => {
      // +65% is past the 60% target AND a >50% retrace from a +180% peak. The
      // give-back reason is the honest one: it is leaving because it faded.
      const d = evaluateShortDatedExit(pos({ peakPremium: 1.148 }), 0.6765, 101, cfg, MID);
      expect(d).toMatchObject({ exit: true, rule: 'give_back' });
    });

    it('tracks the peak on every call, including ones that do not fire', () => {
      // The trail is worthless if peaks are only recorded on acting cycles.
      const d = evaluateShortDatedExit(pos(), 0.55, 100.3, cfg, MID);
      expect(d.exit).toBe(false);
      expect(d.peakPremium).toBe(0.55);
    });

    it('never lowers the peak', () => {
      const d = evaluateShortDatedExit(pos({ peakPremium: 0.8 }), 0.6, 100.4, cfg, MID);
      expect(d.peakPremium).toBe(0.8);
    });
  });

  describe('4. take profit', () => {
    it('fires at the configured premium gain', () => {
      const d = evaluateShortDatedExit(pos({ peakPremium: 0.68 }), 0.68, 100.9, cfg, MID); // +66%
      expect(d).toMatchObject({ exit: true, rule: 'take_profit' });
    });
  });

  describe('5. stagnation cuts before decay takes the rest', () => {
    it('cuts a position that has not started working', () => {
      // 35 minutes in, underlying +0.1%. stagnationExit.ts skips options
      // because theta already prices the slot — mild at 30 DTE, and at 0DTE
      // exactly the reason to leave.
      const d = evaluateShortDatedExit(pos({ entryAt: MID - 35 * 60_000 }), 0.36, 100.1, cfg, MID);
      expect(d).toMatchObject({ exit: true, rule: 'stagnation' });
    });

    it('leaves a working position alone at the same age', () => {
      const d = evaluateShortDatedExit(pos({ entryAt: MID - 35 * 60_000 }), 0.52, 100.4, cfg, MID);
      expect(d.exit).toBe(false);
    });

    it('leaves a young position alone even if it is going nowhere', () => {
      const d = evaluateShortDatedExit(pos({ entryAt: MID - 10 * 60_000 }), 0.4, 100.05, cfg, MID);
      expect(d.exit).toBe(false);
    });
  });

  describe('6. the disaster backstop is last and wide', () => {
    it('fires only on a collapse the underlying stop did not catch', () => {
      // Underlying barely moved but the premium is -75% — an IV crush. With
      // no underlying stop configured, this is the only thing left.
      const noUlStop = { ...cfg, optionsUnderlyingStopPct: 0, optionsStagnationMinutes: 0 };
      const d = evaluateShortDatedExit(pos(), 0.1, 100.05, noUlStop, MID);
      expect(d).toMatchObject({ exit: true, rule: 'disaster_stop' });
    });

    it('is wide enough that ordinary decay never reaches it', () => {
      // -63% is the spec's flat-tape decay by 13:30. The backstop at 70% must
      // not fire on it, or it becomes the clock all over again.
      const noUlStop = { ...cfg, optionsUnderlyingStopPct: 0, optionsStagnationMinutes: 0 };
      const d = evaluateShortDatedExit(pos(), 0.1517, 100.0, noUlStop, MID);
      expect(d.exit).toBe(false);
    });
  });

  describe('unmeasurable inputs never invent a trigger', () => {
    it('holds when the premium cannot be read', () => {
      const d = evaluateShortDatedExit(pos(), null, 100.1, cfg, MID);
      expect(d.exit).toBe(false);
      expect(d.premiumGainPct).toBeNull();
    });

    it('skips only the underlying rules when the underlying is unknown', () => {
      // A legacy row with no underlyingAtEntry: the stop and stagnation cut go
      // quiet, but take-profit still works off the premium.
      const legacy = pos({ underlyingAtEntry: null });
      expect(evaluateShortDatedExit(legacy, 0.2, 99.0, cfg, MID).exit).toBe(false);
      expect(evaluateShortDatedExit(legacy, 0.68, 99.0, cfg, MID)).toMatchObject({
        exit: true,
        rule: 'take_profit',
      });
    });

    it('handles a debit spread on its net basis', () => {
      const spread = pos({ kind: 'debit_spread', entryPrice: 1.2, shortEntryPrice: 0.4, peakPremium: 0.8 });
      const d = evaluateShortDatedExit(spread, 1.3, 100.9, cfg, MID); // net 0.8 -> 1.3 = +62.5%
      expect(d).toMatchObject({ exit: true, rule: 'take_profit' });
    });
  });
});

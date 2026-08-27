import { AutotradeConfig } from '../../db/autotradeConfig';
import { LiveOptionsPosition } from '../../db/autotradeLiveOptionsPositions';
import { minutesUntilClose } from './endOfDayFlatten';

// ---------------------------------------------------------------------------
// Short-dated options exits (2026-08-26) — docs/SHORT_DATED_OPTIONS_SPEC.md.
//
// A 0DTE contract is the only options position this account can afford: a
// 7-21 DTE contract costs $241-340 against a ~$44 per-trade risk budget, which
// is why every options signal on 2026-08-26 died on "risk budget is too small
// to size even one contract at this premium". Short-dated fits. It also breaks
// every exit rule the options path had, in three specific ways.
//
// 1. DECAY CLIFFS AFTER ~14:00. Premium of a 0DTE delta-0.30 call bought 09:45,
//    by hour, if the underlying moves +1% (i.e. the thesis is exactly right):
//        13:30  +15%     14:30  -15%     15:00  -34%     15:30  -59%
//    Past roughly 14:00 being right stops paying. The equity flatten at 5
//    minutes before the bell would convert correct trades into near-total
//    losses, which is why HARD_TIME outranks every other rule here: it is the
//    only one whose cost is arithmetic rather than a judgement about price.
//
// 2. UNREALISED GAIN IS PERISHABLE. That same contract at +62% (underlying
//    +1% by 11:30), if the underlying gives back half its move, is -9%. A
//    winner becomes a loser on a modest retrace, so a single fixed target is
//    not enough — hence the give-back trail alongside it.
//
// 3. A %-OF-PREMIUM STOP MEASURES THETA, NOT THE THESIS. With the underlying
//    perfectly still the premium is already -11% at 10:30 and -63% at 13:30.
//    The configured 40% stop therefore fires on a flat tape by early
//    afternoon, every time, with no adverse move whatsoever. So the real stop
//    is on the UNDERLYING, which means the same thing at every hour. The
//    premium percentage survives only as a disaster backstop for a gap or a
//    volatility collapse.
//
// Pure, like scaleOut.ts and stopAdjust.ts: the caller supplies the clock, the
// quotes and the config, and does the closing. Everything here is arithmetic.
// ---------------------------------------------------------------------------

export type ShortDatedExitConfig = Pick<
  AutotradeConfig,
  | 'shortDatedOptionsEnabled'
  | 'optionsHardExitMinutesBeforeClose'
  | 'optionsUnderlyingStopPct'
  | 'optionsGiveBackArmPct'
  | 'optionsGiveBackPct'
  | 'optionsTakeProfitPct'
  | 'optionsStagnationMinutes'
  | 'optionsStagnationMinMovePct'
  | 'optionsDisasterStopPct'
>;

/** Which rule fired. Ordered by priority — see evaluate() for why the clock
 *  outranks everything. */
export type ShortDatedExitRule =
  'hard_time' | 'underlying_stop' | 'give_back' | 'take_profit' | 'stagnation' | 'disaster_stop';

export interface ShortDatedExitDecision {
  exit: boolean;
  rule: ShortDatedExitRule | null;
  /** The premium high-water mark the caller should persist, whether or not it
   *  exits — the give-back trail is useless if the peak is only recorded on
   *  the cycles that fire. Null when the premium is unusable. */
  peakPremium: number | null;
  /** Gain vs entry as a % of premium, for the journal. Null when unmeasurable. */
  premiumGainPct: number | null;
  /** Underlying move since entry, signed so positive always means "in this
   *  position's favour". Null when unmeasurable. */
  underlyingMovePct: number | null;
  detail: string;
}

export type ShortDatedExitPosition = Pick<
  LiveOptionsPosition,
  'side' | 'kind' | 'entryPrice' | 'shortEntryPrice' | 'entryAt' | 'underlyingAtEntry' | 'peakPremium'
>;

const no = (
  detail: string,
  peakPremium: number | null = null,
  premiumGainPct: number | null = null,
  underlyingMovePct: number | null = null,
): ShortDatedExitDecision => ({
  exit: false,
  rule: null,
  peakPremium,
  premiumGainPct,
  underlyingMovePct,
  detail,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Should this short-dated options position close now?
 *
 * `premium` is the CURRENT net basis — the long leg's mark for a single leg,
 * long minus short for a spread — matching how entryPrice/shortEntryPrice are
 * stored. `underlying` is the current underlying price; pass null when it
 * could not be fetched, which disables only the rules that need it rather than
 * the whole ladder (the clock in particular must never depend on a quote).
 */
export function evaluateShortDatedExit(
  pos: ShortDatedExitPosition,
  premium: number | null,
  underlying: number | null,
  cfg: ShortDatedExitConfig,
  now: number,
): ShortDatedExitDecision {
  if (!cfg.shortDatedOptionsEnabled) return no('short-dated options off');

  const entryBasis = pos.kind === 'debit_spread' ? pos.entryPrice - (pos.shortEntryPrice ?? 0) : pos.entryPrice;
  const usablePremium = typeof premium === 'number' && Number.isFinite(premium) && premium > 0 ? premium : null;
  const premiumGainPct =
    usablePremium !== null && entryBasis > 0 ? round2(((usablePremium - entryBasis) / entryBasis) * 100) : null;

  // The peak is maintained on EVERY call, including the ones that decline to
  // exit and the ones where another rule fires first. A trail that only learns
  // about peaks on the cycles it acts is measuring the wrong thing.
  const priorPeak = pos.peakPremium ?? entryBasis;
  const peakPremium = usablePremium !== null ? Math.max(priorPeak, usablePremium) : null;

  // Underlying move, signed so positive is always "in our favour": a put gains
  // when the underlying falls.
  let underlyingMovePct: number | null = null;
  if (
    typeof underlying === 'number' &&
    Number.isFinite(underlying) &&
    underlying > 0 &&
    pos.underlyingAtEntry !== null &&
    pos.underlyingAtEntry > 0
  ) {
    const raw = ((underlying - pos.underlyingAtEntry) / pos.underlyingAtEntry) * 100;
    underlyingMovePct = round2(pos.side === 'put' ? -raw : raw);
  }

  const fire = (rule: ShortDatedExitRule, detail: string): ShortDatedExitDecision => ({
    exit: true,
    rule,
    peakPremium,
    premiumGainPct,
    underlyingMovePct,
    detail,
  });

  // --- 1. HARD TIME EXIT ----------------------------------------------------
  // First, and deliberately independent of every quote: this is the one rule
  // whose cost is certain rather than a judgement about price. Past ~14:00 a
  // correct thesis stops paying, so nothing survives the window.
  if (cfg.optionsHardExitMinutesBeforeClose > 0) {
    const left = minutesUntilClose(now);
    if (left !== null && left <= cfg.optionsHardExitMinutesBeforeClose) {
      return fire('hard_time', `${left}m to the close — short-dated hard exit (decay past here outruns any thesis)`);
    }
  }

  // --- 2. UNDERLYING STOP ---------------------------------------------------
  // The real stop. Time-invariant, because it asks about the stock rather than
  // the contract: -0.5% means the same thing at 10:00 and at 13:00, which no
  // percentage of a decaying premium ever can.
  if (cfg.optionsUnderlyingStopPct > 0 && underlyingMovePct !== null) {
    if (underlyingMovePct <= -cfg.optionsUnderlyingStopPct) {
      return fire(
        'underlying_stop',
        `underlying ${underlyingMovePct}% against the position (stop ${cfg.optionsUnderlyingStopPct}%) — thesis wrong`,
      );
    }
  }

  // --- 3. GIVE-BACK TRAIL ---------------------------------------------------
  // Was up, is fading. Ahead of take-profit on purpose: a position at +62%
  // that has started to roll over should be banked at +31% rather than held
  // for a 60% target it has already passed and is walking away from.
  if (
    cfg.optionsGiveBackArmPct > 0 &&
    cfg.optionsGiveBackPct > 0 &&
    peakPremium !== null &&
    premiumGainPct !== null &&
    entryBasis > 0
  ) {
    const peakGainPct = round2(((peakPremium - entryBasis) / entryBasis) * 100);
    if (peakGainPct >= cfg.optionsGiveBackArmPct) {
      const givenBack = peakGainPct - premiumGainPct;
      if (givenBack >= (peakGainPct * cfg.optionsGiveBackPct) / 100) {
        return fire(
          'give_back',
          `peaked +${peakGainPct}%, now +${premiumGainPct}% — gave back ${round2(givenBack)} of it`,
        );
      }
    }
  }

  // --- 4. TAKE PROFIT -------------------------------------------------------
  if (cfg.optionsTakeProfitPct > 0 && premiumGainPct !== null && premiumGainPct >= cfg.optionsTakeProfitPct) {
    return fire('take_profit', `+${premiumGainPct}% premium — take-profit at ${cfg.optionsTakeProfitPct}%`);
  }

  // --- 5. STAGNATION --------------------------------------------------------
  // The deliberate reversal of stagnationExit.ts's options exclusion. That rule
  // skips options because a stagnant long option "already pays for its slot
  // through theta" — true and mild at 30 DTE, and at 0DTE precisely the reason
  // to cut: -11% by 10:30, -28% by 11:30, for a thesis that has not started.
  if (cfg.optionsStagnationMinutes > 0 && underlyingMovePct !== null) {
    const heldMin = (now - pos.entryAt) / 60_000;
    if (heldMin >= cfg.optionsStagnationMinutes && underlyingMovePct < cfg.optionsStagnationMinMovePct) {
      return fire(
        'stagnation',
        `${Math.round(heldMin)}m held, underlying only ${underlyingMovePct}% — cutting before decay takes the rest`,
      );
    }
  }

  // --- 6. DISASTER BACKSTOP -------------------------------------------------
  // Deliberately last and deliberately wide. A percentage of premium cannot
  // distinguish a wrong thesis from ordinary decay, so this is not management —
  // it is a floor for a gap or a volatility collapse that the underlying stop
  // somehow did not catch.
  if (cfg.optionsDisasterStopPct > 0 && premiumGainPct !== null && premiumGainPct <= -cfg.optionsDisasterStopPct) {
    return fire('disaster_stop', `${premiumGainPct}% premium — disaster backstop at -${cfg.optionsDisasterStopPct}%`);
  }

  return no(
    premiumGainPct === null ? 'no usable premium — holding' : `+${premiumGainPct}% — no exit rule reached`,
    peakPremium,
    premiumGainPct,
    underlyingMovePct,
  );
}

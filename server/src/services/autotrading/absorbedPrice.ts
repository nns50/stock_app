/**
 * Is this name's price FREE TO MOVE today, or is it being absorbed at a level?
 *
 * WHY THIS EXISTS (2026-09-14, BWIN). The operator spotted what the screener
 * structurally cannot: BWIN scored 85.2 — clearing even the raised 81 floor —
 * while being, in their words, "continuous flat for several candles and not
 * going to move". It was up on going-private news, pinned at the buyout price.
 * The journal agrees to the decimal:
 *
 *   09:57:06  price $31.82  total 85.2  gap 8.27%  relVol 7.74
 *   11:48:28  price $31.95  total 85.2  gap 8.27%  relVol 9.88
 *
 * Two hours, thirteen cents, and an IDENTICAL score. Momentum, gap and trend
 * all read 100 — off the one-time deal gap, not off any ongoing move. The
 * model has no way to tell "gapped 8% and still running" from "gapped 8% and
 * died at the deal price".
 *
 * WHY THE EXISTING REACHABILITY GATE MISSES IT, and misses it by design. That
 * gate (liveExecute.ts, `risk_atr_unreachable_skipped`) asks whether 1R fits
 * inside this name's TYPICAL daily range, reading a 14-day ATR. BWIN's ATR was
 * $1.133 — healthy, 3.82% of price, recent daily ranges $0.83-$1.99 — so a
 * $0.741 stop passed at 0.93x of the 0.7 bar. But the ATR is propped up BY THE
 * GAP DAY ITSELF, and today's actual range was $0.24. The same event that
 * maxes the score also inflates the yardstick the gate trusts. Both look at
 * the past, and both are fooled by the same candle.
 *
 * So this asks the other question: not "what does this name usually do" but
 * "what is it ACTUALLY doing today".
 *
 * WHY BOTH CONDITIONS, AND WHY NEITHER ALONE. A collapsed range on its own is
 * not a reason to refuse — it is also exactly what a coiled breakout looks
 * like before it breaks, and refusing those would cost the book real trades.
 * What separates them is VOLUME:
 *
 *   heavy volume + collapsed range = size being absorbed at a fixed price
 *   light volume + collapsed range = an ordinary coil, still free to expand
 *
 * Ten times normal volume inside a fifth of the normal range is not quiet; it
 * is a level someone is defending. Measured across every name the loop looked
 * at that session, BWIN was alone on both axes:
 *
 *   BWIN  relVol 9.88  range/ATR 0.21     <- the only one that qualifies
 *   NOW   relVol 1.84  range/ATR 0.68
 *   COIN  relVol 1.20  range/ATR 0.81
 *   TER   relVol 0.64  range/ATR 0.86
 *   VRT   relVol 1.16  range/ATR 0.88
 *   CRWD  relVol 1.42  range/ATR 1.68
 *   DFTX  relVol 2.11  range/ATR 2.11
 *
 * The next lowest ratio is more than three times BWIN's, and the next highest
 * relVol is a fifth of it. The defaults sit in that gap rather than on either
 * edge of it.
 *
 * WHY THE ELAPSED-MINUTES GUARD. Range accumulates through the session, so
 * every name looks collapsed at 09:31. Without a floor on elapsed time this
 * refuses the whole opening — the part of the day the book's edge actually
 * lives in. Before the guard expires the verdict is `too_early`, never a
 * block.
 *
 * UNITS. `sessionRangeUsd` and `atr` are both PRICE, so their ratio is
 * dimensionless and comparable across names at any price. `relVolume` is this
 * symbol's cumulative volume today over its OWN ~20-day average full-day
 * volume — self-relative, NOT the universe-relative `relVolPace`. The two are
 * never interchangeable here: the question is "heavy for this name", and pace
 * answers "heavy versus everyone else".
 */

export interface AbsorbedPriceInput {
  /** Today's session high minus session low, in price units. Null = unmeasured. */
  sessionRangeUsd: number | null;
  /** The daily ATR the stop was derived from, in price units. Null = unmeasured. */
  atr: number | null | undefined;
  /** Cumulative volume today over this symbol's own average full-day volume. */
  relVolume: number | null | undefined;
  /** Minutes elapsed in the regular session at the moment of the check. */
  minutesIntoSession: number;
  /** Minimum relVolume for "heavy". 0 disables the whole check. */
  minRelVolume: number;
  /** Session range below this FRACTION of ATR counts as collapsed. 0 disables. */
  maxRangeAtrFraction: number;
  /** Elapsed minutes before the check may block anything. */
  minMinutesIntoSession: number;
}

export type AbsorbedPriceVerdict =
  | 'absorbed'
  /** Range is fine, or volume is not heavy — an ordinary name. */
  | 'free'
  /** Too early in the session for range to mean anything yet. */
  | 'too_early'
  /** A required input was missing, or the check is switched off. */
  | 'unmeasured';

export interface AbsorbedPrice {
  verdict: AbsorbedPriceVerdict;
  /** sessionRange ÷ ATR. Null when either side was unmeasured. */
  rangeAtrRatio: number | null;
  relVolume: number | null;
  /** Populated only for an `absorbed` verdict, for the journal and the skip. */
  reason: string | null;
}

const unmeasured = (relVolume: number | null): AbsorbedPrice => ({
  verdict: 'unmeasured',
  rangeAtrRatio: null,
  relVolume,
  reason: null,
});

export function evaluateAbsorbedPrice(input: AbsorbedPriceInput): AbsorbedPrice {
  const {
    sessionRangeUsd,
    atr,
    relVolume,
    minutesIntoSession,
    minRelVolume,
    maxRangeAtrFraction,
    minMinutesIntoSession,
  } = input;

  const rv = typeof relVolume === 'number' && Number.isFinite(relVolume) ? relVolume : null;

  // Either threshold at 0 switches the rule off entirely — the same "0 = off"
  // idiom maxRiskAtrFraction uses, so the two reachability gates are turned
  // off the same way.
  if (!(minRelVolume > 0) || !(maxRangeAtrFraction > 0)) return unmeasured(rv);

  // Fail OPEN on any missing input. A provider hiccup that nulls the session
  // range must never read as "collapsed" — that would refuse every entry for
  // as long as the feed is unhappy, which is the opposite of what a
  // no-data state should cost.
  if (sessionRangeUsd === null || !Number.isFinite(sessionRangeUsd) || sessionRangeUsd < 0) return unmeasured(rv);
  if (typeof atr !== 'number' || !Number.isFinite(atr) || !(atr > 0)) return unmeasured(rv);
  if (rv === null) return unmeasured(rv);

  const rangeAtrRatio = Math.round((sessionRangeUsd / atr) * 1000) / 1000;

  // Checked AFTER the ratio is computed, so an early-session row still carries
  // the number for later fitting rather than reporting nothing.
  if (!(minutesIntoSession >= minMinutesIntoSession)) {
    return { verdict: 'too_early', rangeAtrRatio, relVolume: rv, reason: null };
  }

  const heavy = rv >= minRelVolume;
  const collapsed = rangeAtrRatio < maxRangeAtrFraction;
  if (!heavy || !collapsed) return { verdict: 'free', rangeAtrRatio, relVolume: rv, reason: null };

  return {
    verdict: 'absorbed',
    rangeAtrRatio,
    relVolume: rv,
    reason:
      `trading ${rv.toFixed(2)}x its own average volume inside ${rangeAtrRatio.toFixed(2)}x its daily range ` +
      `(needs ${maxRangeAtrFraction}x) — price is being absorbed at a level, not moving`,
  };
}

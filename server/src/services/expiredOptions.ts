import { Position } from '../db/positions';

// ---------------------------------------------------------------------------
// Expired option positions that are still sitting OPEN in the ledger.
//
// Exits are only ever recorded from a real closing order (the Trade page's
// reconcile, autotrade's own loop, or a hand-logged exit). An option held
// THROUGH expiry never produces one — nobody sells a contract that expired —
// so the position stays `open` forever with quantity remaining. That inflates
// open exposure, the aggregate open-risk caps, the position count, and the
// unrealized P&L tiles with a contract that has not existed since expiry.
//
// This module decides what SHOULD happen to each of them. It is pure: it takes
// positions plus a price lookup and returns findings. The caller books the
// worthless ones and surfaces the rest.
//
// The split is deliberately conservative:
//
//   worthless      — finished out of the money by a clear margin. Its value is
//                    unambiguously zero, so a $0 exit is a statement of fact,
//                    not a guess, and is safe to book automatically.
//   in_the_money   — finished ITM, so it was almost certainly exercised or
//                    assigned. That produces a STOCK position (or removes one)
//                    which this app does not model, and inventing a cash exit
//                    would misstate both the P&L and the resulting holding.
//                    Flagged for a human, never auto-closed.
//   unknown        — no usable price for the expiry date, or close enough to
//                    the strike that pin risk makes the outcome genuinely
//                    uncertain. Flagged, never guessed.
//
// The asymmetry matters: leaving a position open is visible and correctable,
// while a fabricated exit silently writes a realized P&L number that never
// happened into the journal and the tax export.
// ---------------------------------------------------------------------------

/**
 * How close to the strike counts as "too close to call", as a fraction of the
 * strike. Inside this band an option can be exercised even when it settles
 * fractionally out of the money (pin risk — the holder may exercise on
 * after-hours news, and the settlement print itself can differ from the
 * regular-session close this uses). Rather than book a $0 exit that a later
 * assignment would contradict, anything inside the band is handed to a human.
 */
export const PIN_RISK_BAND = 0.0025; // 0.25% of strike

export type ExpiredOptionDisposition = 'worthless' | 'in_the_money' | 'unknown';

/**
 * The minimum an option position must expose to be classified.
 *
 * Structural rather than `Position` so this same reasoning covers autotrade's
 * live options book, which lives in its own table
 * (`autotrade_live_options_positions`) with a different row shape — a debit
 * spread needs a second leg's columns the Positions ledger has no room for.
 * `Position` satisfies this as-is; autotrade adapts its rows onto it (and
 * classifies a spread one leg at a time — see the live options sweep).
 *
 * Note `side` is long/short, NOT the contract type: autotrade's own rows use
 * `side` for call/put and are always long, so the adapter must not pass its
 * `side` straight through.
 */
export interface ExpiringOption {
  id: number;
  symbol: string;
  expiration: string | null;
  side: 'long' | 'short';
  remainingQuantity: number;
  strike: number | null;
  optionType: 'call' | 'put' | null;
}

export interface ExpiredOptionFinding {
  positionId: number;
  symbol: string;
  /** Human label, e.g. "AAPL 200C 2026-07-17". */
  label: string;
  expiration: string;
  side: 'long' | 'short';
  remainingQuantity: number;
  disposition: ExpiredOptionDisposition;
  /** Underlying close on the expiry date, when it could be resolved. */
  underlyingAtExpiry: number | null;
  /** Per-share intrinsic value at expiry (null when undetermined). */
  intrinsic: number | null;
  /** Why this disposition — shown to the user verbatim. */
  reason: string;
}

export function optionLabel(p: Pick<ExpiringOption, 'symbol' | 'strike' | 'optionType' | 'expiration'>): string {
  const type = p.optionType === 'call' ? 'C' : p.optionType === 'put' ? 'P' : '';
  return `${p.symbol} ${p.strike ?? '?'}${type} ${p.expiration ?? ''}`.trim();
}

/**
 * Open option positions whose expiration is strictly BEFORE `today`.
 *
 * Strictly before, not on-or-before: an option is tradeable all through its own
 * expiration day, so sweeping a position on its expiry date would close
 * something that may still be sold, exercised, or roll into a real closing
 * order later the same session.
 */
export function findExpiredOpenOptions(positions: Position[], today: string): Position[] {
  return positions.filter(
    (p) =>
      p.assetType === 'option' &&
      p.status === 'open' &&
      p.remainingQuantity > 0 &&
      !!p.expiration &&
      p.expiration < today,
  );
}

/** Per-share intrinsic value of an option at settlement. */
export function intrinsicAt(optionType: 'call' | 'put', strike: number, underlying: number): number {
  return optionType === 'call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
}

/**
 * Classify each expired-but-open option. `underlyingAtExpiry` returns the
 * underlying's close on that position's expiration date, or null when it can't
 * be resolved — a null is treated as unknown, never as "probably worthless".
 */
export function classifyExpiredOptions<T extends ExpiringOption>(
  expired: T[],
  underlyingAtExpiry: (p: T) => number | null,
): ExpiredOptionFinding[] {
  return expired.map((p) => {
    const base = {
      positionId: p.id,
      symbol: p.symbol,
      label: optionLabel(p),
      expiration: p.expiration ?? '',
      side: p.side,
      remainingQuantity: p.remainingQuantity,
    };

    const strike = p.strike;
    const optionType = p.optionType;
    if (strike === null || strike === undefined || (optionType !== 'call' && optionType !== 'put')) {
      return {
        ...base,
        disposition: 'unknown' as const,
        underlyingAtExpiry: null,
        intrinsic: null,
        reason: 'the position has no strike or option type recorded, so its expiry value cannot be determined',
      };
    }

    const underlying = underlyingAtExpiry(p);
    if (underlying === null || !Number.isFinite(underlying) || underlying <= 0) {
      return {
        ...base,
        disposition: 'unknown' as const,
        underlyingAtExpiry: null,
        intrinsic: null,
        reason: `no usable ${p.symbol} price for ${p.expiration} — cannot tell whether this expired worthless or was exercised`,
      };
    }

    const intrinsic = intrinsicAt(optionType, strike, underlying);
    const distance = Math.abs(underlying - strike);

    if (distance <= strike * PIN_RISK_BAND) {
      return {
        ...base,
        disposition: 'unknown' as const,
        underlyingAtExpiry: underlying,
        intrinsic,
        reason:
          `${p.symbol} closed at ${underlying} against a ${strike} strike — too close to call. ` +
          `An option this near the strike can be exercised even when it settles slightly out of the money, ` +
          `so this needs your broker statement rather than a guess`,
      };
    }

    if (intrinsic > 0) {
      return {
        ...base,
        disposition: 'in_the_money' as const,
        underlyingAtExpiry: underlying,
        intrinsic,
        reason:
          `${p.symbol} closed at ${underlying}, leaving this ${intrinsic.toFixed(2)}/share in the money — ` +
          `it was almost certainly ${p.side === 'long' ? 'exercised' : 'assigned'}, which creates or removes a ` +
          `stock position this app does not track. Record the outcome yourself`,
      };
    }

    return {
      ...base,
      disposition: 'worthless' as const,
      underlyingAtExpiry: underlying,
      intrinsic: 0,
      reason: `${p.symbol} closed at ${underlying} against a ${strike} strike — expired worthless`,
    };
  });
}

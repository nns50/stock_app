// ---------------------------------------------------------------------------
// Sanity guard on the synced account equity (2026-08-27).
//
// syncAccountEquityFromBroker() wrote Webull's total_net_liquidation_value
// verbatim, every tick, with no check at all. On 2026-08-27 that feed was
// unstable: while the account held ONE position (SMCI, 32 shares, ~$1,220,
// moving cents) the reported net liquidation swung between $1,907.21 and
// $2,316.71 — a $409 range on a ~$2,230 account.
//
// Two things read that number, and both were damaged:
//
//   1. THE DAILY TARGET. At 14:16:02 a reading of $2,444.70 against a
//      $2,228.83 baseline banked the day at a fictional +9.69%. For the one
//      open position to have produced that it would have had to trade at
//      $44.98; it was near $39. `reachedAt` is sticky by design, so a single
//      bad tick halted live entries for the rest of the session.
//   2. POSITION SIZING. Every %-of-equity cap is a fraction of this, so a
//      feed swinging 18% sizes every order 18% wrong.
//
// The guard is deliberately NOT a clamp. Clamping writes a number that is
// merely less wrong, and sizing would then run on a value nothing reported.
// Rejecting keeps the last figure the broker actually stood behind, which is
// the honest choice when a feed contradicts itself.
//
// The escape hatch matters as much as the rejection: a deposit, a withdrawal
// or an overnight gap IS a large, real jump, and a guard with no way to accept
// one would freeze equity at a stale value forever. So an out-of-band reading
// that REPEATS — consistently, at the same new level — is accepted. A glitch
// does not reproduce itself three ticks running; a real balance change does.
// ---------------------------------------------------------------------------

export interface EquityGuardState {
  /** The out-of-band level currently being corroborated, or null when the
   *  last reading was in-band. */
  pendingUsd: number | null;
  /** How many consecutive readings have agreed with `pendingUsd`. */
  pendingCount: number;
}

export const freshEquityGuardState = (): EquityGuardState => ({ pendingUsd: null, pendingCount: 0 });

export interface EquityGuardDecision {
  accept: boolean;
  /** Why, for the journal. Null when the reading was ordinary and in-band —
   *  the common case, which must not journal anything. */
  reason: string | null;
  /** Percentage move from the previous accepted equity, for the journal. */
  jumpPct: number | null;
  state: EquityGuardState;
}

/** Consecutive corroborating readings that promote an out-of-band level to
 *  accepted. Three ticks is ~3 minutes at the loop's cadence: long enough that
 *  a transient feed glitch has passed, short enough that a genuine deposit or
 *  overnight gap is reflected before it can distort a session. */
export const EQUITY_GUARD_CONFIRMATIONS = 3;

/** How close two readings must be to count as "the same level" while
 *  corroborating. Generous on purpose — a real new balance still marks to
 *  market between ticks, so demanding equality would never confirm. */
const AGREEMENT_PCT = 1;

const pctDelta = (from: number, to: number): number => Math.abs((to - from) / from) * 100;

/**
 * Should this net-liquidation reading be written?
 *
 * `previousUsd` is the last ACCEPTED equity (null on the very first sync, when
 * there is nothing to compare against and the reading is taken on trust).
 * `maxJumpPct` of 0 disables the guard entirely, restoring the original
 * write-whatever-arrives behaviour.
 */
export function evaluateEquitySync(
  nextUsd: number,
  previousUsd: number | null,
  maxJumpPct: number,
  state: EquityGuardState,
): EquityGuardDecision {
  const clean = freshEquityGuardState();
  if (!(maxJumpPct > 0) || previousUsd === null || !(previousUsd > 0)) {
    return { accept: true, reason: null, jumpPct: null, state: clean };
  }

  const jumpPct = pctDelta(previousUsd, nextUsd);
  if (jumpPct <= maxJumpPct) {
    // Ordinary tick. Any half-corroborated outlier is abandoned: the feed has
    // come back to the level we already trust, so whatever it briefly claimed
    // was noise, not a new balance.
    return { accept: true, reason: null, jumpPct, state: clean };
  }

  // Out of band. Is this the same level we were already corroborating?
  const corroborates = state.pendingUsd !== null && pctDelta(state.pendingUsd, nextUsd) <= AGREEMENT_PCT;
  const pendingCount = corroborates ? state.pendingCount + 1 : 1;

  if (pendingCount >= EQUITY_GUARD_CONFIRMATIONS) {
    return {
      accept: true,
      reason: `accepted after ${pendingCount} consecutive readings near this level — a sustained ${jumpPct.toFixed(1)}% move is a real balance change, not a glitch`,
      jumpPct,
      state: clean,
    };
  }

  return {
    accept: false,
    reason: `rejected: ${jumpPct.toFixed(1)}% jump exceeds the ${maxJumpPct}% guard (reading ${pendingCount}/${EQUITY_GUARD_CONFIRMATIONS} at this level) — keeping the last confirmed equity`,
    jumpPct,
    // Track the level rather than the reading, so a drifting feed still has to
    // agree with ITSELF to get promoted.
    state: { pendingUsd: corroborates ? state.pendingUsd : nextUsd, pendingCount },
  };
}

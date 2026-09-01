import { Position } from '../../db/positions';

// ---------------------------------------------------------------------------
// Same-session re-entry cooldown (2026-09-01).
//
// The loop kept going back to a name it had just exited. Measured over the 26
// live entries from 2026-08-24: FOUR were re-entries into a symbol already
// traded that same day (ANF, ESTC, CRWD, DE) — 15% of the entry budget, on four
// of seven sessions.
//
// symbolCooldown.ts does NOT catch this, by design: it needs
// `symbolCooldownLosses` (>= 2) LOSING closed trades within a rolling window,
// and its own header says "wins and breakeven scratches never count". The
// exit doing the damage here is the STAGNATION exit, which by definition
// scratches near zero — so it is not a loss, never counts, and the cooldown
// never engages. That module also measures in CALENDAR DAYS, so it has no
// intraday opinion at all.
//
// And the re-entry directly contradicts the exit that produced it. The
// stagnation exit journals its own reason as "recycling the slot for fresh
// signals". Handing the freed slot straight back to the name that just failed
// to move is the opposite of a fresh signal — it is the same thesis, at a
// worse time of day, with less of the session left to work.
//
// TIME-BASED, NOT REST-OF-DAY. symbolCooldown's header records the counter-case
// that keeps this honest: LVWR lost -0.98R at 12:30 and the same-day re-entry
// won +1.93R. A genuine second setup hours later is a real thing, so this
// blocks the reflexive re-entry and then gets out of the way.
//
// Gates NEW live entries only. Exits, scale-ins and the paper book are
// untouched — paper stays the always-on sanity track, exactly as the loss
// cooldown leaves it.
// ---------------------------------------------------------------------------

export interface ReentryCooldownState {
  symbol: string;
  /** Epoch ms of the most recent close for this symbol. */
  lastExitAt: number;
  /** Whole minutes since that close. */
  minutesSince: number;
  /** The configured window it is still inside. */
  cooldownMinutes: number;
}

/** Most recent exit timestamp across a position's exits, or null. */
function lastExitAtOf(p: Position): number | null {
  if (!p.exits.length) return null;
  return Math.max(...p.exits.map((e) => e.createdAt));
}

/**
 * Is `symbol` still inside its post-exit cooldown?
 *
 * `closedPositions` should already be filtered to autotrade's own book — a
 * human's manual trade in the same name is not the loop's thesis and must not
 * gate it. Returns null when the feature is off, the symbol has never closed,
 * or the window has elapsed.
 */
export function reentryCooldownFor(
  symbol: string,
  closedPositions: Position[],
  cooldownMinutes: number,
  now: number = Date.now(),
): ReentryCooldownState | null {
  if (!(cooldownMinutes > 0)) return null;
  const exits = closedPositions
    .filter((p) => p.symbol === symbol)
    .map(lastExitAtOf)
    .filter((t): t is number => t !== null);
  if (exits.length === 0) return null;

  const lastExitAt = Math.max(...exits);
  // A clock skew or a future-dated row must never read as "cooled forever".
  const elapsedMs = now - lastExitAt;
  if (elapsedMs < 0) return null;
  const minutesSince = Math.floor(elapsedMs / 60_000);
  if (minutesSince >= cooldownMinutes) return null;
  return { symbol, lastExitAt, minutesSince, cooldownMinutes };
}

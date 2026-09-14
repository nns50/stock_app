/**
 * What the broker has actually REFUSED to fund today, learned from the broker.
 *
 * WHY THIS EXISTS INSTEAD OF A FORMULA (2026-09-14). On the trial sizing's
 * first session the broker refused five opening orders for insufficient buying
 * power while the app's own sizer was happy. Every order that day:
 *
 *   09:37:21  COIN  18 x $184.00  = $3,312.00   exposure $0          filled
 *   09:37:24  NOW   21 x $139.88  = $2,937.48   exposure $0          filled
 *   09:57-10:38  BWIN x4, FTFT   up to $3,720.12  exposure $0        REFUSED
 *   10:40:34  CRWD  15 x $231.97  = $3,479.55   exposure $0          filled
 *   10:44:40  BWIN               = $3,076.80   exposure $3,483.45    REFUSED
 *   10:51:36  BWIN               = $3,111.76   exposure $3,511.50    REFUSED
 *
 * Two things are certain from that. First, MARGIN IS REAL on this account:
 * COIN and NOW were held together, $6,249.48 against $3,497.62 of cash, 1.79x.
 * So a cash bound is wrong — it would have refused NOW outright. Second, the
 * app's available-buying-power figure is WRONG IN THE OTHER DIRECTION: at
 * 09:57 the book was flat (both positions sold), `exposureUsd` was back to 0,
 * the app computed the full $13,990.49 day figure as available, and the broker
 * refused $3,720.12. Closing a position returned the app's exposure to zero;
 * it did not return the broker's pool.
 *
 * Fitting every row, the broker's real ceiling on CUMULATIVE purchases sat
 * between $9,729.03 and $9,969.60 — against a reported `day_buying_power` of
 * $13,990.49. Ten orders are not enough to derive the broker's formula, and a
 * guessed formula is how the four discarded theories (PDT status, unsettled
 * proceeds, a static entitlement, non-marginable small caps) each cost a day.
 *
 * So this does not model the broker. It REMEMBERS it: the smallest notional
 * refused today, and the largest accepted today. The next order is sized to
 * sit between them — a bisection that converges in two or three attempts and
 * needs no theory about what the broker is counting.
 *
 * Scope: in memory, per account, per ET day. Not a column, for the same reason
 * the options re-price budget is not: it is a within-session fact, and a
 * restart forgiving at most one day's learning is cheaper than a schema. It is
 * also strictly a CEILING — it can only ever shrink an order the broker has
 * already demonstrated it will refuse, so it can never cost a fill that was
 * going to happen.
 */

interface DayRefusalState {
  etDate: string;
  /** Smallest opening notional the broker refused today, if any. */
  refusedUsd?: number;
  /** Largest opening notional the broker ACCEPTED today, if any. */
  acceptedUsd?: number;
}

const byAccount = new Map<string, DayRefusalState>();

/** Fraction of a refused notional to aim at when nothing has been accepted yet
 *  today, so there is no lower bracket to bisect against. 10% is one step, not
 *  a tuned number: at 2% a refusal near the true ceiling takes four more
 *  attempts to clear, and at a signal cadence of minutes that is the session. */
const BLIND_STEP_PCT = 10;

function dayState(accountId: string, etDate: string): DayRefusalState {
  const current = byAccount.get(accountId);
  if (current && current.etDate === etDate) return current;
  const fresh: DayRefusalState = { etDate };
  byAccount.set(accountId, fresh);
  return fresh;
}

/** Record that the broker refused an opening order of this notional for
 *  insufficient buying power. Keeps the SMALLEST such notional: the ceiling is
 *  bounded by the tightest refusal seen, not the most recent one. */
export function markBuyingPowerRefusal(accountId: string, etDate: string, notionalUsd: number): void {
  if (!(notionalUsd > 0)) return;
  const st = dayState(accountId, etDate);
  st.refusedUsd = st.refusedUsd === undefined ? notionalUsd : Math.min(st.refusedUsd, notionalUsd);
}

/** Record that the broker ACCEPTED an opening order of this notional — the
 *  lower bracket of the bisection, and the proof the ceiling is at least this
 *  high. */
export function markBuyingPowerAccepted(accountId: string, etDate: string, notionalUsd: number): void {
  if (!(notionalUsd > 0)) return;
  const st = dayState(accountId, etDate);
  st.acceptedUsd = st.acceptedUsd === undefined ? notionalUsd : Math.max(st.acceptedUsd, notionalUsd);
}

export interface LearnedCeiling {
  /** Dollars of notional the next opening order should not exceed. */
  ceilingUsd: number;
  /** The refusal that set the upper bracket. */
  refusedUsd: number;
  /** The largest accepted order today, when there was one to bisect against. */
  acceptedUsd: number | null;
}

/**
 * The largest opening order worth sending now, or undefined when the broker has
 * refused nothing today and there is therefore nothing to learn from.
 *
 * UNITS: both brackets and the result are DOLLARS OF ORDER NOTIONAL (quantity x
 * the marketable limit), which is what the broker judged — not risk, and not
 * buying power. The caller compares it against the same quantity.
 */
export function learnedOpenNotionalCeiling(accountId: string, etDate: string): LearnedCeiling | undefined {
  const st = byAccount.get(accountId);
  if (!st || st.etDate !== etDate || st.refusedUsd === undefined) return undefined;
  const refusedUsd = st.refusedUsd;
  // An accepted order at or above the refusal is not a contradiction to argue
  // with — the pool moves during a session — but it is no longer a valid lower
  // bracket, so fall back to the blind step rather than bisecting upward.
  const accepted = st.acceptedUsd !== undefined && st.acceptedUsd < refusedUsd ? st.acceptedUsd : null;
  const ceilingUsd = accepted === null ? refusedUsd * (1 - BLIND_STEP_PCT / 100) : (accepted + refusedUsd) / 2;
  return { ceilingUsd, refusedUsd, acceptedUsd: accepted };
}

/** Test-only: drop every account's learned state. */
export function resetBuyingPowerRefusals(): void {
  byAccount.clear();
}

/**
 * Whether a broker rejection was a buying-power refusal rather than something
 * else (an unparseable symbol, a halted name, a bad price).
 *
 * Matched on the broker's own wording — "Buying power is insufficient. Please
 * cancel open buy orders (if any) and try again." — case-insensitively and on
 * the two words that carry it, so a reworded message with the same meaning
 * still lands. Over-matching costs one order sized smaller than it needed to
 * be; under-matching costs the whole mechanism, so this leans permissive.
 */
export function isInsufficientBuyingPowerError(error: string | undefined | null): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return text.includes('buying power') && (text.includes('insufficient') || text.includes('not enough'));
}

/**
 * Largest whole quantity whose notional fits under the learned ceiling.
 *
 * UNITS: `ceilingUsd` and `limitPrice * quantity` are both dollars of ORDER
 * NOTIONAL — the quantity the broker judged when it refused. Priced at the
 * LIMIT the order will carry, not the signal entry, for the same reason
 * fundableMaxQuantity does it: a marketable buy limit sits above the quote, so
 * valuing at the entry would send an order dearer than the ceiling it was
 * sized to fit.
 */
export function ceilingCappedQuantity(ceilingUsd: number, limitPrice: number): number | undefined {
  if (!(ceilingUsd >= 0) || !(limitPrice > 0)) return undefined;
  return Math.floor(ceilingUsd / limitPrice);
}

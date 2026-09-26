// ---------------------------------------------------------------------------
// Which way the WHOLE market is leaning today (2026-09-23).
//
// On 2026-09-23 the live book bought four names between 09:50 and 10:13 —
// SHOP, GRML, SMCI, DELL — while SPY sat 0.3-0.5% under its prior close and
// most of the universe traded red. All four stopped out or were closed at a
// loss. Nothing on the entry path looked at the market's direction:
//
//   - the ML regime overlay reads a DAILY model, and it read Low-Vol Bullish
//     that morning;
//   - the ATR guard and the shock nowcast read VOLATILITY, and a quiet red day
//     is neither volatile nor a regime change;
//   - the screener scores each name on its OWN tape, so a stock holding up on
//     a red day scores as strength.
//
// The operator's words: "They may not seem violent but can be outreaching to
// all stocks and vice versa for green days." That is BREADTH — how widely red
// or green the market is — not how far any one index moved.
//
// So a reading has two legs, and a day counts as one-sided only when BOTH
// agree:
//
//   the index    SPY's move vs its own prior close, at least `indexPct` in the
//                day's direction;
//   breadth      at least `breadthPct` of the scored universe on the same side
//                of ITS OWN prior close.
//
// Breadth is the leg the operator asked for. The index leg is there so a
// breadth reading built from stale or partial quotes (a provider hiccup, a
// half-scored universe) cannot fire on its own, and so a day that is red only
// in the small names while the index is green does not read as a red MARKET.
//
// The reading is market data only, the same for both books. What is done with
// it is live-only: the live stock book refuses a long on a red day and a short
// on a green one, and the live options sleeve refuses a call on a red day and a
// put on a green one. The paper book keeps taking every signal as the control,
// the arrangement every other live entry gate uses, so what the gate refused is
// measured rather than assumed.
// ---------------------------------------------------------------------------

/** Which way the market leans this tick. `mixed` is a readable market that is
 *  one-sided in neither direction; `unknown` is a market the reading could not
 *  see (no index quote, or too few names measured). */
export type MarketDirection = 'red' | 'green' | 'mixed' | 'unknown';

/** The tape a trade met, as a report groups it: a direction the loop read, or
 *  `unlabeled` — no reading yet that day, one the loop could not see, or a row
 *  from before the readings began. The tape backfill (historicalTape.ts) and
 *  the short shadow record (shortShadowRecord.ts) both group by it. */
export type TapeBucket = 'red' | 'mixed' | 'green' | 'unlabeled';

export const TAPE_BUCKETS: readonly TapeBucket[] = ['red', 'mixed', 'green', 'unlabeled'];

export function tapeBucketOf(direction: MarketDirection | null | undefined): TapeBucket {
  return direction === null || direction === undefined || direction === 'unknown' ? 'unlabeled' : direction;
}

/** Counts over the scored universe this tick: names below, above and exactly
 *  at their own prior close. */
export interface MarketBreadth {
  red: number;
  green: number;
  flat: number;
  /** Names with a measurable move: red + green + flat. */
  sample: number;
}

export const EMPTY_BREADTH: MarketBreadth = { red: 0, green: 0, flat: 0, sample: 0 };

/** Fewer measured names than this and breadth is not a reading. The universe
 *  is ~560 names and a normal tick scores ~500 of them; under 100 means the
 *  screen mostly failed (a rate-limit storm, a provider outage), and a share
 *  of whatever happened to load says nothing about the market. */
export const MIN_BREADTH_SAMPLE = 100;

/** The journal action the loop writes for a reading, once per change
 *  (claimDirectionChange below). The edge-leak scan reads these rows back to
 *  place each entry against the tape. */
export const MARKET_DIRECTION_ACTION = 'market_direction_read';

/** The market proxy the index leg reads. The same symbol the ATR guard and the
 *  shock nowcast already read. */
export const MARKET_DIRECTION_INDEX_SYMBOL = 'SPY';

export interface MarketDirectionReading {
  direction: MarketDirection;
  indexSymbol: string;
  /** The index's move vs its prior close, in percent. Null when unread. */
  indexChangePct: number | null;
  /** Share of the measured universe below / above its prior close, in percent
   *  (one decimal). Null when the sample is under MIN_BREADTH_SAMPLE. */
  redPct: number | null;
  greenPct: number | null;
  sample: number;
  /** The thresholds this reading was judged against. Carried on the reading so
   *  a journal row states what it was measured against after the settings
   *  move. */
  indexPct: number;
  breadthPct: number;
  /** The exit band a one-sided reading was held against (holdMarketDirection),
   *  as it applied: never stricter than the entry bar. Absent on a raw
   *  reading, which has no band. */
  exitIndexPct?: number;
  exitBreadthPct?: number;
  /** Set only when a hold kept the direction the tape no longer reads on its
   *  own: what this tick read raw (`mixed` or `unknown`), and which hold kept
   *  it. The journal row carries both, so a held stretch can be told from a
   *  tape that met the bar. */
  rawDirection?: MarketDirection;
  heldBy?: DirectionHeldBy;
  /** One line a person can read. */
  detail: string;
}

/** What kept a one-sided reading after the tape stopped meeting the bar:
 *  `hysteresis` — the tape eased back but stayed inside the exit band;
 *  `data_gap` — a tick the reading could not see, soon after the last one that
 *  confirmed the direction. */
export type DirectionHeldBy = 'hysteresis' | 'data_gap';

/** What a reading is judged from. */
export interface MarketDirectionInput {
  indexSymbol: string;
  indexChangePct: number | null;
  breadth: MarketBreadth;
  indexPct: number;
  breadthPct: number;
}

/** Count a set of per-name moves (percent vs prior close) into breadth. A
 *  missing or non-finite move is not a name the reading can see, so it is left
 *  out of the sample rather than counted as flat. */
export function breadthOf(changes: Iterable<number | null | undefined>): MarketBreadth {
  let red = 0;
  let green = 0;
  let flat = 0;
  for (const c of changes) {
    if (c === null || c === undefined || !Number.isFinite(c)) continue;
    if (c < 0) red += 1;
    else if (c > 0) green += 1;
    else flat += 1;
  }
  return { red, green, flat, sample: red + green + flat };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signed(n: number, digits: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** The raw figures both the entry bar and the exit band judge: the index's
 *  move, and the red and green shares of the measured universe in percent.
 *  Null when unread; the shares are null under MIN_BREADTH_SAMPLE. */
interface TapeFigures {
  rawIndex: number | null;
  redShare: number | null;
  greenShare: number | null;
}

function measure(input: MarketDirectionInput): TapeFigures {
  const { breadth } = input;
  const rawIndex = input.indexChangePct !== null && Number.isFinite(input.indexChangePct) ? input.indexChangePct : null;
  const measurable = breadth.sample >= MIN_BREADTH_SAMPLE;
  return {
    rawIndex,
    redShare: measurable ? (breadth.red / breadth.sample) * 100 : null,
    greenShare: measurable ? (breadth.green / breadth.sample) * 100 : null,
  };
}

/** Whether a tape meets a one-sided bar on the given side: red when the index
 *  is strictly down at least `indexPct` AND at least `breadthPct` of names are
 *  red; green mirrors. The entry rule and the exit band both judge through
 *  this one function, so the band can differ from the entry rule only in its
 *  two numbers. */
function sideMet(
  side: 'red' | 'green',
  f: { rawIndex: number; redShare: number; greenShare: number },
  indexPct: number,
  breadthPct: number,
): boolean {
  return side === 'red'
    ? f.rawIndex < 0 && f.rawIndex <= -indexPct && f.redShare >= breadthPct
    : f.rawIndex > 0 && f.rawIndex >= indexPct && f.greenShare >= breadthPct;
}

/** The figures, when the reading can see the whole tape. */
function readable(f: TapeFigures): { rawIndex: number; redShare: number; greenShare: number } | null {
  if (f.rawIndex === null || f.redShare === null || f.greenShare === null) return null;
  return { rawIndex: f.rawIndex, redShare: f.redShare, greenShare: f.greenShare };
}

/**
 * Read the market's direction from the index's move and the universe's
 * breadth.
 *
 * Red when the index is DOWN at least `indexPct` AND at least `breadthPct` of
 * the measured universe is below its own prior close; green is the mirror.
 * Both comparisons are inclusive, and the index must be strictly on the day's
 * side of zero, so `indexPct: 0` means "the index is red at all", never "the
 * index is flat".
 *
 * This is the RAW reading: one tick, judged on its own. The loop acts on
 * holdMarketDirection's reading, which is this one plus the hold.
 */
export function readMarketDirection(input: MarketDirectionInput): MarketDirectionReading {
  const { indexSymbol, breadth, indexPct, breadthPct } = input;
  const figures = measure(input);
  const indexChangePct = figures.rawIndex === null ? null : round2(figures.rawIndex);
  const redPct = figures.redShare === null ? null : round1(figures.redShare);
  const greenPct = figures.greenShare === null ? null : round1(figures.greenShare);
  const base = { indexSymbol, indexChangePct, redPct, greenPct, sample: breadth.sample, indexPct, breadthPct };

  const f = readable(figures);
  if (f === null) {
    const why =
      indexChangePct === null
        ? `no ${indexSymbol} move vs its prior close this tick`
        : `only ${breadth.sample} names measured (needs ${MIN_BREADTH_SAMPLE})`;
    return { ...base, direction: 'unknown', detail: `Market direction unknown: ${why}` };
  }

  // The raw move and the raw counts, not the rounded figures shown: a value
  // that rounds up to the bar must not pass it.
  const tape = tapeLine(base);
  if (sideMet('red', f, indexPct, breadthPct)) {
    return { ...base, direction: 'red', detail: `Broad red market (${tape})` };
  }
  if (sideMet('green', f, indexPct, breadthPct)) {
    return { ...base, direction: 'green', detail: `Broad green market (${tape})` };
  }
  return {
    ...base,
    direction: 'mixed',
    detail: `Mixed market (${tape}; one-sided needs ${indexSymbol} ${indexPct}%+ and ${breadthPct}%+ of names the same way)`,
  };
}

function tapeLine(r: {
  indexSymbol: string;
  indexChangePct: number | null;
  redPct: number | null;
  greenPct: number | null;
  sample: number;
}): string {
  const index = r.indexChangePct === null ? 'unread' : signed(r.indexChangePct, 2);
  return `${r.indexSymbol} ${index}, ${r.redPct}% of ${r.sample} names red, ${r.greenPct}% green`;
}

// --- the hold (2026-09-24) ---------------------------------------------------
//
// The raw reading judges each tick on its own, and a tape sitting near the bar
// crosses it back and forth. Replayed over 22 sessions (2026-08-24..09-23,
// breadth from a 60-name sample of the universe, a reading every 2 minutes),
// the 0.2% / 65% bar changed label 7.4 times a session, and 4.5 of those
// changes were undone within 10 minutes. Each dip to `mixed` in the middle of a
// red day lets that tick's longs through, and each return journals another row.
//
// Two holds, both judged here so the loop and a replay of past sessions apply
// the same rule:
//
//   hysteresis   a red (green) reading stays red while the tape stays inside
//                the EXIT band — the index at least `exitIndexPct` down (up)
//                and at least `exitBreadthPct` of names red (green). Entering
//                still needs the full bar. The band is never stricter than the
//                entry bar, so it can only hold a reading, never drop one.
//   data gap     a tick the reading cannot see (`unknown`: no index move, or
//                fewer than MIN_BREADTH_SAMPLE names) keeps the last one-sided
//                reading for up to DIRECTION_DATA_GAP_HOLD_MS after a readable
//                tape last supported it. An unreadable tick refuses nothing, so
//                without this one rate-limited screen on a red day lets that
//                tick's longs through.
//
// Neither hold crosses the ET day: the index leg is measured against the prior
// close, which moves overnight.

/** How long a one-sided reading outlives ticks the reading cannot see: a
 *  little over two loop ticks (~2m10s each). */
export const DIRECTION_DATA_GAP_HOLD_MS = 5 * 60_000;

/** A one-sided reading being held: its direction, the ET day it belongs to,
 *  and when a readable tape last supported it — by meeting the bar, or by
 *  staying inside the exit band. */
export interface HeldDirection {
  direction: 'red' | 'green';
  day: string;
  confirmedAt: number;
}

export interface DirectionExitBand {
  /** A held red (green) stays while the index is at least this far down (up). */
  exitIndexPct: number;
  /** ...and at least this % of the measured universe is red (green). */
  exitBreadthPct: number;
}

/**
 * One tick of the held reading: the raw reading, plus the two holds. Pure —
 * the caller carries `held` from one tick to the next (the loop through
 * readMarketDirectionForTick; a replay of past sessions through its own loop),
 * so live and replayed sessions apply the same rule by construction.
 *
 * `now` is epoch ms and `day` the ET date of this tick.
 */
export function holdMarketDirection(
  input: MarketDirectionInput & DirectionExitBand,
  prev: HeldDirection | null,
  now: number,
  day: string,
): { reading: MarketDirectionReading; held: HeldDirection | null } {
  const raw = readMarketDirection(input);
  // Never stricter than the entry bar: a band above it would drop a reading
  // that still meets the bar, which is not a hold.
  const band = {
    exitIndexPct: Math.min(input.exitIndexPct, input.indexPct),
    exitBreadthPct: Math.min(input.exitBreadthPct, input.breadthPct),
  };
  const unheld = { ...raw, ...band };
  if (raw.direction === 'red' || raw.direction === 'green') {
    return { reading: unheld, held: { direction: raw.direction, day, confirmedAt: now } };
  }
  // A hold is carried only from a reading the loop confirmed in the last
  // DIRECTION_DATA_GAP_HOLD_MS (2026-09-24, review). The loop returns before
  // its screen while a kill switch, a stop or a macro blackout holds it, and
  // then nothing reads the tape at all. Without this bound the first tick
  // after hours of that, under the bar but inside the band, re-confirmed a red
  // from the morning; the same stretch seen as unreadable ticks would have
  // released after five minutes. Consecutive ticks (~2m10s apart) each
  // refresh a band hold, so this bites only across a gap in the reading.
  const carried =
    prev !== null && prev.day === day && now - prev.confirmedAt <= DIRECTION_DATA_GAP_HOLD_MS ? prev : null;
  if (carried === null) return { reading: unheld, held: null };
  const side = carried.direction;
  const word = side === 'red' ? 'down' : 'up';

  if (raw.direction === 'mixed') {
    const f = readable(measure(input));
    if (f !== null && sideMet(side, f, band.exitIndexPct, band.exitBreadthPct)) {
      return {
        reading: {
          ...unheld,
          direction: side,
          rawDirection: 'mixed',
          heldBy: 'hysteresis',
          detail:
            `Broad ${side} market, held (${tapeLine(raw)}; below the ${raw.indexPct}% / ${raw.breadthPct}% bar ` +
            `but inside the exit band: stays ${side} while ${raw.indexSymbol} is ${band.exitIndexPct}%+ ${word} ` +
            `and ${band.exitBreadthPct}%+ of names are ${side})`,
        },
        held: { ...carried, confirmedAt: now },
      };
    }
    return { reading: unheld, held: null };
  }

  // Unknown: the reading cannot see the tape this tick.
  const gapMs = now - carried.confirmedAt;
  if (gapMs <= DIRECTION_DATA_GAP_HOLD_MS) {
    return {
      reading: {
        ...unheld,
        direction: side,
        rawDirection: 'unknown',
        heldBy: 'data_gap',
        detail:
          `Broad ${side} market, held through a data gap (${raw.detail}; last confirmed ` +
          `${Math.round(gapMs / 1000)}s ago, held up to ${DIRECTION_DATA_GAP_HOLD_MS / 1000}s)`,
      },
      // Not refreshed: a gap never extends itself.
      held: carried,
    };
  }
  return { reading: unheld, held: null };
}

/** Which way an entry leans: a stock buy or a call is long the underlying; a
 *  stock short or a put is short it. */
export type Lean = 'long' | 'short';

/** Why a live stock short may not go out: shorts are off, on without the
 *  stamp their window counts from, or held to a red tape and the tape is not
 *  red. */
export type ShortRefusalCause = 'shorts_off' | 'shorts_unstamped' | 'red_tape_only';

export type ShortPermission = { permitted: true } | { permitted: false; cause: ShortRefusalCause; reason: string };

/**
 * Live stock shorts are ARMED: switched on AND carrying the stamp their
 * probation and revert window count from (2026-09-25, on review). Every writer
 * stamps shorts that are on (setAutotradeConfig), but only when it writes: a
 * row restored or edited by hand with shorts on and no stamp, on a tick whose
 * equity sync writes nothing, would size a short in full, and the stamp the
 * next write sets would then start AFTER it, so neither the probation nor the
 * tripwires would ever count it. Unarmed shorts refuse instead, until that
 * write. The same truthiness test getShortProbationStatus uses, and the ONE
 * test behind both this predicate and the placement guardrail's
 * `allowNakedShort` (liveExecute.ts), so the two cannot disagree.
 */
export function liveShortsArmed(cfg: { liveAllowNakedShort: boolean; liveShortsEnabledAt: number | null }): boolean {
  return cfg.liveAllowNakedShort && Boolean(cfg.liveShortsEnabledAt);
}

/**
 * Whether the live book may put on stock SHORT exposure on this reading
 * (2026-09-24, the tape plan's PR 8): a fresh entry, a scale-in or a per-lot
 * second lot. One predicate for all three, so an add can never go out on a
 * tape a fresh short would be refused on.
 *
 * Shorts off refuses everything. With liveShortsRedTapeOnly, only a RED
 * reading admits; mixed, green, unknown and no reading at all refuse. Asking
 * "not green" instead would admit a mixed tape, the one the rule exists to
 * keep shorts out of.
 */
export function liveShortPermitted(
  cfg: { liveAllowNakedShort: boolean; liveShortsEnabledAt: number | null; liveShortsRedTapeOnly: boolean },
  reading: Pick<MarketDirectionReading, 'direction'> | null,
): ShortPermission {
  if (!cfg.liveAllowNakedShort) return { permitted: false, cause: 'shorts_off', reason: 'liveAllowNakedShort is off' };
  if (!liveShortsArmed(cfg)) {
    return {
      permitted: false,
      cause: 'shorts_unstamped',
      reason:
        'shorts are on without liveShortsEnabledAt: the probation and the revert window count from it, ' +
        'so a short now would be sized in full and never counted (the next config write stamps it)',
    };
  }
  if (cfg.liveShortsRedTapeOnly && reading?.direction !== 'red') {
    return {
      permitted: false,
      cause: 'red_tape_only',
      reason: `red-tape only: the tape is ${reading?.direction ?? 'unread'}`,
    };
  }
  return { permitted: true };
}

/** A reading refuses an entry that leans AGAINST a one-sided market: a long on
 *  a red day, a short on a green one. A mixed or unknown market refuses
 *  nothing — the gate acts only on a one-sided market it can actually see. */
export function directionRefuses(reading: MarketDirectionReading | null, lean: Lean): boolean {
  if (reading === null) return false;
  return (reading.direction === 'red' && lean === 'long') || (reading.direction === 'green' && lean === 'short');
}

/** How an entry sat against the tape at the moment it was taken — the leak
 *  scan's dimension. `mixed` when the market was one-sided in neither
 *  direction; null when there was no reading, which is a trade the dimension
 *  cannot place, not a bucket of its own. */
export type TapeAlignment = 'with' | 'against' | 'mixed';

export function tapeAlignment(direction: MarketDirection | null, lean: Lean): TapeAlignment | null {
  if (direction === null || direction === 'unknown') return null;
  if (direction === 'mixed') return 'mixed';
  return (direction === 'red') === (lean === 'short') ? 'with' : 'against';
}

// --- the journal's change detector ------------------------------------------
//
// The loop journals a reading only when it CHANGES (the first reading of the ET
// day, then every change), which is a handful of rows a session rather than one
// a minute — and still exact: the reading in force at any moment is the latest
// row at or before it, which is how the edge-leak scan places each entry
// against the tape. Module state, like the other once-per-day throttles; a
// restart journals the current reading again, a duplicate that changes nothing.
//
// A change is a new direction OR a new hold (2026-09-24): a red that starts
// being held by hysteresis, or held through a data gap, writes a row, so the
// journal shows when the tape stopped meeting the bar on its own. That makes
// rows and FLIPS different counts — a flip is a change of `direction` between
// consecutive rows, and anything counting flips must compare directions rather
// than count rows.

let lastJournaled: { day: string; key: string } | null = null;

/** What makes two readings the same row: the direction, and the hold that
 *  kept it. The loop's change detector below and the tape rebuild
 *  (historicalTape.ts) both key on this, so a rebuilt session writes the rows
 *  the loop would have written. */
export function directionJournalKey(direction: MarketDirection, heldBy?: DirectionHeldBy): string {
  return heldBy === undefined ? direction : `${direction}|${heldBy}`;
}

/** True when a reading with this direction (and hold) is a change worth a
 *  journal row: the first of the ET day, or a direction or hold different from
 *  the last one journaled. */
export function claimDirectionChange(day: string, direction: MarketDirection, heldBy?: DirectionHeldBy): boolean {
  const key = directionJournalKey(direction, heldBy);
  if (lastJournaled !== null && lastJournaled.day === day && lastJournaled.key === key) return false;
  lastJournaled = { day, key };
  return true;
}

// --- the loop's held reading -------------------------------------------------

let held: HeldDirection | null = null;
let latest: { reading: MarketDirectionReading; at: number } | null = null;

/** The loop's reading for this tick: holdMarketDirection applied to the
 *  previous tick's hold, remembered for the next tick and for the add-on gates
 *  (latestMarketDirection). The only writer of this module's hold state. */
export function readMarketDirectionForTick(
  input: MarketDirectionInput & DirectionExitBand,
  now: number,
  day: string,
): MarketDirectionReading {
  const step = holdMarketDirection(input, held, now, day);
  held = step.held;
  latest = { reading: step.reading, at: now };
  return step.reading;
}

/** How old the loop's last reading may be and still gate an add-on: a few
 *  ticks. Older than this and the loop has not read the market lately (the
 *  screen failed, or the loop stalled), which is a market the add-on gate
 *  cannot see — it refuses nothing, the same as an `unknown` reading. */
export const LATEST_DIRECTION_MAX_AGE_MS = 10 * 60_000;

/** The reading the loop's last screen produced, with its age, when it is
 *  recent enough to stand for now. Scale-ins and per-lot second lots run
 *  BEFORE the tick's screen (loop.ts), so they judge against the previous
 *  tick's reading, about one tick old. Null when there is none that recent. */
export function latestMarketDirection(
  now: number,
  maxAgeMs: number = LATEST_DIRECTION_MAX_AGE_MS,
): { reading: MarketDirectionReading; ageMs: number } | null {
  if (latest === null) return null;
  const ageMs = now - latest.at;
  if (ageMs > maxAgeMs) return null;
  return { reading: latest.reading, ageMs };
}

/** For tests (setupProcessState.ts). */
export function resetMarketDirectionState(): void {
  lastJournaled = null;
  held = null;
  latest = null;
}

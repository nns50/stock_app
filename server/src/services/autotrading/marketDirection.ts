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
  /** One line a person can read. */
  detail: string;
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

/**
 * Read the market's direction from the index's move and the universe's
 * breadth.
 *
 * Red when the index is DOWN at least `indexPct` AND at least `breadthPct` of
 * the measured universe is below its own prior close; green is the mirror.
 * Both comparisons are inclusive, and the index must be strictly on the day's
 * side of zero, so `indexPct: 0` means "the index is red at all", never "the
 * index is flat".
 */
export function readMarketDirection(input: {
  indexSymbol: string;
  indexChangePct: number | null;
  breadth: MarketBreadth;
  indexPct: number;
  breadthPct: number;
}): MarketDirectionReading {
  const { indexSymbol, breadth, indexPct, breadthPct } = input;
  const rawIndex = input.indexChangePct !== null && Number.isFinite(input.indexChangePct) ? input.indexChangePct : null;
  const indexChangePct = rawIndex === null ? null : round2(rawIndex);
  const measurable = breadth.sample >= MIN_BREADTH_SAMPLE;
  const redPct = measurable ? round1((breadth.red / breadth.sample) * 100) : null;
  const greenPct = measurable ? round1((breadth.green / breadth.sample) * 100) : null;
  const base = { indexSymbol, indexChangePct, redPct, greenPct, sample: breadth.sample, indexPct, breadthPct };

  if (rawIndex === null || indexChangePct === null || redPct === null || greenPct === null) {
    const why =
      indexChangePct === null
        ? `no ${indexSymbol} move vs its prior close this tick`
        : `only ${breadth.sample} names measured (needs ${MIN_BREADTH_SAMPLE})`;
    return { ...base, direction: 'unknown', detail: `Market direction unknown: ${why}` };
  }

  const tape = `${indexSymbol} ${signed(indexChangePct, 2)}, ${redPct}% of ${breadth.sample} names red, ${greenPct}% green`;
  // The raw move and the raw counts, not the rounded figures shown: a value
  // that rounds up to the bar must not pass it.
  const redShare = (breadth.red / breadth.sample) * 100;
  const greenShare = (breadth.green / breadth.sample) * 100;
  if (rawIndex < 0 && rawIndex <= -indexPct && redShare >= breadthPct) {
    return { ...base, direction: 'red', detail: `Broad red market (${tape})` };
  }
  if (rawIndex > 0 && rawIndex >= indexPct && greenShare >= breadthPct) {
    return { ...base, direction: 'green', detail: `Broad green market (${tape})` };
  }
  return {
    ...base,
    direction: 'mixed',
    detail: `Mixed market (${tape}; one-sided needs ${indexSymbol} ${indexPct}%+ and ${breadthPct}%+ of names the same way)`,
  };
}

/** Which way an entry leans: a stock buy or a call is long the underlying; a
 *  stock short or a put is short it. */
export type Lean = 'long' | 'short';

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
// day, then every flip), which is a handful of rows a session rather than one a
// minute — and still exact: the reading in force at any moment is the latest
// row at or before it, which is how the edge-leak scan places each entry
// against the tape. Module state, like the other once-per-day throttles; a
// restart journals the current reading again, a duplicate that changes nothing.

let lastJournaled: { day: string; direction: MarketDirection } | null = null;

/** True when a reading with this direction is a change worth a journal row: the
 *  first of the ET day, or a direction different from the last one journaled. */
export function claimDirectionChange(day: string, direction: MarketDirection): boolean {
  if (lastJournaled !== null && lastJournaled.day === day && lastJournaled.direction === direction) return false;
  lastJournaled = { day, direction };
  return true;
}

/** For tests (setupProcessState.ts). */
export function resetMarketDirectionState(): void {
  lastJournaled = null;
}

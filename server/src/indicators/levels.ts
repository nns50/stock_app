import { Bar } from './indicators';

// ---------------------------------------------------------------------------
// Support & resistance from swing structure (2026-08-24).
//
// Every other indicator in this app measures how HARD a stock is moving —
// momentum, relative volume, RSI, ATR, gap, trend. None of them knows WHERE
// price sits in its own history, and the exits paid for it: a stop was placed
// at 1.5x ATR and a target at a flat 2R with no idea whether either sat on top
// of a level the stock has repeatedly refused to cross. A 2R target set through
// a wall the name has failed at three times isn't a target, it's a hope; a stop
// resting just inside a shelf buyers keep defending is an invitation to be
// wicked out at the low.
//
// METHOD — deliberately the plainest thing that works, because a level nobody
// can explain is a level nobody should trade:
//   1. PIVOTS. A swing high is a bar whose high is the highest within
//      `pivotWindow` bars either side; a swing low mirrors it. Requiring
//      confirmation on BOTH sides means the most recent `pivotWindow` bars can
//      never produce a pivot — correct, not a limitation: an unconfirmed
//      extreme is not yet structure, and pretending otherwise invents levels
//      out of whatever price did yesterday.
//   2. ZONES. Real structure is a band, not a number — three tests of "about
//      $15.20" show up as 15.18 / 15.22 / 15.19. Pivots within `tolerancePct`
//      of each other merge into one zone, priced at the volume-free mean of
//      its members, so a shelf tested repeatedly reads as ONE strong level
//      rather than three weak ones.
//   3. STRENGTH. Touch count (more tests = more real) blended with recency
//      (structure decays; a level from 90 bars ago matters less than one from
//      last week). Normalised to 0..1 so callers can threshold it without
//      knowing the internals.
//
// Levels are classified relative to a reference price at the moment they are
// read, NOT when they formed: the same zone is resistance while price is under
// it and support once price is above it. That is how the market treats it —
// broken resistance becomes support — and it means one detection pass serves
// both the long and short side without a second notion of "kind".
//
// Pure math over daily bars. No I/O, no provider, no config coupling — same
// contract as every other function in this directory.
// ---------------------------------------------------------------------------

export interface Pivot {
  /** Index into the bars array the pivot formed at. */
  index: number;
  price: number;
  kind: 'high' | 'low';
}

export interface PriceLevel {
  /** Mean of the pivots that merged into this zone. */
  price: number;
  /** Half-width of the zone: |price - edge|. A test anywhere inside counts. */
  halfWidth: number;
  /** How many distinct pivots formed this zone. */
  touches: number;
  /** Bars since the most recent touch (0 = the newest bar). */
  barsSinceTouch: number;
  /** Whether the merged pivots were swing highs, lows, or both. */
  from: 'highs' | 'lows' | 'both';
  /** 0..1 — touch count blended with recency. */
  strength: number;
}

export interface LevelOptions {
  /** Bars either side that must be lower (higher) to confirm a swing. */
  pivotWindow?: number;
  /** Pivots within this % of each other merge into one zone. */
  tolerancePct?: number;
  /** Ignore pivots older than this many bars. 0 = no limit. */
  lookbackBars?: number;
}

const DEFAULTS = { pivotWindow: 3, tolerancePct: 0.75, lookbackBars: 120 };

/**
 * Confirmed swing pivots. A bar qualifies only when it is the extreme of the
 * full window on BOTH sides, so the last `pivotWindow` bars never produce one
 * (see the header — an unconfirmed extreme is not structure yet).
 *
 * Ties resolve to the LAST bar of a plateau (strict > against the left, >= against
 * the right): a flat double-top is one pivot, not two, and dating it at the later
 * bar keeps `barsSinceTouch` honest about when the level was most recently tested.
 */
export function findPivots(bars: Bar[], pivotWindow = DEFAULTS.pivotWindow): Pivot[] {
  const w = Math.max(1, Math.floor(pivotWindow));
  const out: Pivot[] = [];
  for (let i = w; i < bars.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      const left = j < i;
      if (isHigh && (left ? bars[j].high > bars[i].high : bars[j].high >= bars[i].high)) isHigh = false;
      if (isLow && (left ? bars[j].low < bars[i].low : bars[j].low <= bars[i].low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: bars[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, price: bars[i].low, kind: 'low' });
  }
  return out;
}

/**
 * Merge pivots into price zones and score them. Returns zones sorted by
 * strength, strongest first. Empty when there aren't enough bars to confirm
 * any pivot — never a guessed level.
 */
export function detectLevels(bars: Bar[], opts: LevelOptions = {}): PriceLevel[] {
  const { pivotWindow, tolerancePct, lookbackBars } = { ...DEFAULTS, ...opts };
  if (bars.length < pivotWindow * 2 + 1) return [];
  const newest = bars.length - 1;
  const pivots = findPivots(bars, pivotWindow)
    .filter((p) => lookbackBars <= 0 || newest - p.index <= lookbackBars)
    .sort((a, b) => a.price - b.price);
  if (pivots.length === 0) return [];

  // Single pass over price-sorted pivots: extend the current cluster while the
  // next pivot is within tolerance of the cluster's running mean, else start a
  // new one. Tolerance is relative, so it scales with price — 0.75% is the same
  // structural distance on a $15 stock as on a $300 one.
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [pivots[0]];
  let mean = pivots[0].price;
  for (let i = 1; i < pivots.length; i++) {
    const p = pivots[i];
    if (mean > 0 && (Math.abs(p.price - mean) / mean) * 100 <= tolerancePct) {
      current.push(p);
      mean = current.reduce((s, x) => s + x.price, 0) / current.length;
    } else {
      clusters.push(current);
      current = [p];
      mean = p.price;
    }
  }
  clusters.push(current);

  const maxTouches = Math.max(...clusters.map((c) => c.length));
  return clusters
    .map((c) => {
      const price = c.reduce((s, x) => s + x.price, 0) / c.length;
      const barsSinceTouch = newest - Math.max(...c.map((x) => x.index));
      const kinds = new Set(c.map((x) => x.kind));
      // Touch weight dominates (a thrice-tested level is genuinely stronger),
      // recency modulates it. Recency decays linearly across the lookback so a
      // level at the edge of the window still counts for something.
      const touchScore = c.length / maxTouches;
      const span = lookbackBars > 0 ? lookbackBars : Math.max(1, newest);
      const recency = Math.max(0, 1 - barsSinceTouch / span);
      return {
        price: round4(price),
        halfWidth: round4(Math.max(...c.map((x) => Math.abs(x.price - price)))),
        touches: c.length,
        barsSinceTouch,
        from: kinds.size === 2 ? ('both' as const) : kinds.has('high') ? ('highs' as const) : ('lows' as const),
        strength: round4(0.7 * touchScore + 0.3 * recency),
      };
    })
    .sort((a, b) => b.strength - a.strength);
}

/**
 * The nearest level ABOVE `price` (overhead resistance for a long / a short's
 * risk) and BELOW it (support under a long / a short's objective). Either can
 * be null when nothing qualifies in that direction.
 *
 * `minStrength` filters out noise levels the caller shouldn't trade around —
 * a single stale touch is not a wall.
 */
export function surroundingLevels(
  levels: PriceLevel[],
  price: number,
  minStrength = 0,
): { above: PriceLevel | null; below: PriceLevel | null } {
  let above: PriceLevel | null = null;
  let below: PriceLevel | null = null;
  for (const l of levels) {
    if (l.strength < minStrength) continue;
    // A level is only "above" once its whole zone clears the price — a zone
    // price is standing inside is neither overhead nor underfoot, and treating
    // it as either would place a stop or target in the middle of the fight.
    if (l.price - l.halfWidth > price) {
      if (!above || l.price < above.price) above = l;
    } else if (l.price + l.halfWidth < price) {
      if (!below || l.price > below.price) below = l;
    }
  }
  return { above, below };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

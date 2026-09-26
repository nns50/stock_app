import { getMarketQuoteLegs } from './executionGuards';
import { MarketBreadth, MarketDirection, MarketDirectionReading } from './marketDirection';
import {
  breadthMomentum30,
  breadthNetOf,
  IndexLegReading,
  indexLegsOf,
  recordBreadthNet,
  scoreMarketTape,
  TapeScore,
  tapeDetailLine,
} from './marketTape';
import { fetchTodayIndexContext } from './vwap';

// ---------------------------------------------------------------------------
// The tape score's inputs, gathered (2026-09-26; the rule is marketTape.ts).
//
// The loop hands over what its direction reading was taken from: the reading
// itself (its SPY move and its label) and the screen's breadth. This module
// adds what the reading does not carry: a quote of each index for its price
// against today's open, and one cached 5-minute fetch of each for the session
// VWAP and the price 30 minutes ago. SPY's move vs the previous close is the
// READING's own figure, not a second quote's, so the score's first leg and the
// label cannot disagree about it; QQQ's comes from its quote through the same
// derivation (executionGuards.ts's quoteChangePct).
//
// It runs at the END of the tick (loop.ts), after the entries, so its fetches
// never compete with an order's own quotes; its `readAt` is still the moment
// the reading was taken, which is what places an entry against it. Every fetch
// here fails to null and never throws.
// ---------------------------------------------------------------------------

/** The indexes the price legs average over. SPY is the direction reading's own
 *  index (MARKET_DIRECTION_INDEX_SYMBOL). */
export const TAPE_INDEX_SYMBOLS: readonly string[] = ['SPY', 'QQQ'];

/** What the loop hands over from its direction reading. */
export interface MarketTapeRequest {
  reading: MarketDirectionReading;
  breadth: MarketBreadth;
  /** When the reading was taken (the tick's marketDirectionAt). */
  readAt: number;
  /** That moment's ET day. */
  day: string;
}

/** The tape score for one tick, as the summary and the journal carry it. */
export interface MarketTapeReading extends TapeScore {
  direction: MarketDirection;
  /** When the reading it scores was taken: what an entry is placed against. */
  readAt: number;
  /** When the index quotes and bars were read, a few seconds later. */
  quotedAt: number;
  /** Per index: what it answered (null fields went unmeasured). */
  indexes: IndexLegReading[];
  /** One line a person can read. */
  detail: string;
}

/**
 * Score this tick's tape. Reads the breadth-momentum ring and then adds this
 * tick's breadth to it, so call it once per tick that read the tape.
 */
export async function readMarketTape(req: MarketTapeRequest, now: number = Date.now()): Promise<MarketTapeReading> {
  const breadthNet = breadthNetOf(req.breadth);
  const breadthMomentum = breadthMomentum30(req.day, req.readAt, breadthNet);
  recordBreadthNet(req.day, req.readAt, breadthNet);

  const indexes: IndexLegReading[] = await Promise.all(
    TAPE_INDEX_SYMBOLS.map(async (symbol) => {
      const [quote, bars] = await Promise.all([getMarketQuoteLegs(symbol), fetchTodayIndexContext(symbol, now)]);
      const isReadingIndex = symbol === req.reading.indexSymbol;
      return {
        symbol,
        vsPrevClose: isReadingIndex ? req.reading.indexChangePct : (quote?.changePct ?? null),
        last: quote?.last ?? null,
        open: quote?.open ?? bars.sessionOpen,
        vwap: bars.vwap,
        closeThirtyMinAgo: bars.closeThirtyMinAgo,
      };
    }),
  );

  const tape = scoreMarketTape(req.reading.direction, {
    ...indexLegsOf(indexes),
    breadthNet,
    breadthMomentum30: breadthMomentum,
  });
  return {
    ...tape,
    direction: req.reading.direction,
    readAt: req.readAt,
    quotedAt: now,
    indexes,
    detail: tapeDetailLine(tape, req.reading),
  };
}

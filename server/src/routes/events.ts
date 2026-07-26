import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { getSymbolEvents } from '../services/events';

// Upcoming corporate events (earnings / ex-dividend) for a set of symbols, so
// the UI can flag positions and watchlist names with earnings approaching.
export const eventsRouter = Router();

const query = z.object({ symbols: z.string().min(1) });

/** Bounds the per-symbol fan-out behind this endpoint. */
const MAX_EVENT_SYMBOLS = 100;

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { symbols } = parseQuery(query, req);
    const requested = symbols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const list = requested.slice(0, MAX_EVENT_SYMBOLS);
    // Anything past the cap is named, not dropped in silence: a caller asking
    // about 120 symbols and getting events for 100 has no way to tell the
    // other 20 have no earnings from "we never looked".
    res.json({ events: await getSymbolEvents(list), omitted: requested.slice(MAX_EVENT_SYMBOLS) });
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { getSymbolEvents } from '../services/events';

// Upcoming corporate events (earnings / ex-dividend) for a set of symbols, so
// the UI can flag positions and watchlist names with earnings approaching.
export const eventsRouter = Router();

const query = z.object({ symbols: z.string().min(1) });

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { symbols } = parseQuery(query, req);
    const list = symbols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    res.json({ events: await getSymbolEvents(list) });
  }),
);

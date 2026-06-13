import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from './_helpers';
import { addToWatchlist, getWatchlist, removeFromWatchlist } from '../services/watchlist';

export const watchlistRouter = Router();

watchlistRouter.get('/', (_req, res) => {
  res.json({ symbols: getWatchlist() });
});

const addBody = z.object({ symbol: z.string().min(1).max(12) });
watchlistRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { symbol } = parseBody(addBody, req);
    res.status(201).json({ symbols: addToWatchlist(symbol) });
  }),
);

watchlistRouter.delete(
  '/:symbol',
  asyncHandler(async (req, res) => {
    res.json({ symbols: removeFromWatchlist(param(req, 'symbol')) });
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { getNews } from '../services/news';

// Per-symbol news headlines (Yahoo) — the catalyst context for a move.
export const newsRouter = Router();

const query = z.object({ symbol: z.string().min(1).max(12) });

newsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { symbol } = parseQuery(query, req);
    res.json({ symbol: symbol.toUpperCase(), news: await getNews(symbol) });
  }),
);

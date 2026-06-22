import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseQuery } from './_helpers';
import { getAnalyst } from '../services/analyst';

// Analyst consensus (target + rating) and recent upgrade/downgrade actions.
export const analystRouter = Router();

const query = z.object({ symbol: z.string().min(1).max(12) });

analystRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { symbol } = parseQuery(query, req);
    res.json(await getAnalyst(symbol));
  }),
);

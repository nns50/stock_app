import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from './_helpers';
import { computeRiskSizing } from '../services/riskSizing';

export const toolsRouter = Router();

const sizeBody = z.object({
  accountSize: z.number().positive(),
  riskPct: z.number().positive().max(100),
  entryPrice: z.number().positive(),
  stopPrice: z.number().nonnegative(),
  assetType: z.enum(['stock', 'option']),
  side: z.enum(['long', 'short']).optional(),
  multiplier: z.number().int().positive().optional(),
  targetRMultiple: z.number().positive().optional(),
});

toolsRouter.post(
  '/position-size',
  asyncHandler(async (req, res) => {
    const body = parseBody(sizeBody, req);
    res.json(computeRiskSizing(body));
  }),
);

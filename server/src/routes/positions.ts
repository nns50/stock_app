import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody, parseQuery } from './_helpers';
import {
  addExit,
  createPosition,
  deleteExit,
  deletePosition,
  getPosition,
  listPositions,
  Position,
  PositionFilter,
  updatePosition,
} from '../db/positions';
import { resolveOptionMarks, resolveStockPrices } from '../services/quotes';
import { aggregatePnl, computePositionPnl } from '../services/pnl';
import { computeExposure, ExposureInput } from '../services/exposure';
import { listUniverse } from '../db/universe';

export const positionsRouter = Router();

const createBody = z
  .object({
    assetType: z.enum(['stock', 'option']),
    symbol: z.string().min(1),
    side: z.enum(['long', 'short']),
    quantity: z.number().positive(),
    entryPrice: z.number().nonnegative(),
    entryDate: z.string().min(8),
    entryTime: z
      .string()
      .regex(/^\d{1,2}:\d{2}$/)
      .nullish(),
    fees: z.number().nonnegative().optional(),
    optionType: z.enum(['call', 'put']).nullish(),
    strike: z.number().positive().nullish(),
    expiration: z.string().min(8).nullish(),
    multiplier: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    grade: z.string().nullish(),
    notes: z.string().nullish(),
    checklist: z.array(z.object({ rule: z.string(), checked: z.boolean() })).optional(),
    stopPrice: z.number().positive().nullish(),
    targetPrice: z.number().positive().nullish(),
  })
  .refine((d) => d.assetType !== 'option' || (d.optionType && d.strike && d.expiration), {
    message: 'option positions require optionType, strike and expiration',
  });

const patchBody = z.object({
  tags: z.array(z.string()).optional(),
  grade: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  entryPrice: z.number().nonnegative().optional(),
  quantity: z.number().positive().optional(),
  fees: z.number().nonnegative().optional(),
  entryDate: z.string().min(8).optional(),
  entryTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  stopPrice: z.number().positive().nullable().optional(),
  targetPrice: z.number().positive().nullable().optional(),
});

const exitBody = z.object({
  quantity: z.number().positive(),
  exitPrice: z.number().nonnegative(),
  exitDate: z.string().min(8),
  fees: z.number().nonnegative().optional(),
  notes: z.string().nullable().optional(),
});

const listQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  symbol: z.string().optional(),
  assetType: z.enum(['stock', 'option']).optional(),
  withPnl: z.string().optional(),
});

/** Resolve a current price per position (stocks via quote, options via mark). */
async function priceMap(
  positions: Position[],
): Promise<Map<number, { price: number | null; stale: boolean; asOf: number | null }>> {
  const out = new Map<number, { price: number | null; stale: boolean; asOf: number | null }>();
  const stocks = positions.filter((p) => p.assetType === 'stock');
  const options = positions.filter((p) => p.assetType === 'option');

  if (stocks.length) {
    const prices = await resolveStockPrices(stocks.map((p) => p.symbol));
    for (const p of stocks) {
      const r = prices.get(p.symbol.toUpperCase());
      out.set(p.id, { price: r?.price ?? null, stale: r?.stale ?? false, asOf: r?.asOf ?? null });
    }
  }
  if (options.length) {
    const marks = await resolveOptionMarks(options);
    for (const p of options) {
      const m = marks.get(p.id);
      out.set(p.id, { price: m?.mark ?? null, stale: false, asOf: m?.mark != null ? Date.now() : null });
    }
  }
  return out;
}

async function withPnlPayload(positions: Position[]) {
  const prices = await priceMap(positions);
  const items = positions.map((p) => {
    const info = prices.get(p.id) ?? { price: null, stale: false, asOf: null };
    return {
      position: p,
      price: info.price,
      stale: info.stale,
      asOf: info.asOf,
      pnl: computePositionPnl(p, info.price),
    };
  });
  const aggregate = aggregatePnl(
    items.map((i) => i.pnl),
    positions,
  );

  // Concentration/exposure across the OPEN book, by direction and sector.
  const sectorBySymbol = new Map(listUniverse().map((u) => [u.symbol, u.sector]));
  const openInputs: ExposureInput[] = items
    .filter((i) => i.position.status === 'open')
    .map((i) => ({
      symbol: i.position.symbol,
      side: i.position.side,
      value: i.pnl.marketValue ?? i.pnl.costBasis,
    }));
  const exposure = computeExposure(openInputs, (s) => sectorBySymbol.get(s.toUpperCase()) ?? null);

  return { positions: items, aggregate, exposure };
}

positionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = parseQuery(listQuery, req);
    const filter: PositionFilter = { status: q.status, symbol: q.symbol, assetType: q.assetType };
    const positions = listPositions(filter);
    if (q.withPnl === 'true') {
      res.json(await withPnlPayload(positions));
    } else {
      res.json({ positions });
    }
  }),
);

positionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const pos = getPosition(Number(req.params.id));
    if (!pos) throw new HttpError(404, 'position not found');
    const prices = await priceMap([pos]);
    const info = prices.get(pos.id) ?? { price: null, stale: false, asOf: null };
    res.json({
      position: pos,
      price: info.price,
      stale: info.stale,
      asOf: info.asOf,
      pnl: computePositionPnl(pos, info.price),
    });
  }),
);

positionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(createBody, req);
    const pos = createPosition({
      ...body,
      optionType: body.optionType ?? null,
      strike: body.strike ?? null,
      expiration: body.expiration ?? null,
      grade: body.grade ?? null,
      notes: body.notes ?? null,
    });
    res.status(201).json(pos);
  }),
);

positionsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(patchBody, req);
    const updated = updatePosition(Number(req.params.id), body);
    if (!updated) throw new HttpError(404, 'position not found');
    res.json(updated);
  }),
);

positionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!deletePosition(Number(req.params.id))) throw new HttpError(404, 'position not found');
    res.json({ deleted: Number(req.params.id) });
  }),
);

positionsRouter.post(
  '/:id/exits',
  asyncHandler(async (req, res) => {
    const body = parseBody(exitBody, req);
    const pos = getPosition(Number(req.params.id));
    if (!pos) throw new HttpError(404, 'position not found');
    if (body.quantity > pos.remainingQuantity + 1e-9) {
      throw new HttpError(400, `exit quantity ${body.quantity} exceeds remaining ${pos.remainingQuantity}`);
    }
    const updated = addExit(pos.id, body);
    res.status(201).json(updated);
  }),
);

positionsRouter.delete(
  '/:id/exits/:exitId',
  asyncHandler(async (req, res) => {
    if (!deleteExit(Number(req.params.exitId))) throw new HttpError(404, 'exit not found');
    res.json({ deleted: Number(req.params.exitId), position: getPosition(Number(req.params.id)) });
  }),
);

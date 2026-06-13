import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { createSnapshot, deleteSnapshot, getSnapshot, listSnapshots } from '../db/snapshots';
import { resolveStockPrices } from '../services/quotes';
import { computeEdgeReport, computeSnapshotPerformance } from '../services/snapshotPerf';

export const snapshotsRouter = Router();

const createBody = z.object({
  direction: z.enum(['long', 'short']),
  note: z.string().max(200).optional(),
  picks: z
    .array(z.object({ symbol: z.string().min(1), score: z.number(), price: z.number().positive() }))
    .min(1)
    .max(100),
});

// Save the top picks of a screener run as a dated snapshot.
snapshotsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(createBody, req);
    res.status(201).json(createSnapshot(body.direction, body.note ?? null, body.picks));
  }),
);

snapshotsRouter.get('/', (_req, res) => {
  res.json({ snapshots: listSnapshots() });
});

// Aggregate forward-return edge across ALL snapshots (does the screener work?).
// Registered before '/:id' so the literal path wins.
snapshotsRouter.get(
  '/edge',
  asyncHandler(async (_req, res) => {
    const snaps = listSnapshots()
      .map((s) => getSnapshot(s.id))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const symbols = [...new Set(snaps.flatMap((s) => s.picks.map((p) => p.symbol.toUpperCase())))];
    const priceMap = new Map<string, number | null>();
    if (symbols.length) {
      const prices = await resolveStockPrices(symbols);
      for (const [sym, info] of prices) priceMap.set(sym.toUpperCase(), info.price);
    }
    const report = computeEdgeReport(
      snaps.map((s) => ({ direction: s.direction, picks: s.picks })),
      (sym) => priceMap.get(sym.toUpperCase()) ?? null,
    );
    res.json(report);
  }),
);

snapshotsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const snap = getSnapshot(Number(req.params.id));
    if (!snap) throw new HttpError(404, 'snapshot not found');
    res.json(snap);
  }),
);

// Forward performance: how the picks have moved since the snapshot.
snapshotsRouter.get(
  '/:id/performance',
  asyncHandler(async (req, res) => {
    const snap = getSnapshot(Number(req.params.id));
    if (!snap) throw new HttpError(404, 'snapshot not found');
    const prices = await resolveStockPrices(snap.picks.map((p) => p.symbol));
    const priceMap = new Map<string, number | null>();
    for (const [sym, info] of prices) priceMap.set(sym, info.price);
    const performance = computeSnapshotPerformance(snap.direction, snap.picks, priceMap);
    res.json({
      snapshot: { id: snap.id, createdAt: snap.createdAt, direction: snap.direction, note: snap.note },
      performance,
    });
  }),
);

snapshotsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!deleteSnapshot(Number(req.params.id))) throw new HttpError(404, 'snapshot not found');
    res.json({ deleted: Number(req.params.id) });
  }),
);

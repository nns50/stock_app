import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { asyncHandler, parseBody, parseQuery } from './_helpers';
import { db } from '../db';
import { importPositions, listPositions, type ImportablePosition } from '../db/positions';
import { positionsToCsv, positionsToJson } from '../services/exporter';

export const exportRouter = Router();

const statusQuery = z.object({ status: z.enum(['open', 'closed']).optional() });

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

// Trade data as a spreadsheet (one row per position, with realized P&L).
exportRouter.get(
  '/positions.csv',
  asyncHandler(async (req, res) => {
    const { status } = parseQuery(statusQuery, req);
    const positions = listPositions(status ? { status } : {});
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stock-app-positions-${stamp()}.csv"`);
    res.send(positionsToCsv(positions));
  }),
);

// Structured, round-trippable snapshot (re-importable via POST /import).
exportRouter.get(
  '/positions.json',
  asyncHandler(async (req, res) => {
    const { status } = parseQuery(statusQuery, req);
    const positions = listPositions(status ? { status } : {});
    res.setHeader('Content-Disposition', `attachment; filename="stock-app-positions-${stamp()}.json"`);
    res.json(positionsToJson(positions));
  }),
);

// Consistent snapshot of the entire SQLite database (positions, journal,
// presets, settings, alerts, …) via the online backup API — safe to call while
// the app is running.
exportRouter.get(
  '/backup.db',
  asyncHandler(async (_req, res) => {
    const tmp = path.join(os.tmpdir(), `stock-app-backup-${Date.now()}.db`);
    await db.backup(tmp);
    res.download(tmp, `stock-app-backup-${new Date().toISOString().slice(0, 10)}.db`, (err) => {
      fs.unlink(tmp, () => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  }),
);

const importedExit = z.object({
  quantity: z.number(),
  exitPrice: z.number(),
  exitDate: z.string(),
  fees: z.number().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.number().optional(),
});

const importedPosition = z.object({
  assetType: z.enum(['stock', 'option']),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  quantity: z.number(),
  entryPrice: z.number(),
  entryDate: z.string(),
  fees: z.number().optional(),
  optionType: z.enum(['call', 'put']).nullable().optional(),
  strike: z.number().nullable().optional(),
  expiration: z.string().nullable().optional(),
  multiplier: z.number().optional(),
  status: z.enum(['open', 'closed']).optional(),
  tags: z.array(z.string()).optional(),
  grade: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  checklist: z.array(z.object({ rule: z.string(), checked: z.boolean() })).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  exits: z.array(importedExit).optional(),
});

const importBody = z.object({
  positions: z.array(importedPosition).max(10000),
  mode: z.enum(['merge', 'replace']).default('merge'),
});

// Restore trade history from a positions.json export. 'replace' clears existing
// positions first; 'merge' appends. Atomic (single transaction).
exportRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const body = parseBody(importBody, req);
    const result = importPositions(body.positions as ImportablePosition[], body.mode);
    res.json({ ...result, totalNow: listPositions().length });
  }),
);

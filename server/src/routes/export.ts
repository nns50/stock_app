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

// This schema is the RESTORE side of positions.json, so it has to accept
// everything the export side writes. Zod strips keys a schema doesn't list, so
// a field missing here isn't a lax check — it's silent data loss on every
// restore: positionsToJson() emits the whole Position, and any column absent
// below was quietly dropped on the way back in.
//
// It also has to hold the same line routes/positions.ts holds. Import is a
// second door into the same journal, and a value it lets through is
// indistinguishable afterwards from one the create route refused — so the
// date and positivity rules are shared, not re-stated loosely here.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const importedExit = z.object({
  quantity: z.number().positive(),
  exitPrice: z.number().nonnegative(),
  exitDate: isoDate,
  fees: z.number().nonnegative().optional(),
  notes: z.string().nullable().optional(),
  sourceIntentId: z.number().nullable().optional(),
  createdAt: z.number().optional(),
});

const importedPosition = z.object({
  assetType: z.enum(['stock', 'option']),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  quantity: z.number().positive(),
  // Positive for the same reason POST /positions demands it: a 0 entry makes
  // costBasis 0, so the entire market value books as unrealized "gain".
  entryPrice: z.number().positive(),
  entryDate: isoDate,
  /** Restores the time-of-day breakdown. Absent here until 2026-07-26, so
   *  every restore silently flattened it to null. */
  entryTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  fees: z.number().nonnegative().optional(),
  optionType: z.enum(['call', 'put']).nullable().optional(),
  strike: z.number().positive().nullable().optional(),
  expiration: isoDate.nullable().optional(),
  multiplier: z.number().int().positive().optional(),
  status: z.enum(['open', 'closed']).optional(),
  tags: z.array(z.string()).optional(),
  grade: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  checklist: z.array(z.object({ rule: z.string(), checked: z.boolean() })).optional(),
  stopPrice: z.number().positive().nullable().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  sourceIntentId: z.number().nullable().optional(),
  /** Which brokerage account the lot lives in. Absent here until 2026-07-26,
   *  so a restore (and the Positions page's own delete-Undo, which round-trips
   *  through this route) handed every position back unassigned — re-creating
   *  exactly the account-blind state that column exists to prevent. */
  accountId: z.string().nullable().optional(),
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

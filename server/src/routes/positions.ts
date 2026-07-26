import { Request, Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody, parseQuery } from './_helpers';
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
import { priceMap } from '../services/quotes';
import { aggregatePnl, computePositionPnl } from '../services/pnl';
import { computeExposure, ExposureInput } from '../services/exposure';
import { computePortfolioStress } from '../services/portfolioStress';
import { computePortfolioCorrelation } from '../services/portfolioCorrelation';
import { listUniverse } from '../db/universe';
import { isWebullTracked } from '../providers/webull/positions';
import { closeLivePosition } from '../services/trading/closePosition';
import { detectWashSale } from '../services/washSale';
import { sweepExpiredOptions } from '../services/expiredOptionsSweep';

export const positionsRouter = Router();

/** A record id from the path. `Number('abc')` is NaN, which SQLite binds as
 *  NULL — every lookup then misses and reports a plain "not found", quietly
 *  presenting a malformed request as a missing row. Parsed strictly so a bad
 *  id says so (400) and only a genuinely absent row 404s. */
function idParam(req: Request, name: string): number {
  const raw = param(req, name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid ${name}: ${JSON.stringify(raw)}`);
  return n;
}

// Every date the journal stores is a plain YYYY-MM-DD string, compared
// LEXICOGRAPHICALLY (hold-time buckets, the wash-sale window, the equity
// curve's ordering, the exit-before-entry check below, the CSV/tax export). A
// merely "long enough" string — '07/26/2026', '2026-7-4' — sorts and subtracts
// as garbage against those, so it doesn't just display wrong, it silently
// corrupts the analytics computed from it. Reject it at the door instead.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const createBody = z
  .object({
    assetType: z.enum(['stock', 'option']),
    symbol: z.string().min(1),
    side: z.enum(['long', 'short']),
    quantity: z.number().positive(),
    // Must be > 0: a 0 entry makes costBasis 0, so computePositionPnl books the
    // entire market value as unrealized "gain" and returnPct/rMultiple go null.
    entryPrice: z.number().positive(),
    entryDate: isoDate,
    entryTime: z
      .string()
      .regex(/^\d{1,2}:\d{2}$/)
      .nullish(),
    fees: z.number().nonnegative().optional(),
    optionType: z.enum(['call', 'put']).nullish(),
    strike: z.number().positive().nullish(),
    expiration: isoDate.nullish(),
    multiplier: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    grade: z.string().nullish(),
    notes: z.string().nullish(),
    checklist: z.array(z.object({ rule: z.string(), checked: z.boolean() })).optional(),
    stopPrice: z.number().positive().nullish(),
    targetPrice: z.number().positive().nullish(),
    accountId: z.string().nullish(),
  })
  .refine((d) => d.assetType !== 'option' || (d.optionType && d.strike && d.expiration), {
    message: 'option positions require optionType, strike and expiration',
  });

const patchBody = z.object({
  tags: z.array(z.string()).optional(),
  grade: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  entryPrice: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  fees: z.number().nonnegative().optional(),
  entryDate: isoDate.optional(),
  entryTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional(),
  stopPrice: z.number().positive().nullable().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  accountId: z.string().nullable().optional(),
});

const exitBody = z.object({
  quantity: z.number().positive(),
  exitPrice: z.number().nonnegative(),
  exitDate: isoDate,
  fees: z.number().nonnegative().optional(),
  notes: z.string().nullable().optional(),
});

const listQuery = z.object({
  status: z.enum(['open', 'closed']).optional(),
  symbol: z.string().optional(),
  assetType: z.enum(['stock', 'option']).optional(),
  withPnl: z.string().optional(),
});

/** What the STILL-OPEN part of a lot cost — the honest fallback when no live
 *  price resolved. The whole-lot costBasis would count a half-exited position
 *  at twice the capital it actually still has at risk. */
function remainingCostBasis(p: Position): number {
  return p.entryPrice * p.remainingQuantity * p.multiplier;
}

async function withPnlPayload(positions: Position[]) {
  // A fully-exited OPTION lot's contract is normally expired and no longer in
  // any chain, and resolveOptionMarks() spends one provider chain fetch per
  // (symbol, expiration) group — so pricing closed options burns a request per
  // refresh (every 60s, on a page that polls) to learn nothing: with nothing
  // left open, computePositionPnl books 0 unrealized and 0 market value no
  // matter what the mark is. Stocks stay in — they're one batched, cached
  // quote call for the whole set, and their last price still reads sensibly
  // next to a closed row.
  const prices = await priceMap(positions.filter((p) => p.assetType !== 'option' || p.remainingQuantity > 1e-9));
  // Wash-sale detection needs visibility into EVERY position sharing a
  // symbol, not just the ones this call was filtered to (e.g. status:
  // 'closed' for the Journal) — a reopened lot might still be open. Fetched
  // once, unfiltered, and grouped in memory rather than one query per
  // closed position. Skipped entirely when this payload has no closed row at
  // all (the Dashboard's open book), since detectWashSale() only ever fires
  // for a closed one.
  const bySymbol = new Map<string, Position[]>();
  if (positions.some((p) => p.status === 'closed')) {
    for (const p of listPositions()) {
      const arr = bySymbol.get(p.symbol);
      if (arr) arr.push(p);
      else bySymbol.set(p.symbol, [p]);
    }
  }
  const items = positions.map((p) => {
    const info = prices.get(p.id) ?? { price: null, stale: false, asOf: null };
    return {
      position: p,
      price: info.price,
      stale: info.stale,
      asOf: info.asOf,
      pnl: computePositionPnl(p, info.price),
      washSale: detectWashSale(p, bySymbol.get(p.symbol) ?? []),
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
      value: i.pnl.marketValue ?? remainingCostBasis(i.position),
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

// Registered ahead of '/:id' — otherwise Express would match this literal path
// as an :id param instead.
positionsRouter.get(
  '/stress-test',
  asyncHandler(async (_req, res) => {
    const open = listPositions({ status: 'open' });
    res.json(await computePortfolioStress(open));
  }),
);

// Expired-but-still-open option positions. GET classifies without writing (what
// the Positions banner shows); POST books the $0 exits for the ones that
// unambiguously expired worthless and leaves the rest flagged. Both registered
// ahead of '/:id' so Express doesn't read the literal path as an id.
positionsRouter.get(
  '/expired-options',
  asyncHandler(async (_req, res) => {
    res.json(await sweepExpiredOptions({ dryRun: true }));
  }),
);

positionsRouter.post(
  '/expired-options/sweep',
  asyncHandler(async (_req, res) => {
    res.json(await sweepExpiredOptions());
  }),
);

const DEFAULT_CORRELATION_LOOKBACK_DAYS = 30;
const correlationQuery = z.object({ lookbackDays: z.coerce.number().int().min(5).max(250).optional() });

// Pairwise correlation of daily returns across the open book's underlyings —
// see services/portfolioCorrelation.ts. Registered ahead of '/:id' too.
positionsRouter.get(
  '/correlation',
  asyncHandler(async (req, res) => {
    const q = parseQuery(correlationQuery, req);
    const open = listPositions({ status: 'open' });
    res.json(await computePortfolioCorrelation(open, q.lookbackDays ?? DEFAULT_CORRELATION_LOOKBACK_DAYS));
  }),
);

positionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const pos = getPosition(idParam(req, 'id'));
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
    const id = idParam(req, 'id');
    const body = parseBody(patchBody, req);
    const existing = getPosition(id);
    if (!existing) throw new HttpError(404, 'position not found');
    // Shrinking the size below what's already been exited leaves a lot holding
    // exits it can't account for: remainingQuantity clamps at 0, recomputeStatus
    // flips it to 'closed', and every realized-P&L number is then computed
    // against a size the position never had. A quantity that contradicts the
    // exits is a reason to refuse the edit, not to silently absorb it.
    if (body.quantity !== undefined) {
      const exited = existing.exits.reduce((s, e) => s + e.quantity, 0);
      if (body.quantity + 1e-9 < exited) {
        throw new HttpError(400, `quantity ${body.quantity} is below the ${exited} already exited`);
      }
    }
    const updated = updatePosition(id, body);
    if (!updated) throw new HttpError(404, 'position not found');
    res.json(updated);
  }),
);

positionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req, 'id');
    if (!deletePosition(id)) throw new HttpError(404, 'position not found');
    res.json({ deleted: id });
  }),
);

positionsRouter.post(
  '/:id/exits',
  asyncHandler(async (req, res) => {
    const body = parseBody(exitBody, req);
    const pos = getPosition(idParam(req, 'id'));
    if (!pos) throw new HttpError(404, 'position not found');
    if (body.quantity > pos.remainingQuantity + 1e-9) {
      throw new HttpError(400, `exit quantity ${body.quantity} exceeds remaining ${pos.remainingQuantity}`);
    }
    // A $0 exit is legitimate for an option that expired worthless, but for a
    // stock it silently books a full-loss realized P&L (the schema allows 0 so
    // the option case works — guard the stock case here instead).
    if (pos.assetType === 'stock' && body.exitPrice <= 0) {
      throw new HttpError(400, 'exit price must be greater than 0 for a stock position');
    }
    // An exit before the entry yields negative hold-days and a negative
    // wash-sale window; reject rather than corrupt the journal's time stats.
    if (body.exitDate < pos.entryDate) {
      throw new HttpError(400, `exit date ${body.exitDate} is before entry date ${pos.entryDate}`);
    }
    const updated = addExit(pos.id, body);
    res.status(201).json(updated);
  }),
);

positionsRouter.delete(
  '/:id/exits/:exitId',
  asyncHandler(async (req, res) => {
    const id = idParam(req, 'id');
    const exitId = idParam(req, 'exitId');
    const pos = getPosition(id);
    if (!pos) throw new HttpError(404, 'position not found');
    // The delete has to be scoped to THIS position's own exits. Keyed on the
    // exit id alone, any exit was reachable through any position's URL — so a
    // mismatched pair silently reopened an unrelated lot for the quantity it
    // closed, while the response reported the position from the path as if
    // that were what changed.
    if (!pos.exits.some((e) => e.id === exitId)) throw new HttpError(404, 'exit not found on this position');
    if (!deleteExit(exitId)) throw new HttpError(404, 'exit not found');
    res.json({ deleted: exitId, position: getPosition(id) });
  }),
);

// Close a REAL (broker-tracked) position for real: cancels any resting
// bracket first, then places an actual closing order through the same
// TRADING_ENABLED + type-to-confirm + guardrails pipeline the Trade page
// uses (services/trading/closePosition.ts). Distinct from POST /:id/exits
// above, which only ever writes a journal entry — the right action for a
// manually-logged/paper-tracked position (there's nothing to place an order
// against), but a silent no-op toward the broker for a live one. This route
// is the fix: only reachable for a position isWebullTracked() considers
// broker-attributable.
const closeBody = z.object({
  accountId: z.string().min(1).max(64),
  confirmation: z.string().min(1).max(64),
});
positionsRouter.post(
  '/:id/close',
  asyncHandler(async (req, res) => {
    const body = parseBody(closeBody, req);
    const pos = getPosition(idParam(req, 'id'));
    if (!pos) throw new HttpError(404, 'position not found');
    if (pos.status !== 'open' || pos.remainingQuantity <= 1e-9) {
      throw new HttpError(409, 'position is already closed');
    }
    if (!isWebullTracked(pos)) {
      throw new HttpError(400, 'not a broker-tracked position — use POST /:id/exits to record a manual exit instead');
    }
    res.json(await closeLivePosition(pos, body.accountId, body.confirmation));
  }),
);

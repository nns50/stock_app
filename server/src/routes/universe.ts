import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { addSymbols, listUniverse, removeSymbol, replaceUniverse } from '../db/universe';
import { DATA_DIR } from '../util/paths';

export const universeRouter = Router();

// Accept either ["AAPL","MSFT"] or [{symbol,name,sector}] for convenience.
const symbolEntry = z.union([
  z.string().min(1),
  z.object({ symbol: z.string().min(1), name: z.string().optional(), sector: z.string().optional() }),
]);
const symbolsBody = z.object({ symbols: z.array(symbolEntry).min(1) });

function normalize(entries: z.infer<typeof symbolsBody>['symbols']) {
  return entries.map((e) => (typeof e === 'string' ? { symbol: e } : e));
}

universeRouter.get('/', (_req, res) => {
  res.json({ symbols: listUniverse() });
});

// Bundled S&P 500 reference list (for an "add from index" picker in the UI).
universeRouter.get(
  '/source',
  asyncHandler(async (_req, res) => {
    const file = path.join(DATA_DIR, 'sp500.json');
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    res.json({ source: 'sp500', symbols: data });
  }),
);

universeRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(symbolsBody, req);
    const added = addSymbols(normalize(body.symbols));
    res.json({ added, symbols: listUniverse() });
  }),
);

universeRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(symbolsBody, req);
    const count = replaceUniverse(normalize(body.symbols));
    res.json({ count, symbols: listUniverse() });
  }),
);

universeRouter.delete(
  '/:symbol',
  asyncHandler(async (req, res) => {
    const ok = removeSymbol(req.params.symbol);
    if (!ok) throw new HttpError(404, `${req.params.symbol} not in universe`);
    res.json({ removed: req.params.symbol.toUpperCase() });
  }),
);

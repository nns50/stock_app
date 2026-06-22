import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, parseQuery } from './_helpers';
import { ProbeKind, webullProbe, webullStatus } from '../providers/webull/account';
import { importWebullPositions, previewWebullPositions } from '../providers/webull/positions';
import { webullMovers } from '../providers/webull/movers';
import { webullOptionQuotes } from '../providers/webull/optionQuotes';

// Webull connectivity: report whether credentials are configured, and run a
// read-only probe to validate them live + reveal response shapes. Session-gated
// (mounted after the auth middleware) since it touches the brokerage account.
export const webullRouter = Router();

webullRouter.get('/status', (_req, res) => {
  res.json(webullStatus());
});

const probeBody = z.object({
  kind: z.enum([
    'account-list',
    'snapshot',
    'bars',
    'movers',
    'depth',
    'option-snapshot',
    'positions',
    'balance',
    'subscriptions',
  ]),
  symbol: z.string().max(24).optional(), // up to a full OCC option symbol
  accountId: z.string().max(64).optional(),
});

webullRouter.post(
  '/probe',
  asyncHandler(async (req, res) => {
    const { kind, symbol, accountId } = parseBody(probeBody, req);
    res.json(await webullProbe(kind as ProbeKind, { symbol, accountId }));
  }),
);

const accountBody = z.object({ accountId: z.string().min(1).max(64) });

// Positions sync (preview-and-confirm): preview maps live Webull positions and
// writes nothing; import adds the open positions the journal doesn't already
// have (never edits or deletes existing entries).
webullRouter.post(
  '/positions/preview',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(accountBody, req);
    res.json(await previewWebullPositions(accountId));
  }),
);

webullRouter.post(
  '/positions/import',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(accountBody, req);
    res.json(await importWebullPositions(accountId));
  }),
);

// Market movers (gainers / losers / most-active) from Webull's server-side
// screeners. Read-only; works whenever Webull keys are set.
const moversQuery = z.object({
  list: z.enum(['gainers', 'losers', 'active', 'unusual']).default('gainers'),
  session: z.enum(['regular', 'premarket', 'afterhours']).default('regular'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

webullRouter.get(
  '/movers',
  asyncHandler(async (req, res) => {
    const { list, session, limit } = parseQuery(moversQuery, req);
    res.json(await webullMovers(list, limit, session));
  }),
);

// Live option quotes (real bid/ask/size/volume/OI/greeks from OPRA) for one or
// more OCC contract symbols — overlays the delayed Yahoo chain. Read-only;
// works whenever Webull keys are set and the app has an options entitlement.
const optionQuotesQuery = z.object({
  symbols: z.string().min(1).max(2048), // comma-separated OCC symbols
});

webullRouter.get(
  '/option-quotes',
  asyncHandler(async (req, res) => {
    const { symbols } = parseQuery(optionQuotesQuery, req);
    res.json(await webullOptionQuotes(symbols.split(',')));
  }),
);

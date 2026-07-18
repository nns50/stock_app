import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody, parseQuery } from './_helpers';
import { ProbeKind, webullProbe, webullStatus } from '../providers/webull/account';
import { comparePositionsToBroker, importWebullPositions, previewWebullPositions } from '../providers/webull/positions';
import {
  getWebullSyncConfig,
  setWebullSyncConfig,
  syncWebullAccount,
  MIN_SYNC_INTERVAL_SECONDS,
} from '../services/webullPositionsScheduler';
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
    'open-orders',
    'order-history',
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

// On-demand, read-only side-by-side: every contract the broker currently
// shows held for this account vs. what the journal shows open, matches
// included — unlike sync/preview above, writes nothing and reports
// everything, not just confirmed gaps, so a mismatch is visible immediately.
webullRouter.post(
  '/positions/compare',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(accountBody, req);
    res.json(await comparePositionsToBroker(accountId));
  }),
);

// Full sync (reconcile working orders, close positions Webull no longer
// shows, import new ones) — what the "Sync now" button and the background
// scheduler both call. Unlike preview/import above, this writes without a
// confirm step (see services/webullPositionsScheduler.ts's syncWebullAccount).
webullRouter.post(
  '/positions/sync',
  asyncHandler(async (req, res) => {
    const { accountId } = parseBody(accountBody, req);
    res.json(await syncWebullAccount(accountId));
  }),
);

// Background sync scheduler config — enable/interval/account id. The loop
// itself starts unconditionally at boot (services/webullPositionsScheduler.ts)
// and no-ops until enabled with an account id set here.
const schedulerBody = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(MIN_SYNC_INTERVAL_SECONDS).max(86400).optional(),
  accountId: z.string().max(64).nullable().optional(),
});

webullRouter.get('/positions/scheduler', (_req, res) => {
  res.json(getWebullSyncConfig());
});

webullRouter.post(
  '/positions/scheduler',
  asyncHandler(async (req, res) => {
    res.json(setWebullSyncConfig(parseBody(schedulerBody, req)));
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

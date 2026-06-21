import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parseBody } from './_helpers';
import { ProbeKind, webullProbe, webullStatus } from '../providers/webull/account';
import { importWebullPositions, previewWebullPositions } from '../providers/webull/positions';

// Webull connectivity: report whether credentials are configured, and run a
// read-only probe to validate them live + reveal response shapes. Session-gated
// (mounted after the auth middleware) since it touches the brokerage account.
export const webullRouter = Router();

webullRouter.get('/status', (_req, res) => {
  res.json(webullStatus());
});

const probeBody = z.object({
  kind: z.enum(['account-list', 'snapshot', 'bars', 'positions', 'balance', 'subscriptions']),
  symbol: z.string().max(10).optional(),
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

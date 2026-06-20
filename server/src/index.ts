import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { initDb } from './db';
import { getProvider, getProviderStatus } from './providers';
import { ProviderError } from './providers/MarketDataProvider';
import { HttpError } from './routes/_helpers';
import { marketRouter } from './routes/market';
import { universeRouter } from './routes/universe';
import { screenerRouter } from './routes/screener';
import { presetsRouter } from './routes/presets';
import { optionsRouter } from './routes/options';
import { positionsRouter } from './routes/positions';
import { journalRouter } from './routes/journal';
import { settingsRouter } from './routes/settings';
import { toolsRouter } from './routes/tools';
import { snapshotsRouter } from './routes/snapshots';
import { alertsRouter } from './routes/alerts';
import { exportRouter } from './routes/export';
import { watchlistRouter } from './routes/watchlist';
import { authRouter, requireAuth } from './routes/auth';
import { startAlertScheduler } from './services/alertScheduler';

initDb();

export const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Health stays open (used by container/Fly health checks) and so does the auth
// router (login/status). Everything else under /api requires a session when
// APP_PASSWORD is set; `requireAuth` is a no-op when auth is disabled.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now(), provider: getProviderStatus() });
});
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);

app.use('/api', marketRouter);
app.use('/api/universe', universeRouter);
app.use('/api/screener', screenerRouter);
app.use('/api/presets', presetsRouter);
app.use('/api/options', optionsRouter);
app.use('/api/positions', positionsRouter);
app.use('/api/journal', journalRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/snapshots', snapshotsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/export', exportRouter);
app.use('/api/watchlist', watchlistRouter);

// Unknown API route
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// In production, serve the built frontend and fall back to index.html for SPA
// client-side routes. Enabled by setting PUBLIC_DIR (e.g. in Docker).
if (config.publicDir && fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir));
  // SPA fallback. Express 5 (path-to-regexp 8) rejects a bare '*' route, so use a
  // pathless middleware and serve index.html for non-API GETs.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });
}

// Centralized error handler: maps ProviderError / HttpError / Zod issues to JSON.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let message = 'Internal server error';
  if (err instanceof HttpError || err instanceof ProviderError) {
    status = err.status;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  }
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: message });
});

// Only listen when run directly (tests import `app` without binding a port).
if (require.main === module) {
  app.listen(config.port, () => {
    const status = getProviderStatus();

    console.log(
      `[stock-app] API on http://localhost:${config.port}  provider=${status.name}` +
        `${status.synthetic ? ' (synthetic)' : ''}${status.configured ? '' : ' [NOT CONFIGURED]'}`,
    );
    // Prime any first-call cost (e.g. Yahoo's cookie/crumb) in the background so
    // the user's first request doesn't pay for it.
    const warm = getProvider().warmup?.();
    if (warm) warm.catch(() => {});
    // Start the background alert poller (no-op until enabled in Settings).
    startAlertScheduler();
  });
}

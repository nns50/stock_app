import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { db, initDb } from './db';
import { getLastTick } from './db/autotradeLastTick';
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
import { webullRouter } from './routes/webull';
import { eventsRouter } from './routes/events';
import { newsRouter } from './routes/news';
import { analystRouter } from './routes/analyst';
import { tradeRouter } from './routes/trade';
import { autotradeRouter } from './routes/autotrade';
import { authRouter, requireAuth } from './routes/auth';
import { startAlertScheduler, stopAlertScheduler } from './services/alertScheduler';
import { startWebullPositionsSync, stopWebullPositionsSync } from './services/webullPositionsScheduler';
import { startAutotradeLoop, stopAutotradeLoop } from './services/autotrading/loop';

initDb();

export const app = express();
// No Express fingerprint header; the version disclosure serves nobody here.
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Baseline security headers, applied to every response (API and the served
// SPA alike). Deliberately only the set that cannot break this app: nothing
// legitimately embeds it in a frame, no cross-origin page needs referrers
// from it, and no response should ever be MIME-sniffed into something else.
//
// The Content-Security-Policy is strict because the built SPA was audited to
// need nothing looser (2026-07-28, re-verified in a real Chromium against the
// production bundle): no inline scripts (the theme-init script is external —
// web/public/theme-init.js — precisely so script-src can stay 'self'), no
// inline <style> or url()/data:/blob: references in the emitted CSS, no
// workers, no eval, and every request the browser makes is same-origin
// (`/api/*`, hashed /assets, /icon.svg). React/Recharts set styles through
// the CSSOM (element.style), which CSP does not restrict, so charts need no
// 'unsafe-inline'. If a future dependency genuinely needs a looser policy,
// loosen the ONE directive it needs — never the script ones.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Health stays open (used by container/Fly health checks and external uptime
// pingers — see docs/DEPLOY.md's monitoring section) and so does the auth
// router (login/status). Everything else under /api requires a session when
// APP_PASSWORD is set; `requireAuth` is a no-op when auth is disabled.
app.get('/api/health', (_req, res) => {
  // A trivial read proves the DATABASE is actually usable, not just that the
  // process accepts sockets — if this throws, the error handler's 500 fails
  // the platform health check, which is exactly the point: a deploy whose
  // volume didn't mount (or whose DB file is wedged) should read unhealthy,
  // not "ok" because Express happens to be up.
  db.prepare('SELECT 1').get();
  // The autotrade loop persists a tick summary every ~60s once the server is
  // up — even fully disabled it still runs its exit/reconcile pass — so a
  // large age here means the loop (or the whole event loop) is wedged. Null
  // before the first tick after boot, or on a fresh database. Informational
  // (never fails the check itself): an external monitor can alert on it, but
  // auto-restarting on it would loop on a deliberately stopped loop.
  const lastTick = getLastTick();
  res.json({
    ok: true,
    time: Date.now(),
    provider: getProviderStatus(),
    loopLastTickAgeMs: lastTick ? Date.now() - lastTick.ranAt : null,
  });
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
app.use('/api/webull', webullRouter);
app.use('/api/events', eventsRouter);
app.use('/api/news', newsRouter);
app.use('/api/analyst', analystRouter);
app.use('/api/trade', tradeRouter);
app.use('/api/autotrade', autotradeRouter);

// Unknown API route
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// In production, serve the built frontend and fall back to index.html for SPA
// client-side routes. Enabled by setting PUBLIC_DIR (e.g. in Docker).
//
// Cache policy avoids stale-bundle bugs after a deploy: Vite's hashed assets
// (/assets/*.[hash].js) are immutable so cache them for a year, but index.html
// MUST always be revalidated — otherwise a browser keeps an old index that
// references the previous build's chunks, and the app runs stale code.
if (config.publicDir && fs.existsSync(config.publicDir)) {
  app.use(
    express.static(config.publicDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA fallback. Express 5 (path-to-regexp 8) rejects a bare '*' route, so use a
  // pathless middleware and serve index.html for non-API GETs.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
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
  const server = app.listen(config.port, () => {
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
    // Start the background Webull positions sync (no-op until an account id
    // is set on Settings — enabled by default otherwise).
    startWebullPositionsSync();
    // Start the autonomous paper execution loop (no-op until enabled on the
    // Auto-Trade page — see docs/AUTOTRADING_SPEC.md, Phase 6).
    startAutotradeLoop();
  });

  // Graceful shutdown — Fly (and Docker) deliver SIGTERM on every deploy/stop,
  // and the default handler kills the process mid-whatever-it-was-doing. The
  // order here is deliberate: stop the background loops FIRST so nothing new
  // is placed or evaluated during the drain (stopAutotradeLoop() also aborts a
  // genuinely in-flight tick at its own pre-execution checkpoint), then let
  // in-flight HTTP requests finish, then close the DB. WAL mode makes an
  // abrupt kill crash-safe for the data either way — this narrows the window
  // where a deploy lands between a live order placement and its journaling.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // a second signal while draining: let the backstop finish it
    shuttingDown = true;
    console.log(`[stock-app] ${signal} received — draining requests, stopping background loops`);
    stopAutotradeLoop();
    stopAlertScheduler();
    stopWebullPositionsSync();
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed / mid-statement — the exit below is the point */
      }
      process.exit(0);
    });
    // Backstop: if a request (or a hung broker call behind one) won't drain,
    // exit before the platform escalates to SIGKILL mid-write anyway.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

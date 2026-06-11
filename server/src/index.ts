import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { config } from './config';
import { initDb } from './db';
import { getProviderStatus } from './providers';
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

initDb();

export const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now(), provider: getProviderStatus() });
});

app.use('/api', marketRouter);
app.use('/api/universe', universeRouter);
app.use('/api/screener', screenerRouter);
app.use('/api/presets', presetsRouter);
app.use('/api/options', optionsRouter);
app.use('/api/positions', positionsRouter);
app.use('/api/journal', journalRouter);
app.use('/api/settings', settingsRouter);

// Unknown API route
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler: maps ProviderError / HttpError / Zod issues to JSON.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let message = 'Internal server error';
  let code: string | undefined;
  if (err instanceof HttpError || err instanceof ProviderError) {
    status = err.status;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  }
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({ error: message, code });
});

// Only listen when run directly (tests import `app` without binding a port).
if (require.main === module) {
  app.listen(config.port, () => {
    const status = getProviderStatus();
    // eslint-disable-next-line no-console
    console.log(
      `[stock-app] API on http://localhost:${config.port}  provider=${status.name}` +
        `${status.synthetic ? ' (synthetic)' : ''}${status.configured ? '' : ' [NOT CONFIGURED]'}`,
    );
  });
}

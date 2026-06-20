import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { asyncHandler, parseBody } from './_helpers';
import { authRequired, checkPassword, isAuthenticated, issueToken, SESSION_COOKIE } from '../services/auth';

export const authRouter = Router();

const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.auth.secureCookie,
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

// Whether a login is needed and whether this client already has one. Ungated so
// the SPA can decide what to render.
authRouter.get('/status', (req, res) => {
  res.json({ required: authRequired(), authenticated: isAuthenticated(req) });
});

const loginBody = z.object({ password: z.string() });

// Brief constant delay to blunt brute-forcing the single password.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!authRequired()) {
      res.json({ ok: true }); // nothing to log into
      return;
    }
    const { password } = parseBody(loginBody, req);
    if (!checkPassword(password)) {
      await delay(400);
      res.status(401).json({ error: 'Incorrect password', code: 'invalid_credentials' });
      return;
    }
    res.cookie(SESSION_COOKIE, issueToken(), cookieOpts());
    res.json({ ok: true });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/**
 * Gate for protected routes: 401 unless the request carries a valid session (or
 * auth is disabled). Mount after the health + auth routes and before the data
 * routers.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
}

import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { authRequired, checkPassword, isAuthenticated, issueToken, SESSION_COOKIE } from '../services/auth';
import {
  disableMfa,
  enableMfa,
  getMfa,
  getPendingSecret,
  mfaEnabled,
  mfaEnforced,
  setPendingSecret,
} from '../services/mfa';
import { otpauthUri, randomSecret, verifyTotp } from '../services/totp';

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

const loginBody = z.object({ password: z.string(), code: z.string().optional() });

// Brief constant delay to blunt brute-forcing the password / TOTP code.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!authRequired()) {
      res.json({ ok: true }); // nothing to log into
      return;
    }
    const { password, code } = parseBody(loginBody, req);
    if (!checkPassword(password)) {
      await delay(400);
      res.status(401).json({ error: 'Incorrect password', code: 'invalid_credentials' });
      return;
    }
    // Second factor: only after the password is correct, so we never reveal MFA
    // status to someone who doesn't have the password.
    if (mfaEnforced()) {
      if (!code) {
        res.status(401).json({ error: 'Two-factor code required', code: 'mfa_required' });
        return;
      }
      if (!verifyTotp(getMfa().secret, code)) {
        await delay(400);
        res.status(401).json({ error: 'Invalid two-factor code', code: 'invalid_code' });
        return;
      }
    }
    res.cookie(SESSION_COOKIE, issueToken(), cookieOpts());
    res.json({ ok: true });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// --- Two-factor management (all require an active session) ------------------

const codeBody = z.object({ code: z.string() });
const ISSUER = 'Stock App';

authRouter.get('/mfa', requireAuth, (_req, res) => {
  res.json({ available: authRequired(), enabled: mfaEnabled(), enforced: mfaEnforced() });
});

// Begin enrollment: mint a secret (pending until a code proves it works).
authRouter.post(
  '/mfa/setup',
  requireAuth,
  asyncHandler(async (_req, res) => {
    if (!authRequired()) throw new HttpError(400, 'Set a password (APP_PASSWORD) before enabling two-factor.');
    const secret = randomSecret();
    setPendingSecret(secret);
    res.json({ secret, otpauthUri: otpauthUri(secret, 'account', ISSUER) });
  }),
);

// Confirm a code against the pending secret, then turn MFA on.
authRouter.post(
  '/mfa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = parseBody(codeBody, req);
    const pending = getPendingSecret();
    if (!pending) throw new HttpError(400, 'Start two-factor setup first.');
    if (!verifyTotp(pending, code)) {
      res.status(400).json({ error: 'That code did not match — try again.', code: 'invalid_code' });
      return;
    }
    enableMfa(pending);
    res.json({ enabled: true });
  }),
);

// Turn MFA off — requires a current code so a hijacked session can't disable it.
authRouter.post(
  '/mfa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!mfaEnabled()) {
      res.json({ enabled: false });
      return;
    }
    const { code } = parseBody(codeBody, req);
    if (!verifyTotp(getMfa().secret, code)) {
      res.status(400).json({ error: 'That code did not match.', code: 'invalid_code' });
      return;
    }
    disableMfa();
    res.json({ enabled: false });
  }),
);

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

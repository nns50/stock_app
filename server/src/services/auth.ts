import crypto from 'crypto';
import type { Request } from 'express';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Single-password app lock. When APP_PASSWORD is set, the app requires a login;
// a successful login gets an HMAC-signed, HttpOnly session cookie that every
// protected route checks. No dependencies — Node's crypto. The signing key is
// derived from the password, so changing the password invalidates old sessions.
// When no password is configured, auth is disabled (everything is allowed).
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'sa_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Is the app password-protected? */
export function authRequired(): boolean {
  return !!config.auth.password;
}

function signingKey(): Buffer {
  return crypto.createHash('sha256').update(`stock-app:session:${config.auth.password}`).digest();
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payloadB64).digest('base64url');
}

/** Constant-time string compare that won't throw on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verify a submitted password against the configured one (constant-time). */
export function checkPassword(input: unknown): boolean {
  if (!authRequired() || typeof input !== 'string') return false;
  return safeEqual(input, config.auth.password);
}

/** Issue a fresh signed session token (`<payload>.<hmac>`). */
export function issueToken(now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Validate a session token: signature intact and not expired. */
export function verifyToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number };
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

/** Read a single cookie value from the request (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Is this request carrying a valid session? (true when auth is disabled.) */
export function isAuthenticated(req: Request): boolean {
  if (!authRequired()) return true;
  return verifyToken(readCookie(req, SESSION_COOKIE));
}

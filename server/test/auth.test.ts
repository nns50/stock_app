import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../src/config';
import {
  authRequired,
  checkPassword,
  issueToken,
  loginLockedForMs,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
  verifyToken,
} from '../src/services/auth';

const orig = config.auth.password;
afterEach(() => {
  config.auth.password = orig;
});

describe('auth service', () => {
  it('is disabled when no password is set', () => {
    config.auth.password = '';
    expect(authRequired()).toBe(false);
    expect(checkPassword('anything')).toBe(false);
  });

  it('checks the password by value and length, constant-time', () => {
    config.auth.password = 's3cret';
    expect(authRequired()).toBe(true);
    expect(checkPassword('s3cret')).toBe(true);
    expect(checkPassword('wrong!')).toBe(false);
    expect(checkPassword('s3cre')).toBe(false); // length mismatch
    expect(checkPassword(123)).toBe(false); // non-string
  });

  it('issues a token that verifies, and rejects tampering / garbage / expiry', () => {
    config.auth.password = 'pw';
    const t = issueToken();
    expect(verifyToken(t)).toBe(true);
    expect(verifyToken(t + 'x')).toBe(false); // signature no longer matches
    expect(verifyToken('garbage')).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
    const expired = issueToken(Date.now() - 40 * 24 * 60 * 60 * 1000); // older than the 30d TTL
    expect(verifyToken(expired)).toBe(false);
  });

  it('ties the token to the password — changing it invalidates old sessions', () => {
    config.auth.password = 'first';
    const t = issueToken();
    expect(verifyToken(t)).toBe(true);
    config.auth.password = 'second';
    expect(verifyToken(t)).toBe(false);
  });
});

describe('login throttle', () => {
  it('locks after the threshold, backs off exponentially, and clears on success', () => {
    resetLoginThrottle();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordLoginFailure(t0);
    expect(loginLockedForMs(t0)).toBe(0); // under the threshold: no lock

    recordLoginFailure(t0); // 5th consecutive failure
    expect(loginLockedForMs(t0)).toBe(30_000);
    recordLoginFailure(t0); // 6th → doubles
    expect(loginLockedForMs(t0)).toBe(60_000);
    expect(loginLockedForMs(t0 + 60_001)).toBe(0); // window elapses

    recordLoginSuccess();
    recordLoginFailure(t0);
    expect(loginLockedForMs(t0)).toBe(0); // streak reset — one failure is fine

    // The window is capped, not unbounded.
    resetLoginThrottle();
    for (let i = 0; i < 40; i++) recordLoginFailure(t0);
    expect(loginLockedForMs(t0)).toBeLessThanOrEqual(15 * 60_000);
    resetLoginThrottle();
  });
});

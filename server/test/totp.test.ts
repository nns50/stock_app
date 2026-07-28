import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, matchTotpStep, randomSecret, totp, verifyTotp } from '../src/services/totp';

// RFC 6238 SHA-1 test key ("12345678901234567890").
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('hello world!');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('matches the RFC 6238 SHA-1 test vectors (6-digit)', () => {
    expect(totp(RFC_SECRET, 59 * 1000)).toBe('287082');
    expect(totp(RFC_SECRET, 1111111109 * 1000)).toBe('081804');
  });

  it('verifies the current code and adjacent windows, rejects others', () => {
    const now = 1_000_000_000_000;
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true); // within ±1 step
    expect(verifyTotp(RFC_SECRET, code, now + 120_000)).toBe(false); // outside the window
    expect(verifyTotp(RFC_SECRET, '000000', now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'notacode', now)).toBe(false);
  });

  it('generates distinct base32 secrets', () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a).not.toBe(randomSecret());
  });
});

describe('matchTotpStep', () => {
  it('reports the matched time-step across the ±1 window, undefined otherwise', () => {
    const secret = randomSecret();
    const t = 59_000; // step 1 (30s period)
    expect(matchTotpStep(secret, totp(secret, t), t)).toBe(1);
    // The previous step's code matches at its OWN step number.
    expect(matchTotpStep(secret, totp(secret, t - 30_000), t)).toBe(0);
    expect(matchTotpStep(secret, '000000', t)).toBeUndefined();
    expect(matchTotpStep(secret, 'nonsense', t)).toBeUndefined();
  });
});

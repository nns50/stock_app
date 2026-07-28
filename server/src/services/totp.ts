import crypto from 'crypto';

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) for two-factor auth — the codes an authenticator app (Google
// Authenticator, Authy, 1Password, …) shows. Zero dependencies: Node's crypto.
// SHA-1, 6 digits, 30s step (the universal defaults authenticator apps assume).
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random base32 secret (160-bit, the recommended size). */
export function randomSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HMAC-based one-time password for a given counter. */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** The current TOTP code for a base32 secret. */
export function totp(secretBase32: string, time = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(time / 1000 / PERIOD));
}

/**
 * Verify a submitted code, accepting the adjacent windows (±`window` steps) to
 * tolerate clock skew. Constant-time per-window compare.
 */
export function verifyTotp(secretBase32: string, token: string, time = Date.now(), window = 1): boolean {
  return matchTotpStep(secretBase32, token, time, window) !== undefined;
}

/**
 * Like verifyTotp, but reports WHICH time-step the code matched (undefined =
 * no match). The step is what one-time-use enforcement needs: RFC 6238 §5.2
 * requires a verifier to reject a code it has already accepted, and "already
 * accepted" is a fact about the step, not the string.
 */
export function matchTotpStep(secretBase32: string, token: string, time = Date.now(), window = 1): number | undefined {
  const code = (token || '').trim();
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(time / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return counter + w;
  }
  return undefined;
}

/** Build the `otpauth://` URI authenticator apps import (QR or manual key). */
export function otpauthUri(secretBase32: string, label: string, issuer: string): string {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}

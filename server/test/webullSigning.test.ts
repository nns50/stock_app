import { describe, it, expect } from 'vitest';
import { buildStringToSign, signRequest, strictEncode, isoTimestamp } from '../src/providers/webull/signing';

// Golden vectors generated from Webull's OWN official Python SDK
// (webull-python-sdk-core 0.1.18) with the nonce + timestamp frozen — so this
// proves the TypeScript port signs byte-for-byte like the SDK.
const FIXED = {
  timestamp: '2026-06-20T12:00:00Z',
  nonce: 'fixed-nonce-123',
  appKey: 'APPKEY123',
  appSecret: 'SECRET456',
};

describe('webull signing', () => {
  it('strictEncode matches Python quote(safe="")', () => {
    expect(strictEncode('/market-data/snapshot')).toBe('%2Fmarket-data%2Fsnapshot');
    expect(strictEncode('a=b&c')).toBe('a%3Db%26c');
    expect(strictEncode("keep-_.~ drop!*'()")).toBe('keep-_.~%20drop%21%2A%27%28%29');
  });

  it('isoTimestamp has no milliseconds', () => {
    expect(isoTimestamp(Date.UTC(2026, 5, 20, 12, 0, 0))).toBe('2026-06-20T12:00:00Z');
  });

  it('reproduces the SDK signature for a GET (market data) request', () => {
    const sig = signRequest({
      host: 'usquotes-api.webullfintech.com',
      path: '/market-data/snapshot',
      query: { symbols: 'AAPL', category: 'US_STOCK' },
      ...FIXED,
    });
    expect(sig['x-signature']).toBe('rwINnp53OcCvBR3mEAQRmlljzX4=');
    expect(sig['x-app-key']).toBe('APPKEY123');
    expect(sig['x-signature-algorithm']).toBe('HMAC-SHA1');
    expect(sig['x-signature-version']).toBe('1.0');
  });

  it('reproduces the SDK signature for a POST (with JSON body)', () => {
    const sig = signRequest({
      host: 'api.webull.com',
      path: '/account/positions',
      body: { account_id: 'X1', symbol: 'AAPL' },
      ...FIXED,
    });
    expect(sig['x-signature']).toBe('zBxYh5wlFy+4/z99EeSkp1OFulU=');
  });

  it('folds query params into the canonical string (sorted)', () => {
    const s = buildStringToSign({
      host: 'h',
      path: '/p',
      query: { symbols: 'AAPL' },
      ...FIXED,
    });
    // path first, then sorted k=v of headers+query, all strict-encoded.
    expect(s.startsWith(strictEncode('/p&'))).toBe(true);
    expect(s).toContain(strictEncode('symbols=AAPL'));
  });
});

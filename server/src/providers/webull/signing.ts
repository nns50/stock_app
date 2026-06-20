import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Webull OpenAPI request signing (HMAC-SHA1, header-based) — a faithful port of
// the official Python SDK's signature composer (webullsdkcore, which itself
// derives from Alibaba's aliyun-openapi signing). Pure & deterministic; verified
// byte-for-byte against the SDK's own output in webullSigning.test.ts.
//
// Canonical string = strictEncode( path + "&" + sorted("k=v" of the signing
// headers ∪ query params) [+ "&" + MD5(body).upper()] ), signed with
// HMAC-SHA1(secret + "&") and base64-encoded.
// ---------------------------------------------------------------------------

export const SIGN_VERSION = '1.0';
export const SIGN_ALGORITHM = 'HMAC-SHA1';

/** Percent-encode like Python's urllib.parse.quote(s, safe='') — escape every
 *  byte except the unreserved set A-Za-z0-9-._~ (encodeURIComponent leaves
 *  !*'() unescaped, so finish those off). */
export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** ISO-8601 to the second in UTC, e.g. 2026-06-20T12:00:00Z (no milliseconds). */
export function isoTimestamp(now = Date.now()): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SignInput {
  /** Hostname being called (signed, but the HTTP layer sets the Host header). */
  host: string;
  /** Request path only, e.g. /market-data/snapshot (no query string). */
  path: string;
  /** Query params (folded into the signed key/value set). */
  query?: Record<string, string>;
  /** JSON body for POSTs (its MD5 joins the canonical string); omit for GET. */
  body?: unknown;
  appKey: string;
  appSecret: string;
  /** Overridable for deterministic tests. */
  timestamp?: string;
  nonce?: string;
}

/** Build the canonical string-to-sign (already strict-encoded). */
export function buildStringToSign(input: SignInput): string {
  const params: Record<string, string> = {
    'x-app-key': input.appKey,
    'x-timestamp': input.timestamp ?? isoTimestamp(),
    'x-signature-version': SIGN_VERSION,
    'x-signature-algorithm': SIGN_ALGORITHM,
    'x-signature-nonce': input.nonce ?? crypto.randomUUID(),
    host: input.host,
  };
  for (const [k, v] of Object.entries(input.query ?? {})) {
    params[k] = params[k] !== undefined ? `${params[k]}&${v}` : String(v);
  }
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  let raw = `${input.path}&${sorted}`;
  if (input.body !== undefined && input.body !== null) {
    const bodyMd5 = crypto.createHash('md5').update(JSON.stringify(input.body)).digest('hex').toUpperCase();
    raw += `&${bodyMd5}`;
  }
  return strictEncode(raw);
}

export interface SignedHeaders {
  'x-app-key': string;
  'x-timestamp': string;
  'x-signature-version': string;
  'x-signature-algorithm': string;
  'x-signature-nonce': string;
  'x-signature': string;
}

/** Produce the full set of signing headers for a request (incl. the signature). */
export function signRequest(input: SignInput): SignedHeaders {
  const timestamp = input.timestamp ?? isoTimestamp();
  const nonce = input.nonce ?? crypto.randomUUID();
  const stringToSign = buildStringToSign({ ...input, timestamp, nonce });
  const signature = crypto.createHmac('sha1', `${input.appSecret}&`).update(stringToSign).digest('base64');
  return {
    'x-app-key': input.appKey,
    'x-timestamp': timestamp,
    'x-signature-version': SIGN_VERSION,
    'x-signature-algorithm': SIGN_ALGORITHM,
    'x-signature-nonce': nonce,
    'x-signature': signature,
  };
}

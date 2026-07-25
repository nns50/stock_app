import { signRequest } from './signing';
import { normalizeRegion, webullHost, WebullRegion } from './hosts';
import { sleep } from '../../util/http';

// ---------------------------------------------------------------------------
// Thin signed HTTP client for the Webull v2 OpenAPI. Every request carries the
// HMAC app signature (x-app-key/x-signature/…). An account access token
// (x-access-token) is ONLY required when 2FA is enabled on the Webull account —
// in that case a verified token is supplied via WEBULL_ACCESS_TOKEN and sent on
// each request; with 2FA off, the signature alone authenticates.
//
// `call()` returns the resolved URL + status + raw body (never throws) so the
// connection probe can show exactly what was hit; `get()/post()` throw a
// WebullError on non-2xx. No dependencies (Node global fetch).
// ---------------------------------------------------------------------------

export class WebullError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'WebullError';
  }
}

export interface WebullClientConfig {
  appKey: string;
  appSecret: string;
  region: WebullRegion;
  apiHost?: string;
  quotesHost?: string;
  /** Verified account access token — only needed when 2FA is enabled. */
  accessToken?: string;
  /** API version header (x-version); the v2 OpenAPI expects "v2". */
  version?: string;
  timeoutMs?: number;
  /** Max retries on HTTP 429 (rate limited) with exponential backoff. */
  maxRetries?: number;
}

type Surface = 'market' | 'trade';

// ---------------------------------------------------------------------------
// Per-endpoint request pacing.
//
// Webull rate-limits PER ENDPOINT, and the limits differ by an order of
// magnitude, so pacing has to be per-endpoint too. From the Trading API
// reference ("Frequency limit" on each endpoint page):
//
//   2 requests / 2 seconds   order/open, order/history, order/detail,
//                            assets/balance, assets/positions
//   10 requests / 30 seconds account/list
//   150 / 10 seconds         order/preview
//   600 / minute             order/place, order/cancel, order/batch-place
//
// Only the first two groups are slow enough to be worth gating. Pacing the
// 600/minute mutations would be actively harmful: every trade request shares
// one process, so a queued cancel or replace would wait behind whatever
// backlog of status polls happened to be in flight — injecting latency into
// the exit path to solve a problem the exit path does not have.
//
// webullClient() builds a FRESH client per call, so a per-instance guard would
// do nothing; the gates must be module-level, shared by every caller in the
// process. One gate per endpoint, so a slow account/list never blocks an order
// status lookup.
//
// Pacing is a backstop, not the fix. The reason these were exceeded at all is
// that a status lookup costs two requests and used to be issued per order —
// see webullOrderStatusBatch(), which fetches each list once for the whole set.
//
// Market data is left alone: separate limits, its own caching layer, and no
// observed problem.
//
// Note: the docs also state a global "less than 90 requests per minute" per
// user, which contradicts the 600/minute figures on individual endpoints. We
// pace to the specific documented per-endpoint limits and rely on the 429
// backoff below for the global ceiling, rather than throttling market data to
// 1.5 req/s on the strength of a sentence the endpoint pages contradict.
// ---------------------------------------------------------------------------

/** Minimum spacing between successive calls to the same endpoint, in ms.
 *  Anything not listed is unpaced. */
const MIN_INTERVAL_MS: Record<string, number> = {
  '/openapi/trade/order/open': 1000,
  '/openapi/trade/order/history': 1000,
  '/openapi/trade/order/detail': 1000,
  '/openapi/assets/balance': 1000,
  '/openapi/assets/positions': 1000,
  '/openapi/account/list': 3000,
};

/** Scales every interval above. The test suite sets it to 0 (see
 *  vitest.config.ts): pacing is about the broker's frequency limit, not about
 *  any logic the tests exercise, and paying real seconds per request would make
 *  the suite slower than it is useful. */
const PACING_SCALE = Number(process.env.WEBULL_PACING_SCALE ?? 1);

const gates = new Map<string, Promise<void>>();

/** The pacing this endpoint is subject to, in ms; 0 means unpaced. Exported so
 *  the table itself can be asserted on — in particular that the order-placement
 *  and cancellation paths are never gated behind a queue of status polls. */
export function minIntervalMs(path: string): number {
  return MIN_INTERVAL_MS[path] ?? 0;
}

/** Space successive calls to `path` by its documented limit. Chained rather
 *  than timestamp-checked so concurrent callers queue behind one another
 *  instead of all reading the same "last sent" value and firing together. */
function pace(path: string): Promise<void> {
  const interval = minIntervalMs(path) * PACING_SCALE;
  if (!(interval > 0)) return Promise.resolve();
  const wait = (gates.get(path) ?? Promise.resolve()).then(() => sleep(interval));
  // Swallow so one rejected link can't poison the chain for every later caller.
  gates.set(
    path,
    wait.catch(() => undefined),
  );
  return wait;
}

export interface CallResult {
  url: string;
  status: number;
  ok: boolean;
  data: unknown;
}

export class WebullClient {
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly cfg: WebullClientConfig) {
    this.version = cfg.version ?? 'v2';
    this.timeoutMs = cfg.timeoutMs ?? 10000;
    this.maxRetries = cfg.maxRetries ?? 3;
  }

  static fromEnv(env: {
    appKey: string;
    appSecret: string;
    region?: string;
    apiHost?: string;
    quotesHost?: string;
    accessToken?: string;
  }): WebullClient {
    return new WebullClient({
      appKey: env.appKey,
      appSecret: env.appSecret,
      region: normalizeRegion(env.region),
      apiHost: env.apiHost || undefined,
      quotesHost: env.quotesHost || undefined,
      accessToken: env.accessToken || undefined,
    });
  }

  private host(surface: Surface): string {
    if (surface === 'market' && this.cfg.quotesHost) return this.cfg.quotesHost;
    if (surface === 'trade' && this.cfg.apiHost) return this.cfg.apiHost;
    return webullHost(this.cfg.region);
  }

  async get<T>(path: string, query: Record<string, string> = {}, surface: Surface = 'market'): Promise<T> {
    return this.unwrap<T>(await this.call('GET', path, { query, surface }));
  }

  async post<T>(path: string, body: unknown, surface: Surface = 'trade'): Promise<T> {
    return this.unwrap<T>(await this.call('POST', path, { body, surface }));
  }

  private unwrap<T>(r: CallResult): T {
    if (!r.ok) {
      const j = r.data as { code?: string; error_code?: string; msg?: string; message?: string } | null;
      throw new WebullError(
        r.status,
        j?.msg || j?.message || j?.error_code || `Webull request failed (${r.status})`,
        j?.code || j?.error_code,
        r.url,
      );
    }
    return r.data as T;
  }

  /** Low-level request that never throws — returns the URL, status and parsed body.
   *  Pass `nonIdempotent: true` for a request that must NOT be transparently
   *  retried (order placement): a retry after a lost response/timeout could
   *  double-submit a real order, since we can't confirm from here whether the
   *  first attempt reached the broker. Such calls fail fast instead and let the
   *  caller reconcile against broker state. */
  async call(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; surface?: Surface; nonIdempotent?: boolean } = {},
  ): Promise<CallResult> {
    const surface = opts.surface ?? 'market';
    const host = this.host(surface);
    const query = opts.query ?? {};
    const qs = new URLSearchParams(query).toString();
    const url = `https://${host}${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
    const body = method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined;

    for (let attempt = 0; ; attempt++) {
      // Respect this endpoint's documented frequency limit before spending a
      // request — including on retries, which would otherwise be the fastest way
      // back into the limit that caused the retry.
      await pace(path);
      // Re-sign each attempt so the timestamp/nonce stay fresh across retries.
      const signed = signRequest({
        host,
        path,
        query: method === 'GET' ? query : undefined,
        body: method === 'POST' ? opts.body : undefined,
        appKey: this.cfg.appKey,
        appSecret: this.cfg.appSecret,
      });
      const headers: Record<string, string> = {
        ...signed,
        'x-version': this.version,
        'content-type': 'application/json',
      };
      if (this.cfg.accessToken) headers['x-access-token'] = this.cfg.accessToken;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: controller.signal });
      } catch (err) {
        // A network error or the timeout abort — fetch rejects here. This
        // method's contract is "never throws", and a caller like
        // webullPlaceOrder relies on it (a throw would unwind BEFORE the intent
        // is recorded, orphaning an order that may have reached the broker).
        // Retry transient failures — EXCEPT for a nonIdempotent call (order
        // placement): the first attempt may have reached the broker and filled
        // before the response was lost, so a blind retry could double-submit.
        // Fail fast there and let the caller reconcile against broker state.
        clearTimeout(timer);
        if (attempt < this.maxRetries && !opts.nonIdempotent) {
          await sleep(250 * 2 ** attempt + Math.random() * 100);
          continue;
        }
        const aborted = (err as Error)?.name === 'AbortError';
        const detail = aborted
          ? `Request timed out after ${this.timeoutMs}ms`
          : (err as Error)?.message || 'network error';
        return { url, status: 0, ok: false, data: { error: detail } };
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();

      // Back off on rate limiting (429); honor Retry-After when present. A
      // nonIdempotent call (order placement) still must not retry — a 429 can
      // be returned AFTER the order was accepted, so treat it as terminal here.
      if (res.status === 429 && attempt < this.maxRetries && !opts.nonIdempotent) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt + Math.random() * 100;
        await sleep(waitMs);
        continue;
      }
      return { url, status: res.status, ok: res.ok, data: text ? safeParse(text) : {} };
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

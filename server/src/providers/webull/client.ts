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

  /** Low-level request that never throws — returns the URL, status and parsed body. */
  async call(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; surface?: Surface } = {},
  ): Promise<CallResult> {
    const surface = opts.surface ?? 'market';
    const host = this.host(surface);
    const query = opts.query ?? {};
    const qs = new URLSearchParams(query).toString();
    const url = `https://${host}${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
    const body = method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined;

    for (let attempt = 0; ; attempt++) {
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
        // Retry transient failures (the client_order_id is built once outside
        // this loop, so a retried POST is idempotent at the broker — same as
        // the 429 path); otherwise return a clean non-throwing failure.
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
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

      // Back off on rate limiting (429); honor Retry-After when present.
      if (res.status === 429 && attempt < this.maxRetries) {
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

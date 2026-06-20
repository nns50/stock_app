import { signRequest } from './signing';
import { normalizeRegion, webullHost, WebullRegion } from './hosts';

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

  constructor(private readonly cfg: WebullClientConfig) {
    this.version = cfg.version ?? 'v2';
    this.timeoutMs = cfg.timeoutMs ?? 10000;
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
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      return { url, status: res.status, ok: res.ok, data: text ? safeParse(text) : {} };
    } finally {
      clearTimeout(timer);
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

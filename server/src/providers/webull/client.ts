import { signRequest } from './signing';
import { normalizeRegion, webullHost, WebullRegion } from './hosts';

// ---------------------------------------------------------------------------
// Thin signed HTTP client for the Webull OpenAPI. Handles host resolution, the
// HMAC signing headers, JSON encode/decode, and error surfacing. Returns raw
// parsed JSON — mapping to the app's domain types lives in the provider. No
// dependencies (Node global fetch).
// ---------------------------------------------------------------------------

export class WebullError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'WebullError';
  }
}

export interface WebullClientConfig {
  appKey: string;
  appSecret: string;
  region: WebullRegion;
  /** API version header (x-version); Webull endpoints are v1. */
  version?: string;
  timeoutMs?: number;
}

type Surface = 'market' | 'trade';

export class WebullClient {
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: WebullClientConfig) {
    this.version = cfg.version ?? 'v1';
    this.timeoutMs = cfg.timeoutMs ?? 10000;
  }

  static fromEnv(env: { appKey: string; appSecret: string; region?: string }): WebullClient {
    return new WebullClient({
      appKey: env.appKey,
      appSecret: env.appSecret,
      region: normalizeRegion(env.region),
    });
  }

  get<T>(path: string, query: Record<string, string> = {}, surface: Surface = 'market'): Promise<T> {
    return this.request<T>('GET', path, surface, query, undefined);
  }

  post<T>(path: string, body: unknown, surface: Surface = 'trade'): Promise<T> {
    return this.request<T>('POST', path, surface, {}, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    surface: Surface,
    query: Record<string, string>,
    body: unknown,
  ): Promise<T> {
    const host = webullHost(this.cfg.region, surface);
    const signed = signRequest({
      host,
      path,
      query: method === 'GET' ? query : undefined,
      body: method === 'POST' ? body : undefined,
      appKey: this.cfg.appKey,
      appSecret: this.cfg.appSecret,
    });
    const qs = new URLSearchParams(query).toString();
    const url = `https://${host}${path}${qs ? `?${qs}` : ''}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...signed,
          'x-version': this.version,
          'content-type': 'application/json',
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? safeParse(text) : {};
      if (!res.ok) {
        const code = (json as { code?: string })?.code;
        const msg = (json as { msg?: string; message?: string })?.msg ?? (json as { message?: string })?.message;
        throw new WebullError(res.status, msg || `Webull request failed (${res.status})`, code);
      }
      return json as T;
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

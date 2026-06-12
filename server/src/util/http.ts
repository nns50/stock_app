import { ProviderError } from '../providers/MarketDataProvider';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface GetJsonOptions {
  headers?: Record<string, string>;
  /** Number of retries on 429 / 5xx before giving up. */
  retries?: number;
  /** Base backoff in ms (doubles each attempt, capped at 8s). */
  baseDelayMs?: number;
  timeoutMs?: number;
}

/**
 * GET JSON with graceful handling of rate limits (HTTP 429) and transient 5xx
 * errors using exponential backoff + jitter. Honors a `Retry-After` header when
 * the upstream sends one. Throws ProviderError on permanent failure.
 */
export async function getJson<T = unknown>(url: string, opts: GetJsonOptions = {}): Promise<T> {
  const { headers = {}, retries = 3, baseDelayMs = 500, timeoutMs = 15000 } = opts;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= retries) {
        throw new ProviderError(`Network error calling upstream: ${(err as Error).message}`, 504, err);
      }
      await sleep(backoff(attempt, baseDelayMs));
      attempt++;
      continue;
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) {
        throw new ProviderError(`Upstream returned ${res.status} after ${retries} retries`, 429);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt, baseDelayMs);
      await sleep(wait);
      attempt++;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(`Upstream ${res.status}: ${body.slice(0, 300)}`, res.status === 404 ? 404 : 502);
    }

    return (await res.json()) as T;
  }
}

function backoff(attempt: number, base: number): number {
  const expo = Math.min(8000, base * 2 ** attempt);
  return expo + Math.random() * 250; // jitter
}

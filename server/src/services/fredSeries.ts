import { ProviderError } from '../providers/MarketDataProvider';
import { sleep } from '../util/http';
import type { SeriesPoint } from './hmmForward';

// ---------------------------------------------------------------------------
// FRED daily closes for the market-regime reading — the SAME two series, from
// the SAME keyless CSV endpoint, that ml/regime/data.py trained the model on,
// parsed by the same rules (docs/MARKET_REGIME_MODEL.md, "Data"):
//
//   * the header must be exactly `observation_date,<SERIES_ID>`;
//   * a `.` value is a holiday / missing print and is dropped;
//   * dates are sorted ascending and de-duplicated (the last row wins).
//
// A body that fails those rules is a ProviderError, never a partial series:
// feeding the model a column from the wrong series would be a silent, wrong
// regime rather than a visible failure. The caller (services/mlRegime.ts)
// journals failures and falls back to its cache; this file only fetches.
// ---------------------------------------------------------------------------

export const FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
export const FRED_SP500 = 'SP500';
export const FRED_VIX = 'VIXCLS';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse one `fredgraph.csv` body. Throws ProviderError on anything that is
 *  not the requested series. */
export function parseFredCsv(text: string, seriesId: string): SeriesPoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) throw new ProviderError(`FRED ${seriesId}: empty body`, 502);
  const expected = `observation_date,${seriesId}`;
  if (lines[0] !== expected) {
    throw new ProviderError(
      `FRED ${seriesId}: unexpected header ${JSON.stringify(lines[0])} (expected ${expected})`,
      502,
    );
  }
  const byDate = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length !== 2) throw new ProviderError(`FRED ${seriesId}: malformed row ${JSON.stringify(line)}`, 502);
    const date = parts[0].trim();
    const raw = parts[1].trim();
    if (!DATE_RE.test(date)) throw new ProviderError(`FRED ${seriesId}: malformed date ${JSON.stringify(date)}`, 502);
    if (raw === '.' || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value))
      throw new ProviderError(`FRED ${seriesId}: non-numeric value ${JSON.stringify(raw)} on ${date}`, 502);
    byDate.set(date, value);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

export interface FetchFredOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts (a second try covers a transient 5xx / reset). */
  attempts?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** GET one series from `cosd` (YYYY-MM-DD) onward. */
export async function fetchFredSeries(
  seriesId: string,
  cosd: string,
  opts: FetchFredOptions = {},
): Promise<SeriesPoint[]> {
  const { timeoutMs = 10_000, attempts = 2, fetchImpl = fetch } = opts;
  const url = `${FRED_CSV_URL}?id=${encodeURIComponent(seriesId)}&cosd=${encodeURIComponent(cosd)}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'text/csv', 'User-Agent': 'stock-app-regime-reading/1.0' },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new ProviderError(`FRED ${seriesId}: upstream ${res.status}`, 502);
        continue;
      }
      if (!res.ok) throw new ProviderError(`FRED ${seriesId}: upstream ${res.status}`, 502);
      return parseFredCsv(await res.text(), seriesId);
    } catch (err) {
      if (err instanceof ProviderError && err.message.includes('upstream 4')) throw err;
      if (err instanceof ProviderError && !err.message.includes('upstream')) throw err; // a parse failure is final
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError(`FRED ${seriesId}: ${(lastError as Error)?.message ?? 'fetch failed'}`, 504, lastError);
}

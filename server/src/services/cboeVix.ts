import { ProviderError } from '../providers/MarketDataProvider';
import { sleep } from '../util/http';
import type { SeriesPoint } from './hmmForward';

// ---------------------------------------------------------------------------
// The VIX close from its publisher, for the days FRED has not published yet
// (2026-09-26).
//
// FRED's VIXCLS is CBOE's own daily VIX close, republished, and it can run days
// behind. On 2026-09-26 it ended 09-22 while FRED's SP500 had 09-25 and CBOE's
// history file had 09-25. The reading needs both series on a date, so a VIX
// lag alone made the whole reading stale: `unknown`, no ML cut, and a run of
// inert sessions toward the overlay's automatic revert.
//
// Measured the same day: over the 9,278 dates both sources carry since
// 1990-01-02, CBOE's CLOSE equals VIXCLS exactly on every one (the only date in
// one and not the other is FRED's 1999-12-31). So the days FRED is missing are
// read from CBOE, and only those (fillVixTail): no FRED value is ever replaced,
// no gap inside FRED's range is filled, and the fill is refused when the two
// disagree on the latest days they share or CBOE has nothing newer either.
// What it adds is what FRED will publish. ml/regime/data.py applies the same rule, so `regime:predict` (the
// parity check) reads the same numbers.
// ---------------------------------------------------------------------------

export const CBOE_VIX_CSV_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
const HEADER = 'DATE,OPEN,HIGH,LOW,CLOSE';
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** How many of FRED's latest VIX days CBOE must carry, at exactly FRED's close,
 *  before its later days may extend FRED's series. */
export const VIX_FILL_OVERLAP = 5;

/** Parse CBOE's VIX_History.csv into its daily CLOSE by ISO date. Throws a
 *  ProviderError on anything that is not that file: a changed layout must be a
 *  visible failure, never a column of the wrong numbers. */
export function parseCboeVixCsv(text: string): SeriesPoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) throw new ProviderError('CBOE VIX: empty body', 502);
  if (lines[0] !== HEADER) {
    throw new ProviderError(`CBOE VIX: unexpected header ${JSON.stringify(lines[0])} (expected ${HEADER})`, 502);
  }
  const byDate = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length !== 5) throw new ProviderError(`CBOE VIX: malformed row ${JSON.stringify(line)}`, 502);
    const m = DATE_RE.exec(parts[0].trim());
    if (!m) throw new ProviderError(`CBOE VIX: malformed date ${JSON.stringify(parts[0])}`, 502);
    const close = Number(parts[4].trim());
    if (!Number.isFinite(close) || close <= 0) {
      throw new ProviderError(`CBOE VIX: bad close ${JSON.stringify(parts[4])} on ${parts[0]}`, 502);
    }
    byDate.set(`${m[3]}-${m[1]}-${m[2]}`, close);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

export interface FetchCboeOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts (a second try covers a transient 5xx / reset). */
  attempts?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** GET CBOE's whole VIX history (about 470 KB; the file has no date filter). */
export async function fetchCboeVix(opts: FetchCboeOptions = {}): Promise<SeriesPoint[]> {
  const { timeoutMs = 15_000, attempts = 2, fetchImpl = fetch } = opts;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(CBOE_VIX_CSV_URL, {
        headers: { Accept: 'text/csv', 'User-Agent': 'stock-app-regime-reading/1.0' },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new ProviderError(`CBOE VIX: upstream ${res.status}`, 502);
        continue;
      }
      if (!res.ok) throw new ProviderError(`CBOE VIX: upstream ${res.status}`, 502);
      return parseCboeVixCsv(await res.text());
    } catch (err) {
      if (err instanceof ProviderError && err.message.includes('upstream 4')) throw err;
      if (err instanceof ProviderError && !err.message.includes('upstream')) throw err; // a parse failure is final
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError(`CBOE VIX: ${(lastError as Error)?.message ?? 'fetch failed'}`, 504, lastError);
}

export interface VixTailFill {
  /** FRED's rows, then CBOE's for the days after FRED's last one. */
  vix: SeriesPoint[];
  /** The days read from CBOE, oldest first; empty when nothing was added. */
  filled: string[];
  /** Why CBOE was not used although FRED ended before `through`; null otherwise. */
  refused: string | null;
}

/**
 * FRED's VIX, extended from CBOE through `through` (the last S&P 500 day the
 * reading has): CBOE's closes for the days after FRED's last one, and nothing
 * else. Refused, with FRED's rows returned unchanged, when FRED has no rows,
 * when CBOE does not carry FRED's latest VIX_FILL_OVERLAP days at exactly
 * FRED's closes, or when CBOE has no day after FRED's last one either.
 */
export function fillVixTail(fred: readonly SeriesPoint[], cboe: readonly SeriesPoint[], through: string): VixTailFill {
  const unchanged = (refused: string | null): VixTailFill => ({ vix: [...fred], filled: [], refused });
  if (fred.length === 0) return unchanged('FRED returned no VIX rows to extend');
  const last = fred[fred.length - 1].date;
  if (last >= through) return unchanged(null);
  const cboeClose = new Map(cboe.map((p) => [p.date, p.value]));
  for (const p of fred.slice(-VIX_FILL_OVERLAP)) {
    const c = cboeClose.get(p.date);
    if (c === undefined) return unchanged(`CBOE has no close for ${p.date}, which FRED carries`);
    if (c !== p.value) return unchanged(`CBOE's ${p.date} close ${c} differs from FRED's ${p.value}`);
  }
  const tail = cboe.filter((p) => p.date > last && p.date <= through);
  if (tail.length === 0) return unchanged(`CBOE has no close after ${last} either`);
  return { vix: [...fred, ...tail], filled: tail.map((p) => p.date), refused: null };
}

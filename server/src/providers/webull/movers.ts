import { webullClient, webullConfigured } from './account';

// ---------------------------------------------------------------------------
// Market movers from Webull's server-side screeners — top gainers, losers, and
// most-active US stocks (something Yahoo doesn't expose). Read-only and
// independent of MARKET_DATA_PROVIDER: works whenever Webull keys are set.
//
// gainers-losers and top-active share a row shape (confirmed live):
//   { symbol, name, price, close, change, change_ratio (fraction),
//     volume, relative_volume_10d, market_value, … } wrapped in { data: [...] }.
// ---------------------------------------------------------------------------

export type MoverList = 'gainers' | 'losers' | 'active';

export interface Mover {
  symbol: string;
  name?: string;
  price: number;
  change?: number;
  /** Percent change (change_ratio × 100). */
  changePct?: number;
  volume?: number;
  /** 10-day relative volume. */
  relativeVolume?: number;
  marketCap?: number;
}

export interface MoversResult {
  ok: boolean;
  list: MoverList;
  movers: Mover[];
  error?: string;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function rows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const d = (data as { data?: unknown })?.data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

function endpointFor(list: MoverList, limit: number): { path: string; query: Record<string, string> } {
  const base = { rank_type: 'DAY_1', category: 'US_STOCK', page_size: String(limit) };
  if (list === 'active') {
    return {
      path: '/openapi/market-data/screener/top-active',
      query: { ...base, sort_by: 'VOLUME', direction: 'DESC' },
    };
  }
  // Gainers rank change% descending; losers ascending.
  return {
    path: '/openapi/market-data/screener/gainers-losers',
    query: { ...base, sort_by: 'CHANGE_RATIO', direction: list === 'gainers' ? 'DESC' : 'ASC' },
  };
}

function mapMover(r: Record<string, unknown>): Mover {
  const cr = num(r.change_ratio);
  return {
    symbol: String(r.symbol ?? '').toUpperCase(),
    name: r.name ? String(r.name) : undefined,
    price: num(r.price) ?? num(r.close) ?? 0,
    change: num(r.change),
    changePct: cr !== undefined ? Math.round(cr * 10000) / 100 : undefined,
    volume: num(r.volume),
    relativeVolume: num(r.relative_volume_10d),
    marketCap: num(r.market_value),
  };
}

/** Fetch a ranked mover list from Webull. Read-only; never throws. */
export async function webullMovers(list: MoverList, limit = 10): Promise<MoversResult> {
  if (!webullConfigured()) {
    return { ok: false, list, movers: [], error: 'Webull is not configured.' };
  }
  const { path, query } = endpointFor(list, limit);
  const r = await webullClient().call('GET', path, { query, surface: 'market' });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string };
    return { ok: false, list, movers: [], error: j.msg || j.message || `Webull request failed (${r.status})` };
  }
  return {
    ok: true,
    list,
    movers: rows(r.data)
      .map(mapMover)
      .filter((m) => m.symbol),
  };
}

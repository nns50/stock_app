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

export type MoverList = 'gainers' | 'losers' | 'active' | 'unusual';
/** Which trading session to rank over. */
export type MoverSession = 'regular' | 'premarket' | 'afterhours';

const RANK_TYPE: Record<MoverSession, string> = {
  regular: 'DAY_1',
  premarket: 'PRE_MARKET',
  afterhours: 'AFTER_MARKET',
};

export interface Mover {
  symbol: string;
  name?: string;
  price: number;
  change?: number;
  /** Percent change (change_ratio × 100) — the session's move; the gap in pre-market. */
  changePct?: number;
  /** Opening gap vs prior close ((open − pre_close)/pre_close × 100). */
  gapPct?: number;
  volume?: number;
  /** 10-day relative volume. */
  relativeVolume?: number;
  marketCap?: number;
}

export interface MoversResult {
  ok: boolean;
  list: MoverList;
  session: MoverSession;
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

const TOP_ACTIVE = '/openapi/market-data/screener/top-active';
const GAINERS_LOSERS = '/openapi/market-data/screener/gainers-losers';

function endpointFor(
  list: MoverList,
  limit: number,
  session: MoverSession,
): { path: string; query: Record<string, string> } {
  const base = { rank_type: RANK_TYPE[session], category: 'US_STOCK', page_size: String(limit) };
  if (list === 'active') return { path: TOP_ACTIVE, query: { ...base, sort_by: 'VOLUME', direction: 'DESC' } };
  // "Unusual volume" = most-active ranked by 10-day relative volume.
  if (list === 'unusual')
    return { path: TOP_ACTIVE, query: { ...base, sort_by: 'RELATIVE_VOLUME_10D', direction: 'DESC' } };
  // Gainers rank change% descending; losers ascending.
  return {
    path: GAINERS_LOSERS,
    query: { ...base, sort_by: 'CHANGE_RATIO', direction: list === 'gainers' ? 'DESC' : 'ASC' },
  };
}

function pct(ratio: number): number {
  return Math.round(ratio * 10000) / 100;
}

function mapMover(r: Record<string, unknown>): Mover {
  const cr = num(r.change_ratio);
  const open = num(r.open);
  const preClose = num(r.pre_close);
  return {
    symbol: String(r.symbol ?? '').toUpperCase(),
    name: r.name ? String(r.name) : undefined,
    price: num(r.price) ?? num(r.close) ?? 0,
    change: num(r.change),
    changePct: cr !== undefined ? pct(cr) : undefined,
    gapPct: open !== undefined && preClose ? pct(open / preClose - 1) : undefined,
    volume: num(r.volume),
    relativeVolume: num(r.relative_volume_10d),
    marketCap: num(r.market_value),
  };
}

/** Fetch a ranked mover list from Webull for a session. Read-only; never throws. */
export async function webullMovers(
  list: MoverList,
  limit = 10,
  session: MoverSession = 'regular',
): Promise<MoversResult> {
  if (!webullConfigured()) {
    return { ok: false, list, session, movers: [], error: 'Webull is not configured.' };
  }
  const { path, query } = endpointFor(list, limit, session);
  const r = await webullClient().call('GET', path, { query, surface: 'market' });
  if (!r.ok) {
    const j = (r.data ?? {}) as { msg?: string; message?: string };
    return { ok: false, list, session, movers: [], error: j.msg || j.message || `Webull request failed (${r.status})` };
  }
  return {
    ok: true,
    list,
    session,
    movers: rows(r.data)
      .map(mapMover)
      .filter((m) => m.symbol),
  };
}

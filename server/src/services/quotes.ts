import { db } from '../db';
import { Position } from '../db/positions';
import { getProvider } from '../providers';
import { Quote } from '../providers/types';
import { chunk } from '../util/async';

// ---------------------------------------------------------------------------
// Quote helpers with a durable SQLite fallback. Live quotes are persisted to
// `quote_cache` so P&L can still render last-known prices when the provider is
// rate-limited or down (clearly flagged `stale`).
// ---------------------------------------------------------------------------

export function saveQuote(q: Quote): void {
  db.prepare(
    `INSERT INTO quote_cache(symbol, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(q.symbol.toUpperCase(), JSON.stringify(q), Date.now());
}

export function readCachedQuote(symbol: string): { quote: Quote; updatedAt: number } | undefined {
  const row = db.prepare('SELECT data, updated_at FROM quote_cache WHERE symbol = ?').get(symbol.toUpperCase()) as
    | { data: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  return { quote: JSON.parse(row.data) as Quote, updatedAt: row.updated_at };
}

export interface ResolvedPrice {
  symbol: string;
  price: number | null;
  stale: boolean;
  asOf: number | null;
}

/**
 * Resolve stock prices for a set of symbols. Tries the provider (batched) and
 * persists results; for any symbol the provider couldn't return, falls back to
 * the last-known cached quote (flagged stale).
 */
export async function resolveStockPrices(symbols: string[]): Promise<Map<string, ResolvedPrice>> {
  const provider = getProvider();
  const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const out = new Map<string, ResolvedPrice>();

  for (const group of chunk(upper, 100)) {
    try {
      const quotes = provider.getQuotes
        ? await provider.getQuotes(group)
        : await Promise.all(group.map((s) => provider.getQuote(s)));
      for (const q of quotes) {
        saveQuote(q);
        out.set(q.symbol.toUpperCase(), { symbol: q.symbol.toUpperCase(), price: q.last, stale: false, asOf: q.timestamp });
      }
    } catch {
      // fall through to cache for this group
    }
  }

  for (const sym of upper) {
    if (out.has(sym)) continue;
    const cached = readCachedQuote(sym);
    out.set(sym, cached
      ? { symbol: sym, price: cached.quote.last, stale: true, asOf: cached.updatedAt }
      : { symbol: sym, price: null, stale: false, asOf: null });
  }
  return out;
}

/**
 * Resolve current option marks for a set of option positions by fetching the
 * relevant chains once per (symbol, expiration) and matching strike + type.
 * Returns marks and the contract's current delta (for delta-drift exit checks).
 */
export async function resolveOptionMarks(
  positions: Position[],
): Promise<Map<number, { mark: number | null; delta: number | null }>> {
  const provider = getProvider();
  const out = new Map<number, { mark: number | null; delta: number | null }>();
  if (!provider.capabilities.options) {
    for (const p of positions) out.set(p.id, { mark: null, delta: null });
    return out;
  }

  // Group positions by symbol + expiration to minimize chain fetches.
  const groups = new Map<string, Position[]>();
  for (const p of positions) {
    if (!p.expiration) {
      out.set(p.id, { mark: null, delta: null });
      continue;
    }
    const key = `${p.symbol.toUpperCase()}|${p.expiration}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }

  for (const [key, members] of groups) {
    const [symbol, expiration] = key.split('|');
    try {
      const chain = await provider.getOptionsChain(symbol, expiration);
      for (const p of members) {
        const pool = p.optionType === 'put' ? chain.puts : chain.calls;
        const match = pool.find((c) => Math.abs(c.strike - (p.strike ?? -1)) < 1e-6);
        out.set(p.id, {
          mark: match?.mark ?? match?.last ?? null,
          delta: match?.greeks?.delta ?? null,
        });
      }
    } catch {
      for (const p of members) out.set(p.id, { mark: null, delta: null });
    }
  }
  return out;
}

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
        out.set(q.symbol.toUpperCase(), {
          symbol: q.symbol.toUpperCase(),
          price: q.last,
          stale: false,
          asOf: q.timestamp,
        });
      }
    } catch {
      // fall through to cache for this group
    }
  }

  for (const sym of upper) {
    if (out.has(sym)) continue;
    const cached = readCachedQuote(sym);
    out.set(
      sym,
      cached
        ? { symbol: sym, price: cached.quote.last, stale: true, asOf: cached.updatedAt }
        : { symbol: sym, price: null, stale: false, asOf: null },
    );
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

export interface GreeksLookupItem {
  /** Caller-chosen identifier for this leg — not necessarily a position id, so
   *  a debit spread's SHORT leg can be looked up as its own synthetic entry
   *  alongside the long leg (see services/portfolioGreeks.ts). */
  key: string;
  symbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
}

export interface ContractGreeks {
  delta: number | null;
  theta: number | null;
  vega: number | null;
}

/**
 * Resolve current delta/theta/vega for a set of option legs by fetching the
 * relevant chains once per (symbol, expiration) and matching strike + type —
 * same batching strategy as resolveOptionMarks() above. Kept as an
 * independent function rather than a shared refactor: resolveOptionMarks()'s
 * only existing caller (positionExits.ts) drives real exit decisions, and
 * this one has no reason to touch that path to add an unrelated read.
 */
export async function resolveOptionGreeks(items: GreeksLookupItem[]): Promise<Map<string, ContractGreeks>> {
  const out = new Map<string, ContractGreeks>();
  if (items.length === 0) return out; // never touch the provider for an empty batch
  const provider = getProvider();
  if (!provider.capabilities.options) {
    for (const it of items) out.set(it.key, { delta: null, theta: null, vega: null });
    return out;
  }

  const groups = new Map<string, GreeksLookupItem[]>();
  for (const it of items) {
    const groupKey = `${it.symbol.toUpperCase()}|${it.expiration}`;
    (groups.get(groupKey) ?? groups.set(groupKey, []).get(groupKey)!).push(it);
  }

  for (const [groupKey, members] of groups) {
    const [symbol, expiration] = groupKey.split('|');
    try {
      const chain = await provider.getOptionsChain(symbol, expiration);
      for (const it of members) {
        const pool = it.optionType === 'put' ? chain.puts : chain.calls;
        const match = pool.find((c) => Math.abs(c.strike - it.strike) < 1e-6);
        out.set(it.key, {
          delta: match?.greeks?.delta ?? null,
          theta: match?.greeks?.theta ?? null,
          vega: match?.greeks?.vega ?? null,
        });
      }
    } catch {
      for (const it of members) out.set(it.key, { delta: null, theta: null, vega: null });
    }
  }
  return out;
}

/** Resolve a current price per position (stocks via quote, options via mark) —
 *  shared by routes/positions.ts (the human's own book) and the autotrade
 *  live-positions route (server/src/routes/autotrade.ts), so both read the
 *  exact same stock/option price-resolution logic rather than two
 *  implementations that could quietly drift apart. */
export async function priceMap(
  positions: Position[],
): Promise<Map<number, { price: number | null; stale: boolean; asOf: number | null }>> {
  const out = new Map<number, { price: number | null; stale: boolean; asOf: number | null }>();
  const stocks = positions.filter((p) => p.assetType === 'stock');
  const options = positions.filter((p) => p.assetType === 'option');

  if (stocks.length) {
    const prices = await resolveStockPrices(stocks.map((p) => p.symbol));
    for (const p of stocks) {
      const r = prices.get(p.symbol.toUpperCase());
      out.set(p.id, { price: r?.price ?? null, stale: r?.stale ?? false, asOf: r?.asOf ?? null });
    }
  }
  if (options.length) {
    const marks = await resolveOptionMarks(options);
    for (const p of options) {
      const m = marks.get(p.id);
      out.set(p.id, { price: m?.mark ?? null, stale: false, asOf: m?.mark != null ? Date.now() : null });
    }
  }
  return out;
}

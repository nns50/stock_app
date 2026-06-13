// A small, persisted watchlist — the handful of symbols you're actively watching
// today, kept separate from the full screener universe. Stored as a setting.

import { getSetting, setSetting } from '../db/settings';

const KEY = 'watchlist';

/** Coerce an arbitrary setting value into a clean, de-duplicated symbol list. */
export function normalizeWatchlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toUpperCase();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Pure: add a symbol to the end if not already present (case-insensitive). */
export function withSymbol(list: string[], symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  if (!s || list.includes(s)) return list;
  return [...list, s];
}

/** Pure: remove a symbol (case-insensitive). */
export function withoutSymbol(list: string[], symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  return list.filter((x) => x !== s);
}

export function getWatchlist(): string[] {
  return normalizeWatchlist(getSetting(KEY));
}

export function addToWatchlist(symbol: string): string[] {
  const next = withSymbol(getWatchlist(), symbol);
  setSetting(KEY, next);
  return next;
}

export function removeFromWatchlist(symbol: string): string[] {
  const next = withoutSymbol(getWatchlist(), symbol);
  setSetting(KEY, next);
  return next;
}

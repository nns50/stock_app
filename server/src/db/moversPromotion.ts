import { db } from './index';

// ---------------------------------------------------------------------------
// Movers auto-promotion (docs/AUTOTRADING_SPEC.md — the 2026-07-10
// universe-widening fix's explicitly separate follow-up): track how often a
// symbol recurs as a movers-sourced, filters-passing screen candidate, so the
// automatic loop can promote it into the persistent `universe` once it's
// shown up often enough, instead of re-discovering and discarding the same
// genuinely active name every day.
// ---------------------------------------------------------------------------

function daysAgo(n: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Record today's (UTC calendar day) occurrence for a symbol. Once per day
 *  regardless of how many loop ticks see it — mirrors ivHistory.ts's
 *  recordAtmIv() upsert-by-day shape, but IGNORE instead of UPDATE since
 *  there's nothing to overwrite for a plain occurrence marker. */
export function recordMoverOccurrence(symbol: string, date = new Date().toISOString().slice(0, 10)): void {
  db.prepare('INSERT OR IGNORE INTO movers_occurrences(symbol, date, created_at) VALUES (?, ?, ?)').run(
    symbol.toUpperCase(),
    date,
    Date.now(),
  );
}

/** Distinct calendar days `symbol` has occurred in the last `windowDays`
 *  (inclusive of today). */
export function countRecentMoverOccurrences(symbol: string, windowDays: number, from = new Date()): number {
  const cutoff = daysAgo(Math.max(0, windowDays - 1), from);
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM movers_occurrences WHERE symbol = ? AND date >= ?')
      .get(symbol.toUpperCase(), cutoff) as { n: number }
  ).n;
}

/** True once `symbol` has ever been auto-promoted — the gate that stops this
 *  mechanism from re-adding a symbol a user later removed from `universe`. */
export function isAutoPromoted(symbol: string): boolean {
  return !!db.prepare('SELECT 1 FROM auto_promoted_symbols WHERE symbol = ?').get(symbol.toUpperCase());
}

/** Lifetime count of symbols added by this mechanism (for the growth cap). */
export function countAutoPromoted(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM auto_promoted_symbols').get() as { n: number }).n;
}

/** Record that `symbol` was auto-promoted. INSERT OR IGNORE: a symbol only
 *  ever enters the ledger once, by construction (isAutoPromoted is always
 *  checked first), but this stays a no-op rather than throwing if that
 *  invariant is ever violated. */
export function recordAutoPromotion(symbol: string, promotedAt = Date.now()): void {
  db.prepare('INSERT OR IGNORE INTO auto_promoted_symbols(symbol, promoted_at) VALUES (?, ?)').run(
    symbol.toUpperCase(),
    promotedAt,
  );
}

export interface AutoPromotedSymbol {
  symbol: string;
  promotedAt: number;
}

/** The full auto-promotion ledger, most recent first. */
export function listAutoPromotedSymbols(): AutoPromotedSymbol[] {
  return (
    db.prepare('SELECT symbol, promoted_at FROM auto_promoted_symbols ORDER BY promoted_at DESC').all() as {
      symbol: string;
      promoted_at: number;
    }[]
  ).map((r) => ({ symbol: r.symbol, promotedAt: r.promoted_at }));
}

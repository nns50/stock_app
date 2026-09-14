import { db } from '../../db';
import { YahooProvider } from '../../providers/YahooProvider';
import { listUniverse } from '../../db/universe';

// ---------------------------------------------------------------------------
// Sector/industry classification for the real-estate exclusion (the second of
// the two checks in docs/AUTOTRADING_SPEC.md's EXCLUDED SECTOR requirement —
// the first is the static list in db/autotradeExclusions.ts). Catches REITs
// and real-estate operating companies that aren't on that hand-maintained
// list, using whatever sector/industry string is available for the symbol.
//
// Uses a dedicated YahooProvider instance for the fundamentals fallback,
// independent of MARKET_DATA_PROVIDER — mirrors WebullProvider's own `aux`
// pattern for the same gap. TradierProvider doesn't return sector/industry at
// all (see its header comment), so relying on the app's active provider would
// silently break this check under MARKET_DATA_PROVIDER=tradier.
//
// Results are cached durably (autotrade_sector_cache) — a symbol's sector is
// essentially static, but without a cache the autonomous loop re-fetched it
// from Yahoo on EVERY 60-second tick for every non-seeded symbol, forever:
// enough sustained, concurrent, unofficial-API traffic to trip Yahoo's
// free-tier rate limiting on an ordinary screen (seen live: dozens of "Too
// many requests" errors in one run). A positive result (real_estate/clear) is
// cached for a long time; 'unknown' (fetch failed) gets a much shorter TTL so
// it's retried reasonably soon without immediately re-hammering an
// already-rate-limited API on the very next cycle.
// ---------------------------------------------------------------------------

const RE_PATTERN = /real estate|\breit\b/i;

const fundamentalsFallback = new YahooProvider();

const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type ClassificationOutcome = 'real_estate' | 'clear' | 'unknown';

export interface SectorClassification {
  outcome: ClassificationOutcome;
  sector?: string;
  industry?: string;
  /** Where the sector/industry string came from — 'unknown' has neither. */
  source: 'universe' | 'fundamentals' | 'unknown';
}

/** The real-estate test itself, so the screen's live decision and the standing
 *  list below can never disagree about what counts (CLAUDE.md). */
export function isRealEstateSector(sector?: string, industry?: string): boolean {
  return RE_PATTERN.test(sector ?? '') || RE_PATTERN.test(industry ?? '');
}

function classify(
  sector: string | undefined,
  industry: string | undefined,
  source: 'universe' | 'fundamentals',
): SectorClassification {
  const hit = isRealEstateSector(sector, industry);
  return { outcome: hit ? 'real_estate' : 'clear', sector, industry, source };
}

interface CacheRow {
  outcome: ClassificationOutcome;
  sector: string | null;
  industry: string | null;
  updated_at: number;
}

function readCache(symbol: string): CacheRow | undefined {
  return db
    .prepare('SELECT outcome, sector, industry, updated_at FROM autotrade_sector_cache WHERE symbol = ?')
    .get(symbol) as CacheRow | undefined;
}

function writeCache(symbol: string, outcome: ClassificationOutcome, sector?: string, industry?: string): void {
  db.prepare(
    `INSERT INTO autotrade_sector_cache (symbol, outcome, sector, industry, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       outcome = excluded.outcome, sector = excluded.sector, industry = excluded.industry, updated_at = excluded.updated_at`,
  ).run(symbol, outcome, sector ?? null, industry ?? null, Date.now());
}

/**
 * Pre-built once by a caller about to classify many symbols in a loop
 * (screen.ts's every-60s universe scan, backtest.ts's upfront eligibility
 * filter) and passed to classifySector below — avoids re-querying and
 * re-sorting the whole universe table (SELECT * ... ORDER BY symbol) on
 * every single symbol, which is what listUniverse() does per call.
 */
export function buildUniverseSectorMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const u of listUniverse()) {
    if (u.sector) map.set(u.symbol, u.sector);
  }
  return map;
}

/**
 * Classify a symbol as real estate, clear, or unknown. Checks the seeded
 * `universe.sector` first (free, no network); then the durable cache; for
 * symbols outside both — the common case for screened small/mid-cap gappers,
 * not an edge case — falls back to a live fundamentals fetch, which is then
 * cached for next time.
 *
 * A fetch failure returns 'unknown', NOT 'clear' — an unverifiable symbol
 * should be skipped for this cycle (and re-tried once the negative-cache TTL
 * expires), not waved through as confirmed non-real-estate just because the
 * check couldn't run.
 *
 * `universeSectorBySymbol` lets a caller looping over many symbols pass a
 * map built once via buildUniverseSectorMap() instead of paying for a fresh
 * listUniverse() call per symbol; omitted, it falls back to the same
 * single-symbol lookup this function has always done.
 */
export async function classifySector(
  symbol: string,
  universeSectorBySymbol?: Map<string, string>,
): Promise<SectorClassification> {
  const upper = symbol.toUpperCase();
  const universeSector = universeSectorBySymbol
    ? universeSectorBySymbol.get(upper)
    : listUniverse().find((u) => u.symbol === upper)?.sector;
  if (universeSector) {
    return classify(universeSector, undefined, 'universe');
  }

  const cached = readCache(upper);
  if (cached) {
    const ttl = cached.outcome === 'unknown' ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    if (Date.now() - cached.updated_at < ttl) {
      if (cached.outcome === 'unknown') return { outcome: 'unknown', source: 'unknown' };
      return classify(cached.sector ?? undefined, cached.industry ?? undefined, 'fundamentals');
    }
  }

  try {
    const f = await fundamentalsFallback.getFundamentals(symbol);
    if (!f.sector && !f.industry) {
      writeCache(upper, 'unknown');
      return { outcome: 'unknown', source: 'unknown' };
    }
    const result = classify(f.sector, f.industry, 'fundamentals');
    writeCache(upper, result.outcome, f.sector, f.industry);
    return result;
  } catch {
    writeCache(upper, 'unknown');
    return { outcome: 'unknown', source: 'unknown' };
  }
}

/** A symbol the SECTOR CHECK bans, and the string that banned it. */
export interface RealEstateBan {
  symbol: string;
  sector: string | null;
  industry: string | null;
  /** Which store the classification came from — the same two `classifySector`
   *  reads, in the same precedence. */
  source: 'universe' | 'fundamentals';
  /** When the fundamentals lookup was cached. Null for a universe row, whose
   *  sector is a seeded fact with no fetch behind it. */
  classifiedAt: number | null;
}

/**
 * Every symbol the sector/industry check would ban right now.
 *
 * WHY THIS IS NOT A JOURNAL READ (2026-09-14). The `excluded_re` rows say what
 * was banned on a day a screen happened to look at it — one row per symbol per
 * ET day, and nothing at all for a name the screen did not reach. The question
 * "what is banned" is a standing fact about two tables, so it is answered from
 * the tables. It also costs no network: `classifySector` only fetches for a
 * symbol in neither store.
 *
 * BOTH STORES ARE NEEDED, and the reason is easy to miss: `classifySector`
 * returns EARLY on a universe sector hit and never writes the cache. So the
 * cache holds only names discovered by a fundamentals fetch, and reading it
 * alone would have missed all 29 of the names banned on 2026-09-14 — every one
 * of which came from the universe table.
 *
 * Precedence matches `classifySector`: universe first, then the cache, so a
 * symbol in both is reported the way the screen would really see it.
 */
export function listRealEstateBans(): RealEstateBan[] {
  const out = new Map<string, RealEstateBan>();
  for (const u of listUniverse()) {
    if (u.sector && isRealEstateSector(u.sector)) {
      out.set(u.symbol, { symbol: u.symbol, sector: u.sector, industry: null, source: 'universe', classifiedAt: null });
    }
  }
  const cached = db
    .prepare("SELECT symbol, sector, industry, updated_at FROM autotrade_sector_cache WHERE outcome = 'real_estate'")
    .all() as { symbol: string; sector: string | null; industry: string | null; updated_at: number }[];
  for (const c of cached) {
    if (out.has(c.symbol)) continue; // the universe answer is the one the screen uses
    out.set(c.symbol, {
      symbol: c.symbol,
      sector: c.sector,
      industry: c.industry,
      source: 'fundamentals',
      classifiedAt: c.updated_at,
    });
  }
  return [...out.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

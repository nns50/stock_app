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
// ---------------------------------------------------------------------------

const RE_PATTERN = /real estate|\breit\b/i;

const fundamentalsFallback = new YahooProvider();

export type ClassificationOutcome = 'real_estate' | 'clear' | 'unknown';

export interface SectorClassification {
  outcome: ClassificationOutcome;
  sector?: string;
  industry?: string;
  /** Where the sector/industry string came from — 'unknown' has neither. */
  source: 'universe' | 'fundamentals' | 'unknown';
}

function classify(
  sector: string | undefined,
  industry: string | undefined,
  source: 'universe' | 'fundamentals',
): SectorClassification {
  const hit = RE_PATTERN.test(sector ?? '') || RE_PATTERN.test(industry ?? '');
  return { outcome: hit ? 'real_estate' : 'clear', sector, industry, source };
}

/**
 * Classify a symbol as real estate, clear, or unknown. Checks the seeded
 * `universe.sector` first (free, no network); for symbols outside that
 * ~124-name seed — the common case for screened small/mid-cap gappers, not an
 * edge case — falls back to a live fundamentals fetch.
 *
 * A fetch failure returns 'unknown', NOT 'clear' — an unverifiable symbol
 * should be skipped for this cycle (and re-tried next cycle), not waved
 * through as confirmed non-real-estate just because the check couldn't run.
 */
export async function classifySector(symbol: string): Promise<SectorClassification> {
  const inUniverse = listUniverse().find((u) => u.symbol === symbol.toUpperCase());
  if (inUniverse?.sector) {
    return classify(inUniverse.sector, undefined, 'universe');
  }

  try {
    const f = await fundamentalsFallback.getFundamentals(symbol);
    if (!f.sector && !f.industry) return { outcome: 'unknown', source: 'unknown' };
    return classify(f.sector, f.industry, 'fundamentals');
  } catch {
    return { outcome: 'unknown', source: 'unknown' };
  }
}

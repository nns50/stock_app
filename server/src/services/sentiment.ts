// ---------------------------------------------------------------------------
// A deliberately simple, fully transparent sentiment reading from headline
// TEXT — no ML model, no third-party sentiment API. This app's scoring stays
// explainable (see AboutPage.tsx); a vendor's black-box classifier isn't, and
// would also mean a new server-side API key, cost, and latency for a screener
// factor that's off by default. Counts how many of a small, fixed list of
// finance-specific positive/negative words or phrases appear (case-
// insensitive substring match) across a symbol's recent headlines — net
// positive hits minus negative hits. Weak as sentiment signals go, but every
// hit is visible in the matchedTerms list, and the word lists ARE the entire
// "model" — there's nothing hidden to take on faith.
// ---------------------------------------------------------------------------

// Deliberately no bare 'upgrade'/'downgrade' alongside 'upgraded'/'downgraded'
// (or similarly overlapping pairs) — the former is a SUBSTRING of the
// latter, which would silently double-count a single headline mentioning
// one analyst action as two hits. Every term below is checked to share no
// substring relationship with any other term in its own list.
const POSITIVE_TERMS = [
  'beats estimates',
  'beats expectations',
  'tops estimates',
  'raises guidance',
  'raised guidance',
  'upgraded',
  'outperform',
  'record high',
  'record revenue',
  'record profit',
  'surges',
  'soars',
  'rallies',
  'buyback',
  'strong demand',
] as const;

const NEGATIVE_TERMS = [
  'misses estimates',
  'misses expectations',
  'cuts guidance',
  'cut guidance',
  'downgraded',
  'underperform',
  'plunges',
  'plummets',
  'tumbles',
  'lawsuit',
  'investigation',
  'recall',
  'bankruptcy',
  'layoffs',
  'weak demand',
] as const;

export interface HeadlineSentiment {
  /** Positive term hits minus negative term hits, across every headline. */
  netScore: number;
  positiveHits: number;
  negativeHits: number;
  /** Which terms actually matched at least once (deduped, not every
   *  occurrence) — for a note string a human can audit. */
  matchedTerms: string[];
}

/** Pure — no fetch, no I/O. Caller (screen.ts) supplies already-fetched
 *  headline titles (services/news.ts's getNews()); this never calls it
 *  itself, same "this module never fetches data" convention
 *  indicators/screener.ts's own relativeStrength component uses. */
export function computeHeadlineSentiment(headlines: { title: string }[]): HeadlineSentiment {
  let positiveHits = 0;
  let negativeHits = 0;
  const matchedTerms = new Set<string>();
  for (const h of headlines) {
    const text = h.title.toLowerCase();
    for (const term of POSITIVE_TERMS) {
      if (text.includes(term)) {
        positiveHits += 1;
        matchedTerms.add(term);
      }
    }
    for (const term of NEGATIVE_TERMS) {
      if (text.includes(term)) {
        negativeHits += 1;
        matchedTerms.add(term);
      }
    }
  }
  return { netScore: positiveHits - negativeHits, positiveHits, negativeHits, matchedTerms: Array.from(matchedTerms) };
}

import YahooFinance from 'yahoo-finance2';
import { TtlCache } from './cache';

// ---------------------------------------------------------------------------
// Per-symbol news headlines from Yahoo — the catalyst behind a move. Provider-
// agnostic (Yahoo's free search), cached briefly. Decision-support: we surface
// headlines + links, never summarize or editorialize.
// ---------------------------------------------------------------------------

export interface NewsItem {
  title: string;
  publisher?: string;
  link: string;
  /** ISO timestamp of publication, if known. */
  publishedAt?: string;
  relatedTickers?: string[];
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const cache = new TtlCache<NewsItem[]>(5 * 60 * 1000); // 5 minutes

/** Yahoo uses a hyphen for class shares (BRK.B → BRK-B). */
function toYahoo(s: string): string {
  return s.replace(/\.([A-Za-z])$/, '-$1');
}

export async function getNews(symbol: string, count = 12): Promise<NewsItem[]> {
  const key = symbol.toUpperCase();
  return cache.getOrLoad(key, async () => {
    try {
      const res = await yf.search(toYahoo(key), { newsCount: count, quotesCount: 0, enableNavLinks: false });
      const news = ((res as { news?: unknown }).news ?? []) as Array<Record<string, unknown>>;
      return news
        .map((n) => ({
          title: String(n.title ?? ''),
          publisher: n.publisher ? String(n.publisher) : undefined,
          link: String(n.link ?? ''),
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime as string | number).toISOString()
            : undefined,
          relatedTickers: Array.isArray(n.relatedTickers) ? (n.relatedTickers as string[]) : undefined,
        }))
        .filter((n) => n.title && n.link);
    } catch {
      return []; // best-effort; news is non-critical
    }
  });
}

/** Test/maintenance helper. */
export function clearNewsCache(): void {
  cache.clear();
}

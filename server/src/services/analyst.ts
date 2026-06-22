import YahooFinance from 'yahoo-finance2';
import { TtlCache } from './cache';

// ---------------------------------------------------------------------------
// Analyst context for a symbol (Yahoo): consensus price target + rating, and
// recent upgrade/downgrade actions — the latter are genuine intraday catalysts.
// Provider-agnostic, cached 1h. Decision-support, not advice.
// ---------------------------------------------------------------------------

export interface RatingAction {
  /** YYYY-MM-DD, if known. */
  date?: string;
  firm: string;
  /** 'up' | 'down' | 'init' | 'main' | 'reit'. */
  action?: string;
  fromGrade?: string;
  toGrade?: string;
}

export interface AnalystInfo {
  symbol: string;
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  /** strong_buy | buy | hold | sell | strong_sell. */
  recommendationKey?: string;
  numberOfAnalysts?: number;
  /** Recent rating changes, newest first. */
  actions: RatingAction[];
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const cache = new TtlCache<AnalystInfo>(60 * 60 * 1000); // 1h

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toYahoo(s: string): string {
  return s.replace(/\.([A-Za-z])$/, '-$1');
}

function isoDate(d: unknown): string | undefined {
  if (d === null || d === undefined) return undefined;
  const t = new Date(d as string | number);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
}

export async function getAnalyst(symbol: string): Promise<AnalystInfo> {
  const key = symbol.toUpperCase();
  return cache.getOrLoad(key, async () => {
    const empty: AnalystInfo = { symbol: key, actions: [] };
    try {
      const res = (await yf.quoteSummary(toYahoo(key), {
        modules: ['financialData', 'upgradeDowngradeHistory'],
      })) as {
        financialData?: Record<string, unknown>;
        upgradeDowngradeHistory?: { history?: Array<Record<string, unknown>> };
      };
      const fd = res.financialData ?? {};
      const actions = (res.upgradeDowngradeHistory?.history ?? [])
        .map((h) => ({
          date: isoDate(h.epochGradeDate),
          firm: String(h.firm ?? ''),
          action: h.action ? String(h.action) : undefined,
          fromGrade: h.fromGrade ? String(h.fromGrade) : undefined,
          toGrade: h.toGrade ? String(h.toGrade) : undefined,
        }))
        .filter((a) => a.firm)
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
        .slice(0, 8);
      return {
        symbol: key,
        targetMean: num(fd.targetMeanPrice),
        targetHigh: num(fd.targetHighPrice),
        targetLow: num(fd.targetLowPrice),
        recommendationKey: fd.recommendationKey ? String(fd.recommendationKey) : undefined,
        numberOfAnalysts: num(fd.numberOfAnalystOpinions),
        actions,
      };
    } catch {
      return empty; // best-effort; non-critical
    }
  });
}

export function clearAnalystCache(): void {
  cache.clear();
}

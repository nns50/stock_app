import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { processMoversForPromotion } from '../src/services/autotrading/moversPromotion';
import { ScreenCandidate, DiscoverySource } from '../src/services/autotrading/screen';
import { countRecentMoverOccurrences, countAutoPromoted, isAutoPromoted } from '../src/db/moversPromotion';
import { listUniverseSymbols, addSymbols, removeSymbol } from '../src/db/universe';
import { addExclusion } from '../src/db/autotradeExclusions';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { AutotradeConfig } from '../src/db/autotradeConfig';
import { etToday } from '../src/util/marketDate';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM movers_occurrences');
  db.exec('DELETE FROM auto_promoted_symbols');
  db.exec('DELETE FROM autotrade_events');
  db.exec('DELETE FROM autotrade_exclusions');
  db.exec("DELETE FROM universe WHERE symbol IN ('ZZZFAKE', 'ZZZFAKE2', 'ZZZFAKE3', 'ZZZFAKE4')");
});

function candidate(symbol: string, discoverySource: DiscoverySource = 'movers'): ScreenCandidate {
  return {
    symbol,
    direction: 'long' as const,
    price: 100,
    total: 70,
    passedFilters: true,
    filterReasons: [],
    components: [],
    indicators: {
      price: 100,
      changePct: 0,
      maShort: null,
      maLong: null,
      distShortPct: null,
      distLongPct: null,
      rsi: null,
      atr: 2,
      atrPct: 3,
      relVolume: null,
      avgVolume: null,
      volume: null,
      gapPct: null,
      weeklyMaShort: null,
      symbolLookbackReturnPct: null,
      benchmarkLookbackReturnPct: null,
      sentimentNetScore: null,
    },
    discoverySource,
  };
}

/** Backfill `count - 1` PRIOR distinct-day occurrences (real, "now"-relative
 *  dates — countRecentMoverOccurrences always measures from the real wall
 *  clock, same as production) so a single subsequent processMoversForPromotion
 *  call supplies the count-th (today's) occurrence and can genuinely clear
 *  the threshold, rather than backdating so far that the rolling window
 *  itself would silently exclude it. */
function seedPriorOccurrences(symbol: string, count: number): void {
  const insert = db.prepare('INSERT INTO movers_occurrences(symbol, date, created_at) VALUES (?, ?, ?)');
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i < count; i++) {
    // ET calendar date i days back — must be built the SAME way production keys
    // today's occurrence (etToday), NOT a raw UTC date. From ~20:00 ET to
    // UTC-midnight the UTC date is already tomorrow, so a UTC-dated "yesterday"
    // equals today's ET date: the seeded prior day collides with today's on the
    // (symbol,date) unique key and the distinct-day count silently falls short.
    insert.run(symbol.toUpperCase(), etToday(Date.now() - i * DAY), Date.now());
  }
}

const cfg: Pick<
  AutotradeConfig,
  'autoPromoteMoversEnabled' | 'autoPromoteThreshold' | 'autoPromoteWindowDays' | 'autoPromoteMaxSymbols'
> = {
  autoPromoteMoversEnabled: true,
  autoPromoteThreshold: 3,
  autoPromoteWindowDays: 10,
  autoPromoteMaxSymbols: 50,
};

describe('processMoversForPromotion', () => {
  it('ignores universe-sourced candidates entirely — no occurrence recorded', () => {
    const result = processMoversForPromotion([candidate('ZZZFAKE', 'universe')], cfg);
    expect(result).toEqual({ recorded: [], promoted: [], atCap: [] });
    expect(countRecentMoverOccurrences('ZZZFAKE', 10)).toBe(0);
  });

  it('records an occurrence for a movers-sourced candidate below the threshold', () => {
    const result = processMoversForPromotion([candidate('ZZZFAKE')], cfg);
    expect(result.recorded).toEqual(['ZZZFAKE']);
    expect(result.promoted).toEqual([]);
    expect(countRecentMoverOccurrences('ZZZFAKE', 10)).toBe(1);
    expect(listUniverseSymbols()).not.toContain('ZZZFAKE');
  });

  it('promotes a symbol once it clears the threshold across distinct calendar days', () => {
    seedPriorOccurrences('ZZZFAKE', 3); // 2 prior days; this call supplies the 3rd (today)
    const result = processMoversForPromotion([candidate('ZZZFAKE')], cfg);

    expect(result.promoted).toEqual(['ZZZFAKE']);
    expect(listUniverseSymbols()).toContain('ZZZFAKE');
    expect(isAutoPromoted('ZZZFAKE')).toBe(true);

    const events = listAutotradeEvents({ stage: 'screen', symbol: 'ZZZFAKE' });
    const promo = events.find((e) => e.action === 'universe_auto_promoted');
    expect(promo).toBeDefined();
    expect(JSON.parse(promo!.detail!)).toMatchObject({ occurrences: 3, windowDays: 10, threshold: 3 });
  });

  it('respects the real-estate exclusion list — never promotes an excluded symbol even once the threshold clears', () => {
    addExclusion('ZZZFAKE', 'test exclusion');
    seedPriorOccurrences('ZZZFAKE', 3);
    const result = processMoversForPromotion([candidate('ZZZFAKE')], cfg);
    expect(result.promoted).toEqual([]);
    expect(listUniverseSymbols()).not.toContain('ZZZFAKE');
  });

  it('never re-promotes (or resurrects) a symbol already in the ledger, even after a user removes it from universe', () => {
    addSymbols([{ symbol: 'ZZZFAKE' }]);
    db.prepare('INSERT INTO auto_promoted_symbols(symbol, promoted_at) VALUES (?, ?)').run('ZZZFAKE', Date.now());
    removeSymbol('ZZZFAKE'); // simulates a deliberate user removal after promotion

    seedPriorOccurrences('ZZZFAKE', 3);
    const result = processMoversForPromotion([candidate('ZZZFAKE')], cfg);

    expect(result.promoted).toEqual([]);
    expect(listUniverseSymbols()).not.toContain('ZZZFAKE'); // stays removed
  });

  it('does not touch (or re-ledger) a symbol already present in universe for an unrelated reason', () => {
    addSymbols([{ symbol: 'ZZZFAKE' }]); // e.g. seeded/user-added, never auto-promoted
    seedPriorOccurrences('ZZZFAKE', 3);
    const result = processMoversForPromotion([candidate('ZZZFAKE')], cfg);

    expect(result.promoted).toEqual([]);
    expect(isAutoPromoted('ZZZFAKE')).toBe(false); // never entered the ledger
  });

  it('respects the lifetime growth cap, reporting blocked-but-eligible symbols separately', () => {
    const capped = { ...cfg, autoPromoteThreshold: 1, autoPromoteMaxSymbols: 1 };

    const first = processMoversForPromotion([candidate('ZZZFAKE')], capped);
    expect(first.promoted).toEqual(['ZZZFAKE']);
    expect(countAutoPromoted()).toBe(1);

    const second = processMoversForPromotion([candidate('ZZZFAKE2')], capped);
    expect(second.promoted).toEqual([]);
    expect(second.atCap).toEqual(['ZZZFAKE2']);
    expect(listUniverseSymbols()).not.toContain('ZZZFAKE2');
  });

  it('enforces the cap correctly within a single call promoting multiple symbols at once', () => {
    const capped = { ...cfg, autoPromoteThreshold: 1, autoPromoteMaxSymbols: 2 };

    const result = processMoversForPromotion(
      [candidate('ZZZFAKE'), candidate('ZZZFAKE2'), candidate('ZZZFAKE3'), candidate('ZZZFAKE4')],
      capped,
    );
    expect(result.promoted).toHaveLength(2);
    expect(result.atCap).toHaveLength(2);
    expect(countAutoPromoted()).toBe(2);
  });

  it('still records occurrences when auto-promotion is disabled, but never promotes', () => {
    const disabled = { ...cfg, autoPromoteMoversEnabled: false, autoPromoteThreshold: 1 };
    const result = processMoversForPromotion([candidate('ZZZFAKE')], disabled);
    expect(result.recorded).toEqual(['ZZZFAKE']);
    expect(result.promoted).toEqual([]);
    expect(countRecentMoverOccurrences('ZZZFAKE', 10)).toBe(1);
    expect(listUniverseSymbols()).not.toContain('ZZZFAKE');
  });

  it('dedupes repeated symbols within the same candidates array', () => {
    const result = processMoversForPromotion([candidate('ZZZFAKE'), candidate('ZZZFAKE')], cfg);
    expect(result.recorded).toEqual(['ZZZFAKE']);
  });

  it('is a no-op given an empty or fully universe-sourced candidate list', () => {
    expect(processMoversForPromotion([], cfg)).toEqual({ recorded: [], promoted: [], atCap: [] });
  });
});

import { describe, it, expect } from 'vitest';
import { computeHeadlineSentiment } from '../src/services/sentiment';

describe('computeHeadlineSentiment', () => {
  it('is neutral (net 0) with no headlines at all', () => {
    const result = computeHeadlineSentiment([]);
    expect(result).toEqual({ netScore: 0, positiveHits: 0, negativeHits: 0, matchedTerms: [] });
  });

  it('is neutral for headlines with no matching keywords', () => {
    const result = computeHeadlineSentiment([{ title: 'Company announces new product lineup' }]);
    expect(result.netScore).toBe(0);
  });

  it('counts a single positive term', () => {
    const result = computeHeadlineSentiment([{ title: 'Acme Corp beats estimates in Q3 earnings' }]);
    expect(result.netScore).toBe(1);
    expect(result.positiveHits).toBe(1);
    expect(result.negativeHits).toBe(0);
    expect(result.matchedTerms).toEqual(['beats estimates']);
  });

  it('counts a single negative term', () => {
    const result = computeHeadlineSentiment([{ title: 'Acme Corp misses estimates, stock falls' }]);
    expect(result.netScore).toBe(-1);
    expect(result.positiveHits).toBe(0);
    expect(result.negativeHits).toBe(1);
  });

  it('sums hits across multiple headlines', () => {
    const result = computeHeadlineSentiment([
      { title: 'Acme upgraded by analysts after strong quarter' }, // 'upgraded'
      { title: 'Acme surges after strong earnings beat' }, // 'surges'
      { title: 'Regulators open investigation into Acme practices' }, // 'investigation'
    ]);
    expect(result.positiveHits).toBe(2);
    expect(result.negativeHits).toBe(1);
    expect(result.netScore).toBe(1);
  });

  it('matches case-insensitively', () => {
    const result = computeHeadlineSentiment([{ title: 'ACME BEATS ESTIMATES this quarter' }]);
    expect(result.netScore).toBe(1);
  });

  it('counts multiple distinct, non-overlapping term hits within one headline separately', () => {
    const result = computeHeadlineSentiment([{ title: 'Acme upgraded following record revenue and a new buyback' }]);
    expect(result.positiveHits).toBe(3); // upgraded, record revenue, buyback
    expect(result.matchedTerms.sort()).toEqual(['buyback', 'record revenue', 'upgraded']);
  });

  it('does not double-count "upgraded"/"downgraded" against a shorter overlapping term', () => {
    // Regression check for the exact bug this term-list design avoids: an
    // earlier draft had bare 'upgrade'/'downgrade' alongside these, which are
    // substrings of the past-tense forms and would have silently doubled
    // every hit below.
    const result = computeHeadlineSentiment([{ title: 'Acme upgraded to Buy' }, { title: 'Acme downgraded to Sell' }]);
    expect(result.positiveHits).toBe(1);
    expect(result.negativeHits).toBe(1);
  });

  it('deduplicates matchedTerms across repeated headlines using the same term', () => {
    const result = computeHeadlineSentiment([
      { title: 'Acme downgraded by big bank' },
      { title: 'Second bank also downgraded Acme' },
    ]);
    expect(result.negativeHits).toBe(2); // each headline counts its own hit
    expect(result.matchedTerms).toEqual(['downgraded']); // but the term itself is listed once
  });
});

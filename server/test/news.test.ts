import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('yahoo-finance2', () => {
  const state = { calls: 0, lastQuery: '' };
  class FakeYahoo {
    constructor(_opts?: unknown) {}
    async search(query: string) {
      state.calls++;
      state.lastQuery = query;
      return {
        news: [
          {
            title: 'Acme beats on earnings',
            publisher: 'Reuters',
            link: 'https://example.com/a',
            providerPublishTime: new Date('2026-06-20T13:30:00Z'),
            relatedTickers: ['ACME'],
          },
          { title: '', link: 'https://example.com/blank' }, // dropped (no title)
        ],
      };
    }
  }
  return { default: FakeYahoo, __state: state };
});

import * as yf from 'yahoo-finance2';
import { getNews, clearNewsCache } from '../src/services/news';

const state = (yf as unknown as { __state: { calls: number; lastQuery: string } }).__state;

beforeEach(() => {
  clearNewsCache();
  state.calls = 0;
});

describe('news service', () => {
  it('maps and filters Yahoo news, normalizing class-share symbols', async () => {
    const items = await getNews('BRK.B');
    expect(state.lastQuery).toBe('BRK-B'); // hyphen form
    expect(items).toHaveLength(1); // the title-less item is dropped
    expect(items[0]).toMatchObject({
      title: 'Acme beats on earnings',
      publisher: 'Reuters',
      link: 'https://example.com/a',
      publishedAt: '2026-06-20T13:30:00.000Z',
    });
  });

  it('caches per symbol', async () => {
    await getNews('AAPL');
    await getNews('AAPL');
    expect(state.calls).toBe(1);
  });
});

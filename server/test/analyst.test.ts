import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('yahoo-finance2', () => {
  const state = { calls: 0, lastQuery: '' };
  class FakeYahoo {
    constructor(_opts?: unknown) {}
    async quoteSummary(query: string) {
      state.calls++;
      state.lastQuery = query;
      return {
        financialData: {
          targetMeanPrice: 250,
          targetHighPrice: 320,
          targetLowPrice: 180,
          recommendationKey: 'buy',
          numberOfAnalystOpinions: 34,
        },
        upgradeDowngradeHistory: {
          history: [
            {
              epochGradeDate: new Date('2026-06-18T00:00:00Z'),
              firm: 'Morgan Stanley',
              action: 'up',
              fromGrade: 'Hold',
              toGrade: 'Buy',
            },
            { epochGradeDate: new Date('2026-05-01T00:00:00Z'), firm: 'Goldman', action: 'main', toGrade: 'Buy' },
            { firm: '' }, // dropped (no firm)
          ],
        },
      };
    }
  }
  return { default: FakeYahoo, __state: state };
});

import * as yf from 'yahoo-finance2';
import { getAnalyst, clearAnalystCache } from '../src/services/analyst';

const state = (yf as unknown as { __state: { calls: number; lastQuery: string } }).__state;

beforeEach(() => {
  clearAnalystCache();
  state.calls = 0;
});

describe('analyst service', () => {
  it('maps target + rating + recent actions (newest first), normalizing class shares', async () => {
    const a = await getAnalyst('BRK.B');
    expect(state.lastQuery).toBe('BRK-B');
    expect(a).toMatchObject({
      targetMean: 250,
      targetHigh: 320,
      targetLow: 180,
      recommendationKey: 'buy',
      numberOfAnalysts: 34,
    });
    expect(a.actions).toHaveLength(2); // firm-less entry dropped
    expect(a.actions[0]).toMatchObject({ date: '2026-06-18', firm: 'Morgan Stanley', action: 'up', toGrade: 'Buy' });
  });

  it('caches per symbol', async () => {
    await getAnalyst('AAPL');
    await getAnalyst('AAPL');
    expect(state.calls).toBe(1);
  });
});

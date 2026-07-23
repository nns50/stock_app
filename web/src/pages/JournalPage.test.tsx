import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import JournalPage from './JournalPage';
import { client } from '../api/client';
import type { AutoTuneRiskAdjustmentEfficacy, JournalStats, Position, PositionWithPnl } from '../api/types';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'journalAutoTuneEfficacy').mockResolvedValue({ adjustments: [] });
});

function journalStatsFixture(overrides: Partial<JournalStats> = {}): JournalStats {
  return {
    totalClosed: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    profitFactor: null,
    totalRealized: 0,
    bestTrade: 0,
    worstTrade: 0,
    equityCurve: [],
    rollingExpectancy: [],
    byTag: [],
    byGrade: [],
    byDiscipline: [],
    byWeekday: [],
    byHold: [],
    byTimeOfDay: [],
    rTrades: 0,
    avgR: null,
    bestR: null,
    worstR: null,
    stdevR: null,
    sqn: null,
    rBuckets: [],
    kelly: null,
    maxDrawdown: 0,
    currentDrawdown: 0,
    currentStreak: { type: 'none', count: 0 },
    longestWinStreak: 0,
    longestLossStreak: 0,
    ...overrides,
  };
}

function efficacyFixture(overrides: Partial<AutoTuneRiskAdjustmentEfficacy> = {}): AutoTuneRiskAdjustmentEfficacy {
  return {
    eventId: 1,
    adjustedAt: Date.parse('2026-07-10T15:00:00Z'),
    from: 1,
    to: 1.3,
    kellySuggestedAtTheTime: 1.5,
    sampleSizeAtTheTime: 22,
    before: journalStatsFixture({ totalClosed: 15, winRate: 55, expectancy: 30 }),
    after: journalStatsFixture({ totalClosed: 4, winRate: 60, expectancy: 45 }),
    ...overrides,
  };
}

function positionFixture(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    assetType: 'stock',
    symbol: 'WASH',
    side: 'long',
    quantity: 10,
    entryPrice: 100,
    entryDate: '2026-04-01',
    entryTime: null,
    fees: 0,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: 'closed',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    sourceIntentId: null,
    accountId: null,
    createdAt: 0,
    updatedAt: 0,
    exits: [
      {
        id: 1,
        positionId: 1,
        quantity: 10,
        exitPrice: 90,
        exitDate: '2026-04-10',
        fees: 0,
        notes: null,
        sourceIntentId: null,
        createdAt: 0,
      },
    ],
    remainingQuantity: 0,
    ...overrides,
  };
}

function positionWithPnlFixture(overrides: Partial<PositionWithPnl> = {}): PositionWithPnl {
  const position = overrides.position ?? positionFixture();
  return {
    position,
    price: null,
    stale: false,
    asOf: null,
    pnl: {
      positionId: position.id,
      currentPrice: null,
      costBasis: 1000,
      realizedPnl: -100,
      unrealizedPnl: null,
      totalPnl: -100,
      returnPct: -10,
      rMultiple: null,
      marketValue: null,
      remainingQuantity: 0,
      closedQuantity: 10,
    },
    washSale: null,
    ...overrides,
  };
}

describe('JournalPage', () => {
  it('mounts and shows its loading state without crashing', () => {
    vi.spyOn(client, 'journalStats').mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(client, 'positionsWithPnl').mockReturnValue(new Promise(() => {}) as never);
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Loading journal/)).toBeInTheDocument();
  });

  it('shows a wash-sale warning badge on a closed loss flagged by the server', async () => {
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture({ totalClosed: 1, totalRealized: -100 }));
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
      positions: [
        positionWithPnlFixture({
          washSale: { triggerPositionId: 2, triggerEntryDate: '2026-04-20', daysApart: 10 },
        }),
      ],
    });
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    const badge = await screen.findByText('wash sale?');
    expect(badge).toBeInTheDocument();
    expect(badge.closest('span')).toHaveAttribute('title', expect.stringContaining('2026-04-20'));
  });

  it('shows no wash-sale badge for a closed trade the server did not flag', async () => {
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture({ totalClosed: 1, totalRealized: 100 }));
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({ positions: [positionWithPnlFixture()] });
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    await screen.findByText('WASH');
    expect(screen.queryByText('wash sale?')).toBeNull();
  });

  it('does not show the auto-tune efficacy card when there are no past adjustments', async () => {
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture());
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({ positions: [] });
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    await screen.findByText(/No closed trades yet|Journal/);
    expect(screen.queryByText('Auto-tune efficacy')).toBeNull();
  });

  it('shows the auto-tune efficacy card with a before/after comparison once adjustments exist', async () => {
    vi.spyOn(client, 'journalAutoTuneEfficacy').mockResolvedValue({ adjustments: [efficacyFixture()] });
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture());
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({ positions: [] });
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Auto-tune efficacy')).toBeInTheDocument();
    expect(screen.getByText(/Before \(15 trades\)/)).toBeInTheDocument();
    expect(screen.getByText(/After \(4 trades\)/)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    datedTrades: 0,
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
    entryScore: null,
    entryComponents: null,
    marketRegime: null,
    marketAtrPct: null,
    entryVwap: null,
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
        exitReason: null,
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

/** The full /api/positions?withPnl shape. The mocks used to pass `{ positions }`
 *  alone, which the API never returns — the page reads aggregate and exposure
 *  too. Nothing caught it because web test files were excluded from tsc. */
function positionsResponse(positions: PositionWithPnl[] = []) {
  return {
    positions,
    aggregate: {
      realized: 0,
      unrealized: 0,
      total: 0,
      openMarketValue: 0,
      openCount: 0,
      closedCount: positions.length,
    },
    exposure: { gross: 0, net: 0, long: 0, short: 0, bySector: [], largest: null },
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
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(
      positionsResponse([
        positionWithPnlFixture({
          washSale: { triggerPositionId: 2, triggerEntryDate: '2026-04-20', daysApart: 10 },
        }),
      ]),
    );
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
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse([positionWithPnlFixture()]));
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
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse());
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
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse());
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Auto-tune efficacy')).toBeInTheDocument();
    expect(screen.getByText(/Before \(15 trades\)/)).toBeInTheDocument();
    expect(screen.getByText(/After \(4 trades\)/)).toBeInTheDocument();
  });

  it('shows profit factor and avg R in the by-tag breakdown, including the null cases', async () => {
    vi.spyOn(client, 'journalStats').mockResolvedValue(
      journalStatsFixture({
        totalClosed: 3,
        profitFactor: 2, // distinct from the byTag row's values so the '∞' assertion below stays unambiguous
        byTag: [
          { key: 'breakout', trades: 3, wins: 2, winRate: 67, totalPnl: 150, avgPnl: 50, profitFactor: 3, avgR: 0.5 },
          {
            key: 'earnings',
            trades: 2,
            wins: 2,
            winRate: 100,
            totalPnl: 250,
            avgPnl: 125,
            profitFactor: null,
            avgR: null,
          },
        ],
      }),
    );
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse());
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    await screen.findByText('breakout');
    expect(screen.getByText('3.0')).toBeInTheDocument(); // breakout's profit factor
    expect(screen.getByText('0.5R')).toBeInTheDocument(); // breakout's avg R
    expect(screen.getByText('∞')).toBeInTheDocument(); // earnings: all winners, no losses
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // earnings: no trade logged a stop
  });
});

describe('JournalPage — failures must not pass for emptiness', () => {
  const boom = () => Promise.reject(new Error('network down'));

  it('shows the error and a retry when the stats request fails', async () => {
    // `const s = stats.data!` asserted non-null, so this threw during render and
    // took the page down with no message and no way back.
    vi.spyOn(client, 'journalStats').mockImplementation(boom as never);
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse());
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('does NOT claim you have no closed trades when the trade list failed to load', async () => {
    // The worst version of this bug: stats load, positions fail, and the page
    // renders "No closed trades yet — Log a trade to start building your
    // journal." to someone whose journal is full.
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture({ totalClosed: 12, wins: 7 }));
    vi.spyOn(client, 'positionsWithPnl').mockImplementation(boom as never);
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.queryByText(/No closed trades yet/)).not.toBeInTheDocument();
  });

  it('keeps the table populated when a tag filter is applied', async () => {
    // The tag-specific empty state guards a STALE filter — filter by a tag, then
    // edit that trade to drop it — which this level can't drive. What it can
    // cover is that filtering by a live tag keeps its own rows, so the empty
    // state is not reachable by simply clicking a chip.
    vi.spyOn(client, 'journalStats').mockResolvedValue(journalStatsFixture({ totalClosed: 1 }));
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue({
      positions: [positionWithPnlFixture({ position: positionFixture({ tags: ['swing'] }) })],
    } as never);
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'swing' }));
    expect(screen.getByRole('link', { name: 'WASH' })).toBeInTheDocument();
    expect(screen.queryByText(/No closed trades/)).not.toBeInTheDocument();
  });
});

describe('JournalPage — R-multiple tiles', () => {
  it('does not render "+-1.50R" when every stopped trade lost', async () => {
    // bestR had a hardcoded "+". A book where the best R outcome is still a loss
    // is exactly the book whose owner is most likely to be reading this tile.
    vi.spyOn(client, 'journalStats').mockResolvedValue(
      journalStatsFixture({
        totalClosed: 3,
        datedTrades: 3,
        rTrades: 3,
        avgR: -1.2,
        bestR: -0.5,
        worstR: -2,
        rBuckets: [{ label: '≤ -2R', count: 1 }],
      }),
    );
    vi.spyOn(client, 'positionsWithPnl').mockResolvedValue(positionsResponse());
    render(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('-0.50R')).toBeInTheDocument();
    expect(screen.queryByText('+-0.50R')).not.toBeInTheDocument();
  });
});

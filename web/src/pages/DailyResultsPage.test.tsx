import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DailyResultsPage from './DailyResultsPage';
import { client } from '../api/client';
import type { AutotradeConfig, DailyResult, DailyResultsReport } from '../api/types';

function day(etDate: string, over: Partial<DailyResult> = {}): DailyResult {
  return {
    etDate,
    baselineEquityUsd: 10_000,
    closeEquityUsd: 10_100,
    accountGainPct: 1,
    strategyPnlUsd: 95,
    strategyGainPct: 0.95,
    liveTrades: 2,
    paperPnlUsd: 12,
    goalReached: false,
    giveBackHalted: false,
    drawdownHalted: false,
    manualTrading: false,
    recordedAt: 1,
    ...over,
  };
}

const REPORT: DailyResultsReport = {
  rows: [
    day('2026-09-01', { accountGainPct: 3.1, strategyGainPct: 3, goalReached: true, strategyPnlUsd: 300 }),
    day('2026-09-02', { accountGainPct: -2.2, strategyGainPct: -2.2, drawdownHalted: true, strategyPnlUsd: -220 }),
    // Pre-go-live: the strategy dollars are exact, the account figure does not exist.
    day('2026-09-03', { accountGainPct: null, strategyGainPct: null, baselineEquityUsd: null, closeEquityUsd: null }),
    day('2026-09-04', { accountGainPct: 0.4, strategyGainPct: 0.05, manualTrading: true }),
  ],
  weekly: [
    {
      key: '2026-W36',
      sessions: 4,
      strategyPnlUsd: 270,
      meanAccountGainPct: 0.43,
      meanStrategyGainPct: 0.28,
      positiveDays: 3,
      goalDays: 1,
      haltDays: 1,
      bestDayPct: 3.1,
      worstDayPct: -2.2,
    },
  ],
  monthly: [
    {
      key: '2026-09',
      sessions: 4,
      strategyPnlUsd: 270,
      meanAccountGainPct: 0.43,
      meanStrategyGainPct: 0.28,
      positiveDays: 3,
      goalDays: 1,
      haltDays: 1,
      bestDayPct: 3.1,
      worstDayPct: -2.2,
    },
  ],
  currentStreak: 1,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <DailyResultsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.spyOn(client, 'journalDailyResults').mockResolvedValue(REPORT);
  vi.spyOn(client, 'autotradeConfig').mockResolvedValue({ targetDailyGainPct: 3 } as AutotradeConfig);
});

describe('DailyResultsPage', () => {
  it('renders the month with its goal, red and pre-go-live days', async () => {
    renderPage();
    expect(await screen.findByTestId('results-month')).toHaveTextContent('September 2026');

    const goalDay = screen.getByTestId('results-day-2026-09-01');
    expect(within(goalDay).getByText('+3.10%')).toBeTruthy();
    expect(within(goalDay).getByTitle('Daily goal reached')).toBeTruthy();

    const redDay = screen.getByTestId('results-day-2026-09-02');
    expect(within(redDay).getByText('-2.20%')).toBeTruthy();
    expect(within(redDay).getByTitle('Daily drawdown halt')).toBeTruthy();

    // The pre-go-live day says it has no account figure rather than showing 0.
    expect(within(screen.getByTestId('results-day-2026-09-03')).getByText('—')).toBeTruthy();
    // A manual-trading day is flagged, not averaged away.
    expect(within(screen.getByTestId('results-day-2026-09-04')).getByTitle(/disagree by more than 0\.5%/)).toBeTruthy();
  });

  it('summarises the month and says the current run', async () => {
    renderPage();
    const summary = await screen.findByTestId('results-month-summary');
    expect(summary).toHaveTextContent('Sessions4');
    expect(summary).toHaveTextContent('+0.43%');
    expect(summary).toHaveTextContent('Positive days3 of 4');
    expect(summary).toHaveTextContent('Goal days1');
    expect(screen.getByText(/1 green session/)).toBeTruthy();
  });

  it('the toggle switches which percentage the tiles show', async () => {
    renderPage();
    await screen.findByTestId('results-calendar');
    expect(within(screen.getByTestId('results-day-2026-09-04')).getByText('+0.40%')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Strategy %' }));
    expect(within(screen.getByTestId('results-day-2026-09-04')).getByText('+0.05%')).toBeTruthy();
  });

  it('navigates months and shows an empty one honestly', async () => {
    renderPage();
    await screen.findByTestId('results-calendar');
    fireEvent.click(screen.getByRole('button', { name: '‹ Prev' }));
    expect(screen.getByTestId('results-month')).toHaveTextContent('August 2026');
    expect(screen.getByText('No sessions recorded this month.')).toBeTruthy();
  });

  it('lists every recorded session in a table — the heatmap’s accessible twin', async () => {
    renderPage();
    const table = (await screen.findAllByRole('table'))[0];
    expect(within(table).getByText('2026-09-01')).toBeTruthy();
    expect(within(table).getByText('goal')).toBeTruthy();
    expect(within(table).getByText('halt')).toBeTruthy();
    expect(within(table).getByText('manual')).toBeTruthy();
  });
});

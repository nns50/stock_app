import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DailyResultsCalendar, buildMonthGrid, magnitudeStep, pctOf } from './DailyResultsCalendar';
import type { DailyResult } from '../api/types';

// ---------------------------------------------------------------------------
// The calendar's job is to make a month of days legible at a glance without
// making a claim the record cannot support. So: a day with no account figure
// must SAY so rather than show a zero, the sign must survive without color, and
// the intensity scale must move with the goal rather than with a constant.
// ---------------------------------------------------------------------------

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
    riskPerTradePct: 2.5,
    recordedAt: 1,
    ...over,
  };
}

describe('magnitudeStep — the scale moves with the goal, not with a constant', () => {
  it('reaches full strength at the goal and the middle step at half of it', () => {
    expect(magnitudeStep(3, 3)).toBe(3);
    expect(magnitudeStep(1.6, 3)).toBe(2);
    expect(magnitudeStep(0.4, 3)).toBe(1);
    // The SAME day reads stronger against a lower goal — which is the point:
    // at 2.5% risk the 3% goal is 1.2R, and the calendar rescales with it.
    expect(magnitudeStep(1.6, 1.5)).toBe(3);
    // Losses use the same arm lengths.
    expect(magnitudeStep(-3, 3)).toBe(3);
    // No goal set falls back to 3% rather than dividing by zero.
    expect(magnitudeStep(3, null)).toBe(3);
    expect(magnitudeStep(3, 0)).toBe(3);
  });
});

describe('buildMonthGrid — weekdays only, in the right columns', () => {
  it('places the first session under its own weekday and skips weekends', () => {
    // 2026-09-01 is a Tuesday, so the first row is padded by one.
    const weeks = buildMonthGrid('2026-09', new Map());
    expect(weeks[0][0]).toBeFalsy(); // one pad cell before Tuesday
    expect(weeks[0][1].etDate).toBe('2026-09-01');
    expect(weeks[0]).toHaveLength(5); // Mon-pad, Tue..Fri
    // No Saturday or Sunday anywhere.
    const all = weeks.flat().filter(Boolean);
    expect(all.some((c) => ['2026-09-05', '2026-09-06'].includes(c.etDate))).toBe(false);
  });
});

describe('rendering a month', () => {
  it('shows an explicit sign on every tile, so the day never reads by color alone', () => {
    render(
      <DailyResultsCalendar
        month="2026-09"
        rows={[day('2026-09-01', { accountGainPct: 2.4 }), day('2026-09-02', { accountGainPct: -1.2 })]}
        metric="account"
        goalPct={3}
      />,
    );
    expect(within(screen.getByTestId('results-day-2026-09-01')).getByText('+2.40%')).toBeTruthy();
    expect(within(screen.getByTestId('results-day-2026-09-02')).getByText('-1.20%')).toBeTruthy();
  });

  it('says a dash where the account figure does not exist, and never a zero', () => {
    render(
      <DailyResultsCalendar
        month="2026-09"
        rows={[day('2026-09-01', { accountGainPct: null, strategyGainPct: null, baselineEquityUsd: null })]}
        metric="account"
        goalPct={3}
      />,
    );
    const tile = screen.getByTestId('results-day-2026-09-01');
    expect(within(tile).getByText('—')).toBeTruthy();
    expect(within(tile).queryByText(/0\.00%/)).toBeNull();
    // …and the strategy dollars are still shown, because those ARE known.
    expect(within(tile).getByText('+$95')).toBeTruthy();
  });

  it('carries the badges as letters — a colorblind reader and a printout both read them', () => {
    render(
      <DailyResultsCalendar
        month="2026-09"
        rows={[day('2026-09-01', { goalReached: true, drawdownHalted: true, manualTrading: true })]}
        metric="account"
        goalPct={3}
      />,
    );
    const tile = screen.getByTestId('results-day-2026-09-01');
    expect(within(tile).getByTitle('Daily goal reached')).toHaveTextContent('G');
    expect(within(tile).getByTitle('Daily drawdown halt')).toHaveTextContent('H');
    expect(within(tile).getByTitle(/disagree by more than 0\.5%/)).toHaveTextContent('M');
  });

  it('switches which percentage the tile shows without touching the dollars', () => {
    const rows = [day('2026-09-01', { accountGainPct: 4, strategyGainPct: 0.9 })];
    const { rerender } = render(<DailyResultsCalendar month="2026-09" rows={rows} metric="account" goalPct={3} />);
    expect(within(screen.getByTestId('results-day-2026-09-01')).getByText('+4.00%')).toBeTruthy();
    rerender(<DailyResultsCalendar month="2026-09" rows={rows} metric="strategy" goalPct={3} />);
    const tile = screen.getByTestId('results-day-2026-09-01');
    expect(within(tile).getByText('+0.90%')).toBeTruthy();
    expect(within(tile).getByText('+$95')).toBeTruthy();
    expect(pctOf(rows[0], 'strategy')).toBe(0.9);
  });

  it('totals the week in DOLLARS — a sum of percentages would be two kinds of wrong', () => {
    render(
      <DailyResultsCalendar
        month="2026-09"
        rows={[
          day('2026-09-01', { strategyPnlUsd: 100 }),
          day('2026-09-02', { strategyPnlUsd: -40 }),
          day('2026-09-03', { strategyPnlUsd: 15 }),
        ]}
        metric="account"
        goalPct={3}
        weekTotals
      />,
    );
    expect(screen.getByText('+$75')).toBeTruthy();
  });

  it('renders a month with no sessions at all without falling over', () => {
    render(<DailyResultsCalendar month="2026-09" rows={[]} metric="account" goalPct={3} />);
    expect(screen.getByTestId('results-calendar')).toBeTruthy();
    expect(screen.getByTestId('results-day-2026-09-01')).toBeTruthy();
  });
});

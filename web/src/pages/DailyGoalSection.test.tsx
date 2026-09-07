import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ToastContext';
import { DailyGoalSection, guardLevelsFor } from './DailyGoalSection';
import { client } from '../api/client';
import type { AutotradeConfig, DailyTargetSweepResult, PolicyOutcome } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// The section reads only the three goal fields, so a focused partial cast keeps
// the fixture lean (same idiom as TuneFromTargetSection.test.tsx).
function configFixture(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    targetDailyGainPct: null,
    giveBackArmPct: null,
    giveBackFloorPct: null,
    ...overrides,
  } as unknown as AutotradeConfig;
}

function renderSection(config: AutotradeConfig, onSaved = vi.fn()) {
  const utils = render(
    <ToastProvider>
      <DailyGoalSection config={config} onSaved={onSaved} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Daily goal/ }));
  return { ...utils, onSaved };
}

const inputs = () => ({
  target: screen.getByPlaceholderText('e.g. 1.5') as HTMLInputElement,
  arm: screen.getByPlaceholderText('e.g. 1') as HTMLInputElement,
  floor: screen.getByPlaceholderText('e.g. 0.5') as HTMLInputElement,
});

describe('guardLevelsFor', () => {
  it('stamps the tune ratio: arm at 2/3 of the goal, floor at 1/3', () => {
    expect(guardLevelsFor(3)).toEqual({ armPct: 2, floorPct: 1 });
    expect(guardLevelsFor(1)).toEqual({ armPct: 0.67, floorPct: 0.33 });
  });
});

describe('DailyGoalSection', () => {
  it('seeds the fields from the stored config and disables Save until something changes', () => {
    renderSection(configFixture({ targetDailyGainPct: 3, giveBackArmPct: 2, giveBackFloorPct: 1 }));
    const { target, arm, floor } = inputs();
    expect(target.value).toBe('3');
    expect(arm.value).toBe('2');
    expect(floor.value).toBe('1');
    expect(screen.getByRole('button', { name: 'Save daily goal' })).toBeDisabled();
  });

  it('saves exactly the three fields — numbers for what is filled in, null for what is blank', async () => {
    const spy = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({} as never);
    const { onSaved } = renderSection(configFixture());
    const { target, arm } = inputs();
    fireEvent.change(target, { target: { value: '1.5' } });
    fireEvent.change(arm, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save daily goal' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 1.5, giveBackArmPct: 1, giveBackFloorPct: null }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('"Stamp levels from goal" fills arm and floor at 2/3 and 1/3 without saving', () => {
    const spy = vi.spyOn(client, 'setAutotradeConfig');
    renderSection(configFixture());
    fireEvent.change(inputs().target, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stamp levels from goal' }));
    expect(inputs().arm.value).toBe('2');
    expect(inputs().floor.value).toBe('1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('"Clear all" writes three nulls (disarms the tracker and the guard)', async () => {
    const spy = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({} as never);
    renderSection(configFixture({ targetDailyGainPct: 3, giveBackArmPct: 2, giveBackFloorPct: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: null, giveBackArmPct: null, giveBackFloorPct: null }),
    );
  });

  it('surfaces the route refusal instead of pretending an inverted pair was stored', async () => {
    vi.spyOn(client, 'setAutotradeConfig').mockRejectedValue(
      new Error(
        'giveBackArmPct (1) must be above giveBackFloorPct (2) — stored as-is, the give-back guard would silently stay off',
      ),
    );
    const { onSaved } = renderSection(configFixture());
    const { arm, floor } = inputs();
    fireEvent.change(arm, { target: { value: '1' } });
    fireEvent.change(floor, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save daily goal' }));
    expect(await screen.findByText(/must be above giveBackFloorPct/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('warns that guard levels without a goal do nothing', () => {
    renderSection(configFixture({ giveBackArmPct: 2, giveBackFloorPct: 1 }));
    expect(screen.getByText(/Guard levels without a goal do nothing/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // The sweep (2026-09-07): what the record says about each level.
  // -------------------------------------------------------------------------
  const outcome = (policy: PolicyOutcome['policy'], over: Partial<PolicyOutcome> = {}): PolicyOutcome => ({
    policy,
    sessionsHalted: 3,
    entriesDropped: 4,
    totalR: 2.5,
    meanDayR: 0.1,
    medianDayR: 0,
    worstDayR: -1.5,
    delta: { meanR: 0.05, ciLowR: -0.1, ciHighR: 0.2, pValue: 0.4, reliable: true },
    ...over,
  });
  function sweepFixture(over: Partial<DailyTargetSweepResult> = {}): DailyTargetSweepResult {
    return {
      book: 'live',
      realized: {
        avgR: 0.05,
        rTrades: 43,
        tradesPerSession: 9,
        sessions: 22,
        sessionsWithoutEntries: 1,
        droppedTrades: 2,
        remappedEvents: 0,
        eventsOutsideWindow: 0,
        lookbackSessions: 40,
        reliable: true,
      },
      riskPerTradePct: 1.25,
      storedTargetPct: 3,
      storedTargetR: 2.4,
      actual: outcome('none', { delta: null, sessionsHalted: 0, entriesDropped: 0, totalR: 1.1 }),
      levels: [
        {
          levelR: 1,
          levelPct: 1.25,
          isStoredTarget: false,
          policies: [outcome('bank'), outcome('giveBack'), outcome('bankTrail')],
        },
        {
          levelR: 2.4,
          levelPct: 3,
          isStoredTarget: true,
          policies: [
            outcome('bank', {
              delta: { meanR: 0, ciLowR: 0, ciHighR: 0, pValue: 1, reliable: true },
              sessionsHalted: 0,
            }),
            outcome('giveBack', {
              delta: { meanR: 0, ciLowR: 0, ciHighR: 0, pValue: 1, reliable: true },
              sessionsHalted: 0,
            }),
            outcome('bankTrail', {
              delta: { meanR: 0, ciLowR: 0, ciHighR: 0, pValue: 1, reliable: true },
              sessionsHalted: 0,
            }),
          ],
        },
      ],
      reliable: true,
      tradesUsed: 43,
      droppedTrades: 2,
      approximatedExits: 1,
      sessionDates: ['2026-08-31', '2026-09-01'],
      ...over,
    };
  }

  it("runs the sweep on demand for the chosen book and window, and marks the stored goal's row", async () => {
    const spy = vi.spyOn(client, 'dailyTargetSweep').mockResolvedValue(sweepFixture());
    renderSection(configFixture({ targetDailyGainPct: 3, giveBackArmPct: 2, giveBackFloorPct: 1 }));
    expect(spy).not.toHaveBeenCalled(); // never on mount — it bootstraps
    fireEvent.click(screen.getByRole('tab', { name: 'Paper (control)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ book: 'paper', sessions: 40 }));
    const table = await screen.findByTestId('daily-goal-sweep');
    expect(table).toHaveTextContent(/Reliable record: 43 of 20 trades over 22 of 20 sessions/);
    expect(table).toHaveTextContent(/2 trade\(s\) dropped/);
    expect(table).toHaveTextContent(/1 exit moment\(s\) approximated/);
    const stored = screen.getByTestId('sweep-stored-level');
    expect(stored).toHaveTextContent(/2\.4R/);
    expect(stored).toHaveTextContent(/3\.00% at full size/);
    expect(stored).toHaveTextContent(/stored goal/);
    expect(table).toHaveTextContent(/\+0\.05R\/session/);
    expect(table).toHaveTextContent(/CI -0\.10R … \+0\.20R · halted 3 · dropped 4/);
  });

  it('"Use this level" fills the goal at the level\'s % with the guard stamped at 2/3 and 1/3, and does not save', async () => {
    vi.spyOn(client, 'dailyTargetSweep').mockResolvedValue(sweepFixture());
    const save = vi.spyOn(client, 'setAutotradeConfig');
    renderSection(configFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    const buttons = await screen.findAllByRole('button', { name: 'Use this level' });
    fireEvent.click(buttons[0]); // the 1R row → 1.25%
    expect(inputs().target.value).toBe('1.25');
    expect(inputs().arm.value).toBe('0.83');
    expect(inputs().floor.value).toBe('0.42');
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save daily goal' })).toBeEnabled();
  });

  it('flags a thin record and shows the route error when the sweep fails', async () => {
    vi.spyOn(client, 'dailyTargetSweep').mockResolvedValueOnce(
      sweepFixture({
        reliable: false,
        tradesUsed: 7,
        realized: { ...sweepFixture().realized, rTrades: 7, sessions: 5, reliable: false },
      }),
    );
    renderSection(configFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    expect(
      await screen.findByText(/Thin record — read the shape, not the numbers: 7 of 20 trades over 5 of 20 sessions/),
    ).toBeInTheDocument();
    vi.spyOn(client, 'dailyTargetSweep').mockRejectedValueOnce(
      new Error('sessions: Number must be greater than or equal to 5'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep' }));
    expect(await screen.findByText(/greater than or equal to 5/)).toBeInTheDocument();
  });
});

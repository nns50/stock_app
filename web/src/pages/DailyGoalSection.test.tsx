import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ToastContext';
import { DailyGoalSection, guardLevelsFor } from './DailyGoalSection';
import { client } from '../api/client';
import type { AutotradeConfig } from '../api/types';

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
});

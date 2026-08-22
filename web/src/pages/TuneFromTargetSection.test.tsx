import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmProvider } from '../components/ConfirmContext';
import { TuneFromTargetSection } from './AutoTradePage';
import { client } from '../api/client';
import type { AutotradeConfig, TargetTuneResult, TunablePatch } from '../api/types';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// The section only reads accountEquityUsd + the tunable-allowlist fields (for the
// before -> after table), so a focused partial cast keeps the fixture lean.
function configFixture(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    accountEquityUsd: 1000,
    riskProfile: 'MODERATE',
    maxConcurrentPositions: 2,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    maxTradesPerDay: 6,
    liveMaxOrderUsd: 500,
    optionsDeltaMax: 0.6,
    ...overrides,
  } as unknown as AutotradeConfig;
}

function previewFixture(overrides: Partial<TargetTuneResult> = {}): TargetTuneResult {
  const patch: TunablePatch = {
    riskProfile: 'MODERATE',
    maxConcurrentPositions: 2,
    riskPerTradePct: 2.38,
    maxDailyDrawdownPct: 10.71,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 4.76,
    maxCorrelatedExposurePct: 6,
    maxSectorExposurePct: 20,
    maxTradesPerDay: 6,
    minRelVol: 1.5,
    minPrice: 2,
    minAvgVolume: 500_000,
    minSignalScore: 50,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    targetRMultiple: 2,
    liveMaxOrderUsd: 250,
    liveMaxDailyLossUsd: 107,
    liveMaxOrdersPerDay: 6,
    liveOptionsMaxOrderUsd: 250,
    liveOptionsMaxDailyLossUsd: 107,
    liveOptionsMaxOrdersPerDay: 6,
    liveCapsAnchorEquityUsd: 10000,
    targetDailyGainPct: 5,
    giveBackArmPct: 3.33,
    giveBackFloorPct: 1.67,
    optionsDeltaMin: 0.3,
    optionsDeltaMax: 0.6,
    optionsMaxSpreadPct: 10,
    optionsMinDte: 7,
    optionsMaxDte: 60,
    optionsIvRankMax: 70,
    optionsIvRankMin: 0,
    optionsMaxIvRvRatio: 1.2,
    optionsStopLossPct: 50,
    optionsTakeProfitPct: 80,
  };
  return {
    band: 'moderate',
    basis: 'expected',
    targetDailyGainPct: 5,
    edgeR: 0.35,
    rawRiskPerTradePct: 2.38,
    patch,
    warnings: [],
    ...overrides,
  };
}

function renderSection(props: {
  config?: AutotradeConfig;
  onApply?: (p: TunablePatch, band: 'conservative' | 'moderate' | 'aggressive') => Promise<void>;
  applying?: boolean;
}) {
  return render(
    <ConfirmProvider>
      <TuneFromTargetSection
        config={props.config ?? configFixture()}
        onApply={props.onApply ?? (() => Promise.resolve())}
        applying={props.applying ?? false}
      />
    </ConfirmProvider>,
  );
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: /Tune from target daily gain/ }));
}

describe('TuneFromTargetSection', () => {
  it('is gated on equity — prompts to set it and never previews when unset', () => {
    const spy = vi.spyOn(client, 'tuneFromTargetPreview');
    renderSection({ config: configFixture({ accountEquityUsd: null }) });
    expand();
    expect(screen.getByText(/Set/)).toBeInTheDocument();
    expect(screen.getByText(/Account equity/)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('auto-previews the default target and renders the band, risk %, and a before -> after row', async () => {
    const spy = vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(previewFixture());
    renderSection({});
    expand();
    // default target 5, expected basis
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 5, basis: 'expected' }));
    expect(await screen.findByText('Moderate')).toBeInTheDocument();
    // risk per trade shown, and the changed-row table has the 1% -> 2.38% move
    expect(screen.getByText('Risk per trade')).toBeInTheDocument();
    expect(screen.getAllByText(/2\.38%/).length).toBeGreaterThan(0);
  });

  it('re-previews with the perfect-day basis when the toggle is flipped', async () => {
    const spy = vi
      .spyOn(client, 'tuneFromTargetPreview')
      .mockResolvedValue(
        previewFixture({ basis: 'perfectDay', patch: { ...previewFixture().patch, riskPerTradePct: 0.42 } }),
      );
    renderSection({});
    expand();
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 5, basis: 'expected' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Perfect day' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 5, basis: 'perfectDay' }));
  });

  it('renders warnings from the preview', async () => {
    vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(
      previewFixture({ warnings: ['Auto-tune from realized edge is ON — it will move the risk %.'] }),
    );
    renderSection({});
    expand();
    expect(await screen.findByText(/Auto-tune from realized edge is ON/)).toBeInTheDocument();
  });

  it('applies the previewed patch on click', async () => {
    vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(previewFixture());
    const onApply = vi.fn().mockResolvedValue(undefined);
    renderSection({ onApply });
    expand();
    const applyBtn = await screen.findByRole('button', { name: 'Apply tuned settings' });
    fireEvent.click(applyBtn);
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(previewFixture().patch, 'moderate'));
  });

  it('remembers the entered target and basis across a remount (persisted, not reset to 5)', async () => {
    const spy = vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(previewFixture());
    const first = renderSection({});
    expand();
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 5, basis: 'expected' }));

    const input = (await screen.findByPlaceholderText('e.g. 5')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('12');
    fireEvent.click(screen.getByRole('tab', { name: 'Perfect day' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 12, basis: 'perfectDay' }));

    // Unmount + fresh mount — exactly what toggling the config/dashboard view or
    // reloading the page does. The section's own collapse state is persisted too,
    // so it comes back expanded with the field visible.
    first.unmount();
    renderSection({});
    const input2 = (await screen.findByPlaceholderText('e.g. 5')) as HTMLInputElement;
    expect(input2.value).toBe('12');
    expect(screen.getByRole('tab', { name: 'Perfect day' })).toHaveAttribute('aria-selected', 'true');
    // and it re-previews from the remembered target/basis, not the 5/expected default
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ targetDailyGainPct: 12, basis: 'perfectDay' }));
  });

  it('re-previews when the account equity AMOUNT changes, not just when it is first set', async () => {
    // The server scales the dollar caps (liveMaxOrderUsd, liveMaxDailyLossUsd and
    // their options twins) off equity, and equity moves on its own — the loop
    // marks it to market and the page re-syncs it every 60s. Keying the effect on
    // an "is equity set?" boolean left the tuned column, and the patch Apply
    // writes, scaled to a stale equity.
    const spy = vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(previewFixture());
    const { rerender } = render(
      <ConfirmProvider>
        <TuneFromTargetSection
          config={configFixture({ accountEquityUsd: 1000 })}
          onApply={() => Promise.resolve()}
          applying={false}
        />
      </ConfirmProvider>,
    );
    expand();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender(
      <ConfirmProvider>
        <TuneFromTargetSection
          config={configFixture({ accountEquityUsd: 100_000 })}
          onApply={() => Promise.resolve()}
          applying={false}
        />
      </ConfirmProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('reset-to-moderate fetches the moderate baseline and applies it', async () => {
    vi.spyOn(client, 'tuneFromTargetPreview').mockResolvedValue(previewFixture());
    const moderatePatch = { ...previewFixture().patch, riskPerTradePct: 1 };
    const baselineSpy = vi.spyOn(client, 'tuneModerateBaseline').mockResolvedValue({ patch: moderatePatch });
    const onApply = vi.fn().mockResolvedValue(undefined);
    renderSection({ onApply });
    expand();
    const resetBtn = await screen.findByRole('button', { name: 'Reset to moderate' });
    fireEvent.click(resetBtn);
    await waitFor(() => expect(baselineSpy).toHaveBeenCalled());
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(moderatePatch, 'moderate'));
  });
});

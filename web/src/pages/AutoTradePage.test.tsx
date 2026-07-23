import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AutoTradePage from './AutoTradePage';
import { ToastProvider } from '../components/ToastContext';
import { ConfirmProvider } from '../components/ConfirmContext';
import { client } from '../api/client';
import type {
  AutotradeConfig,
  AutotradeDashboard,
  AutotradeDecideResponse,
  AutotradeLivePosition,
  AutotradeRiskCheckResult,
  BacktestRunResponse,
  CombinedBacktestRunResponse,
  LiveOptionsPosition,
  LoopTickSummary,
  OptionsBacktestRunResponse,
  OptionsPaperPosition,
  PaperPosition,
  SignificanceStats,
  WalkForwardResponse,
} from '../api/types';

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AutoTradePage />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

// The Configuration/Dashboard split (2026-07-17) persists the active tab in
// localStorage the same way CollapsibleCard persists collapse state — seed it
// before render so dashboard-only tests don't need an extra click-and-wait on
// every single case just to reach content that isn't on the default tab.
function renderDashboard() {
  localStorage.setItem('autotrade.view', JSON.stringify('dashboard'));
  return renderPage();
}

function configFixture(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: 100_000,
    maxConcurrentPositions: 2,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxSectorExposurePct: 20,
    maxTradesPerDay: 6,
    regimeAtrThresholdPct: 3,
    regimeSizeCutPct: 0,
    tradeDirection: 'long',
    minRelVol: 1.5,
    requireWeeklyTrendAlignment: false,
    relativeStrengthWeight: 0,
    benchmarkSymbol: 'SPY',
    relativeStrengthLookbackDays: 20,
    sentimentWeight: 0,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    stopAtrMultiple: 1.5,
    targetRMultiple: 2,
    maxHoldDays: 0,
    breakevenTriggerRMultiple: 0,
    trailStartRMultiple: 0,
    trailStopRMultiple: 0,
    partialExitRMultiple: 0,
    partialExitPct: 50,
    optionsStopLossPct: 0,
    optionsTakeProfitPct: 0,
    optionsBreakevenTriggerPct: 0,
    optionsTrailStartPct: 0,
    optionsTrailStopPct: 0,
    optionsPartialExitTriggerPct: 0,
    optionsPartialExitPct: 50,
    sessionBufferMinutes: 15,
    earningsBlackoutDays: 0,
    macroEventBlackoutHours: 0,
    correlationLookbackDays: 30,
    correlationThreshold: 0.7,
    liveTradingEnabled: false,
    liveEnabledAt: null,
    liveAccountId: null,
    liveMaxOrderUsd: 25_000,
    liveMaxDailyLossUsd: 3_000,
    liveMaxOrdersPerDay: 6,
    liveFatFingerPct: 10,
    liveAllowNakedShort: false,
    liveProbationTrades: 20,
    liveProbationSizeMultiplier: 0.5,
    liveOptionsEnabled: false,
    liveOptionsEnabledAt: null,
    liveOptionsMaxOrderUsd: 2_000,
    liveOptionsMaxDailyLossUsd: 500,
    liveOptionsMaxOrdersPerDay: 6,
    liveOptionsFatFingerPct: 10,
    liveOptionsProbationTrades: 20,
    liveOptionsProbationSizeMultiplier: 0.5,
    optionsStrategyType: 'single_leg',
    autoPromoteMoversEnabled: true,
    autoPromoteThreshold: 3,
    autoPromoteWindowDays: 10,
    autoPromoteMaxSymbols: 50,
    autoTuneEnabled: false,
    autoTuneMinTrades: 20,
    autoTuneMaxStepPct: 0.5,
    autoTuneSlippageExcludePct: 2,
    ...overrides,
  };
}

function dashboardFixture(overrides: Partial<AutotradeDashboard> = {}): AutotradeDashboard {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    equity: 100_000,
    lastTick: null,
    openPositions: [],
    openPositionsCount: 0,
    maxConcurrentPositions: 2,
    openRisk: 0,
    maxAggregateOpenRisk: 2_000,
    maxCorrelatedExposure: 6_000,
    lastCorrelatedExposureCheck: null,
    sectorExposure: [],
    maxSectorExposure: 20_000,
    dailyPnl: 0,
    dailyDrawdownHaltLevel: -3_000,
    tradesToday: 0,
    maxTradesPerDay: 6,
    consecutiveLosses: 0,
    stepDownAfterLosses: 2,
    openOptionsPositions: [],
    liveTradingEnabled: false,
    liveAccountId: null,
    liveOpenPositions: [],
    liveOpenPositionsCount: 0,
    liveOpenRisk: 0,
    liveDailyPnl: 0,
    liveTradesToday: 0,
    liveConsecutiveLosses: 0,
    liveMaxOrderUsd: 25_000,
    liveMaxDailyLossUsd: 3_000,
    liveMaxOrdersPerDay: 6,
    probation: { active: false, multiplier: 1, tradesPlaced: 0, tradesRemaining: 20 },
    liveOptionsEnabled: false,
    liveOptionsOpenPositions: [],
    liveOptionsOpenPositionsCount: 0,
    liveOptionsOpenRisk: 0,
    liveOptionsDailyPnl: 0,
    liveOptionsTradesToday: 0,
    liveOptionsConsecutiveLosses: 0,
    liveOptionsMaxOrderUsd: 2_000,
    liveOptionsMaxDailyLossUsd: 500,
    liveOptionsMaxOrdersPerDay: 6,
    liveOptionsProbation: { active: false, multiplier: 1, tradesPlaced: 0, tradesRemaining: 20 },
    ...overrides,
  };
}

function loopSummaryFixture(overrides: Partial<LoopTickSummary> = {}): LoopTickSummary {
  return {
    ranEntries: false,
    exitsChecked: 0,
    exitsClosed: 0,
    optionsExitsChecked: 0,
    optionsExitsClosed: 0,
    liveOrdersReconciled: 0,
    livePositionsClosed: 0,
    liveOptionsOrdersReconciled: 0,
    liveOptionsPositionsClosed: 0,
    liveOptionsExitsRequested: 0,
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    optionsSignalsGenerated: 0,
    optionsCandidatesConsidered: 0,
    entriesOpened: 0,
    optionsEntriesOpened: 0,
    liveEntriesOpened: 0,
    liveOptionsEntriesOpened: 0,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture());
  vi.spyOn(client, 'autotradeExclusions').mockResolvedValue({
    exclusions: [{ symbol: 'VNQ', reason: 'Real estate ETF', source: 'default', createdAt: Date.now() }],
  });
  vi.spyOn(client, 'autotradeMacroEvents').mockResolvedValue({ events: [] });
  vi.spyOn(client, 'autotradeEvents').mockResolvedValue({ events: [] });
  vi.spyOn(client, 'events').mockResolvedValue({ events: [] });
  vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture());
  vi.spyOn(client, 'autotradePortfolioGreeks').mockResolvedValue({ netDelta: 0, netTheta: 0, netVega: 0 });
});

describe('AutoTradePage', () => {
  it('renders the fetched config and exclusion list', async () => {
    renderPage();
    expect(await screen.findByText('VNQ')).toBeInTheDocument();
    expect(screen.getByText('Real estate ETF')).toBeInTheDocument();
    const checkbox = screen.getByLabelText('Auto-trading enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole('combobox', { name: /^Risk profile\b/ })).toHaveValue('MODERATE');
    expect(screen.queryByText(/equity isn.t set/i)).toBeNull();
  });

  it('warns when account equity is not set', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ accountEquityUsd: null }));
    renderPage();
    expect(await screen.findByText(/equity isn.t set/i)).toBeInTheDocument();
  });

  it('saves a new account equity value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 50_000 });
    renderPage();
    await screen.findByText('VNQ');

    const equityInput = screen.getByPlaceholderText('e.g. 25000');
    fireEvent.change(equityInput, { target: { value: '50000' } });

    // NumberInput buffers its own `text` state and re-syncs it from the
    // `value` prop via a useEffect (see components/ui.tsx) — the Save
    // button's disabled state depends on that prop having actually reached
    // the parent's equityDraft, which is not guaranteed to have settled by
    // the very next synchronous line under CI-level scheduling/load (the
    // same class of flake TradePage's own auto-refresh tests hit; see that
    // file's history). Wait for the observable consequence — the button
    // actually becoming enabled — instead of assuming it settled synchronously.
    const saveButton = screen.getByRole('button', { name: 'Save account equity' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ accountEquityUsd: 50_000, confirmAggressive: undefined }),
    );
  });

  it('saves a new regime ATR threshold value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    // No shared placeholder to collide with (unlike the options stop-loss/
    // take-profit fields below) — scope by the Field's own wrapping <label>.
    const thresholdField = screen.getByText('Regime ATR threshold (%)').closest('label')!;
    const thresholdInput = within(thresholdField).getByRole('textbox');
    fireEvent.change(thresholdInput, { target: { value: '4' } });

    const saveButton = screen.getByRole('button', { name: 'Save regime ATR threshold' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ regimeAtrThresholdPct: 4, confirmAggressive: undefined }),
    );
  });

  it('saves a new regime size cut value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const sizeCutInput = screen.getByPlaceholderText('0 (no cut)');
    fireEvent.change(sizeCutInput, { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save regime size cut' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ regimeSizeCutPct: 25, confirmAggressive: undefined }));
  });

  it('reflects a fetched requireWeeklyTrendAlignment: true as a checked checkbox', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ requireWeeklyTrendAlignment: true }));
    renderPage();
    await screen.findByText('VNQ');
    // Unlike 'Auto-trading enabled' elsewhere in this file, this field's
    // fixture value (true) differs from its useState default (false), so
    // this assertion can actually distinguish "config hydrated" from "still
    // on the initial default" — which means it also genuinely needs to wait
    // for that hydration, not just for the (separately-fetched) exclusion
    // list's own VNQ text to land. Same config-hydration-is-not-synchronous-
    // with-VNQ caution as the account equity test above.
    await waitFor(() => {
      const checkbox = screen.getByLabelText('Require weekly trend alignment') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });
  });

  it('toggling require weekly trend alignment saves immediately (no separate Save button)', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByLabelText('Require weekly trend alignment'));

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ requireWeeklyTrendAlignment: true, confirmAggressive: undefined }),
    );
  });

  it('saves a new relative strength weight value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const weightField = screen.getByText('Relative strength weight (0-100)').closest('label')!;
    const weightInput = within(weightField).getByRole('textbox');
    fireEvent.change(weightInput, { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save relative strength weight' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ relativeStrengthWeight: 25, confirmAggressive: undefined }),
    );
  });

  it('saves a new benchmark symbol value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const symbolField = screen.getByText('Benchmark symbol').closest('label')!;
    const symbolInput = within(symbolField).getByRole('textbox');
    fireEvent.change(symbolInput, { target: { value: 'qqq' } });

    const saveButton = screen.getByRole('button', { name: 'Save benchmark symbol' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    // Uppercased as the user types, mirroring how symbols are stored elsewhere.
    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ benchmarkSymbol: 'QQQ', confirmAggressive: undefined }),
    );
  });

  it('toggling auto-tune from realized edge saves immediately (no separate Save button)', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-tune from realized edge/ }));

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ autoTuneEnabled: true, confirmAggressive: undefined }),
    );
  });

  it('saves a new auto-tune min sample size value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const field = screen.getByText('Min sample size').closest('label')!;
    fireEvent.change(within(field).getByRole('textbox'), { target: { value: '10' } });

    const saveButton = screen.getByRole('button', { name: 'Save min sample size' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ autoTuneMinTrades: 10, confirmAggressive: undefined }),
    );
  });

  it('saves a new auto-tune max daily risk-% step value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const field = screen.getByText('Max daily risk-% step').closest('label')!;
    fireEvent.change(within(field).getByRole('textbox'), { target: { value: '1' } });

    const saveButton = screen.getByRole('button', { name: 'Save max daily risk-% step' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ autoTuneMaxStepPct: 1, confirmAggressive: undefined }),
    );
  });

  it('saves a new auto-tune slippage exclusion threshold value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const field = screen.getByText('Slippage exclusion threshold (%)').closest('label')!;
    fireEvent.change(within(field).getByRole('textbox'), { target: { value: '3' } });

    const saveButton = screen.getByRole('button', { name: 'Save slippage exclusion threshold' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ autoTuneSlippageExcludePct: 3, confirmAggressive: undefined }),
    );
  });

  it('saves a new max sector exposure value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const field = screen.getByText('Max sector exposure (%)').closest('label')!;
    fireEvent.change(within(field).getByRole('textbox'), { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save max sector exposure' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ maxSectorExposurePct: 25, confirmAggressive: undefined }),
    );
  });

  it('saves a new relative strength lookback value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const lookbackField = screen.getByText('Relative strength lookback (days)').closest('label')!;
    const lookbackInput = within(lookbackField).getByRole('textbox');
    fireEvent.change(lookbackInput, { target: { value: '10' } });

    const saveButton = screen.getByRole('button', { name: 'Save relative strength lookback' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ relativeStrengthLookbackDays: 10, confirmAggressive: undefined }),
    );
  });

  it('saves a new sentiment weight value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const weightField = screen.getByText('Sentiment weight (0-100)').closest('label')!;
    const weightInput = within(weightField).getByRole('textbox');
    fireEvent.change(weightInput, { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save sentiment weight' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ sentimentWeight: 25, confirmAggressive: undefined }));
  });

  it('saves a new macro event blackout hours value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const field = screen.getByText('Macro event blackout (hours)').closest('label')!;
    const input = within(field).getByRole('textbox');
    fireEvent.change(input, { target: { value: '2' } });

    const saveButton = screen.getByRole('button', { name: 'Save macro event blackout' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ macroEventBlackoutHours: 2, confirmAggressive: undefined }),
    );
  });

  it('adds a new macro event to the blackout list', async () => {
    const addEvent = vi.spyOn(client, 'addAutotradeMacroEvent').mockResolvedValue({
      id: 1,
      label: 'FOMC decision',
      eventAt: Date.parse('2026-09-16T18:00'),
      createdAt: Date.now(),
    });
    renderPage();
    await screen.findByText('VNQ');

    const labelField = screen.getByPlaceholderText('FOMC decision');
    fireEvent.change(labelField, { target: { value: 'FOMC decision' } });
    const dateField = screen.getByText('Date & time').closest('label')!;
    const dateInput = within(dateField).getByDisplayValue('');
    fireEvent.change(dateInput, { target: { value: '2026-09-16T18:00' } });

    // Scoped to this card specifically — the real-estate exclusion list above
    // it has its own, differently-wired "Add" button with the same text.
    const card = screen.getByText('Macro event blackout list').closest('.p-4')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(addEvent).toHaveBeenCalledWith({ label: 'FOMC decision', eventAt: Date.parse('2026-09-16T18:00') }),
    );
  });

  it('removes a macro event from the blackout list after confirming', async () => {
    vi.spyOn(client, 'autotradeMacroEvents').mockResolvedValue({
      events: [{ id: 7, label: 'FOMC decision', eventAt: Date.now(), createdAt: Date.now() }],
    });
    const removeEvent = vi.spyOn(client, 'removeAutotradeMacroEvent').mockResolvedValue({ removed: 7 });
    renderPage();
    const row = (await screen.findByText('FOMC decision')).closest('tr')!;

    fireEvent.click(within(row).getByRole('button', { name: 'remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removeEvent).toHaveBeenCalledWith(7));
  });

  it('saves a new options stop-loss % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    // Scoped by the Field's own wrapping <label> — several sibling fields
    // share the '0 (disabled)' placeholder, so an index into
    // getAllByPlaceholderText would be fragile to their DOM order.
    const stopLossField = screen.getByText('Options stop-loss (%)').closest('label')!;
    const stopLossInput = within(stopLossField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(stopLossInput, { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save options stop-loss' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsStopLossPct: 25, confirmAggressive: undefined }),
    );
  });

  it('saves a new options take-profit % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const takeProfitField = screen.getByText('Options take-profit (%)').closest('label')!;
    const takeProfitInput = within(takeProfitField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(takeProfitInput, { target: { value: '50' } });

    const saveButton = screen.getByRole('button', { name: 'Save options take-profit' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsTakeProfitPct: 50, confirmAggressive: undefined }),
    );
  });

  it('saves a new options breakeven trigger % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const breakevenField = screen.getByText('Options breakeven trigger (%)').closest('label')!;
    const input = within(breakevenField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(input, { target: { value: '20' } });

    const saveButton = screen.getByRole('button', { name: 'Save options breakeven trigger' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsBreakevenTriggerPct: 20, confirmAggressive: undefined }),
    );
  });

  it('saves a new options trailing start % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const trailStartField = screen.getByText('Options trailing start (%)').closest('label')!;
    const input = within(trailStartField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(input, { target: { value: '20' } });

    const saveButton = screen.getByRole('button', { name: 'Save options trailing start' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsTrailStartPct: 20, confirmAggressive: undefined }),
    );
  });

  it('saves a new options trailing distance % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const trailDistanceField = screen.getByText('Options trailing distance (%)').closest('label')!;
    const input = within(trailDistanceField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(input, { target: { value: '10' } });

    const saveButton = screen.getByRole('button', { name: 'Save options trailing distance' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsTrailStopPct: 10, confirmAggressive: undefined }),
    );
  });

  it('saves a new options partial exit trigger % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    const partialExitTriggerField = screen.getByText('Options partial exit trigger (%)').closest('label')!;
    const input = within(partialExitTriggerField).getByPlaceholderText('0 (disabled)');
    fireEvent.change(input, { target: { value: '20' } });

    const saveButton = screen.getByRole('button', { name: 'Save options partial exit trigger' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsPartialExitTriggerPct: 20, confirmAggressive: undefined }),
    );
  });

  it('saves a new options partial exit size % value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    // No shared placeholder (mirrors equity's own "Partial exit size (%)"
    // field) — scope by the Field's own wrapping <label>.
    const sizeField = screen.getByText('Options partial exit size (%)').closest('label')!;
    const sizeInput = within(sizeField).getByRole('textbox');
    fireEvent.change(sizeInput, { target: { value: '25' } });

    const saveButton = screen.getByRole('button', { name: 'Save options partial exit size' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ optionsPartialExitPct: 25, confirmAggressive: undefined }),
    );
  });

  it('disables "Sync from Webull" until a liveAccountId is on file', async () => {
    renderPage(); // default fixture has liveAccountId: null
    await screen.findByText('VNQ');
    expect(screen.getByRole('button', { name: /Sync from Webull/ })).toBeDisabled();
  });

  it('enables "Sync from Webull" once a liveAccountId is configured', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ liveAccountId: 'ACC1' }));
    renderPage();
    await screen.findByText('VNQ');
    expect(screen.getByRole('button', { name: /Sync from Webull/ })).not.toBeDisabled();
  });

  it('syncing from Webull updates the equity field with the returned net liquidation value', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ liveAccountId: 'ACC1' }));
    const sync = vi.spyOn(client, 'syncAutotradeEquity').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      previousEquityUsd: 100_000,
      netLiquidationUsd: 123_456.78,
      buyingPowerUsd: 200_000,
      config: configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 123_456.78 }),
    });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('button', { name: /Sync from Webull/ }));
    await waitFor(() => expect(sync).toHaveBeenCalled());

    const equityInput = (await screen.findByPlaceholderText('e.g. 25000')) as HTMLInputElement;
    await waitFor(() => expect(equityInput.value).toBe('123456.78'));
  });

  it('a failed sync reports the error and leaves the equity field untouched', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
      configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 100_000 }),
    );
    const sync = vi.spyOn(client, 'syncAutotradeEquity').mockResolvedValue({
      ok: false,
      accountId: 'ACC1',
      error: 'Webull did not return a usable net liquidation value',
    });
    renderPage();
    await screen.findByText('VNQ');

    const equityInput = screen.getByPlaceholderText('e.g. 25000') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: /Sync from Webull/ }));
    await waitFor(() => expect(sync).toHaveBeenCalled());

    expect(equityInput.value).toBe('100000');
  });

  it('requires confirmation before switching to AGGRESSIVE, and does not save on cancel', async () => {
    const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({
      enabled: false,
      killSwitch: false,
      riskProfile: 'AGGRESSIVE',
      accountEquityUsd: 100_000,
    });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox', { name: /^Risk profile\b/ }), { target: { value: 'AGGRESSIVE' } });
    expect(await screen.findByText('Switch to AGGRESSIVE?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Switch to AGGRESSIVE?')).toBeNull());
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('saves with confirmAggressive: true once the switch is confirmed', async () => {
    const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue({
      enabled: false,
      killSwitch: false,
      riskProfile: 'AGGRESSIVE',
      accountEquityUsd: 100_000,
    });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox', { name: /^Risk profile\b/ }), { target: { value: 'AGGRESSIVE' } });
    fireEvent.click(await screen.findByText('Switch to Aggressive'));

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ riskProfile: 'AGGRESSIVE', confirmAggressive: true }));
  });

  it('toggling enabled does not prompt for confirmation', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: true, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByLabelText('Auto-trading enabled'));
    expect(screen.queryByText('Switch to AGGRESSIVE?')).toBeNull();
    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ enabled: true, confirmAggressive: undefined }));
  });

  it('runs a screen+decide and renders candidates (with signals), exclusions, and skipped symbols', async () => {
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'AAPL',
            price: 210.5,
            total: 82.4,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 210.5,
              changePct: 3.2,
              maShort: 200,
              maLong: 190,
              distShortPct: 5,
              distLongPct: 10,
              rsi: 65,
              atr: 3,
              atrPct: 1.4,
              relVolume: 2.1,
              avgVolume: 1_000_000,
              volume: 2_100_000,
              gapPct: 4.5,
            },
            discoverySource: 'movers',
            direction: 'long',
          },
        ],
        excluded: [{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }],
        skipped: [{ symbol: 'XYZ', reason: 'sector/industry could not be determined this cycle' }],
        errors: [],
        discovery: { universeCount: 124, moversCount: 5, scannedCount: 129 },
      },
      decision: {
        signals: [
          {
            symbol: 'AAPL',
            side: 'buy',
            entry: 210.5,
            stop: 206,
            target: 219.5,
            rMultiple: 2,
            rationale:
              'Long breakout: score 82.4, gap +4.50%, rel vol 2.10×, RSI 65.0 — entry 210.50, stop 206.00 (1.5× ATR), target 219.50 (2R)',
            score: 82.4,
          },
        ],
        skipped: [],
      },
      optionsDecision: {
        signals: [
          {
            kind: 'single_leg',
            symbol: 'AAPL',
            side: 'call',
            contractSymbol: 'AAPL-fixture',
            strike: 210,
            expiration: '2024-03-15',
            dte: 21,
            premium: 4.2,
            delta: 0.42,
            ivRank: 55,
            maxLossPerContract: 420,
            rationale: 'Long call on AAPL: strike 210, exp 2024-03-15 (21d), premium 4.20, Δ 0.42, IV rank 55',
            score: 82.4,
          },
        ],
        skipped: [],
      },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    const equityResults: AutotradeRiskCheckResult[] = [
      {
        symbol: 'AAPL',
        ok: true,
        checks: [{ rule: 'equity_configured', passed: true, detail: '$100,000.00' }],
        sizing: {
          maxRiskDollars: 1000,
          stopDistance: 4.5,
          riskPerUnit: 4.5,
          suggestedQuantity: 222,
          positionCost: 46_761,
          positionPctOfAccount: 46.76,
          riskOfPosition: 999,
          targetPrice: null,
          targetProfit: null,
          rewardRiskRatio: null,
          warnings: [],
        },
        stepDownActive: false,
        approvedRiskAmount: 999,
        approvedNotional: 46_761,
      },
    ];
    const riskCheck = vi.spyOn(client, 'runAutotradeRiskCheck').mockResolvedValue({ results: equityResults });
    const optionsRiskCheck = vi.spyOn(client, 'runOptionsRiskCheck').mockResolvedValue({
      results: [
        {
          symbol: 'AAPL',
          ok: true,
          checks: [{ rule: 'equity_configured', passed: true, detail: '$100,000.00' }],
          sizing: {
            maxRiskDollars: 1000,
            stopDistance: 4.2,
            riskPerUnit: 420,
            suggestedQuantity: 2,
            positionCost: 840,
            positionPctOfAccount: 0.84,
            riskOfPosition: 840,
            targetPrice: null,
            targetProfit: null,
            rewardRiskRatio: null,
            warnings: [],
          },
          stepDownActive: false,
          approvedRiskAmount: 840,
          approvedNotional: 840,
        },
      ],
    });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('Candidates (1)')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Excluded — real estate (1)')).toBeInTheDocument();
    expect(screen.getByText('Skipped — unverified sector (1)')).toBeInTheDocument();
    expect(screen.getByText('$206.00')).toBeInTheDocument(); // stop
    expect(screen.getByText('$219.50')).toBeInTheDocument(); // target
    expect(screen.getByText('2R')).toBeInTheDocument();
    await waitFor(() => expect(riskCheck).toHaveBeenCalledWith(result.decision.signals));
    expect(await screen.findByText('222')).toBeInTheDocument(); // sized quantity
    expect(screen.getByText('call 210')).toBeInTheDocument(); // options signal badge
    expect(screen.getByText('$4.20 · Mar 15, 2024')).toBeInTheDocument();
    // Equity risk-check results feed the options risk-check's combined budget.
    await waitFor(() => expect(optionsRiskCheck).toHaveBeenCalledWith(result.optionsDecision.signals, equityResults));
    expect(screen.getAllByText('approved')).toHaveLength(2); // one for equity, one for the options signal
    expect(screen.getByText('2 contracts')).toBeInTheDocument();
  });

  it('saves the selected Trade direction on change', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue(configFixture({ tradeDirection: 'both' }));
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox', { name: /^Trade direction\b/ }), { target: { value: 'both' } });

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ tradeDirection: 'both' }));
  });

  it("saves the selected Options strategy on change to 'auto' (IV-rank-adaptive, 2026-07-18)", async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue(configFixture({ optionsStrategyType: 'auto' }));
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByRole('combobox', { name: /^Options strategy\b/ }), { target: { value: 'auto' } });

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ optionsStrategyType: 'auto' }));
  });

  it('shows a long/short badge per candidate — one of each from the SAME screen run', async () => {
    function indicators() {
      return {
        price: 100,
        changePct: null,
        maShort: null,
        maLong: null,
        distShortPct: null,
        distLongPct: null,
        rsi: null,
        atr: 3,
        atrPct: null,
        relVolume: null,
        avgVolume: null,
        volume: null,
        gapPct: null,
      };
    }
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'LONGCO',
            price: 100,
            total: 70,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: indicators(),
            discoverySource: 'universe',
            direction: 'long',
          },
          {
            symbol: 'SHORTCO',
            price: 50,
            total: 65,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: indicators(),
            discoverySource: 'universe',
            direction: 'short',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 2, moversCount: 0, scannedCount: 2 },
      },
      decision: { signals: [], skipped: [] },
      optionsDecision: { signals: [], skipped: [] },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    vi.spyOn(client, 'runAutotradeRiskCheck').mockResolvedValue({ results: [] });
    vi.spyOn(client, 'runOptionsRiskCheck').mockResolvedValue({ results: [] });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('Candidates (2)')).toBeInTheDocument();
    const longRow = screen.getByText('LONGCO').closest('tr')!;
    const shortRow = screen.getByText('SHORTCO').closest('tr')!;
    expect(within(longRow).getByText('long')).toBeInTheDocument();
    expect(within(shortRow).getByText('short')).toBeInTheDocument();
  });

  it('renders a debit-spread options signal (both strikes, net debit, sized "spreads" not "contracts")', async () => {
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'AAPL',
            price: 210.5,
            total: 82.4,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 210.5,
              changePct: 3.2,
              maShort: 200,
              maLong: 190,
              distShortPct: 5,
              distLongPct: 10,
              rsi: 65,
              atr: 3,
              atrPct: 1.4,
              relVolume: 2.1,
              avgVolume: 1_000_000,
              volume: 2_100_000,
              gapPct: 4.5,
            },
            discoverySource: 'movers',
            direction: 'long',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 124, moversCount: 5, scannedCount: 129 },
      },
      decision: { signals: [], skipped: [{ symbol: 'AAPL', reason: 'no usable volatility history' }] },
      optionsDecision: {
        signals: [
          {
            kind: 'debit_spread',
            symbol: 'AAPL',
            side: 'call',
            expiration: '2024-03-15',
            dte: 21,
            ivRank: 55,
            longContractSymbol: 'AAPL-long',
            longStrike: 210,
            longPremium: 4.2,
            longDelta: 0.42,
            shortContractSymbol: 'AAPL-short',
            shortStrike: 220,
            shortPremium: 2.2,
            shortDelta: 0.2,
            width: 10,
            netDebit: 2,
            maxLossPerContract: 200,
            maxProfitPerContract: 800,
            rationale: 'Call debit spread on AAPL: long 210/short 220, exp 2024-03-15 (21d), net debit 2.00, width 10',
            score: 82.4,
          },
        ],
        skipped: [],
      },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    vi.spyOn(client, 'runAutotradeRiskCheck').mockResolvedValue({ results: [] });
    vi.spyOn(client, 'runOptionsRiskCheck').mockResolvedValue({
      results: [
        {
          symbol: 'AAPL',
          ok: true,
          checks: [{ rule: 'equity_configured', passed: true, detail: '$100,000.00' }],
          sizing: {
            maxRiskDollars: 1000,
            maxLossPerSpread: 200,
            maxProfitPerSpread: 800,
            suggestedContracts: 5,
            totalMaxLoss: 1000,
            totalMaxProfit: 4000,
            positionPctOfAccount: 1,
            rewardRiskRatio: 4,
            warnings: [],
          },
          stepDownActive: false,
          approvedRiskAmount: 1000,
          approvedNotional: 1000,
        },
      ],
    });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('Candidates (1)')).toBeInTheDocument();
    expect(screen.getByText('call 210/220')).toBeInTheDocument(); // both strikes shown
    expect(screen.getByText('$2.00 debit · Mar 15, 2024')).toBeInTheDocument();
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.getByText('5 spreads')).toBeInTheDocument(); // NOT "5 contracts"
  });

  it('clears stale candidates when a later screen run fails, so the error is not shown next to old results', async () => {
    const okResult: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'AAPL',
            price: 210.5,
            total: 82.4,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 210.5,
              changePct: 3.2,
              maShort: 200,
              maLong: 190,
              distShortPct: 5,
              distLongPct: 10,
              rsi: 65,
              atr: 3,
              atrPct: 1.4,
              relVolume: 2.1,
              avgVolume: 1_000_000,
              volume: 2_100_000,
              gapPct: 4.5,
            },
            discoverySource: 'movers',
            direction: 'long',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 124, moversCount: 5, scannedCount: 129 },
      },
      decision: { signals: [], skipped: [] },
      optionsDecision: { signals: [], skipped: [] },
    };
    const decide = vi.spyOn(client, 'runAutotradeDecision').mockResolvedValueOnce(okResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));
    expect(await screen.findByText('Candidates (1)')).toBeInTheDocument();

    decide.mockRejectedValueOnce(new Error('provider down'));
    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('provider down')).toBeInTheDocument();
    expect(screen.queryByText('Candidates (1)')).toBeNull();
  });

  it('shows a blocked risk-check reason when a signal fails a cap', async () => {
    const decideResult: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'MSFT',
            price: 400,
            total: 70,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 400,
              changePct: 2,
              maShort: 390,
              maLong: 380,
              distShortPct: 2,
              distLongPct: 5,
              rsi: 60,
              atr: 8,
              atrPct: 2,
              relVolume: 1.8,
              avgVolume: 2_000_000,
              volume: 3_600_000,
              gapPct: 2,
            },
            discoverySource: 'universe',
            direction: 'long',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 124, moversCount: 0, scannedCount: 124 },
      },
      decision: {
        signals: [
          {
            symbol: 'MSFT',
            side: 'buy',
            entry: 400,
            stop: 388,
            target: 424,
            rMultiple: 2,
            rationale: 'fixture',
            score: 70,
          },
        ],
        skipped: [],
      },
      optionsDecision: { signals: [], skipped: [] },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(decideResult);
    const blocked: AutotradeRiskCheckResult = {
      symbol: 'MSFT',
      ok: false,
      checks: [
        { rule: 'equity_configured', passed: true, detail: '$100,000.00' },
        { rule: 'max_concurrent_positions', passed: false, detail: '2 open vs cap 2' },
      ],
      sizing: {
        maxRiskDollars: 1000,
        stopDistance: 12,
        riskPerUnit: 12,
        suggestedQuantity: 83,
        positionCost: 33_200,
        positionPctOfAccount: 33.2,
        riskOfPosition: 996,
        targetPrice: null,
        targetProfit: null,
        rewardRiskRatio: null,
        warnings: [],
      },
      stepDownActive: false,
      approvedRiskAmount: 0,
      approvedNotional: 0,
    };
    vi.spyOn(client, 'runAutotradeRiskCheck').mockResolvedValue({ results: [blocked] });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('max_concurrent_positions')).toBeInTheDocument();
  });

  it('shows a "no signal" section for decision-skipped candidates', async () => {
    const result: AutotradeDecideResponse = {
      screen: {
        generatedAt: Date.now(),
        candidates: [
          {
            symbol: 'MU',
            price: 40,
            total: 55,
            passedFilters: true,
            filterReasons: [],
            components: [],
            indicators: {
              price: 40,
              changePct: 1,
              maShort: 39,
              maLong: 38,
              distShortPct: 1,
              distLongPct: 2,
              rsi: 55,
              atr: null,
              atrPct: null,
              relVolume: 1.6,
              avgVolume: 500_000,
              volume: 800_000,
              gapPct: 1,
            },
            discoverySource: 'universe',
            direction: 'long',
          },
        ],
        excluded: [],
        skipped: [],
        errors: [],
        discovery: { universeCount: 124, moversCount: 0, scannedCount: 124 },
      },
      decision: { signals: [], skipped: [{ symbol: 'MU', reason: 'insufficient volatility history (ATR)' }] },
      optionsDecision: { signals: [], skipped: [] },
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run screen' }));

    expect(await screen.findByText(/No signal — insufficient volatility history \(1\)/)).toBeInTheDocument();
  });

  it('summarizes a risk-check event\'s nested checks array instead of rendering "[object Object]"', async () => {
    vi.spyOn(client, 'autotradeEvents').mockResolvedValue({
      events: [
        {
          id: 1,
          symbol: 'AAPL',
          stage: 'risk_check',
          action: 'blocked',
          riskProfile: 'MODERATE',
          createdAt: Date.now(),
          detail: JSON.stringify({
            checks: [
              { rule: 'equity_configured', passed: true, detail: '$100,000.00' },
              { rule: 'max_concurrent_positions', passed: false, detail: '2 open vs cap 2' },
            ],
            quantity: 0,
          }),
        },
      ],
    });
    renderDashboard();
    expect(await screen.findByText(/1\/2 failed: max_concurrent_positions/)).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).toBeNull();
  });

  const btRun = (overrides: Partial<BacktestRunResponse['stats']> = {}): BacktestRunResponse => ({
    report: {
      trades: [
        {
          symbol: 'AAPL',
          side: 'buy',
          signalDate: '2024-01-01',
          entryDate: '2024-01-02',
          entryPrice: 100,
          exitDate: '2024-01-05',
          exitPrice: 106,
          exitReason: 'target',
          quantity: 50,
          pnl: 300,
          rMultiple: 2,
        },
      ],
      equityCurve: [
        { date: '2024-01-02', equity: 100_000 },
        { date: '2024-01-05', equity: 100_300 },
      ],
      startingEquity: 100_000,
      finalEquity: 100_300,
      excludedSymbols: [],
      errors: [],
    },
    stats: {
      totalTrades: 1,
      wins: 1,
      losses: 0,
      winRate: 100,
      avgWin: 300,
      avgLoss: 0,
      expectancy: 300,
      profitFactor: null,
      totalPnl: 300,
      returnPct: 0.3,
      avgR: 2,
      bestR: 2,
      worstR: 2,
      maxDrawdown: 0,
      longestWinStreak: 1,
      longestLossStreak: 0,
      ...overrides,
    },
  });

  const sigStats = (overrides: Partial<SignificanceStats> = {}): SignificanceStats => ({
    sampleSize: 1,
    expectancy: 300,
    ciLow: 100,
    ciHigh: 500,
    pValue: 0.03,
    resamples: 2000,
    reliable: false,
    ...overrides,
  });

  it('runs a plain backtest and renders stats + the trade', async () => {
    const run = vi.spyOn(client, 'runAutotradeBacktest').mockResolvedValue(btRun());
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          symbols: ['AAPL'],
          riskProfile: 'MODERATE',
          startingEquity: 100_000,
          directionMode: 'long',
        }),
      ),
    );
    expect(await screen.findByText('target')).toBeInTheDocument();
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
    expect(screen.getByText('$106.00')).toBeInTheDocument(); // trade exit price
    expect(screen.getAllByText('+$300.00').length).toBeGreaterThan(0); // expectancy stat + trade pnl
    expect(screen.queryByRole('heading', { name: /In-sample/ })).toBeNull();
  });

  it('threads the selected Backtest trade direction into all three backtest run calls', async () => {
    const eqRun = vi.spyOn(client, 'runAutotradeBacktest').mockResolvedValue(btRun());
    const optRun = vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue({
      report: {
        trades: [],
        equityCurve: [],
        startingEquity: 100_000,
        finalEquity: 100_000,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: btRun().stats,
    });
    const combinedRun = vi.spyOn(client, 'runCombinedBacktest').mockResolvedValue({
      report: {
        equityTrades: [],
        optionsTrades: [],
        equityCurve: [],
        startingEquity: 100_000,
        finalEquity: 100_000,
        excludedSymbols: [],
        errors: [],
        optionsSkipped: [],
      },
      stats: btRun().stats,
    });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.change(screen.getByRole('combobox', { name: /^Backtest trade direction\b/ }), {
      target: { value: 'both' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));
    await waitFor(() => expect(eqRun).toHaveBeenCalledWith(expect.objectContaining({ directionMode: 'both' })));

    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));
    await waitFor(() => expect(optRun).toHaveBeenCalledWith(expect.objectContaining({ directionMode: 'both' })));

    fireEvent.click(screen.getByRole('button', { name: 'Run combined backtest' }));
    await waitFor(() => expect(combinedRun).toHaveBeenCalledWith(expect.objectContaining({ directionMode: 'both' })));
  });

  it('runs a walk-forward split once a split date is set, showing both windows and their significance stats', async () => {
    const wfResult: WalkForwardResponse = {
      inSample: { ...btRun({ totalPnl: 300, returnPct: 0.3 }), significance: sigStats() },
      outOfSample: {
        ...btRun({ totalPnl: -50, returnPct: -0.05, wins: 0, losses: 1, winRate: 0 }),
        significance: sigStats({ expectancy: -50, ciLow: -120, ciHigh: 20, pValue: 0.42 }),
      },
      excludedSymbols: [],
      errors: [],
    };
    const run = vi.spyOn(client, 'runAutotradeWalkForward').mockResolvedValue(wfResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'AAPL' } });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs).toHaveLength(3); // from, to, split
    fireEvent.change(dateInputs[2], { target: { value: '2024-06-01' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Run walk-forward' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ symbols: ['AAPL'], splitDate: '2024-06-01' })),
    );
    expect(await screen.findByRole('heading', { name: /^In-sample/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Out-of-sample/ })).toBeInTheDocument();
    // In-sample's significance (reliable: false, small sample) shows the caution note...
    expect(screen.getAllByText('Thin sample — treat with caution').length).toBeGreaterThan(0);
    // ...and both windows' p-values/CIs render somewhere on the page.
    expect(screen.getByText('0.030')).toBeInTheDocument();
    expect(screen.getByText('0.420')).toBeInTheDocument();
    expect(screen.getByText('+$100.00 to +$500.00')).toBeInTheDocument();
    expect(screen.getByText('-$120.00 to +$20.00')).toBeInTheDocument();
  });

  it('shows a "no trades" note instead of significance stats for an empty walk-forward window', async () => {
    const wfResult: WalkForwardResponse = {
      inSample: {
        report: {
          trades: [],
          equityCurve: [],
          startingEquity: 100_000,
          finalEquity: 100_000,
          excludedSymbols: [],
          errors: [],
        },
        stats: btRun().stats,
        significance: {
          sampleSize: 0,
          expectancy: null,
          ciLow: null,
          ciHigh: null,
          pValue: null,
          resamples: 0,
          reliable: false,
        },
      },
      outOfSample: {
        report: {
          trades: [],
          equityCurve: [],
          startingEquity: 100_000,
          finalEquity: 100_000,
          excludedSymbols: [],
          errors: [],
        },
        stats: btRun().stats,
        significance: {
          sampleSize: 0,
          expectancy: null,
          ciLow: null,
          ciHigh: null,
          pValue: null,
          resamples: 0,
          reliable: false,
        },
      },
      excludedSymbols: [],
      errors: [],
    };
    vi.spyOn(client, 'runAutotradeWalkForward').mockResolvedValue(wfResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'AAPL' } });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[2], { target: { value: '2024-06-01' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Run walk-forward' }));

    expect(await screen.findByRole('heading', { name: /^In-sample/ })).toBeInTheDocument();
    expect(screen.getAllByText('No trades in this window — nothing to test for significance.')).toHaveLength(2);
  });

  it('shows an inline error and does not call the API when no symbols are entered', async () => {
    const run = vi.spyOn(client, 'runAutotradeBacktest');
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(await screen.findByText('Enter at least one symbol')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('surfaces a backtest API error', async () => {
    vi.spyOn(client, 'runAutotradeBacktest').mockRejectedValue(new Error('from must be on or before to'));
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'AAPL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(await screen.findByText('from must be on or before to')).toBeInTheDocument();
  });

  it('surfaces a per-symbol data-fetch failure without blocking the rest of the report', async () => {
    const run = btRun();
    run.report.errors = [{ symbol: 'BAD1', message: 'Polygon 429: rate limited' }];
    vi.spyOn(client, 'runAutotradeBacktest').mockResolvedValue(run);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'AAPL, BAD1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(await screen.findByText(/BAD1 \(Polygon 429: rate limited\)/)).toBeInTheDocument();
    // The rest of the report still renders — one bad symbol doesn't blank the page.
    expect(screen.getByText('target')).toBeInTheDocument();
  });

  it('runs a plain options backtest and renders stats + the options trade', async () => {
    const optResult: OptionsBacktestRunResponse = {
      report: {
        trades: [
          {
            symbol: 'AAPL',
            side: 'call',
            kind: 'single_leg',
            contractTicker: 'O:AAPL240315C00210000',
            strike: 210,
            expiration: '2024-03-15',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPremium: 4,
            exitDate: '2024-01-10',
            exitPremium: 6,
            exitReason: 'time_exit',
            contracts: 3,
            pnl: 600,
            rMultiple: 0.5,
          },
        ],
        equityCurve: [
          { date: '2024-01-02', equity: 100_000 },
          { date: '2024-01-10', equity: 100_600 },
        ],
        startingEquity: 100_000,
        finalEquity: 100_600,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: {
        totalTrades: 1,
        wins: 1,
        losses: 0,
        winRate: 100,
        avgWin: 600,
        avgLoss: 0,
        expectancy: 600,
        profitFactor: null,
        totalPnl: 600,
        returnPct: 0.6,
        avgR: 0.5,
        bestR: 0.5,
        worstR: 0.5,
        maxDrawdown: 0,
        longestWinStreak: 1,
        longestLossStreak: 0,
      },
    };
    const run = vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue(optResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ symbols: ['AAPL'], riskProfile: 'MODERATE', startingEquity: 100_000 }),
      ),
    );
    expect(await screen.findByText('time exit')).toBeInTheDocument();
    expect(screen.getByText('call 210')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // contracts
    expect(screen.getAllByText('+$600.00').length).toBeGreaterThan(0); // expectancy stat + trade pnl
  });

  it('threads the configured Options strategy into the options backtest request', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ optionsStrategyType: 'debit_spread' }));
    const run = vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue({
      report: {
        trades: [],
        equityCurve: [],
        startingEquity: 100_000,
        finalEquity: 100_000,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        expectancy: 0,
        profitFactor: null,
        totalPnl: 0,
        returnPct: 0,
        avgR: 0,
        bestR: 0,
        worstR: 0,
        maxDrawdown: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
      },
    });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ optionsDecisionConfig: { strategyType: 'debit_spread' } }),
      ),
    );
  });

  it("threads strategyType: 'auto' into the options backtest request the same way (IV-rank-adaptive, 2026-07-18)", async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ optionsStrategyType: 'auto' }));
    const run = vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue({
      report: {
        trades: [],
        equityCurve: [],
        startingEquity: 100_000,
        finalEquity: 100_000,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        expectancy: 0,
        profitFactor: null,
        totalPnl: 0,
        returnPct: 0,
        avgR: 0,
        bestR: 0,
        worstR: 0,
        maxDrawdown: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
      },
    });
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ optionsDecisionConfig: { strategyType: 'auto' } })),
    );
  });

  it("renders a debit spread's long/short strikes and nets Entry/Exit $ in the options backtest trades table", async () => {
    const optResult: OptionsBacktestRunResponse = {
      report: {
        trades: [
          {
            symbol: 'AAPL',
            side: 'call',
            kind: 'debit_spread',
            contractTicker: 'O:AAPL240315C00200000',
            strike: 200,
            shortContractTicker: 'O:AAPL240315C00210000',
            shortStrike: 210,
            expiration: '2024-03-15',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPremium: 5,
            shortEntryPremium: 2,
            exitDate: '2024-01-10',
            exitPremium: 8,
            shortExitPremium: 1,
            exitReason: 'time_exit',
            contracts: 2,
            pnl: 800, // ((8-1) - (5-2)) * 2 * 100
            rMultiple: 1.5,
          },
        ],
        equityCurve: [
          { date: '2024-01-02', equity: 100_000 },
          { date: '2024-01-10', equity: 100_800 },
        ],
        startingEquity: 100_000,
        finalEquity: 100_800,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: {
        totalTrades: 1,
        wins: 1,
        losses: 0,
        winRate: 100,
        avgWin: 800,
        avgLoss: 0,
        expectancy: 800,
        profitFactor: null,
        totalPnl: 800,
        returnPct: 0.8,
        avgR: 1.5,
        bestR: 1.5,
        worstR: 1.5,
        maxDrawdown: 0,
        longestWinStreak: 1,
        longestLossStreak: 0,
      },
    };
    vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue(optResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));

    expect(await screen.findByText('call 200/210')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument(); // Entry $ = 5 - 2
    expect(screen.getByText('$7.00')).toBeInTheDocument(); // Exit $ = 8 - 1
    expect(screen.getAllByText('+$800.00').length).toBeGreaterThan(0);
  });

  it('color-codes the options backtest exit-reason badge for stop-loss (red) and take-profit (green)', async () => {
    const optResult: OptionsBacktestRunResponse = {
      report: {
        trades: [
          {
            symbol: 'AAPL',
            side: 'call',
            kind: 'single_leg',
            contractTicker: 'O:AAPL240315C00200000',
            strike: 200,
            expiration: '2024-03-15',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPremium: 5,
            exitDate: '2024-01-05',
            exitPremium: 2,
            exitReason: 'stop_loss',
            contracts: 1,
            pnl: -300,
            rMultiple: -0.5,
          },
          {
            symbol: 'MSFT',
            side: 'put',
            kind: 'single_leg',
            contractTicker: 'O:MSFT240315P00300000',
            strike: 300,
            expiration: '2024-03-15',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPremium: 4,
            exitDate: '2024-01-05',
            exitPremium: 7,
            exitReason: 'take_profit',
            contracts: 1,
            pnl: 300,
            rMultiple: 0.5,
          },
        ],
        equityCurve: [
          { date: '2024-01-02', equity: 100_000 },
          { date: '2024-01-05', equity: 100_000 },
        ],
        startingEquity: 100_000,
        finalEquity: 100_000,
        excludedSymbols: [],
        errors: [],
        skipped: [],
      },
      stats: {
        totalTrades: 2,
        wins: 1,
        losses: 1,
        winRate: 50,
        avgWin: 300,
        avgLoss: 300,
        expectancy: 0,
        profitFactor: 1,
        totalPnl: 0,
        returnPct: 0,
        avgR: 0,
        bestR: 0.5,
        worstR: -0.5,
        maxDrawdown: 0,
        longestWinStreak: 1,
        longestLossStreak: 1,
      },
    };
    vi.spyOn(client, 'runOptionsBacktest').mockResolvedValue(optResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl, msft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run options backtest' }));

    const stopLossBadge = await screen.findByText('stop loss');
    expect(stopLossBadge.className).toMatch(/text-bear/);
    const takeProfitBadge = screen.getByText('take profit');
    expect(takeProfitBadge.className).toMatch(/text-bull/);
  });

  it('runs a combined backtest and renders ONE stats grid plus both an equity trade and an options trade', async () => {
    const combinedResult: CombinedBacktestRunResponse = {
      report: {
        equityTrades: [
          {
            symbol: 'AAPL',
            side: 'buy',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPrice: 200,
            exitDate: '2024-01-05',
            exitPrice: 220,
            exitReason: 'target',
            quantity: 10,
            pnl: 200,
            rMultiple: 2,
          },
        ],
        optionsTrades: [
          {
            symbol: 'AAPL',
            side: 'call',
            kind: 'single_leg',
            contractTicker: 'O:AAPL240315C00210000',
            strike: 210,
            expiration: '2024-03-15',
            signalDate: '2024-01-01',
            entryDate: '2024-01-02',
            entryPremium: 4,
            exitDate: '2024-01-10',
            exitPremium: 6,
            exitReason: 'time_exit',
            contracts: 3,
            pnl: 600,
            rMultiple: 0.5,
          },
        ],
        equityCurve: [
          { date: '2024-01-02', equity: 100_000 },
          { date: '2024-01-10', equity: 100_800 },
        ],
        startingEquity: 100_000,
        finalEquity: 100_800,
        excludedSymbols: [],
        errors: [],
        optionsSkipped: [],
      },
      stats: {
        totalTrades: 2,
        wins: 2,
        losses: 0,
        winRate: 100,
        avgWin: 400,
        avgLoss: 0,
        expectancy: 400,
        profitFactor: null,
        totalPnl: 800,
        returnPct: 0.8,
        avgR: 1.25,
        bestR: 2,
        worstR: 0.5,
        maxDrawdown: 0,
        longestWinStreak: 2,
        longestLossStreak: 0,
      },
    };
    const run = vi.spyOn(client, 'runCombinedBacktest').mockResolvedValue(combinedResult);
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run combined backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ symbols: ['AAPL'], riskProfile: 'MODERATE', startingEquity: 100_000 }),
      ),
    );
    // One shared stats grid (2 total trades across both books, not two grids).
    expect(await screen.findByText('2')).toBeInTheDocument(); // totalTrades stat
    // The equity trade renders in its own table.
    expect(screen.getByText('target')).toBeInTheDocument();
    // The options trade renders in its own table alongside it.
    expect(screen.getByText('time exit')).toBeInTheDocument();
    expect(screen.getByText('call 210')).toBeInTheDocument();
  });

  function paperPosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
    return {
      id: 1,
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      entryAt: Date.now(),
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'test fixture',
      status: 'open',
      exitPrice: null,
      exitAt: null,
      exitReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentPrice: null,
      stale: false,
      unrealizedPnl: null,
      ...overrides,
    };
  }

  it('shows an empty state when there are no paper positions', async () => {
    renderDashboard();
    expect(await screen.findByText('No paper trades yet')).toBeInTheDocument();
  });

  it('renders open and closed paper positions with summary stat tiles', async () => {
    vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
      positions: [
        paperPosition({ id: 1, symbol: 'AAPL', status: 'open' }),
        paperPosition({
          id: 2,
          symbol: 'MSFT',
          status: 'closed',
          entryPrice: 100,
          exitPrice: 110,
          exitAt: Date.now(),
          exitReason: 'target',
          quantity: 10,
          riskAmount: 50,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    // (110-100)*10 realized pnl — appears twice: the stat tile total and the trade's own row.
    expect(screen.getAllByText('+$100.00').length).toBeGreaterThan(0);
    expect(screen.getByText('2.00R')).toBeInTheDocument(); // 100 pnl / 50 risk, fmtNum's default 2 decimals
  });

  it('shows the live current price and unrealized P&L for an OPEN position, not a blank dash', async () => {
    vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
      positions: [
        paperPosition({
          id: 1,
          symbol: 'AAPL',
          status: 'open',
          entryPrice: 100,
          quantity: 10,
          riskAmount: 50,
          currentPrice: 108,
          unrealizedPnl: 80, // (108-100)*10
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('$108.00')).toBeInTheDocument(); // Current $ column
    // 80 unrealized pnl — appears twice: the stat tile total and the trade's own row.
    expect(screen.getAllByText('+$80.00').length).toBeGreaterThan(0);
    expect(screen.getByText('1.60R')).toBeInTheDocument(); // 80 / 50 risk
  });

  it('shows a stale-price chip when the current price came from the cache, not a live quote', async () => {
    vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
      positions: [paperPosition({ status: 'open', currentPrice: 95, stale: true, unrealizedPnl: -50 })],
    });
    renderDashboard();
    expect(await screen.findByText('stale')).toBeInTheDocument();
  });

  it('shows a dash, not $0.00, for unrealized P&L when the live quote could not be resolved at all', async () => {
    // Distinguishes "no P&L" from "P&L is unknown" — a naive sum over
    // `unrealizedPnl ?? 0` would render "+$0.00" here, implying the position
    // is flat when really its price just couldn't be resolved.
    vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
      positions: [paperPosition({ status: 'open', currentPrice: null, unrealizedPnl: null })],
    });
    renderDashboard();
    await screen.findByText('AAPL');
    const tile = screen.getByText('Unrealized P&L').parentElement!;
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });

  function optionsPaperPosition(overrides: Partial<OptionsPaperPosition> = {}): OptionsPaperPosition {
    return {
      id: 1,
      symbol: 'AAPL',
      side: 'call',
      kind: 'single_leg',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      shortContractSymbol: null,
      shortStrike: null,
      expiration: '2026-08-21',
      quantity: 2,
      entryPrice: 3,
      shortEntryPrice: null,
      entryAt: Date.now(),
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'test fixture',
      status: 'open',
      exitPrice: null,
      shortExitPrice: null,
      exitAt: null,
      exitReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentPrice: null,
      shortCurrentPrice: null,
      underlyingPrice: null,
      unrealizedPnl: null,
      ...overrides,
    };
  }

  it('shows an empty state when there are no options paper positions', async () => {
    renderDashboard();
    expect(await screen.findByText('No options paper trades yet')).toBeInTheDocument();
  });

  it('renders open and closed options paper positions with summary stat tiles', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({ id: 1, symbol: 'AAPL', status: 'open' }),
        optionsPaperPosition({
          id: 2,
          symbol: 'MSFT',
          side: 'put',
          strike: 90,
          status: 'closed',
          entryPrice: 2,
          exitPrice: 5,
          exitAt: Date.now(),
          exitReason: 'time_exit',
          quantity: 1,
          riskAmount: 200,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    // (5-2)*1*100 = 300 realized pnl — appears twice: the stat tile total and the trade's own row.
    expect(screen.getAllByText('+$300.00').length).toBeGreaterThan(0);
    expect(screen.getByText('1.50R')).toBeInTheDocument(); // 300 pnl / 200 risk
    expect(screen.getByText('put 90')).toBeInTheDocument();
  });

  it('color-codes the options paper exit-reason badge for stop-loss (red) and take-profit (green)', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'AAPL',
          status: 'closed',
          entryPrice: 5,
          exitPrice: 2,
          exitAt: Date.now(),
          exitReason: 'stop_loss',
        }),
        optionsPaperPosition({
          id: 2,
          symbol: 'MSFT',
          status: 'closed',
          entryPrice: 4,
          exitPrice: 7,
          exitAt: Date.now(),
          exitReason: 'take_profit',
        }),
      ],
    });
    renderDashboard();
    await screen.findByText('AAPL');

    const stopLossBadge = screen.getByText('stop loss');
    expect(stopLossBadge.className).toMatch(/text-bear/);
    const takeProfitBadge = screen.getByText('take profit');
    expect(takeProfitBadge.className).toMatch(/text-bull/);
  });

  it('shows the live current price and unrealized P&L for an OPEN options position, not a blank dash', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'AAPL',
          status: 'open',
          entryPrice: 3,
          quantity: 2,
          riskAmount: 600,
          currentPrice: 4,
          unrealizedPnl: 200, // (4-3)*2*100
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('$4.00')).toBeInTheDocument(); // Current $ column
    expect(screen.getAllByText('+$200.00').length).toBeGreaterThan(0);
    expect(screen.getByText('0.33R')).toBeInTheDocument(); // 200 / 600 risk
  });

  it("renders a closed debit spread's long/short strikes and nets its two legs for Entry/Exit $ and P&L", async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'SPRD',
          kind: 'debit_spread',
          strike: 100,
          shortStrike: 110,
          status: 'closed',
          quantity: 1,
          entryPrice: 3,
          shortEntryPrice: 1, // net debit at entry: 2
          exitPrice: 8,
          shortExitPrice: 0.5, // net value at exit: 7.5
          exitAt: Date.now(),
          exitReason: 'time_exit',
          riskAmount: 200,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('SPRD')).toBeInTheDocument();
    expect(screen.getByText('call 100/110')).toBeInTheDocument();
    expect(screen.getByText('$2.00')).toBeInTheDocument(); // Entry $ = net debit
    expect(screen.getByText('$7.50')).toBeInTheDocument(); // Exit $ = net value at exit
    // pnl = (7.5 - 2) * 1 * 100 = 550 — appears twice: the stat tile total and the trade's own row.
    expect(screen.getAllByText('+$550.00').length).toBeGreaterThan(0);
    expect(screen.getByText('2.75R')).toBeInTheDocument(); // 550 / 200
  });

  it("shows an OPEN debit spread's net current value from both legs' live marks", async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'SPRD',
          kind: 'debit_spread',
          strike: 100,
          shortStrike: 110,
          status: 'open',
          quantity: 2,
          entryPrice: 3,
          shortEntryPrice: 1,
          currentPrice: 5,
          shortCurrentPrice: 2, // net current value: 3
          riskAmount: 400,
          unrealizedPnl: 200, // (3 - 2) * 2 * 100
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('SPRD')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument(); // Current $ = net value now
    expect(screen.getAllByText('+$200.00').length).toBeGreaterThan(0);
    expect(screen.getByText('0.50R')).toBeInTheDocument(); // 200 / 400
  });

  it('shows the general assignment-risk badge on a deep-ITM, near-zero-extrinsic short leg of an OPEN debit spread', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'SPRD',
          side: 'call',
          kind: 'debit_spread',
          strike: 100,
          shortStrike: 90,
          status: 'open',
          currentPrice: 25,
          shortCurrentPrice: 20.02, // 20 intrinsic (110 underlying - 90 strike) + 0.02 extrinsic
          underlyingPrice: 110,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('SPRD')).toBeInTheDocument();
    expect(screen.getByText('Assignment risk')).toBeInTheDocument();
  });

  it('does not show an assignment-risk badge on a single-leg position, even deep ITM — this app never writes a naked short', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'AAPL',
          side: 'call',
          kind: 'single_leg',
          strike: 90,
          status: 'open',
          currentPrice: 20.02,
          underlyingPrice: 110,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText('Assignment risk')).toBeNull();
  });

  it('does not show an assignment-risk badge while the short leg still has real time value', async () => {
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'SPRD',
          side: 'call',
          kind: 'debit_spread',
          strike: 100,
          shortStrike: 90,
          status: 'open',
          currentPrice: 25,
          shortCurrentPrice: 21, // 20 intrinsic + 1.00 extrinsic — well above the low-extrinsic threshold
          underlyingPrice: 110,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('SPRD')).toBeInTheDocument();
    expect(screen.queryByText('Assignment risk')).toBeNull();
  });

  it('shows the dividend-specific badge when a deep-ITM short call meets an imminent ex-dividend date', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    vi.spyOn(client, 'events').mockResolvedValue({ events: [{ symbol: 'SPRD', exDividendDate: soon }] });
    vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({
      positions: [
        optionsPaperPosition({
          id: 1,
          symbol: 'SPRD',
          side: 'call',
          kind: 'debit_spread',
          strike: 100,
          shortStrike: 90,
          status: 'open',
          currentPrice: 25,
          shortCurrentPrice: 20.02,
          underlyingPrice: 110,
        }),
      ],
    });
    renderDashboard();
    expect(await screen.findByText('SPRD')).toBeInTheDocument();
    expect(await screen.findByText('Div. assignment risk')).toBeInTheDocument();
    expect(screen.queryByText('Assignment risk')).toBeNull();
  });

  it('runs one loop cycle, shows the summary, and reloads positions', async () => {
    const runOnce = vi.spyOn(client, 'runAutotradeLoopOnce').mockResolvedValue(
      loopSummaryFixture({
        ranEntries: true,
        exitsChecked: 2,
        exitsClosed: 1,
        optionsExitsChecked: 1,
        optionsExitsClosed: 1,
        candidatesScreened: 10,
        candidatesPassedVolatility: 8,
        signalsGenerated: 3,
        optionsSignalsGenerated: 1,
        entriesOpened: 1,
        optionsEntriesOpened: 1,
      }),
    );
    const positions = vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({ positions: [] });
    renderDashboard();
    await screen.findByText('Monitoring');
    positions.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));

    expect(await screen.findByText(/Screened 10, 8 passed/)).toBeInTheDocument();
    expect(screen.getByText(/3 signal\(s\) generated/)).toBeInTheDocument();
    expect(screen.getByText(/1 opened \(1 options\)/)).toBeInTheDocument();
    expect(screen.getByText(/Exits checked: 2 \(1 closed\) — options: 1 \(1 closed\)/)).toBeInTheDocument();
    await waitFor(() => expect(positions).toHaveBeenCalled()); // reloaded after the run
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('shows the skipped reason when the session window blocked new entries', async () => {
    vi.spyOn(client, 'runAutotradeLoopOnce').mockResolvedValue(
      loopSummaryFixture({ ranEntries: false, skippedReason: 'Market is closed' }),
    );
    renderDashboard();
    await screen.findByText('Monitoring');
    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));
    expect(await screen.findByText(/New entries skipped — Market is closed/)).toBeInTheDocument();
  });

  it('surfaces an error when running a loop cycle fails', async () => {
    vi.spyOn(client, 'runAutotradeLoopOnce').mockRejectedValue(new Error('provider unavailable'));
    renderDashboard();
    await screen.findByText('Monitoring');
    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));
    expect(await screen.findByText('provider unavailable')).toBeInTheDocument();
  });

  it('clears a previous successful summary when a later run fails, so the error is not shown next to stale numbers', async () => {
    const run = vi.spyOn(client, 'runAutotradeLoopOnce');
    run.mockResolvedValueOnce(
      loopSummaryFixture({
        ranEntries: true,
        candidatesScreened: 5,
        candidatesPassedVolatility: 5,
        signalsGenerated: 1,
        entriesOpened: 1,
      }),
    );
    renderDashboard();
    await screen.findByText('Monitoring');

    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));
    expect(await screen.findByText(/Screened 5, 5 passed/)).toBeInTheDocument();

    run.mockRejectedValueOnce(new Error('provider unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));

    expect(await screen.findByText('provider unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Screened 5, 5 passed/)).toBeNull();
  });

  it('shows an accurate warning about the live paper loop when enabled, not the old "not built yet" copy', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ enabled: true }));
    renderPage();
    expect(await screen.findByText(/actively scanning and placing/)).toBeInTheDocument();
    expect(screen.queryByText(/hasn.t been built/)).toBeNull();
  });

  describe('kill switch', () => {
    it('renders released by default, with no engaged warning', async () => {
      renderPage();
      expect(await screen.findByRole('button', { name: 'Kill switch — engage halt' })).toBeInTheDocument();
      expect(screen.queryByText(/Kill switch engaged/)).toBeNull();
    });

    it('engages on click, with no confirmation prompt, and updates config + dashboard', async () => {
      const setKill = vi
        .spyOn(client, 'setAutotradeKillSwitch')
        .mockResolvedValue({ enabled: false, killSwitch: true, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
      // toggleKillSwitch also calls config.reload() right after the optimistic
      // local update — mock its SECOND call (the reload) to agree with the
      // just-applied change, matching what the real server would return; the
      // first call is the page's initial load, still released.
      vi.spyOn(client, 'autotradeConfig')
        .mockResolvedValueOnce({
          enabled: false,
          killSwitch: false,
          riskProfile: 'MODERATE',
          accountEquityUsd: 100_000,
        })
        .mockResolvedValue({ enabled: false, killSwitch: true, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
      const dash = vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture());
      renderPage();
      await screen.findByText('VNQ');
      dash.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Kill switch — engage halt' }));

      expect(setKill).toHaveBeenCalledWith(true);
      expect(await screen.findByRole('button', { name: '■ Kill switch ENGAGED — release' })).toBeInTheDocument();
      // Matches twice: the inline warning AND the toast notification (its own
      // copy also starts with "Kill switch engaged") — both are correct, so
      // assert presence rather than a single unique match.
      expect((await screen.findAllByText(/Kill switch engaged/)).length).toBeGreaterThan(0);
      // no AGGRESSIVE-style confirm modal — a panic button must fire in one click.
      expect(screen.queryByText('Switch to AGGRESSIVE?')).toBeNull();
      await waitFor(() => expect(dash).toHaveBeenCalled()); // dashboard state refreshed too
    });

    it('releases on a second click without touching the enabled flag', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ enabled: true, killSwitch: true }));
      const setKill = vi
        .spyOn(client, 'setAutotradeKillSwitch')
        .mockResolvedValue({ enabled: true, killSwitch: false, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: '■ Kill switch ENGAGED — release' }));

      expect(setKill).toHaveBeenCalledWith(false);
      expect(await screen.findByRole('button', { name: 'Kill switch — engage halt' })).toBeInTheDocument();
      expect((screen.getByLabelText('Auto-trading enabled') as HTMLInputElement).checked).toBe(true);
    });

    it('shows the kill-switch warning instead of the enabled warning when both are active', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ enabled: true, killSwitch: true }));
      renderPage();
      expect(await screen.findByText(/Kill switch engaged/)).toBeInTheDocument();
      expect(screen.queryByText(/actively scanning and placing/)).toBeNull();
    });

    it('surfaces an error without changing the button state when the toggle fails', async () => {
      vi.spyOn(client, 'setAutotradeKillSwitch').mockRejectedValue(new Error('network error'));
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.click(screen.getByRole('button', { name: 'Kill switch — engage halt' }));

      await waitFor(() => expect(client.setAutotradeKillSwitch).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'Kill switch — engage halt' })).toBeInTheDocument();
    });

    it('keeps the kill-switch button visible and correct even if the config reload right after a toggle fails', async () => {
      // toggleKillSwitch fires config.reload() without awaiting it — if THAT
      // GET fails, config.error gets set, and the rest of the Configuration
      // card (enabled checkbox, risk profile, equity) falls back to an error
      // box. The kill-switch button must survive that — it's the one control
      // that can release it, and it reads local state, not config.data.
      vi.spyOn(client, 'setAutotradeKillSwitch').mockResolvedValue({
        enabled: false,
        killSwitch: true,
        riskProfile: 'MODERATE',
        accountEquityUsd: 100_000,
      });
      vi.spyOn(client, 'autotradeConfig')
        .mockResolvedValueOnce({
          enabled: false,
          killSwitch: false,
          riskProfile: 'MODERATE',
          accountEquityUsd: 100_000,
        })
        .mockRejectedValue(new Error('network blip'));
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.click(screen.getByRole('button', { name: 'Kill switch — engage halt' }));

      expect(await screen.findByRole('button', { name: '■ Kill switch ENGAGED — release' })).toBeInTheDocument();
      // The rest of the card fell back to an error state...
      expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
      // ...but the button to release the kill switch is still right there.
      expect(screen.getByRole('button', { name: '■ Kill switch ENGAGED — release' })).toBeInTheDocument();
    });
  });

  describe('Monitoring dashboard', () => {
    it('renders stat tiles sourced from the dashboard snapshot', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          riskProfile: 'AGGRESSIVE',
          openPositionsCount: 1,
          maxConcurrentPositions: 3,
          openRisk: 1_500,
          maxAggregateOpenRisk: 4_500,
          dailyPnl: -200,
          dailyDrawdownHaltLevel: -5_000,
          tradesToday: 2,
          maxTradesPerDay: 10,
          consecutiveLosses: 1,
          stepDownAfterLosses: 2,
        }),
      );
      renderDashboard();
      // "Aggressive" also appears as a <select><option> elsewhere on the page.
      expect((await screen.findAllByText('Aggressive')).length).toBeGreaterThan(0);
      expect(screen.getByText('1 / 3')).toBeInTheDocument(); // open positions vs cap
      expect(screen.getByText('2 / 10')).toBeInTheDocument(); // trades today vs cap
      expect(screen.getByText('-$200.00')).toBeInTheDocument(); // day P&L
    });

    it('shows an error state with retry when the dashboard fails to load', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockRejectedValue(new Error('dashboard unavailable'));
      renderDashboard();
      expect(await screen.findByText('dashboard unavailable')).toBeInTheDocument();
    });

    it('shows "no candidate checked yet" for correlated exposure before any risk-check has run', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ maxCorrelatedExposure: 6_000, lastCorrelatedExposureCheck: null }),
      );
      renderDashboard();
      expect(await screen.findByText(/of \$6,000\.00 cap — no candidate checked yet/)).toBeInTheDocument();
    });

    it('shows the last correlated-exposure reading — symbol, amount, and how long ago', async () => {
      // Real time, not fake timers — react-testing-library's findBy/waitFor polling
      // relies on real setTimeout, and freezing the clock hangs it (and, since fake
      // timers are a global toggle, every test after it in this file too).
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          maxCorrelatedExposure: 6_000,
          lastCorrelatedExposureCheck: {
            symbol: 'MSFT',
            checkedAt: Date.now() - 3 * 60 * 1000, // 3 minutes ago
            passed: true,
            correlatedNotional: 1_500,
          },
        }),
      );
      renderDashboard();
      expect(await screen.findByText('$1,500.00')).toBeInTheDocument();
      expect(screen.getByText(/of \$6,000\.00 cap — MSFT, 3m ago/)).toBeInTheDocument();
      expect(screen.queryByText('BLOCKED')).toBeNull();
    });

    it('flags a BLOCKED correlated-exposure reading in red', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          maxCorrelatedExposure: 6_000,
          lastCorrelatedExposureCheck: {
            symbol: 'NVDA',
            checkedAt: Date.now(),
            passed: false,
            correlatedNotional: 8_200.5,
          },
        }),
      );
      renderDashboard();
      expect(await screen.findByText('$8,200.50')).toBeInTheDocument();
      expect(screen.getByText('BLOCKED')).toBeInTheDocument();
    });

    it('shows "no open positions" for sector exposure with an empty book', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ sectorExposure: [], maxSectorExposure: 20_000 }),
      );
      renderDashboard();
      expect(await screen.findByText(/of \$20,000\.00 cap — no open positions/)).toBeInTheDocument();
    });

    it('shows the worst (largest) current sector concentration, sorted first by computeExposure', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          sectorExposure: [
            { key: 'Technology', gross: 4_500, pct: 60, count: 2 },
            { key: 'Healthcare', gross: 3_000, pct: 40, count: 1 },
          ],
          maxSectorExposure: 20_000,
        }),
      );
      renderDashboard();
      expect(await screen.findByText('$4,500.00')).toBeInTheDocument();
      expect(screen.getByText(/of \$20,000\.00 cap — Technology \(2 positions\)/)).toBeInTheDocument();
    });

    it('flags sector exposure over the cap in red', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          sectorExposure: [{ key: 'Energy', gross: 25_000, pct: 100, count: 3 }],
          maxSectorExposure: 20_000,
        }),
      );
      renderDashboard();
      const value = await screen.findByText('$25,000.00');
      expect(value).toHaveClass('text-bear');
    });

    it('shows the portfolio Greeks aggregate once loaded', async () => {
      vi.spyOn(client, 'autotradePortfolioGreeks').mockResolvedValue({
        netDelta: 1234.5,
        netTheta: -56.78,
        netVega: 90.12,
      });
      renderDashboard();
      expect(await screen.findByText('+$1,234.50')).toBeInTheDocument();
      expect(screen.getByText('-$56.78')).toBeInTheDocument();
      expect(screen.getByText('+$90.12')).toBeInTheDocument();
    });

    it('refetches portfolio Greeks when the Refresh button is clicked', async () => {
      const greeks = vi
        .spyOn(client, 'autotradePortfolioGreeks')
        .mockResolvedValue({ netDelta: 0, netTheta: 0, netVega: 0 });
      renderDashboard();
      await screen.findByText('Net delta ($)');
      expect(greeks).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Reload Greeks' }));
      await waitFor(() => expect(greeks).toHaveBeenCalledTimes(2));
    });

    it('shows an error state with retry when the portfolio-greeks fetch fails', async () => {
      vi.spyOn(client, 'autotradePortfolioGreeks').mockRejectedValue(new Error('greeks unavailable'));
      renderDashboard();
      expect(await screen.findByText('greeks unavailable')).toBeInTheDocument();
    });

    it('shows "hasn\'t run yet" for the last cycle before the loop has ever run', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture({ lastTick: null }));
      renderDashboard();
      expect(await screen.findByText(/The automated loop hasn.t run yet/)).toBeInTheDocument();
    });

    it("shows the last cycle's funnel, entries, and exits once the loop has run", async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          lastTick: {
            ranAt: Date.now() - 30_000,
            summary: loopSummaryFixture({
              candidatesScreened: 12,
              candidatesPassedVolatility: 7,
              signalsGenerated: 3,
              optionsSignalsGenerated: 1,
              entriesOpened: 2,
              optionsEntriesOpened: 1,
              liveEntriesOpened: 0,
              liveOptionsEntriesOpened: 0,
              exitsChecked: 5,
              exitsClosed: 2,
              optionsExitsChecked: 1,
              optionsExitsClosed: 1,
              moversAutoPromoted: 1,
            }),
          },
        }),
      );
      renderDashboard();
      expect(
        await screen.findByText(/12 screened → 7 passed volatility → 3 signals \(\+1 options\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Opened: 2 equity \+ 1 options paper, 0 equity \+ 0 options live/)).toBeInTheDocument();
      expect(screen.getByText(/Exits: 2\/5 equity, 1\/1 options · 1 movers promoted/)).toBeInTheDocument();
    });

    it('surfaces a skip reason from the last cycle prominently', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          lastTick: {
            ranAt: Date.now(),
            summary: loopSummaryFixture({ ranEntries: false, skippedReason: 'Market is closed' }),
          },
        }),
      );
      renderDashboard();
      expect(await screen.findByText('Market is closed')).toBeInTheDocument();
    });

    it('shows the equity/options breakdown for the combined open-positions and aggregate-risk tiles', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          openPositions: [
            {
              id: 1,
              symbol: 'AAPL',
              side: 'buy',
              quantity: 10,
              entryPrice: 100,
              entryAt: Date.now(),
              stopPrice: 95,
              targetPrice: 110,
              riskAmount: 500,
              riskProfile: 'MODERATE',
              rationale: 'fixture',
              status: 'open',
              exitPrice: null,
              exitAt: null,
              exitReason: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          openOptionsPositions: [
            {
              id: 1,
              symbol: 'MSFT',
              side: 'call',
              contractSymbol: 'MSFT-fixture',
              strike: 400,
              expiration: '2026-08-21',
              quantity: 1,
              entryPrice: 3,
              entryAt: Date.now(),
              riskAmount: 300,
              riskProfile: 'MODERATE',
              rationale: 'fixture',
              status: 'open',
              exitPrice: null,
              exitAt: null,
              exitReason: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              dte: 30,
            },
          ],
          openPositionsCount: 2,
          openRisk: 800,
        }),
      );
      renderDashboard();
      expect(await screen.findByText('2 / 2')).toBeInTheDocument(); // combined count
      expect(screen.getByText('1 equity + 1 options')).toBeInTheDocument();
      expect(screen.getByText(/equity \+ options combined/)).toBeInTheDocument();
    });

    it('lists open options positions sorted by days-to-expiration, flagging an imminent one', async () => {
      const optPos = (overrides: { id: number; symbol: string; dte: number; strike: number }) => ({
        id: overrides.id,
        symbol: overrides.symbol,
        side: 'call' as const,
        contractSymbol: `${overrides.symbol}-fixture`,
        strike: overrides.strike,
        expiration: '2026-08-21',
        quantity: 1,
        entryPrice: 3,
        entryAt: Date.now(),
        riskAmount: 300,
        riskProfile: 'MODERATE',
        rationale: 'fixture',
        status: 'open' as const,
        exitPrice: null,
        exitAt: null,
        exitReason: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        dte: overrides.dte,
      });
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          openOptionsPositions: [
            optPos({ id: 1, symbol: 'FAROUT', dte: 30, strike: 100 }),
            optPos({ id: 2, symbol: 'SOON', dte: 3, strike: 200 }),
          ],
        }),
      );
      renderDashboard();
      const soonEl = await screen.findByText('3.0d');
      const farEl = screen.getByText('30.0d');
      expect(soonEl.className).toMatch(/text-bear/); // <=7d imminent -> flagged
      expect(farEl.className).not.toMatch(/text-bear/);
      // Sorted soonest-first: SOON's row comes before FAROUT's in the DOM.
      expect(soonEl.compareDocumentPosition(farEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('hides the options expirations section when there are no open options positions', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture({ openOptionsPositions: [] }));
      renderDashboard();
      await screen.findByText('Monitoring');
      expect(screen.queryByText(/Options expirations/)).toBeNull();
    });

    it('shows a distinct HALT TRIGGERED signal when the daily drawdown halt is actually breached', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: -3_200, dailyDrawdownHaltLevel: -3_000 }), // breached
      );
      renderDashboard();
      expect(await screen.findByText(/HALT TRIGGERED/)).toBeInTheDocument();
    });

    it('does not show HALT TRIGGERED for an ordinary loss that has not reached the halt level', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: -50, dailyDrawdownHaltLevel: -3_000 }), // a normal down day, not halted
      );
      renderDashboard();
      await screen.findByText('Monitoring');
      expect(screen.queryByText(/HALT TRIGGERED/)).toBeNull();
    });

    it('does not misreport HALT TRIGGERED when equity is unset (halt level is the -0/0 edge case)', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: 0, dailyDrawdownHaltLevel: -0 }),
      );
      renderDashboard();
      await screen.findByText('Monitoring');
      expect(screen.queryByText(/HALT TRIGGERED/)).toBeNull();
    });

    it('reloads after running a loop cycle, so risk/P&L figures reflect the new fills', async () => {
      vi.spyOn(client, 'runAutotradeLoopOnce').mockResolvedValue(
        loopSummaryFixture({
          ranEntries: true,
          candidatesScreened: 1,
          candidatesPassedVolatility: 1,
          signalsGenerated: 1,
          entriesOpened: 1,
        }),
      );
      const dash = vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture());
      renderDashboard();
      await screen.findByText('Monitoring');
      dash.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));

      await waitFor(() => expect(dash).toHaveBeenCalled());
    });

    it('the page-level Refresh button reloads the dashboard, paper positions, AND recent activity together', async () => {
      // Monitoring, Paper trading, and Recent activity all reflect state the
      // background loop can change on its own with nothing clicked — a single
      // shared refresh covers all three instead of three independent controls
      // that could drift out of sync (or be missing entirely, as Recent
      // activity's was before this fix).
      const dash = vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture());
      const positions = vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({ positions: [] });
      const evts = vi.spyOn(client, 'autotradeEvents').mockResolvedValue({ events: [] });
      renderDashboard();
      await screen.findByText('Monitoring');
      dash.mockClear();
      positions.mockClear();
      evts.mockClear();

      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

      await waitFor(() => {
        expect(dash).toHaveBeenCalled();
        expect(positions).toHaveBeenCalled();
        expect(evts).toHaveBeenCalled();
      });
    });
  });

  describe('Phase 8: Live trading', () => {
    it('shows the enable flow when live trading is off, with the button disabled until BOTH an account id and the exact phrase are entered', async () => {
      renderPage();
      await screen.findByText('VNQ');

      const enableButton = screen.getByRole('button', { name: 'Enable live trading' });
      const confirmInput = screen.getByLabelText('type to confirm enabling live trading');
      expect(enableButton).toBeDisabled();

      fireEvent.change(confirmInput, { target: { value: 'ENABLE LIVE TRADING' } });
      expect(enableButton).toBeDisabled(); // the exact phrase alone, with no account id, isn't enough either

      fireEvent.change(confirmInput, { target: { value: '' } }); // clear the phrase back out
      fireEvent.change(screen.getByPlaceholderText(/INDIVIDUAL_CASH/), { target: { value: 'ACC1' } });
      expect(enableButton).toBeDisabled(); // account id alone isn't enough

      fireEvent.change(confirmInput, {
        target: { value: 'enable live trading' }, // lower-case — matched case-insensitively
      });
      expect(enableButton).not.toBeDisabled();
    });

    it('calls setAutotradeConfig with the account id, liveTradingEnabled, and the typed phrase when enabling', async () => {
      const setConfig = vi
        .spyOn(client, 'setAutotradeConfig')
        .mockResolvedValue(configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1' }));
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.change(screen.getByPlaceholderText(/INDIVIDUAL_CASH/), { target: { value: 'ACC1' } });
      fireEvent.change(screen.getByLabelText('type to confirm enabling live trading'), {
        target: { value: 'ENABLE LIVE TRADING' },
      });

      // Same class of race as AutoTradePage's own equity-save test above —
      // the button's disabled state depends on two separate field updates
      // having actually propagated, which isn't guaranteed by the very next
      // synchronous line under CI-level scheduling/load. Wait for the
      // observable consequence instead of assuming synchronous settling.
      const enableButton = screen.getByRole('button', { name: 'Enable live trading' });
      await waitFor(() => expect(enableButton).not.toBeDisabled());
      fireEvent.click(enableButton);

      await waitFor(() =>
        expect(setConfig).toHaveBeenCalledWith({
          liveAccountId: 'ACC1',
          liveTradingEnabled: true,
          confirmLiveTrading: 'ENABLE LIVE TRADING',
        }),
      );
    });

    it('shows the LIVE TRADING ENABLED banner and a Disable button once enabled, hiding the confirm flow', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1' }),
      );
      renderPage();
      await screen.findByText('VNQ');

      expect(await screen.findByText('● LIVE TRADING ENABLED')).toBeInTheDocument();
      expect(screen.getByText(/Account ACC1/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Enable live trading' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Disable live trading' })).toBeInTheDocument();
    });

    it('disabling requires no confirmation phrase — a single click calls setAutotradeConfig', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1' }),
      );
      const setConfig = vi
        .spyOn(client, 'setAutotradeConfig')
        .mockResolvedValue(configFixture({ liveTradingEnabled: false }));
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.click(await screen.findByRole('button', { name: 'Disable live trading' }));

      await waitFor(() => expect(setConfig).toHaveBeenCalledWith({ liveTradingEnabled: false }));
    });

    it('shows probation status when active', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1', liveProbationTrades: 20 }),
      );
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          liveTradingEnabled: true,
          liveAccountId: 'ACC1',
          probation: { active: true, multiplier: 0.5, tradesPlaced: 3, tradesRemaining: 17 },
        }),
      );
      renderPage();
      expect(await screen.findByText(/Probation active: 17 of 20 trades remaining at 0.5× size/)).toBeInTheDocument();
    });

    it('saves the live-trading caps as one batch', async () => {
      const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue(configFixture());
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.change(screen.getByPlaceholderText('e.g. 20000'), { target: { value: '30000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save live-trading settings' }));

      await waitFor(() =>
        expect(setConfig).toHaveBeenCalledWith(
          expect.objectContaining({ liveMaxOrderUsd: 30_000, liveMaxDailyLossUsd: 3_000, liveMaxOrdersPerDay: 6 }),
        ),
      );
    });

    it('"Suggest from equity" fills the live guardrail fields without saving them', async () => {
      const suggest = vi
        .spyOn(client, 'suggestAutotradeLiveCaps')
        .mockResolvedValue({ liveMaxOrderUsd: 25_000, liveMaxDailyLossUsd: 5_000, liveMaxOrdersPerDay: 10 });
      const setConfig = vi.spyOn(client, 'setAutotradeConfig');
      renderPage();
      await screen.findByText('VNQ');

      fireEvent.click(screen.getByRole('button', { name: 'Suggest from equity' }));

      await waitFor(() => expect(suggest).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByPlaceholderText('e.g. 20000')).toHaveValue('25000'));
      await waitFor(() => expect(screen.getByPlaceholderText('e.g. 3000')).toHaveValue('5000'));
      // "e.g. 6" is shared with the options live-caps "Max orders/day" field below it —
      // the equity one (this button's field) renders first in the DOM.
      await waitFor(() => expect(screen.getAllByPlaceholderText('e.g. 6')[0]).toHaveValue('10'));
      expect(setConfig).not.toHaveBeenCalled();
    });

    it('disables "Suggest from equity" until account equity is set', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture({ accountEquityUsd: null }));
      renderPage();
      await screen.findByText('VNQ');

      expect(screen.getByRole('button', { name: 'Suggest from equity' })).toBeDisabled();
    });

    it('surfaces the paper track record for review — not an enforced gate, just informational', async () => {
      vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
        positions: [
          paperPosition({ id: 1, symbol: 'AAA', status: 'closed', exitPrice: 110, entryAt: Date.parse('2026-01-05') }), // win
          paperPosition({ id: 2, symbol: 'BBB', status: 'closed', exitPrice: 90, entryAt: Date.parse('2026-01-10') }), // loss
          paperPosition({ id: 3, symbol: 'CCC', status: 'open', entryAt: Date.parse('2026-01-15') }),
        ],
      });
      renderPage();
      await screen.findByText('VNQ');

      expect(await screen.findByText('3')).toBeInTheDocument(); // total paper trades
      expect(screen.getByText('2 closed')).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument(); // 1 win / 2 closed
    });

    it('does not show a second "Something went wrong" box when config fails to load — only Configuration\'s own error shows', async () => {
      vi.spyOn(client, 'autotradeConfig').mockRejectedValue(new Error('network blip'));
      renderPage();
      expect(await screen.findByText('Something went wrong')).toBeInTheDocument(); // exactly one — findBy throws on 2+
    });

    function livePosition(overrides: Partial<AutotradeLivePosition> = {}): AutotradeLivePosition {
      return {
        id: 1,
        assetType: 'stock',
        symbol: 'AAPL',
        side: 'long',
        quantity: 10,
        entryPrice: 100,
        entryDate: '2026-07-01',
        entryTime: null,
        fees: 0,
        optionType: null,
        strike: null,
        expiration: null,
        multiplier: 1,
        status: 'open',
        tags: ['live', 'autotrade'],
        grade: null,
        notes: null,
        checklist: [],
        stopPrice: 95,
        targetPrice: 110,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        exits: [],
        remainingQuantity: 10,
        currentPrice: null,
        stale: false,
        pnl: {
          positionId: 1,
          currentPrice: null,
          costBasis: 1000,
          realizedPnl: 0,
          unrealizedPnl: null,
          totalPnl: 0,
          returnPct: null,
          rMultiple: null,
          marketValue: null,
          remainingQuantity: 10,
          closedQuantity: 0,
        },
        ...overrides,
      };
    }

    it('shows an empty state when there are no live positions', async () => {
      renderDashboard();
      expect(await screen.findByText('No live positions yet')).toBeInTheDocument();
    });

    it('renders open and closed live positions with summary stat tiles', async () => {
      vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
        positions: [
          livePosition({ id: 1, symbol: 'AAPL', status: 'open' }),
          livePosition({
            id: 2,
            symbol: 'MSFT',
            status: 'closed',
            remainingQuantity: 0,
            exits: [
              {
                id: 1,
                positionId: 2,
                quantity: 10,
                exitPrice: 110,
                exitDate: '2026-07-02',
                fees: 0,
                notes: null,
                createdAt: Date.now(),
              },
            ],
            pnl: {
              positionId: 2,
              currentPrice: 110,
              costBasis: 1000,
              realizedPnl: 100,
              unrealizedPnl: 0,
              totalPnl: 100,
              returnPct: 10,
              rMultiple: 2,
              marketValue: 0,
              remainingQuantity: 0,
              closedQuantity: 10,
            },
          }),
        ],
      });
      renderDashboard();
      expect(await screen.findByText('AAPL')).toBeInTheDocument();
      expect(screen.getByText('MSFT')).toBeInTheDocument();
      expect(screen.getAllByText('+$100.00').length).toBeGreaterThan(0); // stat tile + row
      expect(screen.getByText('2.00R')).toBeInTheDocument();
    });

    it('shows option contract details inline for an option live position', async () => {
      vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
        positions: [
          livePosition({
            id: 1,
            symbol: 'AAPL',
            assetType: 'option',
            optionType: 'call',
            strike: 200,
            expiration: '2026-08-21',
            multiplier: 100,
          }),
        ],
      });
      renderDashboard();
      await screen.findByText('AAPL');
      expect(screen.getByText(/200\.00 C 2026-08-21/)).toBeInTheDocument();
    });

    it('shows the live current price for an OPEN position, not a blank dash', async () => {
      vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
        positions: [
          livePosition({
            id: 1,
            symbol: 'AAPL',
            currentPrice: 108,
            pnl: {
              positionId: 1,
              currentPrice: 108,
              costBasis: 1000,
              realizedPnl: 0,
              unrealizedPnl: 80,
              totalPnl: 80,
              returnPct: 8,
              rMultiple: 1.6,
              marketValue: 1080,
              remainingQuantity: 10,
              closedQuantity: 0,
            },
          }),
        ],
      });
      renderDashboard();
      await screen.findByText('AAPL');
      expect(screen.getByText('$108.00')).toBeInTheDocument();
      expect(screen.getAllByText('+$80.00').length).toBeGreaterThan(0);
    });

    describe('closing a live equity position (real order)', () => {
      it('shows a close button only for an OPEN position, not a closed one', async () => {
        vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
          positions: [
            livePosition({ id: 1, symbol: 'AAPL', status: 'open' }),
            livePosition({ id: 2, symbol: 'MSFT', status: 'closed', remainingQuantity: 0 }),
          ],
        });
        renderDashboard();
        await screen.findByText('AAPL');
        expect(screen.getByText('MSFT')).toBeInTheDocument(); // closed row rendered too...
        expect(screen.getAllByText('close')).toHaveLength(1); // ...but only the open one gets a close button
      });

      it('opens CloseModal for the clicked position, places the order once armed, and reloads the live positions list', async () => {
        const list = vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
          positions: [livePosition({ id: 1, symbol: 'AAPL', status: 'open' })],
        });
        const closeSpy = vi
          .spyOn(client, 'closePosition')
          .mockResolvedValue({ ok: true, placed: true, reason: 'placed' });
        renderDashboard();
        await screen.findByText('AAPL');
        const callsBeforeClose = list.mock.calls.length;

        fireEvent.click(screen.getByText('close'));
        expect(await screen.findByText(/Close AAPL — real order/)).toBeInTheDocument();
        expect(screen.getByPlaceholderText('SELL 10 AAPL')).toBeInTheDocument(); // remainingQuantity: 10

        fireEvent.change(screen.getByPlaceholderText('e.g. 12345678'), { target: { value: 'ACC1' } });
        fireEvent.change(screen.getByLabelText('type to confirm closing this position'), {
          target: { value: 'SELL 10 AAPL' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close position' }));

        await waitFor(() => expect(closeSpy).toHaveBeenCalledWith(1, 'ACC1', 'SELL 10 AAPL'));
        expect(await screen.findByText(/Close order placed/)).toBeInTheDocument();
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBeforeClose));
      });

      it('shows the failure reason when the close is blocked', async () => {
        vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({
          positions: [livePosition({ id: 1, symbol: 'AAPL', status: 'open' })],
        });
        vi.spyOn(client, 'closePosition').mockResolvedValue({
          ok: true,
          placed: false,
          reason: 'blocked',
          error: 'kill switch engaged',
        });
        renderDashboard();
        await screen.findByText('AAPL');

        fireEvent.click(screen.getByText('close'));
        await screen.findByText(/Close AAPL — real order/);
        fireEvent.change(screen.getByPlaceholderText('e.g. 12345678'), { target: { value: 'ACC1' } });
        fireEvent.change(screen.getByLabelText('type to confirm closing this position'), {
          target: { value: 'SELL 10 AAPL' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close position' }));

        expect(await screen.findByText(/kill switch engaged/)).toBeInTheDocument();
      });
    });
  });

  describe('Task #70: Live options trading', () => {
    function liveOptionsPosition(overrides: Partial<LiveOptionsPosition> = {}): LiveOptionsPosition {
      return {
        id: 1,
        symbol: 'AAPL',
        side: 'call',
        kind: 'single_leg',
        contractSymbol: 'AAPL-fixture',
        strike: 100,
        shortContractSymbol: null,
        shortStrike: null,
        expiration: '2026-08-21',
        quantity: 2,
        entryPrice: 3,
        shortEntryPrice: null,
        entryAt: Date.now(),
        riskAmount: 600,
        riskProfile: 'MODERATE',
        rationale: 'test fixture',
        status: 'open',
        exitPrice: null,
        shortExitPrice: null,
        exitAt: null,
        exitReason: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        currentPrice: null,
        shortCurrentPrice: null,
        underlyingPrice: null,
        unrealizedPnl: null,
        ...overrides,
      };
    }

    it('does not show the live options checkbox/caps until live trading itself is enabled', async () => {
      renderPage();
      await screen.findByText('VNQ');
      expect(screen.queryByText('Live options trading')).toBeNull();
    });

    it('shows the live options checkbox/caps once live trading is enabled', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1' }),
      );
      renderPage();
      expect(await screen.findByText('Live options trading')).toBeInTheDocument();
    });

    it('saves liveOptionsEnabled and the options caps as one batch', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1' }),
      );
      const setConfig = vi.spyOn(client, 'setAutotradeConfig').mockResolvedValue(configFixture());
      renderPage();
      await screen.findByText('Live options trading');

      fireEvent.click(screen.getByLabelText('Live options trading'));
      fireEvent.change(screen.getByPlaceholderText('e.g. 2000'), { target: { value: '3000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save live options settings' }));

      await waitFor(() =>
        expect(setConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            liveOptionsEnabled: true,
            liveOptionsMaxOrderUsd: 3_000,
            liveOptionsMaxDailyLossUsd: 500,
            liveOptionsMaxOrdersPerDay: 6,
          }),
        ),
      );
    });

    it('shows live options probation status when active', async () => {
      vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
        configFixture({ liveTradingEnabled: true, liveAccountId: 'ACC1', liveOptionsEnabled: true }),
      );
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          liveTradingEnabled: true,
          liveAccountId: 'ACC1',
          liveOptionsEnabled: true,
          liveOptionsProbation: { active: true, multiplier: 0.5, tradesPlaced: 3, tradesRemaining: 17 },
        }),
      );
      renderPage();
      expect(
        await screen.findByText(/Options probation active: 17 of 20 trades remaining at 0.5× size/),
      ).toBeInTheDocument();
    });

    it('renders a debit-spread live options position with both strikes', async () => {
      vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({
        positions: [
          liveOptionsPosition({
            kind: 'debit_spread',
            contractSymbol: 'AAPL-long',
            strike: 100,
            shortContractSymbol: 'AAPL-short',
            shortStrike: 110,
            entryPrice: 3,
            shortEntryPrice: 1,
          }),
        ],
      });
      renderDashboard();
      expect(await screen.findByText('call 100/110')).toBeInTheDocument();
    });

    it('shows the empty state when no live options positions exist yet', async () => {
      renderDashboard();
      expect(await screen.findByText('No live options positions yet')).toBeInTheDocument();
    });

    it('shows the Live options section in the Monitoring dashboard', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({
          liveOptionsEnabled: true,
          liveOptionsOpenPositionsCount: 1,
          liveOptionsOpenRisk: 300,
        }),
      );
      renderDashboard();
      expect(await screen.findByText('● enabled')).toBeInTheDocument();
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });

    describe('closing a live options position (real order)', () => {
      it('shows a close button only for an OPEN position, not a closed one', async () => {
        vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({
          positions: [
            liveOptionsPosition({ id: 1, symbol: 'AAPL', status: 'open' }),
            liveOptionsPosition({
              id: 2,
              symbol: 'MSFT',
              status: 'closed',
              exitReason: 'time_exit',
              exitPrice: 4,
              exitAt: Date.now(),
            }),
          ],
        });
        renderDashboard();
        await screen.findByText('AAPL');
        expect(screen.getByText('MSFT')).toBeInTheDocument(); // closed row rendered too...
        expect(screen.getAllByText('close')).toHaveLength(1); // ...but only the open one gets a close button
      });

      it('opens CloseLiveOptionsPositionModal with the computed SELL phrase, gates submission on the exact phrase, and calls closeLiveOptionsPosition once armed', async () => {
        vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({
          positions: [liveOptionsPosition({ id: 5, symbol: 'AAPL', quantity: 2, status: 'open' })],
        });
        const closeSpy = vi
          .spyOn(client, 'closeLiveOptionsPosition')
          .mockResolvedValue({ ok: true, placed: true, reason: 'placed' });
        renderDashboard();
        await screen.findByText('AAPL');

        fireEvent.click(screen.getByText('close'));
        expect(await screen.findByText(/Close AAPL options — real order/)).toBeInTheDocument();
        const phraseInput = screen.getByLabelText('type to confirm closing this options position');
        const submitButton = screen.getByRole('button', { name: 'Close position' });
        expect(screen.getByPlaceholderText('SELL 2 AAPL')).toBeInTheDocument();
        expect(submitButton).toBeDisabled();

        fireEvent.change(phraseInput, { target: { value: 'SELL 2 AAP' } }); // one character short
        fireEvent.change(screen.getByPlaceholderText('e.g. 12345678'), { target: { value: 'ACC1' } });
        expect(submitButton).toBeDisabled();

        fireEvent.change(phraseInput, { target: { value: 'SELL 2 AAPL' } });
        expect(submitButton).not.toBeDisabled();
        fireEvent.click(submitButton);

        await waitFor(() => expect(closeSpy).toHaveBeenCalledWith(5, 'ACC1', 'SELL 2 AAPL'));
        expect(await screen.findByText(/Close order placed/)).toBeInTheDocument();
      });

      it('shows the failure reason when the close is blocked', async () => {
        vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({
          positions: [liveOptionsPosition({ id: 5, symbol: 'AAPL', quantity: 2, status: 'open' })],
        });
        vi.spyOn(client, 'closeLiveOptionsPosition').mockResolvedValue({
          ok: true,
          placed: false,
          reason: 'blocked',
          error: 'kill switch engaged',
        });
        renderDashboard();
        await screen.findByText('AAPL');

        fireEvent.click(screen.getByText('close'));
        await screen.findByText(/Close AAPL options — real order/);
        fireEvent.change(screen.getByPlaceholderText('e.g. 12345678'), { target: { value: 'ACC1' } });
        fireEvent.change(screen.getByLabelText('type to confirm closing this options position'), {
          target: { value: 'SELL 2 AAPL' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close position' }));

        expect(await screen.findByText(/kill switch engaged/)).toBeInTheDocument();
      });

      it("computes the SELL phrase from a debit spread's quantity, not a per-leg count", async () => {
        vi.spyOn(client, 'autotradeLiveOptionsPositions').mockResolvedValue({
          positions: [
            liveOptionsPosition({
              id: 9,
              symbol: 'NVDA',
              kind: 'debit_spread',
              side: 'call',
              strike: 200,
              shortStrike: 210,
              quantity: 3,
              status: 'open',
            }),
          ],
        });
        renderDashboard();
        await screen.findByText('NVDA');

        fireEvent.click(screen.getByText('close'));
        expect(await screen.findByText(/Close NVDA options — real order/)).toBeInTheDocument();
        expect(screen.getByPlaceholderText('SELL 3 NVDA')).toBeInTheDocument();
      });
    });
  });
});

// setInterval/clearInterval/Date are faked — not setTimeout, which React's own
// scheduler relies on (in this jsdom environment) to flush the initial async
// config/dashboard load; faking it too hangs the very first findByText.
// usePolling only ever calls setInterval, so faking that (plus Date, so
// Date.now() advances in lockstep with advanceTimersByTimeAsync — the
// equity-sync throttle below is a real wall-clock check) is enough to
// control this describe block's tests.
describe('AutoTradePage account-equity auto-refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-syncs equity from Webull every 1 minute once a liveAccountId is configured, silently (no toast)', async () => {
    // Stateful, like the real server: the FIRST load is pre-sync (100_000);
    // every reload after that (i.e. after the first sync persists) reflects
    // the newly-synced equity — otherwise the second tick's dirty-check would
    // keep seeing the pre-sync value forever and wrongly skip as "dirty".
    vi.spyOn(client, 'autotradeConfig')
      .mockResolvedValueOnce(configFixture({ liveAccountId: 'ACC1' }))
      .mockResolvedValue(configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 123_456.78 }));
    const sync = vi.spyOn(client, 'syncAutotradeEquity').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      previousEquityUsd: 100_000,
      netLiquidationUsd: 123_456.78,
      buyingPowerUsd: 200_000,
      config: configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 123_456.78 }),
    });
    renderPage();
    await screen.findByText('VNQ');
    // Ensure config.data (liveAccountId in particular — the tick's own gate
    // condition) has actually settled before advancing the fake timer: config
    // loads via its own separate useAsync call from the positions data
    // findByText('VNQ') above waits on, and React's re-render scheduling
    // relies on the REAL (un-faked) setTimeout, so there's no guarantee it's
    // settled yet just because the positions text appeared.
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync from Webull/ })).not.toBeDisabled());
    expect(sync).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(sync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull(); // silent — the manual-click toast does not fire

    const equityInput = screen.getByPlaceholderText('e.g. 25000') as HTMLInputElement;
    expect(equityInput.value).toBe('123456.78');

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not auto-sync while no liveAccountId is configured', async () => {
    const sync = vi.spyOn(client, 'syncAutotradeEquity');
    renderPage(); // default fixture: liveAccountId null
    await screen.findByText('VNQ');

    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not clobber an unsaved manual equity edit with the 1-minute auto-refresh', async () => {
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue(
      configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 100_000 }),
    );
    const sync = vi.spyOn(client, 'syncAutotradeEquity').mockResolvedValue({
      ok: true,
      accountId: 'ACC1',
      previousEquityUsd: 100_000,
      netLiquidationUsd: 123_456.78,
      buyingPowerUsd: 200_000,
      config: configFixture({ liveAccountId: 'ACC1', accountEquityUsd: 123_456.78 }),
    });
    renderPage();
    await screen.findByText('VNQ');

    const equityInput = screen.getByPlaceholderText('e.g. 25000') as HTMLInputElement;
    // Wait for the config-load effect to populate equityDraft from accountEquityUsd
    // FIRST — 'VNQ' above only confirms the (separate) exclusions fetch resolved, not
    // this one, so without this wait the manual edit below can race the config load
    // and get silently clobbered back to 100000 the instant it lands (confirmed
    // flaky without this: the dirty-check then wrongly sees no unsaved edit and
    // fires the sync).
    await waitFor(() => expect(equityInput.value).toBe('100000'));
    fireEvent.change(equityInput, { target: { value: '77000' } }); // unsaved manual edit

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(sync).not.toHaveBeenCalled(); // skipped — draft no longer matches the last known server value
    expect(equityInput.value).toBe('77000');
  });
});

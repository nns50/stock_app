import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  LoopTickSummary,
  OptionsBacktestRunResponse,
  OptionsPaperPosition,
  PaperPosition,
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

function configFixture(overrides: Partial<AutotradeConfig> = {}): AutotradeConfig {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: 100_000,
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
    optionsStrategyType: 'single_leg',
    ...overrides,
  };
}

function dashboardFixture(overrides: Partial<AutotradeDashboard> = {}): AutotradeDashboard {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    equity: 100_000,
    openPositions: [],
    openPositionsCount: 0,
    maxConcurrentPositions: 2,
    openRisk: 0,
    maxAggregateOpenRisk: 2_000,
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
    candidatesScreened: 0,
    candidatesPassedVolatility: 0,
    signalsGenerated: 0,
    optionsSignalsGenerated: 0,
    entriesOpened: 0,
    optionsEntriesOpened: 0,
    liveEntriesOpened: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'autotradeConfig').mockResolvedValue(configFixture());
  vi.spyOn(client, 'autotradeExclusions').mockResolvedValue({
    exclusions: [{ symbol: 'VNQ', reason: 'Real estate ETF', source: 'default', createdAt: Date.now() }],
  });
  vi.spyOn(client, 'autotradeEvents').mockResolvedValue({ events: [] });
  vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeOptionsPaperPositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeLivePositions').mockResolvedValue({ positions: [] });
  vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture());
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({ accountEquityUsd: 50_000, confirmAggressive: undefined }),
    );
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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
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

  it('runs a plain backtest and renders stats + the trade', async () => {
    const run = vi.spyOn(client, 'runAutotradeBacktest').mockResolvedValue(btRun());
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'aapl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ symbols: ['AAPL'], riskProfile: 'MODERATE', startingEquity: 100_000 }),
      ),
    );
    expect(await screen.findByText('target')).toBeInTheDocument();
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
    expect(screen.getByText('$106.00')).toBeInTheDocument(); // trade exit price
    expect(screen.getAllByText('+$300.00').length).toBeGreaterThan(0); // expectancy stat + trade pnl
    expect(screen.queryByRole('heading', { name: /In-sample/ })).toBeNull();
  });

  it('runs a walk-forward split once a split date is set, showing both windows', async () => {
    const wfResult: WalkForwardResponse = {
      inSample: btRun({ totalPnl: 300, returnPct: 0.3 }),
      outOfSample: btRun({ totalPnl: -50, returnPct: -0.05, wins: 0, losses: 1, winRate: 0 }),
      excludedSymbols: [],
      errors: [],
    };
    const run = vi.spyOn(client, 'runAutotradeWalkForward').mockResolvedValue(wfResult);
    renderPage();
    await screen.findByText('VNQ');

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
  });

  it('shows an inline error and does not call the API when no symbols are entered', async () => {
    const run = vi.spyOn(client, 'runAutotradeBacktest');
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(await screen.findByText('Enter at least one symbol')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('surfaces a backtest API error', async () => {
    vi.spyOn(client, 'runAutotradeBacktest').mockRejectedValue(new Error('from must be on or before to'));
    renderPage();
    await screen.findByText('VNQ');

    fireEvent.change(screen.getByPlaceholderText('AAPL, MSFT, NVDA'), { target: { value: 'AAPL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run backtest' }));

    expect(await screen.findByText('from must be on or before to')).toBeInTheDocument();
  });

  it('surfaces a per-symbol data-fetch failure without blocking the rest of the report', async () => {
    const run = btRun();
    run.report.errors = [{ symbol: 'BAD1', message: 'Polygon 429: rate limited' }];
    vi.spyOn(client, 'runAutotradeBacktest').mockResolvedValue(run);
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
    await screen.findByText('VNQ');

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
    renderPage();
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
    renderPage();
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
    renderPage();
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
    renderPage();
    expect(await screen.findByText('stale')).toBeInTheDocument();
  });

  it('shows a dash, not $0.00, for unrealized P&L when the live quote could not be resolved at all', async () => {
    // Distinguishes "no P&L" from "P&L is unknown" — a naive sum over
    // `unrealizedPnl ?? 0` would render "+$0.00" here, implying the position
    // is flat when really its price just couldn't be resolved.
    vi.spyOn(client, 'autotradePaperPositions').mockResolvedValue({
      positions: [paperPosition({ status: 'open', currentPrice: null, unrealizedPnl: null })],
    });
    renderPage();
    await screen.findByText('AAPL');
    const tile = screen.getByText('Unrealized P&L').parentElement!;
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });

  function optionsPaperPosition(overrides: Partial<OptionsPaperPosition> = {}): OptionsPaperPosition {
    return {
      id: 1,
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      expiration: '2026-08-21',
      quantity: 2,
      entryPrice: 3,
      entryAt: Date.now(),
      riskAmount: 600,
      riskProfile: 'MODERATE',
      rationale: 'test fixture',
      status: 'open',
      exitPrice: null,
      exitAt: null,
      exitReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentPrice: null,
      unrealizedPnl: null,
      ...overrides,
    };
  }

  it('shows an empty state when there are no options paper positions', async () => {
    renderPage();
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
    renderPage();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    // (5-2)*1*100 = 300 realized pnl — appears twice: the stat tile total and the trade's own row.
    expect(screen.getAllByText('+$300.00').length).toBeGreaterThan(0);
    expect(screen.getByText('1.50R')).toBeInTheDocument(); // 300 pnl / 200 risk
    expect(screen.getByText('put 90')).toBeInTheDocument();
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
    renderPage();
    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('$4.00')).toBeInTheDocument(); // Current $ column
    expect(screen.getAllByText('+$200.00').length).toBeGreaterThan(0);
    expect(screen.getByText('0.33R')).toBeInTheDocument(); // 200 / 600 risk
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
    renderPage();
    await screen.findByText('VNQ');
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
    renderPage();
    await screen.findByText('VNQ');
    fireEvent.click(screen.getByRole('button', { name: 'Run one cycle now' }));
    expect(await screen.findByText(/New entries skipped — Market is closed/)).toBeInTheDocument();
  });

  it('surfaces an error when running a loop cycle fails', async () => {
    vi.spyOn(client, 'runAutotradeLoopOnce').mockRejectedValue(new Error('provider unavailable'));
    renderPage();
    await screen.findByText('VNQ');
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
    renderPage();
    await screen.findByText('VNQ');

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
      renderPage();
      // "Aggressive" also appears as a <select><option> elsewhere on the page.
      expect((await screen.findAllByText('Aggressive')).length).toBeGreaterThan(0);
      expect(screen.getByText('1 / 3')).toBeInTheDocument(); // open positions vs cap
      expect(screen.getByText('2 / 10')).toBeInTheDocument(); // trades today vs cap
      expect(screen.getByText('-$200.00')).toBeInTheDocument(); // day P&L
    });

    it('shows an error state with retry when the dashboard fails to load', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockRejectedValue(new Error('dashboard unavailable'));
      renderPage();
      expect(await screen.findByText('dashboard unavailable')).toBeInTheDocument();
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
      renderPage();
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
      renderPage();
      const soonEl = await screen.findByText('3.0d');
      const farEl = screen.getByText('30.0d');
      expect(soonEl.className).toMatch(/text-bear/); // <=7d imminent -> flagged
      expect(farEl.className).not.toMatch(/text-bear/);
      // Sorted soonest-first: SOON's row comes before FAROUT's in the DOM.
      expect(soonEl.compareDocumentPosition(farEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('hides the options expirations section when there are no open options positions', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(dashboardFixture({ openOptionsPositions: [] }));
      renderPage();
      await screen.findByText('VNQ');
      expect(screen.queryByText(/Options expirations/)).toBeNull();
    });

    it('shows a distinct HALT TRIGGERED signal when the daily drawdown halt is actually breached', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: -3_200, dailyDrawdownHaltLevel: -3_000 }), // breached
      );
      renderPage();
      expect(await screen.findByText(/HALT TRIGGERED/)).toBeInTheDocument();
    });

    it('does not show HALT TRIGGERED for an ordinary loss that has not reached the halt level', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: -50, dailyDrawdownHaltLevel: -3_000 }), // a normal down day, not halted
      );
      renderPage();
      await screen.findByText('VNQ');
      expect(screen.queryByText(/HALT TRIGGERED/)).toBeNull();
    });

    it('does not misreport HALT TRIGGERED when equity is unset (halt level is the -0/0 edge case)', async () => {
      vi.spyOn(client, 'autotradeDashboard').mockResolvedValue(
        dashboardFixture({ dailyPnl: 0, dailyDrawdownHaltLevel: -0 }),
      );
      renderPage();
      await screen.findByText('VNQ');
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
      renderPage();
      await screen.findByText('VNQ');
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
      renderPage();
      await screen.findByText('VNQ');
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
      fireEvent.click(screen.getByRole('button', { name: 'Enable live trading' }));

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
      renderPage();
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
      renderPage();
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
      renderPage();
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
      renderPage();
      await screen.findByText('AAPL');
      expect(screen.getByText('$108.00')).toBeInTheDocument();
      expect(screen.getAllByText('+$80.00').length).toBeGreaterThan(0);
    });
  });
});

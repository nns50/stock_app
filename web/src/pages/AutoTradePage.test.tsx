import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AutoTradePage from './AutoTradePage';
import { ToastProvider } from '../components/ToastContext';
import { ConfirmProvider } from '../components/ConfirmContext';
import { client } from '../api/client';
import type {
  AutotradeDecideResponse,
  AutotradeRiskCheckResult,
  BacktestRunResponse,
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'autotradeConfig').mockResolvedValue({
    enabled: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: 100_000,
  });
  vi.spyOn(client, 'autotradeExclusions').mockResolvedValue({
    exclusions: [{ symbol: 'VNQ', reason: 'Real estate ETF', source: 'default', createdAt: Date.now() }],
  });
  vi.spyOn(client, 'autotradeEvents').mockResolvedValue({ events: [] });
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
    vi.spyOn(client, 'autotradeConfig').mockResolvedValue({
      enabled: false,
      riskProfile: 'MODERATE',
      accountEquityUsd: null,
    });
    renderPage();
    expect(await screen.findByText(/equity isn.t set/i)).toBeInTheDocument();
  });

  it('saves a new account equity value', async () => {
    const setConfig = vi
      .spyOn(client, 'setAutotradeConfig')
      .mockResolvedValue({ enabled: false, riskProfile: 'MODERATE', accountEquityUsd: 50_000 });
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
      .mockResolvedValue({ enabled: true, riskProfile: 'MODERATE', accountEquityUsd: 100_000 });
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
    };
    vi.spyOn(client, 'runAutotradeDecision').mockResolvedValue(result);
    const riskCheck = vi.spyOn(client, 'runAutotradeRiskCheck').mockResolvedValue({
      results: [
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
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.getByText('222')).toBeInTheDocument(); // sized quantity
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
});

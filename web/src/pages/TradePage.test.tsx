import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TradePage from './TradePage';
import { client } from '../api/client';

const config = {
  enabled: false,
  killSwitch: false,
  maxOrderUsd: 500,
  maxSymbolPositionQty: 100,
  maxExposureUsd: 2000,
  maxOrdersPerDay: 10,
  maxDailyLossUsd: 200,
  fatFingerPct: 20,
  allowNakedShort: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, 'tradeConfig').mockResolvedValue(config as never);
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TradePage />
    </MemoryRouter>,
  );

describe('TradePage', () => {
  it('renders the dry-run workspace, sandbox banner, and config panel', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Trade' })).toBeInTheDocument();
    expect(screen.getByText(/submits a/i)).toBeInTheDocument();
    expect(await screen.findByText('Guardrail config')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dry-run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview \(live\)/ })).toBeInTheDocument();
  });

  it('runs a dry-run and shows the would-submit result with the guardrail breakdown', async () => {
    const dry = vi.spyOn(client, 'dryRunOrder').mockResolvedValue({
      intent: { id: 1, state: 'validated', symbol: 'AAPL' },
      guardrails: {
        ok: true,
        checks: [{ rule: 'trading_enabled', passed: true, severity: 'block', detail: 'enabled' }],
      },
      wouldSubmit: true,
      notional: 1000,
      summary: 'DRY RUN — would submit BUY 10 AAPL limit 100 ($1,000)',
    } as never);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Dry-run \(manual state\)/ }));

    expect(await screen.findByText('would submit')).toBeInTheDocument();
    expect(dry).toHaveBeenCalled();
    // The guardrail breakdown chip (mark + rule), not the config-panel hint that also names the rule.
    expect(screen.getByText('✓ trading_enabled')).toBeInTheDocument();
  });

  it('uses multi-leg labels (Spreads / Net limit, no Reference price) for an iron condor', async () => {
    vi.spyOn(client, 'expirations').mockResolvedValue({ expirations: [] } as never);
    vi.spyOn(client, 'chain').mockResolvedValue(null as never);
    renderPage();
    await screen.findByPlaceholderText('account_id'); // inside Workspace, unlike the page's own heading
    fireEvent.click(screen.getByRole('tab', { name: 'Option' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Condor' }));
    expect(screen.getByText('Spreads')).toBeInTheDocument();
    expect(screen.getByText('Net limit (debit/credit)')).toBeInTheDocument();
    expect(screen.queryByText('Reference price')).not.toBeInTheDocument();
  });
});

describe('TradePage account-state auto-refresh', () => {
  const accountState = (over: Record<string, unknown> = {}) => ({
    ok: true,
    accountId: 'ACC1',
    state: {
      buyingPowerUsd: 10000,
      exposureUsd: 0,
      realizedPnlTodayUsd: 0,
      ordersToday: 0,
      currentPositionQty: 0,
      ...over,
    },
  });

  // Only setInterval/clearInterval are faked — not setTimeout, which React's
  // own scheduler relies on (in this jsdom environment) to flush the page's
  // initial async config load; faking it too hangs the very first findByRole.
  // usePolling only ever calls setInterval, so this is enough to control it.
  //
  // Each test below waits for the Cash account_id input (inside Workspace,
  // gated behind the async tradeConfig() load) rather than the page's own
  // "Trade" heading, which renders on the very first synchronous render —
  // before Workspace necessarily has — so it isn't a reliable signal that
  // usePolling's setInterval has actually been registered by the time the
  // test starts advancing the fake clock. A real gap, not just CI being
  // slower: it passed locally every time but failed intermittently in CI.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    localStorage.setItem('trade.accountId', JSON.stringify('ACC1'));
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem('trade.accountId');
  });

  it('auto-refreshes the account state from Webull every 1 minute, without pressing Pull', async () => {
    const pull = vi.spyOn(client, 'tradeAccountState').mockResolvedValue(accountState() as never);
    renderPage();
    await screen.findByPlaceholderText('account_id'); // see beforeEach's comment above
    expect(pull).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pull).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('does not clobber a hand-edited "Dry-run (manual state)" field with the 1-minute auto-refresh', async () => {
    const pull = vi.spyOn(client, 'tradeAccountState').mockResolvedValue(accountState() as never);
    renderPage();
    await screen.findByPlaceholderText('account_id'); // see beforeEach's comment above

    await act(() => vi.advanceTimersByTimeAsync(60_000)); // first auto-pull seeds the fields
    expect(pull).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Exposure $'), { target: { value: '5000' } });

    await act(() => vi.advanceTimersByTimeAsync(60_000)); // the field no longer matches the last pull — skipped
    expect(pull).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Exposure $')).toHaveValue('5000');
  });

  it('does not auto-refresh while no account id is set', async () => {
    localStorage.removeItem('trade.accountId');
    const pull = vi.spyOn(client, 'tradeAccountState').mockResolvedValue(accountState() as never);
    renderPage();
    await screen.findByPlaceholderText('account_id'); // see beforeEach's comment above

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(pull).not.toHaveBeenCalled();
  });
});

// The strategy builder is where most of the trade-form bugs lived (the label-click
// reset, the decimal swallow, the isMultiLeg label/expiry mix-ups). Pin each mode.
describe('TradePage strategy builder', () => {
  beforeEach(() => {
    vi.spyOn(client, 'expirations').mockResolvedValue({ expirations: [] } as never);
    vi.spyOn(client, 'chain').mockResolvedValue(null as never);
  });

  const openOption = async () => {
    renderPage();
    await screen.findByPlaceholderText('account_id'); // inside Workspace, unlike the page's own heading
    fireEvent.click(screen.getByRole('tab', { name: 'Option' }));
  };

  it('single-leg uses single-leg fields (Call/put, Quantity, Limit price, Reference price)', async () => {
    await openOption();
    expect(screen.getByText('Call / put')).toBeInTheDocument();
    expect(screen.getByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('Limit price')).toBeInTheDocument();
    expect(screen.getByText('Reference price')).toBeInTheDocument();
  });

  it('vertical shows two legs, the margin warning, and Spreads / Net limit', async () => {
    await openOption();
    fireEvent.click(screen.getByRole('tab', { name: 'Vertical' }));
    expect(screen.getByText('Leg 1')).toBeInTheDocument();
    expect(screen.getByText('Leg 2')).toBeInTheDocument();
    expect(screen.getByText(/Requires a margin account/)).toBeInTheDocument();
    expect(screen.getAllByText('Spreads').length).toBeGreaterThan(0); // Field label + the hint's bold
    expect(screen.getByText('Net limit (debit/credit)')).toBeInTheDocument();
    expect(screen.queryByText('Reference price')).not.toBeInTheDocument();
  });

  it('covered shows the buy-write note, one short-call leg, and Contracts', async () => {
    await openOption();
    fireEvent.click(screen.getByRole('tab', { name: 'Covered' }));
    expect(screen.getByText(/Buy-write/)).toBeInTheDocument();
    expect(screen.getByText('Short call — strike')).toBeInTheDocument();
    expect(screen.getByText('Contracts')).toBeInTheDocument();
    expect(screen.getByText('Net limit (debit/credit)')).toBeInTheDocument();
  });

  it('condor shows 4 legs; switching back to Single restores single-leg fields', async () => {
    await openOption();
    fireEvent.click(screen.getByRole('tab', { name: 'Condor' }));
    expect(screen.getByText('Leg 4')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Single')); // first strategy tab's a11y name is "Strategy Single"
    expect(screen.queryByText('Leg 4')).not.toBeInTheDocument();
    expect(screen.getByText('Call / put')).toBeInTheDocument();
    expect(screen.getByText('Quantity')).toBeInTheDocument();
  });
});

// A working spread / bracket is one combo of broker orders, so the single-key
// modify can't safely change it. The Orders panel must offer Modify only for a
// lone stock / single-leg option, and steer combos to Cancel-and-re-place.
describe('TradePage orders panel — modify is single-leg only', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 1,
    idempotencyKey: 'k',
    symbol: 'TSLA',
    assetKind: 'stock',
    side: 'buy',
    openClose: 'open',
    quantity: 1,
    orderType: 'limit',
    limitPrice: 1.5,
    optionType: null,
    strike: null,
    expiration: null,
    optionStrategy: null,
    isBracket: false,
    state: 'acknowledged',
    brokerOrderId: 'WB1',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it('shows Modify for a single-leg order but not for a spread or bracket', async () => {
    vi.spyOn(client, 'tradeIntents').mockResolvedValue({
      intents: [
        row({ id: 1, symbol: 'TSLA' }), // stock single-leg → modifiable in place
        row({ id: 2, symbol: 'NVDA', assetKind: 'option', optionStrategy: 'VERTICAL' }), // spread → not
        row({ id: 3, symbol: 'AMD', isBracket: true }), // bracket → not
      ],
    } as never);
    renderPage();

    // Exactly one Modify button (the single-leg); the spread + bracket show the hint.
    expect(await screen.findAllByRole('button', { name: 'Modify' })).toHaveLength(1);
    // All three are still working, so a one-tap "Refresh all (3)" is offered.
    expect(screen.getByRole('button', { name: 'Refresh all (3)' })).toBeInTheDocument();
    expect(screen.getAllByText(/cancel & re-place to change/i)).toHaveLength(2);

    // Each combo row is tagged (a chip) so it explains itself; the single-leg has none.
    const chips = (text: string) => screen.queryAllByText(text).filter((el) => el.className.includes('chip'));
    expect(chips('vertical')).toHaveLength(1);
    expect(chips('bracket')).toHaveLength(1);
    expect(chips('covered')).toHaveLength(0);
  });
});

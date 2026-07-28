import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The own-book side of the realized-today derivation reads the DB; mock it so
// these provider tests stay hermetic (no initDb, no shared-file ordering).
vi.mock('../src/services/trading/realizedToday', () => ({ realizedTodayFromBook: vi.fn() }));

import { config } from '../src/config';
import { webullAccountState } from '../src/providers/webull/accountState';
import { realizedTodayFromBook } from '../src/services/trading/realizedToday';

const mockBook = vi.mocked(realizedTodayFromBook);
const book = (totalUsd: number) => ({
  totalUsd,
  journalUsd: totalUsd,
  liveOptionsUsd: 0,
  journalExitCount: 1,
  liveOptionsCloseCount: 0,
});

const orig = { ...config.webull };
beforeEach(() => {
  // A quiet book by default; individual tests override.
  mockBook.mockReturnValue(book(0));
});
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

// The confirmed live /openapi/assets/balance shape (every value a string).
const BALANCE = {
  total_asset_currency: 'USD',
  total_net_liquidation_value: '15.31',
  total_market_value: '4.50',
  total_cash_balance: '10.81',
  total_unrealized_profit_loss: '-130.50',
  total_day_profit_loss: '0.00',
  account_currency_assets: [
    {
      currency: 'USD',
      buying_power: '10.81',
      option_buying_power: '10.81',
      settled_cash: '10.81',
      market_value: '4.50',
    },
  ],
};

const okResp = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

describe('webull account state', () => {
  it('is a clean error without keys', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await webullAccountState('ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('maps the confirmed balance shape into AccountState (strings → numbers)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(BALANCE));
    const r = await webullAccountState('ACC1'); // no symbol → no positions call
    expect(r.ok).toBe(true);
    expect(r.state).toMatchObject({
      buyingPowerUsd: 10.81,
      exposureUsd: 4.5,
      // min(day − unrealized = 0 − (−130.5) = +130.5, book = 0) — the raw day
      // figure (0.00) is NOT what lands here; see the realized-today tests.
      realizedPnlTodayUsd: 0,
      ordersToday: 0,
      currentPositionQty: 0,
      settledCashUsd: 10.81,
    });
    expect(r.optionBuyingPowerUsd).toBe(10.81);
    expect(r.netLiquidationUsd).toBe(15.31);
  });

  it('leaves settledCashUsd undefined (not a fabricated 0) when the broker omits it', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const { settled_cash, ...assetWithoutSettledCash } = BALANCE.account_currency_assets[0];
    void settled_cash;
    const balanceWithoutSettledCash = { ...BALANCE, account_currency_assets: [assetWithoutSettledCash] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balanceWithoutSettledCash));
    const r = await webullAccountState('ACC1');
    expect(r.state?.settledCashUsd).toBeUndefined();
  });

  it('sums the signed position for the requested symbol', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '7', position_side: 'LONG', asset_type: 'STOCK', cost_price: '100' },
      { symbol: 'TSLA', quantity: '3', position_side: 'LONG', asset_type: 'STOCK', cost_price: '200' },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(okResp(positions)); // positions
    const r = await webullAccountState('ACC1', 'aapl');
    expect(r.state?.currentPositionQty).toBe(7); // AAPL long 7; TSLA ignored
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/openapi/assets/positions');
  });

  it('counts ONLY the matching option contract for an option instrument (long stock does NOT count)', async () => {
    // Regression (hardening audit, HIGH): the old per-underlying sum let a long
    // STOCK position (or a different option contract) inflate currentPositionQty
    // for a single-leg option order — silently defeating allowNakedShort=false
    // for a SELL-to-open, since long stock does not cover a short option.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '100', position_side: 'LONG', asset_type: 'STOCK', cost_price: '150' },
      {
        symbol: 'AAPL',
        quantity: '2',
        position_side: 'LONG',
        asset_type: 'OPTION',
        option_type: 'CALL',
        strike_price: '150',
        option_expire_date: '2030-01-17',
        cost_price: '5',
      },
      {
        symbol: 'AAPL',
        quantity: '3',
        position_side: 'LONG',
        asset_type: 'OPTION',
        option_type: 'PUT',
        strike_price: '140',
        option_expire_date: '2030-01-17',
        cost_price: '2',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp(BALANCE)).mockResolvedValueOnce(okResp(positions));
    const r = await webullAccountState('ACC1', 'AAPL', {
      assetKind: 'option',
      strike: 150,
      expiration: '2030-01-17',
      optionType: 'call',
    });
    // ONLY the matching 150 call (2) — not the 100 shares, not the 140 put.
    expect(r.state?.currentPositionQty).toBe(2);
  });

  it('counts ONLY stock for a stock instrument (option contracts do NOT count)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '100', position_side: 'LONG', asset_type: 'STOCK', cost_price: '150' },
      {
        symbol: 'AAPL',
        quantity: '2',
        position_side: 'SHORT',
        asset_type: 'OPTION',
        option_type: 'CALL',
        strike_price: '150',
        option_expire_date: '2030-01-17',
        cost_price: '5',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp(BALANCE)).mockResolvedValueOnce(okResp(positions));
    const r = await webullAccountState('ACC1', 'AAPL', { assetKind: 'stock' });
    expect(r.state?.currentPositionQty).toBe(100); // ONLY the shares — not the short call
  });

  it('flags positionsUnavailable (not a fabricated 0) when the positions call fails but balance succeeds', async () => {
    // Regression (hardening audit): balance OK + positions FAILED must not look
    // like a flat account. currentPositionQty stays 0 by default, but the flag
    // lets the human place/replace path fail closed instead of under-counting a
    // real holding for the position_size cap.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance OK
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ msg: 'positions down' }),
      } as Response);
    const r = await webullAccountState('ACC1', 'AAPL');
    expect(r.ok).toBe(true); // balance is usable
    expect(r.positionsUnavailable).toBe(true);
    expect(r.state?.currentPositionQty).toBe(0); // default, NOT a confirmed-flat 0
  });

  it('leaves positionsUnavailable falsy on the happy path', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(
        okResp([{ symbol: 'AAPL', quantity: '5', position_side: 'LONG', asset_type: 'STOCK', cost_price: '10' }]),
      );
    const r = await webullAccountState('ACC1', 'AAPL');
    expect(r.positionsUnavailable).toBeFalsy();
    expect(r.state?.currentPositionQty).toBe(5);
  });

  it('surfaces a balance error cleanly', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'no permission' }),
    } as Response);
    const r = await webullAccountState('ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no permission/i);
  });
});

describe('realized-today derivation (the daily-loss halt input)', () => {
  const arm = () => Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  const balance = (day: string, unrealized?: string) => {
    const b: Record<string, unknown> = { ...BALANCE, total_day_profit_loss: day };
    if (unrealized === undefined) delete b.total_unrealized_profit_loss;
    else b.total_unrealized_profit_loss = unrealized;
    return b;
  };

  it('an open GAIN cannot mask a realized loss (the fail-open case, with the captured numbers)', async () => {
    // The exact 2026-07-28 capture: day −45.68 while unrealized +362.50 — the
    // raw day figure hid a ~$408 realized loss behind an open gain. The halt
    // input must be the derived realized, not the raw −45.68.
    arm();
    mockBook.mockReturnValue(book(0)); // trades placed in the Webull app: our book is blind
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('-45.68', '362.50')));
    const r = await webullAccountState('ACC1');
    expect(r.state?.realizedPnlTodayUsd).toBeCloseTo(-408.18);
    expect(r.realizedToday).toMatchObject({ brokerDayPnlUsd: -45.68, brokerDerivedUsd: -408.18, bookRealizedUsd: 0 });
  });

  it('pure open drawdown does not read as a realized loss (the false-trip case)', async () => {
    // Positions down $500 on the day, nothing sold: day −500, unrealized −500.
    // Derived = 0, book = 0 — the halt sees no realized loss.
    arm();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('-500.00', '-500.00')));
    const r = await webullAccountState('ACC1');
    expect(r.state?.realizedPnlTodayUsd).toBe(0);
  });

  it('takes the OWN BOOK number when it is worse than the broker-derived one', async () => {
    arm();
    mockBook.mockReturnValue(book(-250));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('-45.68', '362.50')));
    const r = await webullAccountState('ACC1');
    // min(−408.18, −250) is still the derived side; flip the balance so the
    // book side is the worse of the two.
    expect(r.state?.realizedPnlTodayUsd).toBeCloseTo(-408.18);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('0.00', '0.00')));
    const r2 = await webullAccountState('ACC1');
    expect(r2.state?.realizedPnlTodayUsd).toBe(-250);
  });

  it('falls back to the book alone when the payload has no unrealized field', async () => {
    arm();
    mockBook.mockReturnValue(book(-77.5));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('12.00', undefined)));
    const r = await webullAccountState('ACC1');
    expect(r.state?.realizedPnlTodayUsd).toBe(-77.5);
    expect(r.realizedToday?.brokerDerivedUsd).toBeUndefined();
  });

  it('falls back to the broker-derived side alone when the book is unreadable', async () => {
    arm();
    mockBook.mockImplementation(() => {
      throw new Error('no such table');
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('-45.68', '362.50')));
    const r = await webullAccountState('ACC1');
    expect(r.state?.realizedPnlTodayUsd).toBeCloseTo(-408.18);
    expect(r.realizedToday?.bookRealizedUsd).toBeUndefined();
  });

  it('uses the raw day figure only when nothing better exists', async () => {
    // No unrealized field AND no readable book — noisy, but "the day is flat"
    // would be a fabrication.
    arm();
    mockBook.mockImplementation(() => {
      throw new Error('no such table');
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(balance('-99.00', undefined)));
    const r = await webullAccountState('ACC1');
    expect(r.state?.realizedPnlTodayUsd).toBe(-99);
  });
});

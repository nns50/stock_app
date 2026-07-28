import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, addExit } from '../src/db/positions';
import { realizedTodayFromBook } from '../src/services/trading/realizedToday';
import { etToday } from '../src/util/marketDate';

const TODAY = etToday();
const ACC = 'ACC-MARGIN';

function pos(over: Partial<Parameters<typeof createPosition>[0]> = {}, accountId: string | null = ACC) {
  const p = createPosition({
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 10,
    entryPrice: 100,
    entryDate: '2026-07-01',
    ...over,
  });
  db.prepare('UPDATE positions SET account_id = ? WHERE id = ?').run(accountId, p.id);
  return p;
}

function liveOptionClose(over: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO autotrade_live_options_positions
       (symbol, side, kind, contract_symbol, strike, short_contract_symbol, short_strike, expiration,
        quantity, entry_price, short_entry_price, entry_at, risk_amount, risk_profile, rationale,
        status, exit_price, short_exit_price, exit_at, account_id, created_at, updated_at)
     VALUES (@symbol, @side, @kind, @contract_symbol, @strike, @short_contract_symbol, @short_strike, @expiration,
        @quantity, @entry_price, @short_entry_price, @entry_at, @risk_amount, @risk_profile, @rationale,
        @status, @exit_price, @short_exit_price, @exit_at, @account_id, @created_at, @updated_at)`,
  ).run({
    symbol: 'TSLA',
    side: 'call',
    kind: 'single_leg',
    contract_symbol: 'TSLA260918C00300000',
    strike: 300,
    short_contract_symbol: null,
    short_strike: null,
    expiration: '2026-09-18',
    quantity: 2,
    entry_price: 4.0,
    short_entry_price: null,
    entry_at: now - 3600_000,
    risk_amount: 800,
    risk_profile: 'moderate',
    rationale: 'fixture',
    status: 'closed',
    exit_price: 3.5,
    short_exit_price: null,
    exit_at: now,
    account_id: ACC,
    created_at: now,
    updated_at: now,
    ...over,
  });
}

describe('realizedTodayFromBook', () => {
  beforeAll(() => initDb());
  beforeEach(() =>
    db.exec('DELETE FROM position_exits; DELETE FROM positions; DELETE FROM autotrade_live_options_positions;'),
  );

  it('sums journal exits dated today, netting exit fees and respecting side/multiplier', () => {
    const long = pos();
    addExit(long.id, { quantity: 10, exitPrice: 95, exitDate: TODAY, fees: 1 }); // −50 − 1
    const short = pos({ symbol: 'XYZ', side: 'short', entryPrice: 50 });
    addExit(short.id, { quantity: 10, exitPrice: 48, exitDate: TODAY }); // +20
    const opt = pos({
      symbol: 'NVDA',
      assetType: 'option',
      optionType: 'call',
      strike: 100,
      expiration: '2026-12-18',
      entryPrice: 2,
      quantity: 1,
    });
    addExit(opt.id, { quantity: 1, exitPrice: 1.5, exitDate: TODAY }); // −0.5 × 100 = −50

    const r = realizedTodayFromBook(ACC);
    expect(r.journalUsd).toBeCloseTo(-51 + 20 - 50);
    expect(r.journalExitCount).toBe(3);
    expect(r.totalUsd).toBe(r.journalUsd);
  });

  it('ignores exits from other days and other accounts', () => {
    const p = pos();
    addExit(p.id, { quantity: 5, exitPrice: 90, exitDate: '2026-01-05' }); // not today
    const other = pos({ symbol: 'OTHR' }, 'ACC-CASH');
    addExit(other.id, { quantity: 10, exitPrice: 0.01, exitDate: TODAY }); // catastrophic — but not this account
    expect(realizedTodayFromBook(ACC).totalUsd).toBe(0);
  });

  it('counts an account-less row only while no OTHER account is known (task #120 rule)', () => {
    const untagged = pos({}, null);
    addExit(untagged.id, { quantity: 10, exitPrice: 90, exitDate: TODAY }); // −100
    // Single-account world: the untagged row is ours.
    expect(realizedTodayFromBook(ACC).journalUsd).toBe(-100);
    // A second account appears: the untagged row can no longer be attributed.
    pos({ symbol: 'ZZZ' }, 'ACC-CASH');
    expect(realizedTodayFromBook(ACC).journalUsd).toBe(0);
  });

  it('includes live options closes: single leg and debit spread', () => {
    liveOptionClose(); // (3.5 − 4.0) × 2 × 100 = −100
    liveOptionClose({
      symbol: 'AMD',
      kind: 'debit_spread',
      contract_symbol: 'AMD260918C00150000',
      strike: 150,
      short_strike: 160,
      short_entry_price: 1.0,
      entry_price: 3.0,
      exit_price: 4.0,
      short_exit_price: 1.5,
      quantity: 1,
    }); // ((4 − 1.5) − (3 − 1)) × 1 × 100 = +50
    const r = realizedTodayFromBook(ACC);
    expect(r.liveOptionsUsd).toBeCloseTo(-100 + 50);
    expect(r.liveOptionsCloseCount).toBe(2);
  });

  it('ignores a live options close from another ET day, and a close without a price', () => {
    liveOptionClose({ exit_at: Date.now() - 3 * 86_400_000 });
    liveOptionClose({ exit_price: null });
    expect(realizedTodayFromBook(ACC).liveOptionsUsd).toBe(0);
  });

  it('books the same contract once when both books recorded the close (sync double-entry)', () => {
    // The positions sync imports broker option holdings into the journal, so a
    // contract autotrade also tracks gets closed twice on paper. The live row
    // carries the real fills — it wins; the journal echo is skipped.
    liveOptionClose(); // TSLA 300C 2026-09-18, −100
    const echo = pos({
      symbol: 'TSLA',
      assetType: 'option',
      optionType: 'call',
      strike: 300,
      expiration: '2026-09-18',
      entryPrice: 4.0,
      quantity: 2,
    });
    addExit(echo.id, { quantity: 2, exitPrice: 3.45, exitDate: TODAY }); // the sync's estimate of the same event
    const r = realizedTodayFromBook(ACC);
    expect(r.totalUsd).toBe(-100); // live number only — not −100 + the echo
    expect(r.journalExitCount).toBe(0);
  });

  it('reports an empty day as zero across the board', () => {
    expect(realizedTodayFromBook(ACC)).toEqual({
      totalUsd: 0,
      journalUsd: 0,
      liveOptionsUsd: 0,
      journalExitCount: 0,
      liveOptionsCloseCount: 0,
    });
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  closeLiveOptionsPosition,
  hasOpenLiveOptionsPosition,
  listOpenLiveOptionsPositions,
  listLiveOptionsPositions,
  createLiveOptionsPosition,
  CreateLiveOptionsPositionInput,
} from '../src/db/autotradeLiveOptionsPositions';

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM autotrade_live_options_positions WHERE symbol LIKE 'LOP%'"));

function input(overrides: Partial<CreateLiveOptionsPositionInput> = {}): CreateLiveOptionsPositionInput {
  return {
    symbol: 'LOPAAA',
    side: 'call',
    contractSymbol: 'LOPAAA240315C00100000',
    strike: 100,
    expiration: '2024-03-15',
    quantity: 2,
    entryPrice: 3.5,
    riskAmount: 700,
    riskProfile: 'MODERATE',
    rationale: 'test fixture',
    ...overrides,
  };
}

describe('autotradeLiveOptionsPositions', () => {
  it('creates a position with status open, kind defaulting to single_leg, and null exit fields', () => {
    const pos = createLiveOptionsPosition(input());
    expect(pos.status).toBe('open');
    expect(pos.kind).toBe('single_leg');
    expect(pos.symbol).toBe('LOPAAA');
    expect(pos.side).toBe('call');
    expect(pos.strike).toBe(100);
    expect(pos.expiration).toBe('2024-03-15');
    expect(pos.shortContractSymbol).toBeNull();
    expect(pos.shortStrike).toBeNull();
    expect(pos.shortEntryPrice).toBeNull();
    expect(pos.exitPrice).toBeNull();
    expect(pos.exitAt).toBeNull();
    expect(pos.exitReason).toBeNull();
    expect(pos.entryAt).toBeGreaterThan(0);
  });

  it('normalizes the symbol to uppercase', () => {
    const pos = createLiveOptionsPosition(input({ symbol: 'lopbbb' }));
    expect(pos.symbol).toBe('LOPBBB');
  });

  it('creates a debit_spread position carrying both legs', () => {
    const pos = createLiveOptionsPosition(
      input({
        symbol: 'LOPSPR',
        kind: 'debit_spread',
        contractSymbol: 'LOPSPR-LONG',
        strike: 100,
        shortContractSymbol: 'LOPSPR-SHORT',
        shortStrike: 110,
        shortEntryPrice: 1.2,
        entryPrice: 3.5,
      }),
    );
    expect(pos.kind).toBe('debit_spread');
    expect(pos.contractSymbol).toBe('LOPSPR-LONG');
    expect(pos.strike).toBe(100);
    expect(pos.shortContractSymbol).toBe('LOPSPR-SHORT');
    expect(pos.shortStrike).toBe(110);
    expect(pos.shortEntryPrice).toBe(1.2);
  });

  it('closes an open position, setting exit fields and status', () => {
    const opened = createLiveOptionsPosition(input());
    const closed = closeLiveOptionsPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('closed');
    expect(closed!.exitPrice).toBe(1.2);
    expect(closed!.exitReason).toBe('time_exit');
    expect(closed!.exitAt).toBeGreaterThan(0);
  });

  it('closes a debit_spread position, setting both legs exit fields', () => {
    const opened = createLiveOptionsPosition(
      input({ symbol: 'LOPSPR2', kind: 'debit_spread', shortContractSymbol: 'LOPSPR2-SHORT', shortStrike: 110 }),
    );
    const closed = closeLiveOptionsPosition(opened.id, { exitPrice: 5, shortExitPrice: 0.5, exitReason: 'time_exit' });
    expect(closed!.exitPrice).toBe(5);
    expect(closed!.shortExitPrice).toBe(0.5);
  });

  it('closing an already-closed position is a no-op that returns null, not a double-close', () => {
    const opened = createLiveOptionsPosition(input());
    const first = closeLiveOptionsPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(first!.exitPrice).toBe(1.2);
    const secondAttempt = closeLiveOptionsPosition(opened.id, { exitPrice: 0.1, exitReason: 'manual' });
    expect(secondAttempt).toBeNull();
    const row = listLiveOptionsPositions({ symbol: opened.symbol })[0];
    expect(row.exitPrice).toBe(1.2);
    expect(row.exitReason).toBe('time_exit');
  });

  it('closing a nonexistent id returns null', () => {
    expect(closeLiveOptionsPosition(999_999_999, { exitPrice: 1, exitReason: 'manual' })).toBeNull();
  });

  it('hasOpenLiveOptionsPosition reflects open/closed state per underlying symbol', () => {
    expect(hasOpenLiveOptionsPosition('LOPCCC')).toBe(false);
    const opened = createLiveOptionsPosition(input({ symbol: 'LOPCCC' }));
    expect(hasOpenLiveOptionsPosition('LOPCCC')).toBe(true);
    closeLiveOptionsPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(hasOpenLiveOptionsPosition('LOPCCC')).toBe(false);
  });

  it('hasOpenLiveOptionsPosition is case-insensitive', () => {
    createLiveOptionsPosition(input({ symbol: 'LOPDDD' }));
    expect(hasOpenLiveOptionsPosition('lopddd')).toBe(true);
  });

  it('listOpenLiveOptionsPositions returns only open ones, oldest first', () => {
    const a = createLiveOptionsPosition(input({ symbol: 'LOPEEE' }));
    const b = createLiveOptionsPosition(input({ symbol: 'LOPFFF' }));
    closeLiveOptionsPosition(a.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    const open = listOpenLiveOptionsPositions().filter((p) => p.symbol.startsWith('LOP'));
    expect(open.map((p) => p.id)).toEqual([b.id]);
  });

  it('listLiveOptionsPositions filters by status and symbol', () => {
    const a = createLiveOptionsPosition(input({ symbol: 'LOPGGG' }));
    createLiveOptionsPosition(input({ symbol: 'LOPHHH' }));
    closeLiveOptionsPosition(a.id, { exitPrice: 1.2, exitReason: 'time_exit' });

    expect(listLiveOptionsPositions({ symbol: 'LOPGGG' }).map((p) => p.status)).toEqual(['closed']);
    const openOnly = listLiveOptionsPositions({ status: 'open' }).filter((p) => p.symbol.startsWith('LOP'));
    expect(openOnly.map((p) => p.symbol)).toEqual(['LOPHHH']);
  });

  it('listLiveOptionsPositions returns newest first', () => {
    createLiveOptionsPosition(input({ symbol: 'LOPIII' }));
    createLiveOptionsPosition(input({ symbol: 'LOPJJJ' }));
    const rows = listLiveOptionsPositions({ limit: 2 });
    expect(rows[0].symbol).toBe('LOPJJJ');
    expect(rows[1].symbol).toBe('LOPIII');
  });
});

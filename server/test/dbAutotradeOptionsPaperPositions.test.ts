import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  closeOptionsPaperPosition,
  hasOpenOptionsPaperPosition,
  listOpenOptionsPaperPositions,
  listOptionsPaperPositions,
  openOptionsPaperPosition,
  OpenOptionsPaperPositionInput,
} from '../src/db/autotradeOptionsPaperPositions';

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM autotrade_options_paper_positions WHERE symbol LIKE 'OPP%'"));

function input(overrides: Partial<OpenOptionsPaperPositionInput> = {}): OpenOptionsPaperPositionInput {
  return {
    symbol: 'OPPAAA',
    side: 'call',
    contractSymbol: 'OPPAAA240315C00100000',
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

describe('autotradeOptionsPaperPositions', () => {
  it('opens a position with status open and null exit fields', () => {
    const pos = openOptionsPaperPosition(input());
    expect(pos.status).toBe('open');
    expect(pos.symbol).toBe('OPPAAA');
    expect(pos.side).toBe('call');
    expect(pos.strike).toBe(100);
    expect(pos.expiration).toBe('2024-03-15');
    expect(pos.exitPrice).toBeNull();
    expect(pos.exitAt).toBeNull();
    expect(pos.exitReason).toBeNull();
    expect(pos.entryAt).toBeGreaterThan(0);
  });

  it('normalizes the symbol to uppercase', () => {
    const pos = openOptionsPaperPosition(input({ symbol: 'oppbbb' }));
    expect(pos.symbol).toBe('OPPBBB');
  });

  it('closes an open position, setting exit fields and status', () => {
    const opened = openOptionsPaperPosition(input());
    const closed = closeOptionsPaperPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('closed');
    expect(closed!.exitPrice).toBe(1.2);
    expect(closed!.exitReason).toBe('time_exit');
    expect(closed!.exitAt).toBeGreaterThan(0);
  });

  it('accepts stop_loss and take_profit as exit reasons', () => {
    const a = openOptionsPaperPosition(input({ symbol: 'OPPKKK' }));
    const closedA = closeOptionsPaperPosition(a.id, { exitPrice: 1.8, exitReason: 'stop_loss' });
    expect(closedA!.exitReason).toBe('stop_loss');

    const b = openOptionsPaperPosition(input({ symbol: 'OPPLLL' }));
    const closedB = closeOptionsPaperPosition(b.id, { exitPrice: 5.2, exitReason: 'take_profit' });
    expect(closedB!.exitReason).toBe('take_profit');
  });

  it('closing an already-closed position is a no-op that returns null, not a double-close', () => {
    const opened = openOptionsPaperPosition(input());
    const first = closeOptionsPaperPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(first!.exitPrice).toBe(1.2);
    const secondAttempt = closeOptionsPaperPosition(opened.id, { exitPrice: 0.1, exitReason: 'manual' });
    expect(secondAttempt).toBeNull();
    const row = listOptionsPaperPositions({ symbol: opened.symbol })[0];
    expect(row.exitPrice).toBe(1.2);
    expect(row.exitReason).toBe('time_exit');
  });

  it('closing a nonexistent id returns null', () => {
    expect(closeOptionsPaperPosition(999_999_999, { exitPrice: 1, exitReason: 'manual' })).toBeNull();
  });

  it('hasOpenOptionsPaperPosition reflects open/closed state per underlying symbol', () => {
    expect(hasOpenOptionsPaperPosition('OPPCCC')).toBe(false);
    const opened = openOptionsPaperPosition(input({ symbol: 'OPPCCC' }));
    expect(hasOpenOptionsPaperPosition('OPPCCC')).toBe(true);
    closeOptionsPaperPosition(opened.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    expect(hasOpenOptionsPaperPosition('OPPCCC')).toBe(false);
  });

  it('hasOpenOptionsPaperPosition is case-insensitive', () => {
    openOptionsPaperPosition(input({ symbol: 'OPPDDD' }));
    expect(hasOpenOptionsPaperPosition('oppddd')).toBe(true);
  });

  it('listOpenOptionsPaperPositions returns only open ones, oldest first', () => {
    const a = openOptionsPaperPosition(input({ symbol: 'OPPEEE' }));
    const b = openOptionsPaperPosition(input({ symbol: 'OPPFFF' }));
    closeOptionsPaperPosition(a.id, { exitPrice: 1.2, exitReason: 'time_exit' });
    const open = listOpenOptionsPaperPositions().filter((p) => p.symbol.startsWith('OPP'));
    expect(open.map((p) => p.id)).toEqual([b.id]);
  });

  it('listOptionsPaperPositions filters by status and symbol', () => {
    const a = openOptionsPaperPosition(input({ symbol: 'OPPGGG' }));
    openOptionsPaperPosition(input({ symbol: 'OPPHHH' }));
    closeOptionsPaperPosition(a.id, { exitPrice: 1.2, exitReason: 'time_exit' });

    expect(listOptionsPaperPositions({ symbol: 'OPPGGG' }).map((p) => p.status)).toEqual(['closed']);
    const openOnly = listOptionsPaperPositions({ status: 'open' }).filter((p) => p.symbol.startsWith('OPP'));
    expect(openOnly.map((p) => p.symbol)).toEqual(['OPPHHH']);
  });

  it('listOptionsPaperPositions returns newest first', () => {
    openOptionsPaperPosition(input({ symbol: 'OPPIII' }));
    openOptionsPaperPosition(input({ symbol: 'OPPJJJ' }));
    const rows = listOptionsPaperPositions({ limit: 2 });
    expect(rows[0].symbol).toBe('OPPJJJ');
    expect(rows[1].symbol).toBe('OPPIII');
  });
});

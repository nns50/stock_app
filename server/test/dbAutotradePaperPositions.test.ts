import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  closePaperPosition,
  hasOpenPaperPosition,
  listOpenPaperPositions,
  listPaperPositions,
  openPaperPosition,
  OpenPaperPositionInput,
} from '../src/db/autotradePaperPositions';

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM autotrade_paper_positions WHERE symbol LIKE 'PP%'"));

function input(overrides: Partial<OpenPaperPositionInput> = {}): OpenPaperPositionInput {
  return {
    symbol: 'PPAAA',
    side: 'buy',
    quantity: 100,
    entryPrice: 50,
    stopPrice: 48,
    targetPrice: 54,
    riskAmount: 200,
    riskProfile: 'MODERATE',
    rationale: 'test fixture',
    ...overrides,
  };
}

describe('autotradePaperPositions', () => {
  it('opens a position with status open and null exit fields', () => {
    const pos = openPaperPosition(input());
    expect(pos.status).toBe('open');
    expect(pos.symbol).toBe('PPAAA');
    expect(pos.exitPrice).toBeNull();
    expect(pos.exitAt).toBeNull();
    expect(pos.exitReason).toBeNull();
    expect(pos.entryAt).toBeGreaterThan(0);
  });

  it('normalizes the symbol to uppercase', () => {
    const pos = openPaperPosition(input({ symbol: 'ppbbb' }));
    expect(pos.symbol).toBe('PPBBB');
  });

  it('closes an open position, setting exit fields and status', () => {
    const opened = openPaperPosition(input());
    const closed = closePaperPosition(opened.id, { exitPrice: 54, exitReason: 'target' });
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe('closed');
    expect(closed!.exitPrice).toBe(54);
    expect(closed!.exitReason).toBe('target');
    expect(closed!.exitAt).toBeGreaterThan(0);
  });

  it('closing an already-closed position is a no-op, not a double-close', () => {
    const opened = openPaperPosition(input());
    closePaperPosition(opened.id, { exitPrice: 54, exitReason: 'target' });
    const secondAttempt = closePaperPosition(opened.id, { exitPrice: 40, exitReason: 'stop' });
    // Still returns the (unchanged) row — but exit fields weren't overwritten.
    expect(secondAttempt!.exitPrice).toBe(54);
    expect(secondAttempt!.exitReason).toBe('target');
  });

  it('closing a nonexistent id returns null', () => {
    expect(closePaperPosition(999_999_999, { exitPrice: 1, exitReason: 'manual' })).toBeNull();
  });

  it('hasOpenPaperPosition reflects open/closed state per symbol', () => {
    expect(hasOpenPaperPosition('PPCCC')).toBe(false);
    const opened = openPaperPosition(input({ symbol: 'PPCCC' }));
    expect(hasOpenPaperPosition('PPCCC')).toBe(true);
    closePaperPosition(opened.id, { exitPrice: 54, exitReason: 'target' });
    expect(hasOpenPaperPosition('PPCCC')).toBe(false);
  });

  it('hasOpenPaperPosition is case-insensitive', () => {
    openPaperPosition(input({ symbol: 'PPDDD' }));
    expect(hasOpenPaperPosition('ppddd')).toBe(true);
  });

  it('listOpenPaperPositions returns only open ones, oldest first', () => {
    const a = openPaperPosition(input({ symbol: 'PPEEE' }));
    const b = openPaperPosition(input({ symbol: 'PPFFF' }));
    closePaperPosition(a.id, { exitPrice: 54, exitReason: 'target' });
    const open = listOpenPaperPositions().filter((p) => p.symbol.startsWith('PP'));
    expect(open.map((p) => p.id)).toEqual([b.id]);
  });

  it('listPaperPositions filters by status and symbol', () => {
    const a = openPaperPosition(input({ symbol: 'PPGGG' }));
    openPaperPosition(input({ symbol: 'PPHHH' }));
    closePaperPosition(a.id, { exitPrice: 54, exitReason: 'target' });

    expect(listPaperPositions({ symbol: 'PPGGG' }).map((p) => p.status)).toEqual(['closed']);
    const openOnly = listPaperPositions({ status: 'open' }).filter((p) => p.symbol.startsWith('PP'));
    expect(openOnly.map((p) => p.symbol)).toEqual(['PPHHH']);
  });

  it('listPaperPositions returns newest first', () => {
    openPaperPosition(input({ symbol: 'PPIII' }));
    openPaperPosition(input({ symbol: 'PPJJJ' }));
    const rows = listPaperPositions({ limit: 2 });
    expect(rows[0].symbol).toBe('PPJJJ');
    expect(rows[1].symbol).toBe('PPIII');
  });
});

import { describe, it, expect } from 'vitest';
import type { Position } from '../src/db/positions';
import type { LiveOptionsPosition } from '../src/db/autotradeLiveOptionsPositions';
import { addDays, computeSymbolCooldowns } from '../src/services/autotrading/symbolCooldown';

// Same minimal closed-position builder as methodSizing.test.ts: entry 100,
// stop 95, one full exit. exitPrice 95 => a LOSS; 110 => a win; 100 => scratch.
let idSeq = 0;
function closed(over: Partial<Position> & { exitPrice?: number; exitDate?: string } = {}): Position {
  const { exitPrice = 95, exitDate = '2026-08-21', ...rest } = over;
  idSeq += 1;
  return {
    id: idSeq,
    assetType: 'stock',
    symbol: 'SOBR',
    side: 'long',
    quantity: 1,
    remainingQuantity: 0,
    entryPrice: 100,
    entryDate: '2026-08-01',
    stopPrice: 95,
    targetPrice: null,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    fees: 0,
    notes: null,
    tags: ['autotrade'],
    grade: null,
    status: 'closed',
    accountId: null,
    sourceIntentId: null,
    exitReason: null,
    marketRegimeAtEntry: null,
    exits: [{ id: idSeq, positionId: idSeq, quantity: 1, exitPrice, exitDate, fees: 0, notes: null, createdAt: 0 }],
    createdAt: 0,
    ...rest,
  } as Position;
}

const closedLiveOption = (over: Partial<LiveOptionsPosition> = {}) =>
  ({
    id: ++idSeq,
    symbol: 'SRAD',
    side: 'put',
    kind: 'single_leg',
    contractSymbol: 'SRAD-fixture',
    strike: 20,
    shortStrike: null,
    expiration: '2026-09-18',
    quantity: 1,
    entryPrice: 1,
    shortEntryPrice: null,
    riskAmount: 100,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    status: 'closed',
    exitPrice: 0.5, // a loss: exited at half the premium
    shortExitPrice: null,
    exitAt: Date.parse('2026-08-21T14:00:00Z'),
    exitReason: 'stop',
    openedAt: 0,
    updatedAt: 0,
    ...over,
  }) as LiveOptionsPosition;

// Trigger 2 losses within 5 calendar days; 3-day cooldown after the last loss.
const cfg = { symbolCooldownLosses: 2, symbolCooldownWindowDays: 5, symbolCooldownDays: 3 };
const TODAY = '2026-08-21';

describe('addDays', () => {
  it('does plain calendar arithmetic, month/year rollovers included', () => {
    expect(addDays('2026-08-21', 3)).toBe('2026-08-24');
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-08-21', -4)).toBe('2026-08-17');
  });
});

describe('computeSymbolCooldowns', () => {
  it('is empty when off (0) — and a trigger of 1 reads as off too', () => {
    const losses = [closed(), closed()];
    expect(computeSymbolCooldowns(losses, [], { ...cfg, symbolCooldownLosses: 0 }, TODAY).size).toBe(0);
    // Single-loss re-entries have WON (LVWR -0.98R then +1.93R same day) —
    // a trigger of 1 would forbid exactly that trade, so it never arms.
    expect(computeSymbolCooldowns(losses, [], { ...cfg, symbolCooldownLosses: 1 }, TODAY).size).toBe(0);
  });

  it('one loss in the window never cools — the feature exists for REPEATED losses', () => {
    expect(computeSymbolCooldowns([closed()], [], cfg, TODAY).size).toBe(0);
  });

  it('two losses within the window cool the symbol until N days after the last', () => {
    const m = computeSymbolCooldowns([closed({ exitDate: '2026-08-20' }), closed()], [], cfg, TODAY);
    expect(m.get('SOBR')).toMatchObject({ losses: 2, lastLossDate: '2026-08-21', until: '2026-08-24' });
  });

  it('wins and breakeven scratches never count as losses', () => {
    const trades = [closed({ exitPrice: 110 }), closed({ exitPrice: 100 }), closed()];
    expect(computeSymbolCooldowns(trades, [], cfg, TODAY).size).toBe(0);
  });

  it('losses older than the window have aged out', () => {
    // Window is 5 days ending today: 08-17..08-21. A loss on 08-16 is gone.
    const m = computeSymbolCooldowns([closed({ exitDate: '2026-08-16' }), closed()], [], cfg, TODAY);
    expect(m.size).toBe(0);
  });

  it('the cooldown itself expires: N days after the last loss the symbol trades again', () => {
    const losses = [closed({ exitDate: '2026-08-18' }), closed({ exitDate: '2026-08-18' })];
    // 08-18 + 3 = until 08-21: cooled through 08-20, trading again today.
    expect(computeSymbolCooldowns(losses, [], cfg, '2026-08-20').get('SOBR')).toBeDefined();
    expect(computeSymbolCooldowns(losses, [], cfg, '2026-08-21')).toEqual(new Map());
  });

  it('symbols are independent — one name cooling never touches another', () => {
    const m = computeSymbolCooldowns([closed(), closed(), closed({ symbol: 'AAPL' })], [], cfg, TODAY);
    expect(m.has('SOBR')).toBe(true);
    expect(m.has('AAPL')).toBe(false);
  });

  it('live options losses count toward the SAME symbol — cooled as a symbol, not per instrument', () => {
    // One stock loss + one options loss on SRAD = 2 qualifying losses.
    const m = computeSymbolCooldowns([closed({ symbol: 'SRAD' })], [closedLiveOption()], cfg, TODAY);
    expect(m.get('SRAD')).toMatchObject({ losses: 2 });
  });

  it('winning or still-open options rows never count', () => {
    const rows = [
      closedLiveOption({ exitPrice: 2 }), // a win
      closedLiveOption({ status: 'open', exitPrice: null }),
    ];
    expect(computeSymbolCooldowns([closed({ symbol: 'SRAD' })], rows, cfg, TODAY).size).toBe(0);
  });
});

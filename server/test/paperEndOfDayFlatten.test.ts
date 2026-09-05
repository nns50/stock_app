import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/providers', () => ({ getProvider: vi.fn() }));
// The flatten window is a wall-clock fact, so it is driven from here rather
// than by waiting for 15:55 ET.
const mockFlatten = vi.fn();
vi.mock('../src/services/autotrading/endOfDayFlatten', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/autotrading/endOfDayFlatten')>()),
  evaluateEndOfDayFlatten: (...args: unknown[]) => mockFlatten(...args),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider } from '../src/providers';
import { initDb, db } from '../src/db';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { openPaperPosition, listPaperPositions } from '../src/db/autotradePaperPositions';
import { checkPaperExits } from '../src/services/autotrading/execute';

// ---------------------------------------------------------------------------
// The paper book's end-of-day flatten (2026-09-05).
//
// It had none. The reasoning — "paper has no overnight risk worth the churn" —
// was right about risk and wrong about MEASUREMENT: with no flatten, a paper
// position opened late in the session necessarily became an overnight hold, and
// the live book never takes one.
//
// All twelve paper entries opened inside the last 95 minutes were carried
// overnight; not one closed same-day, ten of twelve stopped out — nine of them
// before noon the next morning, on the opening gap — and those alone were
// -6.03R against a whole-book total of -2.49R. So the paper book's headline was dominated by trades the
// live strategy could not have held — the same disease as reading a scale-out's
// P&L without its banked slice.
//
// The ENTRY cutoff stays live-only on purpose, and that asymmetry is load-
// bearing: paper keeps opening late entries and now exits them the way live
// would, which is the only way to find out whether the live 95-minute cutoff is
// buying anything.
// ---------------------------------------------------------------------------

const inWindow = {
  active: true,
  minutesLeft: 4,
  detail: '4m to the close — flattening rather than carrying overnight',
};
const outOfWindow = { active: false, minutesLeft: 120, detail: '120m to the close' };

beforeAll(() => initDb());

beforeEach(() => {
  db.exec("DELETE FROM autotrade_paper_positions WHERE symbol LIKE 'ZEOD%'");
  db.exec("DELETE FROM autotrade_events WHERE symbol LIKE 'ZEOD%'");
  mockFlatten.mockReset();
  mockFlatten.mockReturnValue(outOfWindow);
  setAutotradeConfig({ maxHoldDays: 0, partialExitRMultiple: 0, endOfDayFlattenMinutes: 5 });
  vi.mocked(getProvider).mockReturnValue({
    // Between the stop (95) and target (110): nothing else would close it.
    getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 102, timestamp: Date.now() })),
    getCandles: vi.fn(async () => []),
  } as unknown as ReturnType<typeof getProvider>);
});

const openPos = (symbol = 'ZEODA', over: Record<string, unknown> = {}) =>
  openPaperPosition({
    symbol,
    side: 'buy',
    quantity: 10,
    entryPrice: 100,
    stopPrice: 95,
    targetPrice: 110,
    riskAmount: 50,
    riskProfile: 'MODERATE',
    rationale: 'fixture',
    ...over,
  });

const eventsFor = (symbol: string) => listAutotradeEvents({ limit: 200 }).filter((e) => e.symbol === symbol);

/** `detail` is stored as a JSON string, not an object. */
const detailOf = (symbol: string, action: string): Record<string, unknown> => {
  const ev = eventsFor(symbol).find((e) => e.action === action);
  expect(ev, `no ${action} event for ${symbol}`).toBeDefined();
  return JSON.parse(ev!.detail ?? '{}') as Record<string, unknown>;
};

describe('checkPaperExits — end-of-day flatten', () => {
  it('leaves a mid-range position alone outside the window', async () => {
    openPos();
    const outcomes = await checkPaperExits();
    expect(outcomes.find((o) => o.symbol === 'ZEODA')?.closed).toBe(false);
  });

  it('closes that same position inside the window', async () => {
    // This is the whole point: nothing about the TRADE changed, only the clock.
    openPos();
    mockFlatten.mockReturnValue(inWindow);
    const outcomes = await checkPaperExits();
    const o = outcomes.find((x) => x.symbol === 'ZEODA');
    expect(o?.closed).toBe(true);
    expect(o?.position?.exitPrice).toBe(102); // the live quote, not a level
  });

  it('books it as time_exit and says in the journal that the flatten did it', async () => {
    // exit_reason has a four-value CHECK, so the flatten shares 'time_exit'
    // with the hold-days cut. The journal is where they are told apart — and a
    // reason nothing records is a reason nobody can count.
    openPos();
    mockFlatten.mockReturnValue(inWindow);
    await checkPaperExits();

    expect(listPaperPositions({ symbol: 'ZEODA' })[0].exitReason).toBe('time_exit');
    const detail = detailOf('ZEODA', 'paper_position_closed');
    expect(detail.closedBy).toBe('end_of_day_flatten');
    expect(detail.minutesLeft).toBe(4);
  });

  it('does NOT relabel a real stop hit that lands in the same tick', async () => {
    // A position that genuinely stopped out at 15:56 stopped out; calling it a
    // flatten would quietly move a loss out of the stop bucket and corrupt the
    // exit-reason mix the strategy is judged on.
    openPos('ZEODB');
    mockFlatten.mockReturnValue(inWindow);
    vi.mocked(getProvider).mockReturnValue({
      getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 90, timestamp: Date.now() })),
      getCandles: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getProvider>);

    await checkPaperExits();
    expect(listPaperPositions({ symbol: 'ZEODB' })[0].exitReason).toBe('stop');
    const detail = detailOf('ZEODB', 'paper_position_closed');
    expect(detail.closedBy).toBeUndefined();
    expect(detail.exitPrice).toBe(95); // the stop LEVEL, unchanged
  });

  it('does not relabel a target hit either', async () => {
    openPos('ZEODC');
    mockFlatten.mockReturnValue(inWindow);
    vi.mocked(getProvider).mockReturnValue({
      getQuote: vi.fn(async (symbol: string) => ({ symbol, last: 115, timestamp: Date.now() })),
      getCandles: vi.fn(async () => []),
    } as unknown as ReturnType<typeof getProvider>);

    await checkPaperExits();
    expect(listPaperPositions({ symbol: 'ZEODC' })[0].exitReason).toBe('target');
    expect(listPaperPositions({ symbol: 'ZEODC' })[0].exitPrice).toBe(110);
  });

  it('reads the same config field the live book does', async () => {
    // Not a second setting that could disagree — one window, both books. With
    // the flatten off, a mid-range position stays open even in the window.
    setAutotradeConfig({ endOfDayFlattenMinutes: 0 });
    openPos('ZEODD');
    // The real evaluateEndOfDayFlatten returns inactive when the field is 0;
    // this asserts checkPaperExits routes through it rather than its own clock.
    const { evaluateEndOfDayFlatten } = await vi.importActual<
      typeof import('../src/services/autotrading/endOfDayFlatten')
    >('../src/services/autotrading/endOfDayFlatten');
    mockFlatten.mockImplementation((...args: Parameters<typeof evaluateEndOfDayFlatten>) =>
      evaluateEndOfDayFlatten(...args),
    );

    const outcomes = await checkPaperExits();
    expect(outcomes.find((o) => o.symbol === 'ZEODD')?.closed).toBe(false);
    expect(mockFlatten).toHaveBeenCalledWith(
      expect.objectContaining({ endOfDayFlattenMinutes: 0 }),
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------
// The paper/live divergence contract, written down in execute.ts: paper is live
// minus exactly THREE things, each of which is an open question someone is
// trying to answer — the entry cutoff, the stagnation exit, and the symbol
// re-entry cooldown. Anything else that diverges is a bug.
//
// This is a source scan because the thing being guarded is an ABSENCE, and an
// absence has no behaviour to assert. It cannot prove the list is right; it can
// stop the list growing a fourth entry silently, which is how the flatten went
// missing in the first place.
// ---------------------------------------------------------------------------
describe('paper diverges from live in exactly the three documented places', () => {
  const paperSrc = () => readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'execute.ts'), 'utf8');
  /** Code only. The comments NAME all three of these while explaining why they
   *  are absent, so a raw scan finds them in exactly the file that is correct. */
  const paperCode = () =>
    paperSrc()
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  it('copies the structural exit — the end-of-day flatten', () => {
    expect(paperCode()).toMatch(/evaluateEndOfDayFlatten\(/);
  });

  it.each([
    ['evaluateEntryCutoff', 'the entry cutoff'],
    ['evaluateStagnation', 'the stagnation exit'],
    ['activeSymbolCooldowns', 'the symbol re-entry cooldown'],
  ])('does NOT copy %s — %s is the counterfactual', (symbol) => {
    expect(paperCode()).not.toContain(symbol);
  });

  it('says WHY each one is left off, rather than just leaving it off', () => {
    // The whole complaint in task #25 was that the divergence carried no
    // comment, so it read as an omission. If someone deletes the reasoning,
    // the next reader is back where we started.
    const src = paperSrc();
    for (const phrase of ['STAGNATION EXIT', 'RE-ENTRY COOLDOWN', 'counterfactual']) {
      expect(src).toContain(phrase);
    }
  });
});

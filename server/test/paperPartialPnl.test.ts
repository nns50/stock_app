import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  closePaperPosition,
  openPaperPosition,
  partialClosePaperPosition,
  paperRealizedPnl,
  paperRealizedR,
  OpenPaperPositionInput,
  PaperPosition,
} from '../src/db/autotradePaperPositions';
import {
  closeOptionsPaperPosition,
  openOptionsPaperPosition,
  partialCloseOptionsPaperPosition,
  OpenOptionsPaperPositionInput,
} from '../src/db/autotradeOptionsPaperPositions';
import { getPaperPortfolioSnapshot } from '../src/services/autotrading/execute';
import { optionsPaperRealizedPnl } from '../src/services/autotrading/optionsExecute';
import { setAutotradeConfig } from '../src/db/autotradeConfig';

// ---------------------------------------------------------------------------
// Banked partial-exit P&L (2026-09-05).
//
// partialClosePaperPosition reduced `quantity` in place and wrote the closed
// slice nowhere structured. Everything that read this table's P&L therefore
// read the FINAL leg alone: the paper daily P&L, the equity-curve de-risk
// input, the journal event, the UI, and -- the one that changed behaviour --
// the realized R feeding grade-expectancy SIZING.
//
// The partial only fires at a profit (>= partialExitRMultiple), so the bias
// was strictly one-directional. Measured in production the day it was found:
// $356.99 dropped across 17 of 70 closed rows, every event positive. The paper
// book was being sized DOWN off its own deleted profits, and task #20 ("judge
// the 0.30R scale-out after 3 sessions") would have judged the scale-out from
// data that deleted exactly the scale-out's contribution.
//
// partialClosePaperPosition had NO test coverage at all, which is how it
// survived. These are its tests, and the consumer-level ones below are the
// point: asserting the db helper in isolation proves nothing about whether
// anything reads what it banks.
// ---------------------------------------------------------------------------

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM autotrade_paper_positions WHERE symbol LIKE 'ZPP%'"));

function input(overrides: Partial<OpenPaperPositionInput> = {}): OpenPaperPositionInput {
  return {
    symbol: 'ZPPAA',
    side: 'buy',
    quantity: 100,
    entryPrice: 50,
    stopPrice: 45, // $5 of risk/share -> riskAmount 500
    targetPrice: 60,
    riskAmount: 500,
    riskProfile: 'MODERATE',
    rationale: 'test fixture',
    ...overrides,
  };
}

describe('partialClosePaperPosition banks the closed slice', () => {
  it('records the slice P&L on the row instead of losing it', () => {
    const pos = openPaperPosition(input());
    // 40 shares out at 55 = 40 * $5 = $200 banked.
    const after = partialClosePaperPosition(pos.id, { quantity: 40, exitPrice: 55 });
    expect(after).not.toBeNull();
    expect(after!.quantity).toBe(60);
    expect(after!.realizedPartialPnl).toBeCloseTo(200, 6);
    expect(after!.partialExitTaken).toBe(true);
  });

  it('signs a short scale-out the other way', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPBB', side: 'sell', entryPrice: 50, stopPrice: 55 }));
    // Short from 50, covering 40 at 45 is a $200 GAIN.
    const after = partialClosePaperPosition(pos.id, { quantity: 40, exitPrice: 45 });
    expect(after!.realizedPartialPnl).toBeCloseTo(200, 6);
    // ...and covering higher is a loss.
    const worse = partialClosePaperPosition(after!.id, { quantity: 10, exitPrice: 52 });
    expect(worse!.realizedPartialPnl).toBeCloseTo(200 - 20, 6);
  });

  it('accumulates across more than one scale-out', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPCC' }));
    partialClosePaperPosition(pos.id, { quantity: 20, exitPrice: 55 }); // +100
    const after = partialClosePaperPosition(pos.id, { quantity: 20, exitPrice: 60 }); // +200
    expect(after!.realizedPartialPnl).toBeCloseTo(300, 6);
    expect(after!.quantity).toBe(60);
  });

  it('leaves riskAmount at the ORIGINAL full size — it is the R denominator', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPDD' }));
    const after = partialClosePaperPosition(pos.id, { quantity: 40, exitPrice: 55 });
    expect(after!.riskAmount).toBe(500);
  });

  it('banks nothing when the call is a no-op', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPEE' }));
    // Not strictly less than the current quantity — a full close belongs to
    // closePaperPosition, so this must change nothing at all.
    expect(partialClosePaperPosition(pos.id, { quantity: 100, exitPrice: 55 })).toBeNull();
    const [row] = db
      .prepare('SELECT realized_partial_pnl AS p FROM autotrade_paper_positions WHERE id = ?')
      .all(pos.id) as { p: number }[];
    expect(row.p).toBe(0);
  });
});

describe('paperRealizedPnl / paperRealizedR', () => {
  const closedAfterScaleOut = (over: Partial<OpenPaperPositionInput> = {}, exitPrice = 50): PaperPosition => {
    const pos = openPaperPosition(input({ symbol: 'ZPPFF', ...over }));
    partialClosePaperPosition(pos.id, { quantity: 67, exitPrice: 51.25 }); // 67 * 1.25 = +83.75
    return closePaperPosition(pos.id, { exitPrice, exitReason: 'stop' })!;
  };

  it('counts the banked partial, not just the final leg', () => {
    // The production shape: 67% out at +0.25R, remainder trailed to breakeven.
    const closed = closedAfterScaleOut();
    // Final leg alone is exactly zero -- which is what every reader used to see.
    expect((closed.exitPrice! - closed.entryPrice) * closed.quantity).toBe(0);
    // The trade actually made the banked slice.
    expect(paperRealizedPnl(closed)).toBeCloseTo(83.75, 6);
    expect(paperRealizedR(closed)).toBeCloseTo(83.75 / 500, 6);
  });

  it('is the plain subtraction when nothing scaled out', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPGG' }));
    const closed = closePaperPosition(pos.id, { exitPrice: 55, exitReason: 'target' })!;
    expect(paperRealizedPnl(closed)).toBeCloseTo(500, 6);
    expect(paperRealizedR(closed)).toBeCloseTo(1, 6);
  });

  it('reports only what is banked while the position is still open', () => {
    const pos = openPaperPosition(input({ symbol: 'ZPPHH' }));
    const after = partialClosePaperPosition(pos.id, { quantity: 40, exitPrice: 55 })!;
    // Nothing is realized on the remainder yet; the banked slice already is.
    expect(paperRealizedPnl(after)).toBeCloseTo(200, 6);
  });

  it('returns null R rather than Infinity on a zero risk denominator', () => {
    // An Infinity here would flow straight into an expectancy multiplier.
    const pos = openPaperPosition(input({ symbol: 'ZPPII', riskAmount: 0 }));
    const closed = closePaperPosition(pos.id, { exitPrice: 55, exitReason: 'target' })!;
    expect(paperRealizedR(closed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The consumer. This is the assertion that would have caught the defect: the
// db helper's own arithmetic was never wrong, the readers simply never saw
// what it banked.
// ---------------------------------------------------------------------------
describe('the paper snapshot reads the banked partials', () => {
  // getPaperPortfolioSnapshot aggregates the WHOLE table, so these cases need
  // it to hold only their own rows -- but tests share one SQLite file with no
  // guaranteed file order, and a bare DELETE here would silently poison any
  // file that runs after this one. That is precisely how task #34's
  // intermittent failures happened. So: save the table, empty it, and put it
  // back, leaving the shared database exactly as it was found.
  let saved: unknown[] = [];
  beforeAll(() => {
    saved = db.prepare('SELECT * FROM autotrade_paper_positions').all();
  });
  afterAll(() => {
    db.exec('DELETE FROM autotrade_paper_positions');
    if (saved.length === 0) return;
    const cols = Object.keys(saved[0] as Record<string, unknown>);
    const stmt = db.prepare(
      `INSERT INTO autotrade_paper_positions (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    );
    for (const row of saved) stmt.run(row as Record<string, unknown>);
  });

  beforeEach(() => {
    db.exec('DELETE FROM autotrade_paper_positions');
    setAutotradeConfig({
      expectancyWeightingEnabled: true,
      expectancyMinTrades: 2,
      expectancyMinMultiplier: 0.5,
      expectancyMaxMultiplier: 1.5,
    });
  });

  /** Three A-grade trades that each scale 67% out at +0.25R and then trail the
   *  remainder to exactly breakeven — the strategy's own designed win pattern.
   *  Final-leg-only reads them as three scratches; they are three winners. */
  const scaleOutThenBreakeven = (n: number) => {
    for (let i = 0; i < n; i++) {
      const pos = openPaperPosition(input({ symbol: `ZPPX${i}`, grade: 'A' }));
      partialClosePaperPosition(pos.id, { quantity: 67, exitPrice: 51.25 });
      closePaperPosition(pos.id, { exitPrice: 50, exitReason: 'stop' });
    }
  };

  it('does not read a book of scaled-out winners as flat', () => {
    scaleOutThenBreakeven(3);
    const snap = getPaperPortfolioSnapshot();
    // multiplier = 1 + avg R, clamped. Every trade banked +83.75/500 = +0.1675R,
    // so the A grade must size UP. Before the fix each read as exactly 0R and
    // the multiplier sat at a flat 1 -- the book sized down off its own
    // deleted profits.
    expect(snap.gradeExpectancyMultipliers.A).toBeGreaterThan(1);
    // round2(1 + 0.1675) = 1.17 (expectancySizing rounds to cents).
    expect(snap.gradeExpectancyMultipliers.A).toBe(1.17);
  });

  it("counts the banked slice in the day's realized P&L too", () => {
    scaleOutThenBreakeven(2);
    const snap = getPaperPortfolioSnapshot();
    expect(snap.dailyPnl).toBeCloseTo(2 * 83.75, 4);
  });
});

// ---------------------------------------------------------------------------
// The OPTIONS twin. Identical hole, found in the same audit: the short-dated
// ladder that arms this book had only just been switched on, and 0 of 13
// options paper rows had scaled out — so this one is fixed BEFORE it ever cost
// anything, rather than repaired after. There is nothing to backfill; the point
// is that the second copy of a defect gets fixed with the first.
// ---------------------------------------------------------------------------
describe('partialCloseOptionsPaperPosition banks the closed slice too', () => {
  const optInput = (over: Partial<OpenOptionsPaperPositionInput> = {}): OpenOptionsPaperPositionInput => ({
    symbol: 'ZOPAA',
    side: 'call',
    contractSymbol: 'ZOPAA260101C00050000',
    strike: 50,
    expiration: '2026-01-01',
    quantity: 10,
    entryPrice: 2,
    riskAmount: 1_000,
    riskProfile: 'MODERATE',
    rationale: 'test fixture',
    ...over,
  });

  beforeEach(() => db.exec("DELETE FROM autotrade_options_paper_positions WHERE symbol LIKE 'ZOP%'"));

  it('banks a single-leg slice at contracts x 100', () => {
    const pos = openOptionsPaperPosition(optInput());
    // 4 contracts out at 3.00 against a 2.00 entry = 4 * 1.00 * 100 = $400.
    const after = partialCloseOptionsPaperPosition(pos.id, { quantity: 4, exitPrice: 3 });
    expect(after!.quantity).toBe(6);
    expect(after!.realizedPartialPnl).toBeCloseTo(400, 6);
  });

  it('nets both legs of a debit spread, matching optionsPnl', () => {
    const pos = openOptionsPaperPosition(
      optInput({
        symbol: 'ZOPBB',
        kind: 'debit_spread',
        entryPrice: 3,
        shortEntryPrice: 1, // net debit 2.00
        shortContractSymbol: 'ZOPBB260101C00055000',
        shortStrike: 55,
      }),
    );
    // Out at net credit 3.50 on 4 spreads: (3.5 - 2.0) * 4 * 100 = $600.
    const after = partialCloseOptionsPaperPosition(pos.id, { quantity: 4, exitPrice: 4.25, shortExitPrice: 0.75 });
    expect(after!.realizedPartialPnl).toBeCloseTo(600, 6);
  });

  it('accumulates, and leaves riskAmount alone', () => {
    const pos = openOptionsPaperPosition(optInput({ symbol: 'ZOPCC' }));
    partialCloseOptionsPaperPosition(pos.id, { quantity: 2, exitPrice: 3 }); // +200
    const after = partialCloseOptionsPaperPosition(pos.id, { quantity: 2, exitPrice: 4 })!; // +400
    expect(after.realizedPartialPnl).toBeCloseTo(600, 6);
    expect(after.riskAmount).toBe(1_000);
  });

  it('the realized reader adds the banked slice to the final leg', () => {
    const pos = openOptionsPaperPosition(optInput({ symbol: 'ZOPDD' }));
    partialCloseOptionsPaperPosition(pos.id, { quantity: 6, exitPrice: 3 }); // +600 banked
    const closed = closeOptionsPaperPosition(pos.id, { exitPrice: 2, exitReason: 'stop_loss' })!;
    // Remainder exits at the entry premium, so the final leg alone is $0 --
    // exactly the scratch-instead-of-winner shape the equity book suffered.
    expect(closed.exitPrice! - closed.entryPrice).toBe(0);
    expect(optionsPaperRealizedPnl(closed)).toBeCloseTo(600, 6);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { addExit, createPosition, correctExitPrice, getPosition } from '../src/db/positions';
import type { WebullOrderLeg } from '../src/providers/webull/orders';
import { RecordedExit, correctionNote, decideExitCorrection } from '../src/services/exitPriceBackfill';

// A recorded exit the position sync booked at an estimated quote.
const exit = (over: Partial<RecordedExit> = {}): RecordedExit => ({
  exitId: 1,
  positionId: 1,
  symbol: 'AAPL',
  quantity: 10,
  exitPrice: 95,
  exitDate: '2026-03-20',
  ...over,
});

/** The entry leg — the order we asked about, so never an exit leg. */
const entryLeg = (over: Partial<WebullOrderLeg> = {}): WebullOrderLeg => ({
  clientOrderId: 'CID-ENTRY',
  isRequested: true,
  comboType: 'MASTER',
  status: 'FILLED',
  filledQty: 10,
  filledPrice: 100,
  ...over,
});

const exitLeg = (over: Partial<WebullOrderLeg> = {}): WebullOrderLeg => ({
  clientOrderId: 'CID-STOP',
  isRequested: false,
  comboType: 'STOP_LOSS',
  status: 'FILLED',
  filledQty: 10,
  filledPrice: 94.5,
  ...over,
});

describe('decideExitCorrection', () => {
  it('corrects an estimated price to the broker fill, and reports the P&L difference', () => {
    const d = decideExitCorrection(exit(), [entryLeg(), exitLeg({ filledPrice: 94.5 })]);
    expect(d).toEqual({ action: 'correct', realPrice: 94.5, priceDelta: -0.5, pnlDelta: -5 });
  });

  it('never mistakes the ENTRY leg for the exit', () => {
    // The entry also has a filled price. Reading it would rewrite the exit to
    // the entry price and zero out the trade's P&L entirely.
    const d = decideExitCorrection(exit(), [entryLeg({ filledPrice: 100 })]);
    expect(d).toEqual({ action: 'skip', reason: expect.stringMatching(/no filled exit leg/) });
  });

  it('leaves it alone when the combo has aged out of history', () => {
    expect(decideExitCorrection(exit(), [])).toMatchObject({ action: 'skip' });
  });

  it('refuses when two exit legs both filled — cannot say which produced this', () => {
    const d = decideExitCorrection(exit(), [
      entryLeg(),
      exitLeg({ clientOrderId: 'CID-STOP', filledPrice: 94.5 }),
      exitLeg({ clientOrderId: 'CID-TGT', comboType: 'STOP_PROFIT', filledPrice: 110 }),
    ]);
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringMatching(/ambiguous/) });
  });

  it('refuses on a quantity mismatch — right number, wrong amount', () => {
    // A partial exit, or a position closed across more than one order. Applying
    // this leg's price to a row booking a different quantity is worse than the
    // estimate it would replace.
    const d = decideExitCorrection(exit({ quantity: 10 }), [entryLeg(), exitLeg({ filledQty: 4 })]);
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringMatching(/not the same event/) });
  });

  it('refuses an unusable fill price rather than writing a zero', () => {
    for (const filledPrice of [0, -1, undefined, NaN]) {
      expect(decideExitCorrection(exit(), [entryLeg(), exitLeg({ filledPrice })])).toMatchObject({
        action: 'skip',
        reason: expect.stringMatching(/no usable fill price/),
      });
    }
  });

  it('is a no-op when the estimate already matched the fill', () => {
    expect(decideExitCorrection(exit({ exitPrice: 94.5 }), [entryLeg(), exitLeg({ filledPrice: 94.5 })])).toMatchObject(
      { action: 'skip', reason: expect.stringMatching(/already matches/) },
    );
    // Sub-cent differences are broker rounding, not a correction worth making.
    expect(
      decideExitCorrection(exit({ exitPrice: 94.5 }), [entryLeg(), exitLeg({ filledPrice: 94.502 })]),
    ).toMatchObject({ action: 'skip' });
  });

  it('identifies the exit leg without relying on the combo_type label', () => {
    // The label lives on the envelope and was absent from the leg on a real
    // account, which is the whole reason this reads client_order_id instead.
    const d = decideExitCorrection(exit(), [
      entryLeg({ comboType: undefined }),
      exitLeg({ comboType: undefined, filledPrice: 94.5 }),
    ]);
    expect(d).toMatchObject({ action: 'correct', realPrice: 94.5 });
  });

  it('is idempotent — a corrected exit reports no further change', () => {
    const legs = [entryLeg(), exitLeg({ filledPrice: 94.5 })];
    const first = decideExitCorrection(exit(), legs);
    expect(first.action).toBe('correct');
    const after = exit({ exitPrice: first.action === 'correct' ? first.realPrice : 0 });
    expect(decideExitCorrection(after, legs)).toMatchObject({ action: 'skip' });
  });
});

describe('correctExitPrice', () => {
  beforeAll(() => initDb());
  beforeEach(() => db.exec('DELETE FROM position_exits; DELETE FROM positions;'));

  it('rewrites the price and note, leaving quantity and closed status intact', () => {
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-03-01',
    });
    addExit(pos.id, { quantity: 10, exitPrice: 95, exitDate: '2026-03-20', notes: 'Auto-closed via Webull sync — …' });
    expect(getPosition(pos.id)?.status).toBe('closed');
    const exitId = getPosition(pos.id)!.exits[0].id;

    const updated = correctExitPrice(exitId, 94.5, correctionNote(95));

    expect(updated?.exits[0]).toMatchObject({ exitPrice: 94.5, quantity: 10 });
    expect(updated?.exits[0].notes).toMatch(/corrected to the broker's actual fill/);
    expect(updated?.exits[0].notes).toMatch(/was 95/);
    // Price cannot change a position's remaining size, so it stays closed.
    expect(updated?.status).toBe('closed');
    expect(updated?.remainingQuantity).toBe(0);
  });

  it('returns undefined for an unknown exit id', () => {
    expect(correctExitPrice(9999, 1, 'x')).toBeUndefined();
  });

  it('takes the corrected exit OUT of the backfill candidate set', () => {
    // The candidate query keys on the sync's note prefix, and correctionNote()
    // replaces the note wholesale — so a corrected row is not re-examined and
    // reported as "already matches", it disappears. That IS the idempotency,
    // and it is what the operator sees after --apply (the count drops), so pin
    // it here: a future note change that kept the prefix would silently make
    // the tool re-examine rows it has already fixed.
    const candidates = () =>
      db
        .prepare(
          `SELECT e.id FROM position_exits e
             JOIN positions p ON p.id = e.position_id
            WHERE e.notes LIKE 'Auto-closed via Webull sync%'`,
        )
        .all() as Array<{ id: number }>;

    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-03-01',
    });
    addExit(pos.id, { quantity: 10, exitPrice: 95, exitDate: '2026-03-20', notes: 'Auto-closed via Webull sync — …' });
    const exitId = getPosition(pos.id)!.exits[0].id;
    expect(candidates()).toHaveLength(1);

    correctExitPrice(exitId, 94.5, correctionNote(95));

    expect(candidates()).toHaveLength(0);
  });
});

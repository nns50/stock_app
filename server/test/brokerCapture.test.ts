import { describe, expect, it } from 'vitest';
import {
  classifyFillSemantics,
  extractOrders,
  pnlLikeFields,
  redact,
  summarizeOrders,
} from '../src/services/brokerCapture';

describe('redact', () => {
  it('masks identifying values but keeps the field present', () => {
    const out = redact({ account_id: '12345', total_cash_balance: 900 }, 'values') as Record<string, unknown>;
    expect(out.account_id).toBe('«redacted»');
    expect(out.total_cash_balance).toBe(900);
  });

  it('masks identifiers nested inside arrays and objects', () => {
    const out = redact({ rows: [{ accountNumber: 'X1', email: 'a@b.c', qty: 3 }] }, 'values') as {
      rows: Array<Record<string, unknown>>;
    };
    expect(out.rows[0].accountNumber).toBe('«redacted»');
    expect(out.rows[0].email).toBe('«redacted»');
    expect(out.rows[0].qty).toBe(3);
  });

  it('keeps real numbers in values mode — Q1 is answered by comparing them', () => {
    const out = redact({ total_day_profit_loss: -412.5 }, 'values') as Record<string, unknown>;
    expect(out.total_day_profit_loss).toBe(-412.5);
  });

  it('shapes-only keeps only the sign of a number, since sign carries the meaning', () => {
    const out = redact({ gain: 900, drop: -12, flat: 0, note: 'x', missing: null }, 'shapes-only') as Record<
      string,
      unknown
    >;
    expect(out.gain).toBe('<number:+>');
    expect(out.drop).toBe('<number:->');
    expect(out.flat).toBe('<number:0>');
    expect(out.note).toBe('<string>');
    expect(out.missing).toBe('<null>');
  });
});

describe('pnlLikeFields', () => {
  it('finds P&L-named leaves with their dotted paths', () => {
    const fields = pnlLikeFields({
      total_day_profit_loss: -100,
      total_market_value: 5000,
      account_currency_assets: [{ unrealized_profit_loss: 250, buying_power: 900 }],
    });
    const byName = Object.fromEntries(fields.map((f) => [f.field, f.value]));
    expect(byName.total_day_profit_loss).toBe(-100);
    expect(byName['account_currency_assets[0].unrealized_profit_loss']).toBe(250);
    // Not P&L-named — must not be swept in.
    expect(byName.total_market_value).toBeUndefined();
    expect(byName['account_currency_assets[0].buying_power']).toBeUndefined();
  });

  it('returns nothing when no field is P&L-named', () => {
    expect(pnlLikeFields({ total_cash_balance: 1, nested: { buying_power: 2 } })).toEqual([]);
  });
});

describe('extractOrders / summarizeOrders', () => {
  const envelope = {
    data: [
      {
        combo_order_id: 'C1',
        orders: [
          {
            client_order_id: 'a-1',
            status: 'PARTIAL_FILLED',
            filled_quantity: '30',
            total_quantity: '100',
            filled_price: '12.5',
            combo_type: 'MASTER',
          },
          { client_order_id: 'a-2', status: 'FILLED', filled_quantity: '100', total_quantity: '100' },
        ],
      },
    ],
  };

  it('digs order rows out of a nested combo envelope', () => {
    expect(extractOrders(envelope)).toHaveLength(2);
  });

  it('normalizes string numerics and flags the partial', () => {
    const [partial, full] = summarizeOrders(envelope);
    expect(partial).toMatchObject({
      clientOrderId: 'a-1',
      status: 'PARTIAL_FILLED',
      filledQty: 30,
      totalQty: 100,
      filledPrice: 12.5,
      comboType: 'MASTER',
      isPartial: true,
    });
    expect(full.isPartial).toBe(false);
  });

  it('detects a partial from the quantities even when the status does not say so', () => {
    // The case that matters: a broker reporting a generic status while only
    // part of the order actually filled.
    const [o] = summarizeOrders({ orders: [{ status: 'WORKING', filled_quantity: 5, total_quantity: 20 }] });
    expect(o.isPartial).toBe(true);
  });

  it('does not call a zero-filled working order partial', () => {
    const [o] = summarizeOrders({ orders: [{ status: 'WORKING', filled_quantity: 0, total_quantity: 20 }] });
    expect(o.isPartial).toBe(false);
  });

  it('ignores objects that are not order rows', () => {
    expect(extractOrders({ status: 'OK', message: 'no quantity here' })).toEqual([]);
  });
});

describe('classifyFillSemantics', () => {
  it('reads a non-decreasing series ending at total as cumulative', () => {
    const v = classifyFillSemantics([
      { filledQty: 0, totalQty: 100, status: 'WORKING' },
      { filledQty: 30, totalQty: 100, status: 'PARTIAL_FILLED' },
      { filledQty: 100, totalQty: 100, status: 'FILLED' },
    ]);
    expect(v.semantics).toBe('cumulative');
    expect(v.detail).toContain('ending exactly at total_quantity');
  });

  it('reads any decrease as per-execution — the reading that breaks delta materialization', () => {
    const v = classifyFillSemantics([
      { filledQty: 30, totalQty: 100 },
      { filledQty: 70, totalQty: 100 },
      { filledQty: 20, totalQty: 100 },
    ]);
    expect(v.semantics).toBe('per-execution');
    expect(v.detail).toContain('DECREASED');
  });

  it('stays inconclusive when the quantity never moved', () => {
    const v = classifyFillSemantics([
      { filledQty: 0, totalQty: 100 },
      { filledQty: 0, totalQty: 100 },
    ]);
    expect(v.semantics).toBe('inconclusive');
  });

  it('stays inconclusive on an empty or quantity-less watch rather than claiming cumulative', () => {
    expect(classifyFillSemantics([]).semantics).toBe('inconclusive');
    expect(classifyFillSemantics([{ status: 'WORKING' }, { status: 'WORKING' }]).semantics).toBe('inconclusive');
  });

  it('does not require the series to reach total_quantity to be cumulative', () => {
    // A partial that got cancelled — exactly the silent-shares case. Still
    // cumulative evidence, just without a terminal fill.
    const v = classifyFillSemantics([
      { filledQty: 10, totalQty: 100 },
      { filledQty: 40, totalQty: 100, status: 'CANCELLED' },
    ]);
    expect(v.semantics).toBe('cumulative');
    expect(v.detail).not.toContain('ending exactly at total_quantity');
  });
});

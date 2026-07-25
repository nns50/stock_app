import { describe, expect, it } from 'vitest';
import {
  classifyComboLegSemantics,
  classifyDayPnlSemantics,
  classifyFillSemantics,
  extractOrders,
  pnlLikeFields,
  redact,
  collectComboEvidence,
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

describe('classifyDayPnlSemantics', () => {
  // Sampled while holding a position and placing NO orders, so realized P&L is
  // pinned and anything that moves must be mark-to-market.

  it('reads the day figure moving with the mark as including unrealized', () => {
    const v = classifyDayPnlSemantics([
      { dayPnl: -120, unrealizedPnl: -120 },
      { dayPnl: -95, unrealizedPnl: -95 },
      { dayPnl: -140, unrealizedPnl: -140 },
    ]);
    expect(v.semantics).toBe('includes-unrealized');
    expect(v.detail).toMatch(/not realized-only/i);
  });

  it('reads a steady day figure against a moving mark as realized-only', () => {
    const v = classifyDayPnlSemantics([
      { dayPnl: 0, unrealizedPnl: -120 },
      { dayPnl: 0, unrealizedPnl: -95 },
    ]);
    expect(v.semantics).toBe('realized-only');
  });

  it('stays inconclusive when the mark never moved — identical samples prove nothing', () => {
    // The trap this classifier exists for: a flat mark (closed market, illiquid
    // holding) yields identical samples that LOOK like a clean realized-only
    // result while carrying no information.
    const v = classifyDayPnlSemantics([
      { dayPnl: 0, unrealizedPnl: 0 },
      { dayPnl: 0, unrealizedPnl: 0 },
    ]);
    expect(v.semantics).toBe('inconclusive');
    expect(v.detail).toMatch(/never moved/i);
  });

  it('stays inconclusive on a single sample or on missing fields', () => {
    expect(classifyDayPnlSemantics([{ dayPnl: -5, unrealizedPnl: -5 }]).semantics).toBe('inconclusive');
    expect(classifyDayPnlSemantics([]).semantics).toBe('inconclusive');
    expect(
      classifyDayPnlSemantics([
        { dayPnl: null, unrealizedPnl: null },
        { dayPnl: null, unrealizedPnl: null },
      ]).semantics,
    ).toBe('inconclusive');
  });

  it('detects movement even when only part of the series reported a number', () => {
    const v = classifyDayPnlSemantics([
      { dayPnl: -10, unrealizedPnl: -10 },
      { dayPnl: null, unrealizedPnl: null },
      { dayPnl: -30, unrealizedPnl: -30 },
    ]);
    expect(v.semantics).toBe('includes-unrealized');
  });
});

// ---------------------------------------------------------------------------
// Q3 — is combo_type echoed back per leg? The answer decides whether
// WebullOrderLeg can be relied on at all, so the classifier has to be as
// unwilling to guess as the other two.
// ---------------------------------------------------------------------------
describe('collectComboEvidence', () => {
  it('finds a NESTED combo and records each leg tag, including missing ones', () => {
    const payload = [
      {
        client_order_id: 'CID-1',
        combo_order_id: 'WB-1',
        orders: [
          { combo_type: 'MASTER', status: 'FILLED', quantity: '10' },
          { combo_type: 'STOP_LOSS', status: 'WORKING', quantity: '10' },
          { status: 'WORKING', quantity: '10' }, // untagged
        ],
      },
    ];
    const e = collectComboEvidence(payload);
    expect(e.groups).toEqual([
      {
        clientOrderId: 'CID-1',
        comboOrderId: 'WB-1',
        shape: 'nested',
        legCount: 3,
        legComboTypes: ['MASTER', 'STOP_LOSS', null],
        legStatuses: ['FILLED', 'WORKING', 'WORKING'],
      },
    ]);
    expect(e.totalOrderRows).toBe(3);
  });

  it('reads combo_type off the ENVELOPE, where this broker actually puts it', () => {
    // Reading it off the leg reported every leg of a real bracket as untagged
    // — the opposite of what the payload said, from the one tool whose job is
    // to report what the payload says.
    const payload = [
      {
        client_order_id: 'A',
        combo_type: 'MASTER',
        combo_order_id: 'WB-7',
        orders: [{ status: 'FILLED', quantity: '5' }],
      },
      {
        client_order_id: 'B',
        combo_type: 'STOP_LOSS',
        combo_order_id: 'WB-7',
        orders: [{ status: 'WORKING', quantity: '5' }],
      },
    ];
    expect(collectComboEvidence(payload).groups[0].legComboTypes).toEqual(['MASTER', 'STOP_LOSS']);
  });

  it('still reads a leg-level combo_type when that is where it is', () => {
    const payload = [
      {
        client_order_id: 'A',
        combo_order_id: 'WB-8',
        orders: [
          { combo_type: 'MASTER', status: 'FILLED', quantity: '5' },
          { combo_type: 'STOP_LOSS', status: 'WORKING', quantity: '5' },
        ],
      },
    ];
    expect(collectComboEvidence(payload).groups[0].legComboTypes).toEqual(['MASTER', 'STOP_LOSS']);
  });

  it('finds a FLAT combo — separate rows sharing one combo id', () => {
    // The shape a nested-only detector would report as "no bracket", which is
    // the same output as a genuinely empty account.
    const payload = [
      {
        client_order_id: 'A',
        combo_order_id: 'WB-9',
        orders: [{ combo_type: 'MASTER', status: 'FILLED', quantity: '5' }],
      },
      {
        client_order_id: 'B',
        combo_order_id: 'WB-9',
        orders: [{ combo_type: 'STOP_LOSS', status: 'WORKING', quantity: '5' }],
      },
    ];
    const e = collectComboEvidence(payload);
    expect(e.groups).toEqual([
      {
        comboOrderId: 'WB-9',
        shape: 'flat',
        legCount: 2,
        legComboTypes: ['MASTER', 'STOP_LOSS'],
        legStatuses: ['FILLED', 'WORKING'],
      },
    ]);
  });

  it('does not mistake ordinary single orders for a combo', () => {
    // Every order carries a combo id; only a REPEATED one means anything.
    const payload = [
      { client_order_id: 'A', combo_order_id: 'WB-1', orders: [{ status: 'FILLED', quantity: '1' }] },
      { client_order_id: 'B', combo_order_id: 'WB-2', orders: [{ status: 'FILLED', quantity: '1' }] },
    ];
    const e = collectComboEvidence(payload);
    expect(e.groups).toEqual([]);
    expect(e.totalOrderRows).toBe(2);
  });
});

describe('classifyComboLegSemantics', () => {
  const nested = (legComboTypes: Array<string | null>) => ({
    clientOrderId: 'CID',
    comboOrderId: 'WB',
    shape: 'nested' as const,
    legCount: legComboTypes.length,
    legComboTypes,
    legStatuses: legComboTypes.map(() => 'WORKING'),
  });
  const evidence = (groups: ReturnType<typeof nested>[], totalOrderRows = 9) => ({ groups, totalOrderRows });

  it('confirms echoed when a real bracket comes back fully tagged', () => {
    const v = classifyComboLegSemantics(evidence([nested(['MASTER', 'STOP_LOSS', 'STOP_PROFIT'])]));
    expect(v.semantics).toBe('echoed');
    expect(v.detail).toMatch(/MASTER/);
  });

  it('reports absent when combos come back with no leg tagged at all', () => {
    // The consequential answer: every comboType filter in the app is dead code.
    const v = classifyComboLegSemantics(evidence([nested([null, null, null])]));
    expect(v.semantics).toBe('absent');
    expect(v.detail).toMatch(/dead code/);
  });

  it('distinguishes an EMPTY account from one that simply has no brackets', () => {
    // Same verdict, different next step — which is the whole point of tracking
    // the order-row count alongside the group count.
    expect(classifyComboLegSemantics(evidence([], 0)).detail).toMatch(/no order rows at all/i);
    expect(classifyComboLegSemantics(evidence([], 12)).detail).toMatch(/12 order row\(s\) seen/);
  });

  it('flags a FLAT combo shape as its own finding, not as a missing bracket', () => {
    const v = classifyComboLegSemantics({
      groups: [
        {
          comboOrderId: 'WB-9',
          shape: 'flat',
          legCount: 3,
          legComboTypes: ['MASTER', 'STOP_LOSS', 'STOP_PROFIT'],
          legStatuses: [],
        },
      ],
      totalOrderRows: 3,
    });
    expect(v.semantics).toBe('not-nested');
    expect(v.detail).toMatch(/confirmed shape/i);
    expect(v.detail).toMatch(/handled/i);
  });

  it('refuses to let a SPREAD stand in for a bracket', () => {
    // A vertical's legs are tagged NORMAL/NORMAL — no MASTER, no exit roles —
    // so it proves the field exists but not that bracket roles come back.
    const v = classifyComboLegSemantics(evidence([nested(['NORMAL', 'NORMAL'])]));
    expect(v.semantics).toBe('inconclusive');
    expect(v.detail).toMatch(/spread/i);
  });

  it('refuses a partially-tagged bracket rather than calling it confirmed', () => {
    expect(classifyComboLegSemantics(evidence([nested(['MASTER', null])])).semantics).toBe('inconclusive');
  });
});

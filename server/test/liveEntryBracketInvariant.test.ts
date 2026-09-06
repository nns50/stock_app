import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrderRequest } from '../src/providers/webull/orders';
import type { OrderIntent } from '../src/services/trading/guardrails';

// ---------------------------------------------------------------------------
// EVERY LIVE EQUITY ENTRY GOES OUT WITH ITS STOP ATTACHED.
//
// This is the invariant the whole live book's downside rests on, and until now
// nothing asserted it — it was true because two call sites happened to be
// written that way. A third entry path added without a `bracket` would place a
// naked position, and the only thing that would notice is the unprotected-
// position ALARM, which fires after the fact and only tells a human to go and
// fix it by hand (liveExecute.ts: "Check the broker and re-arm protection by
// hand"). It has fired 6 times for real.
//
// Attaching the bracket to the ENTRY REQUEST is what makes the guarantee: the
// stop and target are legs of one OTOCO (MASTER + STOP_PROFIT + STOP_LOSS), so
// there is no window between the fill and the protection in which the position
// is naked. Placing a stop as a separate follow-up order after the fill would
// reintroduce exactly that window.
//
// Options are deliberately different and that asymmetry is worth knowing rather
// than assuming: liveOptionsExecute's header says "No bracket, ever" — every
// options exit is a closing order the loop places itself when a trigger fires.
// So an options position's only protection is the loop running and its exit
// path working, which is why the exit path being broken (the sub-$3 tick
// rejection, fixed 2026-09-06) mattered more there than the same bug would on
// the equity side.
// ---------------------------------------------------------------------------

const liveExecuteSrc = () =>
  readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'liveExecute.ts'), 'utf8');

/** Code only — the file's prose discusses brackets at length. */
const code = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('every live equity entry carries its protection', () => {
  it('each OPENING intent in liveExecute has a bracket', () => {
    const src = code(liveExecuteSrc());
    // Every `openClose: 'open'` and the window after it, up to the end of that
    // object literal. Both entry paths today (the entry batch and the scale-in
    // add) must name a bracket inside their own intent.
    const opens = [...src.matchAll(/openClose: 'open',/g)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      const window = src.slice(m.index ?? 0, (m.index ?? 0) + 900);
      expect(window, `an opening intent at offset ${m.index} has no bracket`).toMatch(/bracket:\s*\{/);
    }
  });

  it('the bracket is a leg of the entry REQUEST, not a follow-up order', () => {
    // A stop placed after the fill would leave a naked window. buildOrderRequest
    // emits the entry and both exits as one OTOCO, so the broker holds the stop
    // from the moment the entry exists.
    const req = buildOrderRequest(
      {
        symbol: 'AAPL',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 10,
        orderType: 'limit',
        limitPrice: 100,
        bracket: { takeProfitPrice: 110, stopLossPrice: 95 },
      } as OrderIntent,
      'CID',
    );
    const orders = req.new_orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(3);
    expect(orders.map((o) => o.combo_type)).toEqual(['MASTER', 'STOP_PROFIT', 'STOP_LOSS']);
    // The stop leg must actually carry a stop price — a MASTER with two empty
    // children would satisfy the shape and protect nothing.
    expect(orders[2].stop_price).toBe('95');
    expect(orders[1].limit_price).toBe('110');
  });

  it('options are the documented exception, and say so', () => {
    // Not a bug — a decision. Pinned so it stays a decision: if options ever
    // gain a bracket, this fails and someone updates the reasoning rather than
    // leaving two contradictory stories in the tree.
    const opts = readFileSync(join(__dirname, '..', 'src', 'services', 'autotrading', 'liveOptionsExecute.ts'), 'utf8');
    expect(opts).toContain('No bracket, ever');
    const optsCode = code(opts);
    const opens = [...optsCode.matchAll(/openClose: 'open',/g)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      const window = optsCode.slice(m.index ?? 0, (m.index ?? 0) + 900);
      expect(window).not.toMatch(/bracket:\s*\{/);
    }
  });
});

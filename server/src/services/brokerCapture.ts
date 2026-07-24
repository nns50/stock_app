// ---------------------------------------------------------------------------
// Pure analysis helpers behind `npm run capture:broker`
// (scripts/captureBrokerFields.ts). Kept out of the CLI so they're unit
// testable — the script itself is a thin shell that fetches, calls these, and
// prints.
//
// These answer two field-semantics questions the app currently ASSUMES answers
// to. Both assumptions are load-bearing for real money:
//
//   Q1  providers/webull/accountState.ts maps `total_day_profit_loss` to
//       AccountState.realizedPnlTodayUsd, which guardrails.ts documents as
//       realized-only and halts the trading day on.
//   Q2  services/trading/reconcile.ts's partial-fill fix materializes the
//       DELTA of `filled_quantity` on each observation, which is only correct
//       if that field is cumulative across executions.
// ---------------------------------------------------------------------------

/** Keys whose VALUES identify the account or its owner — masked so a capture
 *  can be shared without leaking whose account it is. */
const IDENTIFYING_KEY = /account_?(id|number|no)|customer|user_?(id|name)|email|phone|holder|owner|\bname\b/i;

/** `values` keeps real numbers (Q1 is answered by comparing them); `shapes-only`
 *  keeps field names and types but drops magnitudes. */
export type CaptureMode = 'values' | 'shapes-only';

export function redact(value: unknown, mode: CaptureMode, key?: string): unknown {
  if (key && IDENTIFYING_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) {
    return '«redacted»';
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, mode));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, mode, k);
    return out;
  }
  if (mode === 'shapes-only') {
    // The SIGN of a P&L field is meaningful when reading what it represents;
    // its magnitude isn't, so only the sign survives.
    if (typeof value === 'number') return value === 0 ? '<number:0>' : value > 0 ? '<number:+>' : '<number:->';
    return `<${value === null ? 'null' : typeof value}>`;
  }
  return value;
}

export interface PnlField {
  field: string;
  value: unknown;
}

/** Every P&L-named leaf field in the payload, with its dotted path — the
 *  shortlist to read Q1's answer off. */
export function pnlLikeFields(payload: unknown): PnlField[] {
  const hits: PnlField[] = [];
  const walk = (v: unknown, p: string, depth: number): void => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const full = p ? `${p}.${k}` : k;
      if (/profit|loss|pnl|realiz|unrealiz/i.test(k) && (val === null || typeof val !== 'object')) {
        hits.push({ field: full, value: val });
      }
      walk(val, full, depth + 1);
    }
  };
  walk(payload, '', 0);
  return hits;
}

/** Flatten however Webull wraps its order lists (combo envelopes, paging) into
 *  plain order rows. Lenient on purpose — the envelope shape is precisely what
 *  this capture exists to confirm. */
export function extractOrders(payload: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item) => walk(item, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    // An order row is anything carrying a status alongside a quantity field.
    if (o.status && (o.filled_quantity !== undefined || o.total_quantity !== undefined || o.quantity !== undefined)) {
      rows.push(o);
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(payload, 0);
  return rows;
}

function num(v: unknown): number | undefined {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : undefined;
}

export interface OrderSummary {
  clientOrderId?: string;
  status?: string;
  filledQty?: number;
  totalQty?: number;
  filledPrice?: number;
  comboType?: string;
  /** SOME but not all of the order filled — exactly the case reconcile.ts
   *  currently drops on the floor (it only materializes at terminal `filled`). */
  isPartial: boolean;
}

export function summarizeOrders(payload: unknown): OrderSummary[] {
  return extractOrders(payload).map((o) => {
    const filledQty = num(o.filled_quantity);
    const totalQty = num(o.total_quantity) ?? num(o.quantity);
    const status = o.status ? String(o.status).toUpperCase() : undefined;
    return {
      clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
      status,
      filledQty,
      totalQty,
      filledPrice: num(o.filled_price),
      comboType: o.combo_type ? String(o.combo_type) : undefined,
      isPartial:
        (!!status && /PARTIAL/.test(status)) ||
        (filledQty !== undefined && totalQty !== undefined && filledQty > 0 && filledQty < totalQty),
    };
  });
}

export interface FillSample {
  filledQty?: number;
  totalQty?: number;
  status?: string;
}

export type FillSemantics = 'cumulative' | 'per-execution' | 'inconclusive';

export interface FillVerdict {
  semantics: FillSemantics;
  detail: string;
}

/**
 * Read cumulative-vs-per-execution off a time series of one order's reported
 * filled quantity. A cumulative field never decreases and lands on
 * total_quantity; a per-execution field reports each partial's own size and so
 * CAN decrease (e.g. 300 then 100).
 *
 * Fails to 'inconclusive' rather than guessing: one distinct value proves
 * nothing, and a monotonic series that never reached a second value is just an
 * order that filled in one go. Only a genuine decrease is treated as positive
 * evidence AGAINST cumulative, because that's the reading that would make the
 * delta-materialization design unsafe — and this is the assumption the fix
 * rests on, so ambiguity must not read as confirmation.
 */
export function classifyFillSemantics(samples: FillSample[]): FillVerdict {
  const qtys = samples.map((s) => s.filledQty).filter((q): q is number => typeof q === 'number');
  const distinct = [...new Set(qtys)];

  if (distinct.length <= 1) {
    return {
      semantics: 'inconclusive',
      detail:
        'filled_quantity never changed across the watch — nothing to compare. Re-run against an order that fills in more than one execution (larger size, or a limit resting at the touch on a thin name).',
    };
  }

  const decreased = qtys.some((q, i) => i > 0 && q < qtys[i - 1]);
  if (decreased) {
    return {
      semantics: 'per-execution',
      detail: `filled_quantity DECREASED at least once (${distinct.join(' → ')}). The delta-based materialization design does NOT hold — reconcile must sum executions instead of differencing a running total.`,
    };
  }

  const last = samples[samples.length - 1];
  const endsAtTotal =
    typeof last?.filledQty === 'number' && typeof last?.totalQty === 'number' && last.filledQty === last.totalQty;
  return {
    semantics: 'cumulative',
    detail: `${distinct.length} distinct values, never decreasing (${distinct.join(' → ')})${
      endsAtTotal ? ', ending exactly at total_quantity' : ''
    }.`,
  };
}

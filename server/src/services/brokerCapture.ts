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

/** Enum-like STRUCTURAL fields whose values survive `shapes-only`.
 *
 *  A shapes capture exists to reveal how the broker labels things, and these
 *  labels are the answer — combo_type in particular is the whole of Q3. None of
 *  them names a person, an account or an amount: they are closed vocabularies
 *  (MASTER, LIMIT, BUY, FILLED…). Masking them made a shapes-only capture able
 *  to prove a field EXISTS while withholding the one thing that made it useful,
 *  which cost a round trip on the first real run. */
const STRUCTURAL_ENUM_KEY =
  /^(combo_type|order_type|side|status|instrument_type|time_in_force|entrust_type|support_trading_session|option_type|market)$/i;

export function redact(value: unknown, mode: CaptureMode, key?: string): unknown {
  if (key && IDENTIFYING_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) {
    return '«redacted»';
  }
  if (mode === 'shapes-only' && key && STRUCTURAL_ENUM_KEY.test(key) && typeof value === 'string') {
    return value;
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

export interface BalanceSample {
  /** `total_day_profit_loss` — what accountState.ts maps to realizedPnlTodayUsd. */
  dayPnl: number | null;
  /** `total_unrealized_profit_loss` — open-position mark-to-market. */
  unrealizedPnl: number | null;
}

export type DayPnlSemantics = 'includes-unrealized' | 'realized-only' | 'inconclusive';

export interface DayPnlVerdict {
  semantics: DayPnlSemantics;
  detail: string;
}

/**
 * Settle whether `total_day_profit_loss` includes UNREALIZED P&L, from repeated
 * balance samples taken while holding an open position and placing no orders.
 *
 * The trick is that no trading happens between samples, so realized P&L is
 * pinned. Anything that moves must therefore be mark-to-market:
 *
 *   unrealized moved AND day P&L moved  → it tracks the mark, so it is NOT
 *                                          realized-only. guardrails.ts's
 *                                          daily-loss halt is mis-specified.
 *   unrealized moved AND day P&L held   → it ignores the mark: realized-only,
 *                                          and the current mapping is correct.
 *   unrealized never moved              → no signal at all. Says nothing, and
 *                                          must not be read as either answer.
 *
 * That last case is why this exists as a classifier rather than a glance at two
 * numbers: a flat mark (a closed market, an illiquid holding) produces two
 * identical samples that look like a clean "realized-only" result while
 * actually containing no information.
 */
export function classifyDayPnlSemantics(samples: BalanceSample[]): DayPnlVerdict {
  const moved = (vals: Array<number | null>): boolean => {
    const nums = vals.filter((v): v is number => typeof v === 'number');
    return new Set(nums).size > 1;
  };

  const unrealizedMoved = moved(samples.map((s) => s.unrealizedPnl));
  const dayMoved = moved(samples.map((s) => s.dayPnl));

  if (!unrealizedMoved) {
    return {
      semantics: 'inconclusive',
      detail:
        'unrealized P&L never moved across the samples, so there was nothing for the day figure to react to. Re-run during market hours while holding a position whose mark is actually ticking — a flat mark cannot distinguish the two readings.',
    };
  }

  if (dayMoved) {
    return {
      semantics: 'includes-unrealized',
      detail:
        'unrealized P&L moved and total_day_profit_loss moved with it, with no orders placed in between — so it is NOT realized-only. This is the CONFIRMED semantics for this broker (settled by a live watch on 2026-07-28) and it is handled: the daily-loss halt no longer reads the raw figure — webullAccountState feeds it the worse of (day − unrealized) and the app’s own exits dated today (services/trading/realizedToday.ts). Seeing this verdict is normal; a raw day figure that did NOT move with the marks would be the surprise now.',
    };
  }

  return {
    semantics: 'realized-only',
    detail:
      'unrealized P&L moved while total_day_profit_loss held steady — it ignores open-position marks, so the existing mapping to realizedPnlTodayUsd is correct and the daily-loss halt is sound as written.',
  };
}

// ---------------------------------------------------------------------------
// Q3 — does the order response echo `combo_type` back PER LEG?
//
// A bracket is submitted as MASTER + STOP_PROFIT/STOP_LOSS under one
// client_combo_order_id. Reading a bracket's outcome back — which leg filled,
// whether the protective stop was even accepted — depends entirely on the
// response tagging each sub-order. WebullOrderLeg (providers/webull/orders.ts)
// documents that as UNCONFIRMED: combo_type is what we SEND per leg, and
// whether it comes BACK per leg has never been checked against a real account.
//
// That one unknown is load-bearing. It gates the "two exit legs both reported
// FILLED" ambiguity detection, and it is the reason the bracket-protection
// check has to ask the open-orders endpoint "is there a resting exit-side
// order on this symbol?" instead of the far better question "is THIS
// position's stop still there?". Confirming it either unlocks the precise
// version or proves the indirect one is the only one available.
//
// The capture already collects everything needed — extractOrders() descends
// into combo envelopes and summarizeOrders() keeps comboType — it just never
// asked. This asks.
// ---------------------------------------------------------------------------

export interface ComboEnvelopeSummary {
  clientOrderId?: string;
  comboOrderId?: string;
  /** How the legs were correlated in the response. `nested` = one envelope with
   *  a multi-entry `orders` array. `flat` = separate top-level rows sharing a
   *  combo id. Which one it is decides whether the app can read a bracket's
   *  legs AT ALL — see classifyComboLegSemantics. */
  shape: 'nested' | 'flat';
  legCount: number;
  /** Each leg's `combo_type`, in response order; null where the leg omitted it. */
  legComboTypes: Array<string | null>;
  legStatuses: Array<string | undefined>;
}

export interface ComboEvidence {
  groups: ComboEnvelopeSummary[];
  /** Every order row seen, however wrapped. Distinguishes "this account has no
   *  order history to look at" from "it has orders but none is a bracket" —
   *  which a group count alone cannot, and which need completely different
   *  next steps from the operator. */
  totalOrderRows: number;
}

/** A leg's tag and status. `combo_type` is read from the ENVELOPE first —
 *  confirmed against a real account to be where the broker puts it — falling
 *  back to the leg for a response that nests and tags per-leg instead. Reading
 *  only the leg is what made a first live run report every leg of a real
 *  bracket as untagged, which is the opposite of what the payload said. */
function legInfo(
  l: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): { comboType: string | null; status?: string } {
  const comboType = envelope?.combo_type ?? l?.combo_type;
  return {
    comboType: comboType ? String(comboType) : null,
    status: l?.status ? String(l.status).toUpperCase() : undefined,
  };
}

/**
 * Collect every way a multi-leg order might be represented, plus enough context
 * to tell an empty result apart from an absent one.
 *
 * Looks for BOTH shapes deliberately. The nested envelope is what
 * providers/webull/orders.ts assumes (its OrderEnvelope is documented as
 * confirmed — but confirmed for orders in general, where a single order nests
 * its one leg; whether a BRACKET puts all three legs in one envelope is exactly
 * what is unknown). If instead a bracket comes back as three top-level rows
 * sharing a combo_order_id, a detector that only knew the nested shape would
 * report zero — indistinguishable from "no bracket was ever placed", while
 * meaning something far more serious.
 */
export function collectComboEvidence(payload: unknown): ComboEvidence {
  const groups: ComboEnvelopeSummary[] = [];
  const envelopes: Array<Record<string, unknown>> = [];

  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((i) => walk(i, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    const legs = Array.isArray(o.orders) ? (o.orders as Array<Record<string, unknown>>) : undefined;
    if (legs) {
      envelopes.push(o);
      if (legs.length >= 2) {
        const info = legs.map((l) => legInfo(l, o));
        groups.push({
          clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
          comboOrderId: o.combo_order_id ? String(o.combo_order_id) : undefined,
          shape: 'nested',
          legCount: legs.length,
          legComboTypes: info.map((i) => i.comboType),
          legStatuses: info.map((i) => i.status),
        });
      }
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(payload, 0);

  // FLAT shape: several SINGLE-leg envelopes sharing one combo id. Only counted
  // when the id is present and repeated — a combo id on a lone order is just how
  // the broker labels every order and says nothing.
  const byCombo = new Map<string, Array<{ leg: Record<string, unknown>; env: Record<string, unknown> }>>();
  for (const env of envelopes) {
    const legs = env.orders as Array<Record<string, unknown>>;
    if (legs.length !== 1) continue;
    const id = env.combo_order_id ?? (legs[0] as Record<string, unknown>)?.combo_order_id;
    if (id === undefined || id === null || id === '') continue;
    const key = String(id);
    // The envelope travels with its leg: in this shape the tag is on the
    // envelope, so dropping it here is exactly how the tag went missing.
    (byCombo.get(key) ?? byCombo.set(key, []).get(key)!).push({ leg: legs[0], env });
  }
  for (const [comboOrderId, entries] of byCombo) {
    if (entries.length < 2) continue;
    const info = entries.map((e) => legInfo(e.leg, e.env));
    groups.push({
      comboOrderId,
      shape: 'flat',
      legCount: entries.length,
      legComboTypes: info.map((i) => i.comboType),
      legStatuses: info.map((i) => i.status),
    });
  }

  return { groups, totalOrderRows: extractOrders(payload).length };
}

export type ComboLegSemantics = 'echoed' | 'absent' | 'not-nested' | 'inconclusive';

export interface ComboLegVerdict {
  semantics: ComboLegSemantics;
  detail: string;
}

/**
 * Read per-leg combo_type support off the combo evidence actually collected.
 *
 * Fails to 'inconclusive' rather than guessing, in every direction — no order
 * history says nothing, no combo says nothing, and a SPREAD says nothing either
 * (its legs carry no MASTER/exit roles to tag). Only a real bracket settles it,
 * and the verdict names which of those it hit so the operator knows what to do
 * differently rather than just re-running the same thing.
 */
export function classifyComboLegSemantics(evidence: ComboEvidence): ComboLegVerdict {
  const { groups, totalOrderRows } = evidence;

  if (groups.length === 0) {
    return {
      semantics: 'inconclusive',
      detail:
        totalOrderRows === 0
          ? 'No order rows at all in open orders or history — there is nothing in this account for the capture to read. Place a bracketed stock entry (an entry with a stop and/or target attached) and re-run.'
          : `${totalOrderRows} order row(s) seen, none of them multi-leg — under EITHER shape (legs nested in one envelope, or separate rows sharing a combo id). So no bracket has been placed, or the ones that were have aged out of the history window. Place a bracketed stock entry, let it rest or fill, then re-run.`,
    };
  }

  const flatOnly = groups.every((g) => g.shape === 'flat');
  if (flatOnly) {
    return {
      semantics: 'not-nested',
      detail:
        `${groups.length} combo(s) came back as SEPARATE top-level rows sharing a combo id, rather than one envelope ` +
        'with a nested legs array. This is the CONFIRMED shape for this broker and it is handled: collectLegs ' +
        '(providers/webull/orders.ts) gathers a combo across its sibling envelopes, and reads combo_type from the ' +
        'envelope where this broker puts it. Reported rather than silent because it was not always handled — a bracket ' +
        'used to read as a single-leg order, which made every exit-leg branch unreachable and left stop/target fills to ' +
        'be booked later by the position sync at an estimated price. Seeing this verdict is normal; seeing the legs ' +
        'below come back «untagged» would be the surprise.',
    };
  }

  const nested = groups.filter((g) => g.shape === 'nested');
  const bracketLike = nested.find(
    (e) =>
      e.legComboTypes.every((t) => t !== null) &&
      e.legComboTypes.includes('MASTER') &&
      e.legComboTypes.some((t) => t !== null && t !== 'MASTER'),
  );
  if (bracketLike) {
    return {
      semantics: 'echoed',
      detail:
        `A ${bracketLike.legCount}-leg combo came back with every leg tagged (${bracketLike.legComboTypes.join(', ')}), ` +
        'including a MASTER and at least one distinct exit leg. Per-leg combo_type IS echoed, so WebullOrderLeg can be ' +
        'relied on: the both-legs-FILLED detection is sound, and the bracket-protection check can be tightened from ' +
        '"is any exit-side order resting on this symbol" to "is THIS position\'s stop still there".',
    };
  }

  if (nested.every((e) => e.legComboTypes.every((t) => t === null))) {
    return {
      semantics: 'absent',
      detail:
        `${nested.length} nested combo envelope(s) seen and NOT ONE leg carried combo_type. The response does not tag ` +
        'legs, so WebullOrderLeg.comboType is always undefined in practice: the both-legs-FILLED detection can never ' +
        'fire, and every bracket-exit branch that filters on comboType is dead code. The open-orders scan is the only ' +
        "way to reason about a bracket's legs.",
    };
  }

  return {
    semantics: 'inconclusive',
    detail:
      `${nested.length} nested combo envelope(s) seen, but none was an unambiguous bracket (a MASTER leg plus a ` +
      "distinct exit leg, every leg tagged). A spread's legs carry no MASTER/exit roles, so it cannot answer this. " +
      'Re-run after a bracketed stock entry.',
  };
}

import { webullClient, webullConfigured } from './account';
import { extractPositions, mapWebullPosition } from './positions';
import type { ImportablePosition } from '../../db/positions';
import type { AccountState } from '../../services/trading/guardrails';
import { realizedTodayFromBook } from '../../services/trading/realizedToday';

/** The specific instrument an order is for, so the position lookup can count the
 *  quantity of THAT instrument rather than a cross-asset per-underlying sum. */
export interface OrderInstrument {
  assetKind: 'stock' | 'option';
  strike?: number;
  expiration?: string;
  optionType?: 'call' | 'put';
}

/**
 * Whether a live broker position is the SAME instrument the order is for.
 * Webull's positions endpoint returns stock AND every option contract under one
 * `symbol`; the old code summed them all, which let a long STOCK position (or an
 * unrelated option contract) silently defeat `allowNakedShort=false` for a
 * single-leg option SELL-to-open — long stock does NOT cover a short option, and
 * a different strike/expiry is a different instrument. With no instrument
 * (legacy callers, e.g. the long-only autotrade equity path), keep the old
 * per-underlying aggregate.
 */
function matchesInstrument(pos: ImportablePosition, instrument?: OrderInstrument): boolean {
  if (!instrument) return true; // legacy: per-underlying aggregate
  if (instrument.assetKind === 'stock') return pos.assetType === 'stock';
  // Option order: a stock position never covers it.
  if (pos.assetType !== 'option') return false;
  // A single-leg option carries full contract identity — match it EXACTLY.
  if (instrument.strike !== undefined && instrument.expiration && instrument.optionType) {
    return (
      pos.strike != null &&
      Math.abs(pos.strike - instrument.strike) < 1e-6 &&
      pos.expiration === instrument.expiration &&
      pos.optionType === instrument.optionType
    );
  }
  // Multi-leg / incomplete contract details: match any option on the underlying.
  // Multi-leg orders skip naked_short/position_size in the guardrails anyway, so
  // this value isn't consulted for them — but excluding stock is still correct.
  return true;
}

// ---------------------------------------------------------------------------
// Source the guardrails' AccountState from a live Webull account — READ-ONLY.
// Buying power / market value / P&L fields come from /openapi/assets/balance,
// and the signed position in `symbol` from /openapi/assets/positions. Never
// places, cancels, or modifies an order. Realized-today is DERIVED, not read
// off a field — see the realized-P&L block in webullAccountState below.
//
// Balance shape, CAPTURED FROM THE WIRE 2026-08-27 (all values are STRINGS).
// The previous version of this comment listed a `buying_power` key on the
// asset, and the mapping below trusted it. That key does not exist. The
// `?? bal.total_cash_balance` fallback therefore fired on every single call,
// so what this file has always called "buying power" was the account's CASH
// BALANCE -- which on a margin account understates capacity by ~4x and refused
// live entries the account could comfortably fund (2026-08-27: entries blocked
// against "$1,005.46 available" while day buying power was near $4,000).
//   {
//     total_asset_currency, total_net_liquidation_value, total_market_value,
//     total_cash_balance, total_unrealized_profit_loss, total_day_profit_loss,
//     day_trades_left, maintenance_margin, open_margin_calls: [],
//     account_currency_assets: [{
//       currency, net_liquidation_value, market_value, cash_balance,
//       option_buying_power, day_buying_power, overnight_buying_power,
//       night_trading_buying_power, unrealized_profit_loss, day_profit_loss,
//     }]
//   }
// Note there is no `settled_cash` either -- settledCashUsd below is therefore
// undefined for this account, which its own doc comment already handles by
// skipping the good-faith-violation check rather than warning on a fabricated
// shortfall. Re-capture with `npm run capture:broker` rather than editing this
// from memory: reading the comment instead of the wire is what caused the bug
// above.
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** First candidate that actually PARSES to a finite number, else 0.
 *
 *  Not the same as `num(a ?? b ?? c)`, and the difference is the bug it exists
 *  for: `??` only falls through on null/undefined, but every value in this
 *  payload is a STRING, and `Number('')` is 0, not NaN. So an empty-string
 *  `buying_power` short-circuits the chain and `num` turns it into a
 *  perfectly finite $0 — no error, no fallback, buying power reads as zero.
 *
 *  That is not cosmetic any more: since the buying-power sizer landed, this
 *  number BOUNDS every live order, so a blank field would size the whole book
 *  to zero and journal it as a legitimate refusal — the same shape as the
 *  2026-08-27 incident (627 refusals, zero entries), reached through a
 *  different door. A genuine "0" still parses and is still honoured; only
 *  blank/unparseable falls through. */
function firstNum(...candidates: unknown[]): number {
  for (const c of candidates) {
    const n = numOrUndefined(c);
    if (n !== undefined) return n;
  }
  return 0;
}

/** Like num(), but undefined (not 0) when the field is missing/unparseable —
 *  a fabricated 0 would read as "no cash has settled," warning on every buy
 *  for an account this field simply wasn't reported for. */
function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  // A blank string is ABSENT, not zero. Number('') === 0 and Number('  ') === 0,
  // so without this the "missing field" case returns a confident 0 — which for
  // settledCashUsd reads as "no cash has settled" and warns on every buy, and
  // for anything routed through firstNum() would stop the fallback chain dead.
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface WebullAccountStateResult {
  ok: boolean;
  accountId: string;
  /** Guardrail account-state sourced from the live account (read-only). */
  state?: AccountState;
  /** Option buying power (cash accounts can differ from stock buying power). */
  optionBuyingPowerUsd?: number;
  /** Net liquidation value, for display. */
  netLiquidationUsd?: number;
  /** True when a symbol/instrument was requested but the positions call FAILED
   *  — so `currentPositionQty` is 0 by DEFAULT, not because the account holds
   *  nothing. A safety-critical caller (the human place/replace path) must fail
   *  CLOSED on this rather than trust a fabricated 0 (which would under-count a
   *  real holding for the position_size check). Autotrade callers that don't
   *  need it — long-only entries, or a close that supplies its own ledger
   *  quantity via an override — can ignore it. */
  positionsUnavailable?: boolean;
  /** How state.realizedPnlTodayUsd was arrived at — for the dashboard, the
   *  capture tool, and any post-mortem of a halt that surprised someone. */
  realizedToday?: {
    /** Raw `total_day_profit_loss` — confirmed 2026-07-28 to move 1:1 with
     *  open-position marks, i.e. NOT realized-only. Kept for visibility. */
    brokerDayPnlUsd: number;
    /** `total_day_profit_loss − total_unrealized_profit_loss` — the broker-side
     *  realized estimate. Absent when the payload had no unrealized field. */
    brokerDerivedUsd?: number;
    /** Sum of exits our own records date today (services/trading/realizedToday).
     *  Absent when the book couldn't be read. */
    bookRealizedUsd?: number;
  };
  raw?: unknown;
  error?: string;
}

/**
 * Pull the live guardrail AccountState (read-only). `ordersToday` is left at 0 —
 * it's counted from our own audit trail once orders actually flow, not from the
 * broker. Returns a clean error rather than throwing.
 */
export async function webullAccountState(
  accountId: string,
  symbol?: string,
  instrument?: OrderInstrument,
): Promise<WebullAccountStateResult> {
  if (!webullConfigured()) return { ok: false, accountId, error: 'Webull is not configured.' };
  const c = webullClient();

  const b = await c.call('GET', '/openapi/assets/balance', {
    query: { account_id: accountId, total_asset_currency: 'USD' },
    surface: 'trade',
  });
  if (!b.ok) {
    const j = (b.data ?? {}) as { msg?: string; message?: string; error_msg?: string };
    return {
      ok: false,
      accountId,
      raw: b.data,
      error: j.msg || j.message || j.error_msg || `Webull request failed (${b.status})`,
    };
  }

  const bal = (b.data ?? {}) as Record<string, unknown>;
  const assets = (Array.isArray(bal.account_currency_assets) ? bal.account_currency_assets : []) as Array<
    Record<string, unknown>
  >;
  // Pick the asset by CURRENCY, not by position.
  //
  // The vendor docs (reference/account-balance) list `account_id` as the sole
  // query parameter — `total_asset_currency` is a RESPONSE field, and passing
  // it below does not filter anything. `account_currency_assets` is an array
  // with a REQUIRED `currency` on each entry precisely because an account can
  // report more than one, and the docs promise no ordering. So `assets[0]`
  // was an assumption that happens to hold for a USD-only account and would
  // fail silently the moment it doesn't: every dollar figure here — buying
  // power, and the order caps derived from it — would come from the wrong
  // currency with no error to notice.
  //
  // Match the currency the response itself says it totalled in, fall back to
  // USD, then to the first entry (a one-currency account with the field
  // absent behaves exactly as before).
  const wantCurrency = String(bal.total_asset_currency ?? 'USD').toUpperCase();
  const asset = (assets.find((a) => String(a.currency ?? '').toUpperCase() === wantCurrency) ??
    assets.find((a) => String(a.currency ?? '').toUpperCase() === 'USD') ??
    assets[0] ??
    {}) as Record<string, unknown>;

  // overnight_buying_power is the honest general-purpose figure: it is what a
  // position can use WITHOUT having to be closed by the bell, which is the
  // question every caller except autotrade's intraday loop is really asking.
  // Falls back to cash only when the broker reports neither.
  const buyingPowerUsd = firstNum(asset.buying_power, asset.overnight_buying_power, bal.total_cash_balance);
  const optionBuyingPowerUsd = firstNum(asset.option_buying_power, asset.buying_power, buyingPowerUsd);
  const dayBuyingPowerUsd = numOrUndefined(asset.day_buying_power);
  const exposureUsd = num(bal.total_market_value);
  const netLiquidationUsd = num(bal.total_net_liquidation_value);
  const settledCashUsd = numOrUndefined(asset.settled_cash);

  // --- realized P&L today, for the daily-loss halt -------------------------
  // `total_day_profit_loss` is NOT realized-only: a live capture (2026-07-28,
  // capture:broker --watch-day-pnl) showed it moving 1:1 with open-position
  // marks while no orders were placed. Mapped straight to realizedPnlTodayUsd
  // (as this used to do), an open GAIN masks a real realized loss and the
  // daily-loss halt silently fails open on exactly the day it exists for.
  //
  // Two imperfect estimates, so the halt gets the WORSE of them (they cover
  // each other's blind spots — the full reasoning lives in
  // services/trading/realizedToday.ts):
  //   day − unrealized   account-wide, but leaks prior days' unrealized P&L
  //                      for positions held overnight
  //   own book           exact for exits we recorded, blind to trades placed
  //                      outside the app
  const brokerDayPnlUsd = num(bal.total_day_profit_loss);
  const unrealizedUsd = numOrUndefined(bal.total_unrealized_profit_loss);
  const brokerDerivedUsd = unrealizedUsd !== undefined ? brokerDayPnlUsd - unrealizedUsd : undefined;
  let bookRealizedUsd: number | undefined;
  try {
    bookRealizedUsd = realizedTodayFromBook(accountId).totalUsd;
  } catch (e) {
    // Book unreadable → fall back to the broker-side estimate alone rather
    // than fabricating a 0 (which would read as "nothing lost today").
    console.warn('[webull-account-state] own-book realized-today unavailable:', (e as Error).message);
  }
  const candidates = [brokerDerivedUsd, bookRealizedUsd].filter((v): v is number => v !== undefined);
  // No unrealized field AND no readable book: the raw day figure is the only
  // signal left — noisy, but better than declaring the day flat.
  const realizedPnlTodayUsd = candidates.length ? Math.min(...candidates) : brokerDayPnlUsd;

  // Signed position in the order's symbol (long +, short −), if requested.
  let currentPositionQty = 0;
  let positionsUnavailable = false;
  if (symbol) {
    const want = symbol.toUpperCase();
    const p = await c.call('GET', '/openapi/assets/positions', {
      query: { account_id: accountId },
      surface: 'trade',
    });
    if (p.ok) {
      for (const row of extractPositions(p.data)) {
        const mapped = mapWebullPosition(row, accountId);
        if (mapped && mapped.symbol === want && matchesInstrument(mapped, instrument)) {
          currentPositionQty += (mapped.side === 'short' ? -1 : 1) * mapped.quantity;
        }
      }
    } else {
      // Balance succeeded but positions didn't. Do NOT report a fabricated 0 as
      // if the account is flat — flag it so a safety-critical caller can fail
      // closed (a 0 here would under-count a real holding for position_size).
      positionsUnavailable = true;
    }
  }

  return {
    ok: true,
    accountId,
    state: {
      buyingPowerUsd,
      exposureUsd,
      realizedPnlTodayUsd,
      ordersToday: 0,
      currentPositionQty,
      settledCashUsd,
      dayBuyingPowerUsd,
    },
    optionBuyingPowerUsd,
    netLiquidationUsd,
    positionsUnavailable,
    realizedToday: { brokerDayPnlUsd, brokerDerivedUsd, bookRealizedUsd },
    raw: bal,
  };
}

/** Webull accounts from /openapi/account/list — defensive parse (the list may be
 *  bare or wrapped). Each entry carries account_id + account_type. */
function extractAccounts(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const o = (data ?? {}) as Record<string, unknown>;
  for (const k of ['accounts', 'data', 'account_list', 'list']) {
    if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  }
  return [];
}

/**
 * The Webull `account_type` (e.g. INDIVIDUAL_CASH / INDIVIDUAL_MARGIN) for an
 * account_id, from /openapi/account/list — used to gate spreads (margin only).
 * READ-ONLY. Returns undefined when it can't be determined (not configured, call
 * failed, or no match), so callers leave the broker as the final gate.
 */
export async function webullAccountType(accountId: string): Promise<string | undefined> {
  if (!webullConfigured()) return undefined;
  const r = await webullClient().call('GET', '/openapi/account/list', { surface: 'trade' });
  if (!r.ok) return undefined;
  const match = extractAccounts(r.data).find((a) => String(a.account_id) === accountId);
  return match && match.account_type != null ? String(match.account_type) : undefined;
}

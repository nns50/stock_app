import { webullClient, webullConfigured } from './account';
import { extractPositions, mapWebullPosition } from './positions';
import type { ImportablePosition } from '../../db/positions';
import type { AccountState } from '../../services/trading/guardrails';

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
// Buying power / market value / day P&L come from /openapi/assets/balance, and
// the signed position in `symbol` from /openapi/assets/positions. Never places,
// cancels, or modifies an order.
//
// Confirmed balance shape (all values are STRINGS):
//   { total_market_value, total_cash_balance, total_day_profit_loss,
//     total_net_liquidation_value, total_unrealized_profit_loss,
//     account_currency_assets: [{ buying_power, option_buying_power,
//       settled_cash, cash_balance, market_value, day_profit_loss, … }] }
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
  const assets = Array.isArray(bal.account_currency_assets) ? bal.account_currency_assets : [];
  const asset = (assets[0] ?? {}) as Record<string, unknown>;

  const buyingPowerUsd = num(asset.buying_power ?? bal.total_cash_balance);
  const optionBuyingPowerUsd = num(asset.option_buying_power ?? asset.buying_power);
  const exposureUsd = num(bal.total_market_value);
  const realizedPnlTodayUsd = num(bal.total_day_profit_loss);
  const netLiquidationUsd = num(bal.total_net_liquidation_value);

  // Signed position in the order's symbol (long +, short −), if requested.
  let currentPositionQty = 0;
  if (symbol) {
    const want = symbol.toUpperCase();
    const p = await c.call('GET', '/openapi/assets/positions', {
      query: { account_id: accountId },
      surface: 'trade',
    });
    if (p.ok) {
      for (const row of extractPositions(p.data)) {
        const mapped = mapWebullPosition(row);
        if (mapped && mapped.symbol === want && matchesInstrument(mapped, instrument)) {
          currentPositionQty += (mapped.side === 'short' ? -1 : 1) * mapped.quantity;
        }
      }
    }
  }

  return {
    ok: true,
    accountId,
    state: { buyingPowerUsd, exposureUsd, realizedPnlTodayUsd, ordersToday: 0, currentPositionQty },
    optionBuyingPowerUsd,
    netLiquidationUsd,
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

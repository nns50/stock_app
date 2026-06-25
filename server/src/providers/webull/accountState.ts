import { webullClient, webullConfigured } from './account';
import { extractPositions, mapWebullPosition } from './positions';
import type { AccountState } from '../../services/trading/guardrails';

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
export async function webullAccountState(accountId: string, symbol?: string): Promise<WebullAccountStateResult> {
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
        if (mapped && mapped.symbol === want) {
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

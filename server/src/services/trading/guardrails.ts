// ---------------------------------------------------------------------------
// Live-trading guardrails — the safety core (see docs/LIVE_TRADING_DESIGN.md).
//
// PURE decision logic over (intent, account, config): no broker calls, no
// network, no I/O, not wired to any route yet. Given a proposed order, the
// current account state, and the configured limits, it returns a full pass/fail
// breakdown (like the entry-scan rule list) and an `ok` flag that is true only
// when no BLOCKING rule failed. Warnings surface concerns without blocking.
//
// This is the gate every order must clear before it can be confirmed. It is
// deliberately conservative: anything it can't verify (e.g. a missing reference
// price) fails closed. Nothing here places an order.
// ---------------------------------------------------------------------------

export type AssetKind = 'stock' | 'option';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OpenClose = 'open' | 'close';
export type OptionType = 'call' | 'put';

export interface OrderIntent {
  /** Underlying ticker (e.g. AAPL). */
  symbol: string;
  assetKind: AssetKind;
  side: OrderSide;
  /** Whether this opens or closes exposure — closing orders relax some checks. */
  openClose: OpenClose;
  /** Shares (stock) or contracts (option); must be a positive integer. */
  quantity: number;
  orderType: OrderType;
  /** Required for limit orders. */
  limitPrice?: number;
  /** Per-share / per-contract reference (last or mark) for notional + fat-finger. */
  referencePrice?: number;
  // Option-only descriptors:
  optionType?: OptionType;
  strike?: number;
  expiration?: string;
  /** Contract multiplier (default 100 for options). */
  multiplier?: number;
}

export interface AccountState {
  /** Cash/margin available to open new long exposure. */
  buyingPowerUsd: number;
  /** Current gross exposure across the account. */
  exposureUsd: number;
  /** Today's realized P&L; negative is a loss. */
  realizedPnlTodayUsd: number;
  /** Orders already submitted today. */
  ordersToday: number;
  /** Signed current position in THIS symbol/contract (+ long, − short), in shares/contracts. */
  currentPositionQty: number;
}

export interface TradingConfig {
  /** Master switch — when false, nothing can be placed. */
  enabled: boolean;
  /** Sticky halt — when true, nothing can be placed. */
  killSwitch: boolean;
  maxOrderUsd: number;
  /** Max absolute resulting position per symbol/contract (shares/contracts). */
  maxSymbolPositionQty: number;
  maxExposureUsd: number;
  maxOrdersPerDay: number;
  /** Realized loss (as a positive number) at which trading halts for the day. */
  maxDailyLossUsd: number;
  /** A limit price must sit within this percent of the reference price. */
  fatFingerPct: number;
  /** When false, any order that would result in a net-short position is blocked. */
  allowNakedShort: boolean;
}

export type Severity = 'block' | 'warn';

export interface GuardrailCheck {
  rule: string;
  passed: boolean;
  severity: Severity;
  detail: string;
}

export interface GuardrailReport {
  /** True only when no blocking check failed. */
  ok: boolean;
  checks: GuardrailCheck[];
}

export interface GuardrailContext {
  /** Optional market-session flag; when explicitly false, raises a (non-blocking) warning. */
  marketOpen?: boolean;
}

/**
 * Conservative placeholder limits. These are intentionally tiny and trading is
 * OFF — real values come from the operator (design §11) before anything ships.
 */
export function defaultTradingConfig(): TradingConfig {
  return {
    enabled: false,
    killSwitch: false,
    maxOrderUsd: 500,
    maxSymbolPositionQty: 100,
    maxExposureUsd: 2000,
    maxOrdersPerDay: 10,
    maxDailyLossUsd: 200,
    fatFingerPct: 20,
    allowNakedShort: false,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const usd = (n: number): string => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** Effective per-unit price: the limit for limit orders, else the reference. */
function unitPrice(intent: OrderIntent): number | undefined {
  const p = intent.orderType === 'limit' ? (intent.limitPrice ?? intent.referencePrice) : intent.referencePrice;
  return p !== undefined && Number.isFinite(p) && p > 0 ? p : undefined;
}

/** Order notional in USD (contracts × multiplier × price for options). */
function notionalUsd(intent: OrderIntent): number | undefined {
  const px = unitPrice(intent);
  if (px === undefined) return undefined;
  const mult = intent.assetKind === 'option' ? (intent.multiplier ?? 100) : 1;
  return intent.quantity * mult * px;
}

/** Signed position change this order would apply (+buy / −sell). */
function signedDelta(intent: OrderIntent): number {
  return intent.side === 'buy' ? intent.quantity : -intent.quantity;
}

/**
 * Evaluate every guardrail for a proposed order. Pure: no side effects. The
 * report lists each rule (passed or not) so the UI can show the full breakdown;
 * `ok` is false if any BLOCKING rule failed.
 */
export function evaluateGuardrails(
  intent: OrderIntent,
  account: AccountState,
  config: TradingConfig,
  context: GuardrailContext = {},
): GuardrailReport {
  const checks: GuardrailCheck[] = [];
  const block = (rule: string, passed: boolean, detail: string) =>
    checks.push({ rule, passed, severity: 'block', detail });
  const warn = (rule: string, passed: boolean, detail: string) =>
    checks.push({ rule, passed, severity: 'warn', detail });

  // --- hard sanity -------------------------------------------------------
  const qtyValid = Number.isInteger(intent.quantity) && intent.quantity > 0;
  block('quantity', qtyValid, qtyValid ? `${intent.quantity}` : 'quantity must be a positive whole number');

  const limitOk = intent.orderType !== 'limit' || (intent.limitPrice !== undefined && intent.limitPrice > 0);
  block('limit_price', limitOk, limitOk ? 'ok' : 'limit orders need a positive limit price');

  // --- armed? ------------------------------------------------------------
  block('trading_enabled', config.enabled, config.enabled ? 'enabled' : 'trading is disabled (TRADING_ENABLED=false)');
  block('kill_switch', !config.killSwitch, config.killSwitch ? 'kill switch is engaged — trading halted' : 'clear');

  // --- notional / buying power / exposure --------------------------------
  const notional = notionalUsd(intent);
  if (notional === undefined) {
    const m = 'no usable price (limit or reference) to value this order';
    block('order_notional', false, m);
    block('buying_power', false, m);
    block('account_exposure', false, m);
  } else {
    block('order_notional', notional <= config.maxOrderUsd, `${usd(notional)} vs cap ${usd(config.maxOrderUsd)}`);

    // Buying power is only consumed by buys; sells free cash.
    if (intent.side === 'buy') {
      block(
        'buying_power',
        notional <= account.buyingPowerUsd,
        `${usd(notional)} vs ${usd(account.buyingPowerUsd)} available`,
      );
    } else {
      block('buying_power', true, 'n/a (sell frees buying power)');
    }

    // Opening adds exposure; closing does not increase it.
    const exposureAfter = intent.openClose === 'open' ? account.exposureUsd + notional : account.exposureUsd;
    block(
      'account_exposure',
      exposureAfter <= config.maxExposureUsd,
      `${usd(exposureAfter)} vs cap ${usd(config.maxExposureUsd)}`,
    );
  }

  // --- position size -----------------------------------------------------
  const resultingQty = account.currentPositionQty + signedDelta(intent);
  block(
    'position_size',
    Math.abs(resultingQty) <= config.maxSymbolPositionQty,
    `resulting ${resultingQty} vs cap ±${config.maxSymbolPositionQty}`,
  );

  // --- daily risk --------------------------------------------------------
  const dailyLoss = Math.max(0, -account.realizedPnlTodayUsd);
  block(
    'daily_loss_halt',
    dailyLoss < config.maxDailyLossUsd,
    dailyLoss < config.maxDailyLossUsd
      ? `${usd(dailyLoss)} loss vs ${usd(config.maxDailyLossUsd)} limit`
      : `daily loss ${usd(dailyLoss)} hit the ${usd(config.maxDailyLossUsd)} limit — halted`,
  );
  block(
    'max_orders_per_day',
    account.ordersToday < config.maxOrdersPerDay,
    `${account.ordersToday} placed vs ${config.maxOrdersPerDay}/day`,
  );

  // --- fat-finger (limit orders only) ------------------------------------
  if (intent.orderType === 'limit' && intent.limitPrice !== undefined && intent.limitPrice > 0) {
    if (intent.referencePrice !== undefined && intent.referencePrice > 0) {
      const devPct = (Math.abs(intent.limitPrice - intent.referencePrice) / intent.referencePrice) * 100;
      block(
        'fat_finger',
        devPct <= config.fatFingerPct,
        `limit is ${devPct.toFixed(1)}% from reference (max ${config.fatFingerPct}%)`,
      );
    } else {
      warn('fat_finger', true, 'no reference price to sanity-check the limit');
    }
  }

  // --- naked short -------------------------------------------------------
  const wouldBeShort = resultingQty < 0;
  block(
    'naked_short',
    !wouldBeShort || config.allowNakedShort,
    wouldBeShort && !config.allowNakedShort ? 'order would open/extend a net-short position (blocked)' : 'ok',
  );

  // --- session (advisory) ------------------------------------------------
  if (context.marketOpen === false) {
    warn('market_hours', false, 'market appears closed — fills may be delayed or rejected');
  }

  const ok = !checks.some((c) => c.severity === 'block' && !c.passed);
  return { ok, checks };
}

/** Convenience: the blocking failures, for a terse rejection message. */
export function blockingFailures(report: GuardrailReport): GuardrailCheck[] {
  return report.checks.filter((c) => c.severity === 'block' && !c.passed);
}

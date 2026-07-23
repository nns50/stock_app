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
/** `stop_loss` = market-on-trigger; `stop_loss_limit` = limit-on-trigger (both need a stop price). */
export type OrderType = 'market' | 'limit' | 'stop_loss' | 'stop_loss_limit';
export type OpenClose = 'open' | 'close';
export type OptionType = 'call' | 'put';
/** Which trading session(s) the order is eligible for. `core` = regular hours
 *  (default); `extended` = pre/post-market; `overnight` = the overnight market. */
export type TradingSession = 'core' | 'extended' | 'overnight';
/** Single-leg, a 2-leg vertical spread, a covered call (long stock + short call),
 *  or a 4-leg iron condor. */
export type OptionStrategy = 'SINGLE' | 'VERTICAL' | 'COVERED' | 'IRON_CONDOR';

/** One leg of a multi-leg option order. The per-spread quantity comes from the
 *  order's `quantity` (spreads), so a leg only describes its contract + side. */
export interface OptionLeg {
  side: OrderSide;
  optionType: OptionType;
  strike: number;
  expiration: string;
}

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
  /** Trading session this order targets. Defaults to `core` (regular hours). */
  session?: TradingSession;
  /** Required for limit and stop-limit orders. */
  limitPrice?: number;
  /** Trigger price; required for stop_loss and stop_loss_limit orders. */
  stopPrice?: number;
  /** Per-share / per-contract reference (last or mark) for notional + fat-finger. */
  referencePrice?: number;
  // Option-only descriptors:
  optionType?: OptionType;
  strike?: number;
  expiration?: string;
  /** Contract multiplier (default 100 for options). */
  multiplier?: number;
  /**
   * Optional protective bracket on the ENTRY order (stocks): a take-profit
   * and/or stop-loss that fire as the order fills. At least one price arms it.
   */
  bracket?: { takeProfitPrice?: number; stopLossPrice?: number };
  /** Option strategy. Defaults to SINGLE; VERTICAL uses `optionLegs` (2 legs). */
  optionStrategy?: OptionStrategy;
  /** The legs of a multi-leg option order. `limitPrice` is the NET debit/credit. */
  optionLegs?: OptionLeg[];
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
  /** Broker account type (e.g. INDIVIDUAL_CASH / INDIVIDUAL_MARGIN) when known —
   *  debit/credit spreads require a margin account. Only fetched for spreads. */
  accountType?: string;
  /** Cash that has actually settled (T+1 for US equities), distinct from
   *  buyingPowerUsd — a cash account risks a Good Faith Violation buying with
   *  proceeds that haven't cleared yet. Undefined (not 0) when the broker
   *  response didn't include it, so the settled_cash check below can skip
   *  rather than warn on a fabricated shortfall. */
  settledCashUsd?: number;
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
// Cached formatter instead of calling toLocaleString(locale, options) fresh
// every time — that re-parses the options and builds a new ICU formatter on
// EVERY call. Same output (same options object shape, including the implicit
// max-3-decimals default from omitting maximumFractionDigits), reusing one
// Intl.NumberFormat via .format().
const usdFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 });
const usd = (n: number): string => `$${usdFormatter.format(round2(n))}`;

/** Effective per-unit price for valuation: limit, else stop, else reference. */
function unitPrice(intent: OrderIntent): number | undefined {
  let p: number | undefined;
  if (intent.orderType === 'limit') p = intent.limitPrice ?? intent.referencePrice;
  else if (intent.orderType === 'stop_loss_limit') p = intent.limitPrice ?? intent.stopPrice ?? intent.referencePrice;
  else if (intent.orderType === 'stop_loss') p = intent.stopPrice ?? intent.referencePrice;
  else p = intent.referencePrice; // market
  return p !== undefined && Number.isFinite(p) && p > 0 ? p : undefined;
}

/** Order notional in USD (contracts × multiplier × price for options). */
function notionalUsd(intent: OrderIntent): number | undefined {
  const px = unitPrice(intent);
  if (px === undefined) return undefined;
  const mult = intent.assetKind === 'option' ? (intent.multiplier ?? 100) : 1;
  return intent.quantity * mult * px;
}

/** Public wrapper: order notional in USD, or undefined when there's no usable price. */
export function orderNotionalUsd(intent: OrderIntent): number | undefined {
  return notionalUsd(intent);
}

/** Signed position change this order would apply (+buy / −sell). */
function signedDelta(intent: OrderIntent): number {
  return intent.side === 'buy' ? intent.quantity : -intent.quantity;
}

/**
 * Whether this order would open or extend a net-short position — the same
 * resulting-quantity math the naked_short check below uses. Exported so the
 * order builder (providers/webull/orders.ts) can submit Webull's own explicit
 * SHORT side (distinct from a plain SELL, which only closes/reduces a long)
 * when this is true, letting the broker's real-time locate/borrow check run
 * at order time instead of silently mismarking the order.
 */
export function wouldOpenShort(intent: OrderIntent, account: AccountState): boolean {
  return account.currentPositionQty + signedDelta(intent) < 0;
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

  // A vertical is a single defined-risk spread: its `limitPrice` is the NET
  // debit/credit and the single-leg position/naked-short rules don't apply.
  const isVertical = intent.optionStrategy === 'VERTICAL';
  // A covered call (long stock + short call) is defined-risk like a vertical: its
  // short leg is covered, and the combo doesn't map to one signed symbol qty —
  // so it skips the single-leg naked-short / position-size rules too.
  const isCovered = intent.optionStrategy === 'COVERED';
  const isIronCondor = intent.optionStrategy === 'IRON_CONDOR';
  const isMultiLeg = isVertical || isCovered || isIronCondor;

  // --- hard sanity -------------------------------------------------------
  const qtyValid = Number.isInteger(intent.quantity) && intent.quantity > 0;
  block('quantity', qtyValid, qtyValid ? `${intent.quantity}` : 'quantity must be a positive whole number');

  // Limit and stop-limit orders need a positive limit price.
  const needsLimit = intent.orderType === 'limit' || intent.orderType === 'stop_loss_limit';
  const limitOk = !needsLimit || (intent.limitPrice !== undefined && intent.limitPrice > 0);
  block('limit_price', limitOk, limitOk ? 'ok' : 'limit/stop-limit orders need a positive limit price');

  // Stop and stop-limit orders need a positive trigger (stop) price.
  const isStop = intent.orderType === 'stop_loss' || intent.orderType === 'stop_loss_limit';
  if (isStop) {
    const stopOk = intent.stopPrice !== undefined && intent.stopPrice > 0;
    block('stop_price', stopOk, stopOk ? `stop ${usd(intent.stopPrice!)}` : 'stop orders need a positive stop price');
  }

  // Outside regular hours, the broker only accepts LIMIT orders — a market/stop
  // order in an extended/overnight session is rejected, so block it up front.
  const session = intent.session ?? 'core';
  if (session !== 'core') {
    block(
      'session_order_type',
      intent.orderType === 'limit',
      intent.orderType === 'limit'
        ? `${session} session — limit order`
        : `${session} session needs a limit order (only limit orders trade outside regular hours)`,
    );
  }

  // Webull options support LIMIT / STOP_LOSS / STOP_LOSS_LIMIT only — no MARKET.
  if (intent.assetKind === 'option') {
    block(
      'option_order_type',
      intent.orderType !== 'market',
      intent.orderType !== 'market' ? `${intent.orderType}` : 'options have no market order (use limit or a stop type)',
    );
  }

  // --- vertical spread shape (defined-risk; the limit is the NET) ---------
  if (isVertical) {
    const legs = intent.optionLegs ?? [];
    const sameExpiry = legs.every((l) => l.expiration === legs[0]?.expiration && !!l.expiration);
    const strikes = new Set(legs.map((l) => l.strike));
    const sides = new Set(legs.map((l) => l.side));
    const ok = legs.length === 2 && sameExpiry && strikes.size === 2 && sides.size === 2;
    block(
      'spread_legs',
      ok,
      ok
        ? 'vertical: 2 legs, same expiry, distinct strikes, one buy + one sell'
        : 'a vertical needs exactly 2 legs (same expiry, distinct strikes, one buy + one sell)',
    );
  }

  // --- covered call shape (long stock + short call; defined-risk) ---------
  if (isCovered) {
    const legs = intent.optionLegs ?? [];
    const ok = legs.length === 1 && legs[0]?.side === 'sell' && legs[0]?.optionType === 'call' && !!legs[0]?.expiration;
    block(
      'covered_legs',
      ok,
      ok
        ? 'covered call: long stock + one short call'
        : 'a covered call needs exactly one SELL CALL leg (the stock side is added automatically)',
    );
  }

  // --- iron condor shape (a call spread + a put spread; defined-risk) ------
  if (isIronCondor) {
    const legs = intent.optionLegs ?? [];
    const calls = legs.filter((l) => l.optionType === 'call');
    const puts = legs.filter((l) => l.optionType === 'put');
    const sameExpiry = legs.every((l) => l.expiration === legs[0]?.expiration && !!l.expiration);
    const distinctStrikes = new Set(legs.map((l) => l.strike)).size === 4;
    const oneEach = (g: OptionLeg[]) => new Set(g.map((l) => l.side)).size === 2;
    const ok =
      legs.length === 4 &&
      calls.length === 2 &&
      puts.length === 2 &&
      sameExpiry &&
      distinctStrikes &&
      oneEach(calls) &&
      oneEach(puts);
    block(
      'iron_condor_legs',
      ok,
      ok
        ? 'iron condor: 4 legs (a call spread + a put spread), same expiry, distinct strikes'
        : 'an iron condor needs 4 legs — 2 calls + 2 puts, each one buy + one sell, same expiry, distinct strikes',
    );
  }

  // Vertical / iron-condor spreads require a margin account — Webull rejects them
  // on cash/IRA. When the type is known and isn't margin, block here so the Place
  // card never arms; unknown ⇒ leave the broker as the gate. (A covered call's
  // short leg is covered by stock, so it's allowed on cash.)
  if ((isVertical || isIronCondor) && account.accountType !== undefined) {
    const marginOk = /MARGIN/i.test(account.accountType);
    block(
      'spread_account_type',
      marginOk,
      marginOk
        ? `${account.accountType} — margin approved`
        : `${account.accountType} — spreads need an approved margin account (cash/IRA rejected)`,
    );
  }

  // --- protective bracket (stocks) ---------------------------------------
  const bracket = intent.bracket;
  if (bracket && (bracket.takeProfitPrice !== undefined || bracket.stopLossPrice !== undefined)) {
    const entry = intent.limitPrice;
    const long = intent.side === 'buy';
    let ok = true;
    let detail = 'bracket ok';
    // Brackets attach to a single-name entry: a stock, or a single-leg option.
    const bracketable =
      intent.assetKind === 'stock' ||
      (intent.assetKind === 'option' && (intent.optionStrategy ?? 'SINGLE') === 'SINGLE');
    if (!bracketable) {
      ok = false;
      detail = 'brackets are for stocks or single-leg options (not spreads)';
    } else if (intent.orderType !== 'limit' || entry === undefined || entry <= 0) {
      ok = false;
      detail = 'a bracket needs a limit entry price';
    } else if (
      bracket.takeProfitPrice !== undefined &&
      (long ? bracket.takeProfitPrice <= entry : bracket.takeProfitPrice >= entry)
    ) {
      ok = false;
      detail = `take-profit must be ${long ? 'above' : 'below'} the entry ${usd(entry)}`;
    } else if (
      bracket.stopLossPrice !== undefined &&
      (long ? bracket.stopLossPrice >= entry : bracket.stopLossPrice <= entry)
    ) {
      ok = false;
      detail = `stop-loss must be ${long ? 'below' : 'above'} the entry ${usd(entry)}`;
    }
    block('bracket_prices', ok, detail);
  }

  // --- armed? ------------------------------------------------------------
  // NB: this is the in-app, DB-backed "Trading enabled" toggle (config.enabled,
  // set from the Trade config panel) — NOT the server env var TRADING_ENABLED.
  // Both must be on to place: TRADING_ENABLED gates the deploy (config.trading
  // .placeEnabled, checked in placeOrder.ts); this gates the runtime guardrails.
  block(
    'trading_enabled',
    config.enabled,
    config.enabled ? 'enabled' : 'turn on "Trading enabled" in the Trade config panel to arm trading',
  );
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

    // Cash-account settlement (advisory). A cash account risks a Good Faith
    // Violation if a position bought with UNSETTLED funds (e.g. proceeds from
    // a sale that hasn't cleared T+1 yet) is sold again before that funding
    // trade settles. This can't be checked exactly — precise GFV detection
    // needs per-lot settlement-date tracking this app doesn't have — but a
    // buy whose notional exceeds SETTLED cash is the leading indicator: part
    // of what's paying for it hasn't cleared yet. Undefined settledCashUsd
    // (broker didn't report it) skips the check rather than warning blind.
    if (intent.side === 'buy' && account.settledCashUsd !== undefined) {
      const withinSettledCash = notional <= account.settledCashUsd;
      warn(
        'settled_cash',
        withinSettledCash,
        withinSettledCash
          ? `${usd(notional)} within settled cash ${usd(account.settledCashUsd)}`
          : `${usd(notional)} exceeds settled cash ${usd(account.settledCashUsd)} — selling this before its funding trade settles may risk a cash-account Good Faith Violation`,
      );
    }
  }

  // --- position size -----------------------------------------------------
  // A vertical's per-leg position doesn't map to one signed symbol qty, and the
  // spread is defined-risk, so skip the single-symbol size rule for it.
  const resultingQty = account.currentPositionQty + signedDelta(intent);
  if (!isMultiLeg) {
    block(
      'position_size',
      Math.abs(resultingQty) <= config.maxSymbolPositionQty,
      `resulting ${resultingQty} vs cap ±${config.maxSymbolPositionQty}`,
    );
  }

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

  // --- fat-finger --------------------------------------------------------
  // A plain LIMIT is sanity-checked against the market reference (re-derived
  // server-side in placeOrder, so it can't be omitted/spoofed by the client).
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
  // A STOP-LIMIT's limit is checked against its OWN stop, not the market: the
  // stop is deliberately away from the current price, but the limit should sit
  // just past the trigger (an absurd limit is the fat-finger risk here). This
  // order type had NO fat-finger check at all before.
  if (
    intent.orderType === 'stop_loss_limit' &&
    intent.limitPrice !== undefined &&
    intent.limitPrice > 0 &&
    intent.stopPrice !== undefined &&
    intent.stopPrice > 0
  ) {
    const devPct = (Math.abs(intent.limitPrice - intent.stopPrice) / intent.stopPrice) * 100;
    block(
      'fat_finger',
      devPct <= config.fatFingerPct,
      `stop-limit price is ${devPct.toFixed(1)}% from its stop (max ${config.fatFingerPct}%)`,
    );
  }

  // --- naked short -------------------------------------------------------
  // A vertical is defined-risk (its short leg is covered by the long leg), so
  // the single-leg naked-short rule doesn't apply.
  if (!isMultiLeg) {
    const wouldBeShort = resultingQty < 0;
    block(
      'naked_short',
      !wouldBeShort || config.allowNakedShort,
      wouldBeShort && !config.allowNakedShort ? 'order would open/extend a net-short position (blocked)' : 'ok',
    );
  }

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

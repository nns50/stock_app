// Frontend mirror of the server's response shapes (only the fields the UI uses).

export interface ProviderStatus {
  name: string;
  synthetic: boolean;
  configured: boolean;
  capabilities: { quotes: boolean; candles: boolean; options: boolean; fundamentals: boolean };
  message?: string;
}

export interface ProviderTestResult {
  provider: string;
  configured: boolean;
  synthetic: boolean;
  symbol: string;
  ok: boolean;
  checks: { name: string; ok: boolean; ms: number; detail: string }[];
}

export interface RiskSizingResult {
  maxRiskDollars: number;
  stopDistance: number;
  riskPerUnit: number;
  suggestedQuantity: number;
  positionCost: number;
  positionPctOfAccount: number;
  riskOfPosition: number;
  targetPrice: number | null;
  targetProfit: number | null;
  rewardRiskRatio: number | null;
  warnings: string[];
}

/** Defined-risk vertical spread sizing (sized by capped max loss, not a stop). */
export interface SpreadSizingResult {
  maxRiskDollars: number;
  maxLossPerSpread: number;
  maxProfitPerSpread: number;
  suggestedContracts: number;
  totalMaxLoss: number;
  totalMaxProfit: number;
  positionPctOfAccount: number;
  rewardRiskRatio: number | null;
  warnings: string[];
}

export interface Quote {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  avgVolume?: number;
  timestamp: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type IndicatorKey = 'momentum' | 'relativeVolume' | 'rsi' | 'volatility' | 'gap' | 'trend';

export interface ComponentScore {
  key: IndicatorKey;
  label: string;
  value: number | null;
  display: string;
  score: number;
  weight: number;
  contribution: number;
  note: string;
}

export interface IndicatorSnapshot {
  price: number;
  changePct: number | null;
  maShort: number | null;
  maLong: number | null;
  distShortPct: number | null;
  distLongPct: number | null;
  rsi: number | null;
  atr: number | null;
  atrPct: number | null;
  relVolume: number | null;
  avgVolume: number | null;
  volume: number | null;
  gapPct: number | null;
}

export interface SymbolScore {
  symbol: string;
  price: number;
  total: number;
  passedFilters: boolean;
  filterReasons: string[];
  components: ComponentScore[];
  indicators: IndicatorSnapshot;
}

export interface ScreenerFilters {
  minPrice?: number;
  maxPrice?: number;
  minAvgVolume?: number;
  minRelVol?: number;
  rsiMin?: number;
  rsiMax?: number;
  requireTrendAlignment?: boolean;
}

export interface ScreenerConfig {
  direction: 'long' | 'short';
  weights: Record<IndicatorKey, number>;
  maShort: number;
  maLong: number;
  rsiPeriod: number;
  atrPeriod: number;
  momentumScale: number;
  relVolTarget: number;
  rsiSweetSpot: number;
  rsiWidth: number;
  atrPctScale: number;
  gapScale: number;
  filters: ScreenerFilters;
}

export interface ScreenerResult {
  generatedAt: number;
  provider: { name: string; synthetic: boolean };
  config: ScreenerConfig;
  universeCount: number;
  scannedCount: number;
  quoteWarmup: boolean;
  results: SymbolScore[];
  filteredOut: Array<SymbolScore | { symbol: string; price: number; total: number; filterReasons: string[] }>;
  errors: { symbol: string; message: string }[];
}

export interface UniverseSymbol {
  symbol: string;
  name: string | null;
  sector: string | null;
  addedAt: number;
}

export interface Preset {
  id: number;
  name: string;
  kind: 'screener' | 'option_entry' | 'option_exit';
  config: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface OptionGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  iv?: number;
  computed?: boolean;
}

export interface OptionContract {
  symbol: string;
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  expiration: string;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  volume?: number;
  openInterest?: number;
  greeks?: OptionGreeks;
}

export interface OptionsChain {
  underlying: string;
  expiration: string;
  underlyingPrice?: number;
  calls: OptionContract[];
  puts: OptionContract[];
  atmIv?: number | null;
  synthetic?: boolean;
}

export interface OptionsIv {
  symbol: string;
  expiration: string;
  underlyingPrice: number | null;
  ivContext: IvContext;
}

export interface IvContext {
  atmIv: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  method: 'history' | 'hv-estimate' | 'insufficient';
  samples: number;
  min: number | null;
  max: number | null;
}

export interface EntryStrategyConfig {
  side: 'call' | 'put';
  deltaMin: number;
  deltaMax: number;
  maxSpreadPct: number;
  minOpenInterest: number;
  minVolume: number;
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  ivMin?: number;
  ivMax?: number;
  ivRankMin?: number;
  ivRankMax?: number;
  weights?: { spread: number; liquidity: number; deltaFit: number };
}

export interface EntryCandidate {
  contract: OptionContract;
  passed: boolean;
  score: number;
  rules: { rule: string; passed: boolean; detail: string }[];
  metrics: {
    spreadPct: number | null;
    delta: number | null;
    iv: number | null;
    dte: number;
    openInterest: number | null;
    volume: number | null;
    mark: number | null;
  };
}

export interface ExitRulesConfig {
  takeProfitPct?: number;
  stopLossPct?: number;
  timeExitDaysBeforeExpiry?: number;
  deltaMin?: number;
  deltaMax?: number;
}

export interface ExitEvaluation {
  unrealizedPct: number | null;
  dte: number;
  triggered: boolean;
  activeRule: string | null;
  triggers: { rule: string; triggered: boolean; detail: string }[];
}

export interface ExitCheckRow {
  position: {
    id: number;
    symbol: string;
    optionType: 'call' | 'put' | null;
    strike: number | null;
    expiration: string | null;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
  };
  currentMark: number | null;
  currentDelta: number | null;
  evaluation: ExitEvaluation;
}

export interface PositionExit {
  id: number;
  positionId: number;
  quantity: number;
  exitPrice: number;
  exitDate: string;
  fees: number;
  notes: string | null;
  createdAt: number;
}

export interface Position {
  id: number;
  assetType: 'stock' | 'option';
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  entryTime: string | null;
  fees: number;
  optionType: 'call' | 'put' | null;
  strike: number | null;
  expiration: string | null;
  multiplier: number;
  status: 'open' | 'closed';
  tags: string[];
  grade: string | null;
  notes: string | null;
  checklist: ChecklistItem[];
  stopPrice: number | null;
  targetPrice: number | null;
  createdAt: number;
  updatedAt: number;
  exits: PositionExit[];
  remainingQuantity: number;
}

export interface ChecklistItem {
  rule: string;
  checked: boolean;
}

export interface PositionPnl {
  positionId: number;
  currentPrice: number | null;
  costBasis: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
  totalPnl: number;
  returnPct: number | null;
  rMultiple: number | null;
  marketValue: number | null;
  remainingQuantity: number;
  closedQuantity: number;
}

export interface PositionWithPnl {
  position: Position;
  price: number | null;
  stale: boolean;
  asOf: number | null;
  pnl: PositionPnl;
}

export interface AggregatePnl {
  realized: number;
  unrealized: number;
  total: number;
  openMarketValue: number;
  openCount: number;
  closedCount: number;
}

export interface ExposureSlice {
  key: string;
  gross: number;
  pct: number;
  count: number;
}

export interface Exposure {
  gross: number;
  net: number;
  long: number;
  short: number;
  bySector: ExposureSlice[];
  largest: { symbol: string; pct: number } | null;
}

export interface JournalStats {
  totalClosed: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number | null;
  totalRealized: number;
  bestTrade: number;
  worstTrade: number;
  equityCurve: { date: string; pnl: number; cumulative: number }[];
  rollingExpectancy: { date: string; value: number }[];
  byTag: GroupStat[];
  byGrade: GroupStat[];
  byDiscipline: GroupStat[];
  byWeekday: GroupStat[];
  byHold: GroupStat[];
  byTimeOfDay: GroupStat[];
  rTrades: number;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  stdevR: number | null;
  sqn: number | null;
  rBuckets: { label: string; count: number }[];
  kelly: KellySuggestion | null;
  maxDrawdown: number;
  currentDrawdown: number;
  currentStreak: { type: 'win' | 'loss' | 'none'; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface KellySuggestion {
  fraction: number;
  payoffRatio: number;
  suggestedRiskPct: number;
  sampleSize: number;
  reliable: boolean;
}

export interface BenchmarkResult {
  symbol: string;
  startDate: string | null;
  endDate: string | null;
  benchStart: number | null;
  benchEnd: number | null;
  benchmarkReturnPct: number | null;
  totalRealized: number;
  accountSize: number | null;
  userReturnPct: number | null;
  alphaPct: number | null;
}

export interface DayStats {
  date: string;
  realizedPnl: number;
  exits: number;
  entries: number;
}

export interface TradeExcursion {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  entryDate: string;
  mfePct: number;
  maePct: number;
  mfeR: number | null;
  maeR: number | null;
  realizedR: number | null;
  capturedPct: number | null;
}

export interface ExcursionReport {
  trades: number;
  avgMfeR: number | null;
  avgMaeR: number | null;
  avgRealizedR: number | null;
  capturePct: number | null;
  rows: TradeExcursion[];
}

/** One live-traded fill's execution quality vs. the order's limit price. */
export interface SlippageRow {
  positionId: number;
  symbol: string;
  kind: 'entry' | 'exit';
  side: 'buy' | 'sell';
  date: string;
  limitPrice: number;
  fillPrice: number;
  quantity: number;
  multiplier: number;
  /** Signed $ per share/contract; positive = cost you money. */
  perUnit: number;
  totalUsd: number;
  pct: number;
}

export interface SlippageReport {
  trades: number;
  totalUsd: number;
  avgPct: number | null;
  /** Most costly fills first (by totalUsd, descending). */
  rows: SlippageRow[];
}

export interface RuinParams {
  winRate: number;
  payoffRatio: number;
  riskPct: number;
  ruinThresholdPct: number;
  trades: number;
  sims: number;
}

export interface RuinResult {
  riskOfRuinPct: number;
  medianReturnPct: number;
  p5ReturnPct: number;
  p95ReturnPct: number;
  medianMaxDrawdownPct: number;
}

export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

export interface SymbolDetail {
  symbol: string;
  timeframe: string;
  quote: Quote | null;
  candles: Candle[];
  overlays: {
    maShortPeriod: number;
    maLongPeriod: number;
    maShort: (number | null)[];
    maLong: (number | null)[];
  };
  indicators: IndicatorSnapshot | null;
  fundamentals: Record<string, unknown> | null;
  synthetic: boolean;
}

export interface EdgeBucket {
  label: string;
  picks: number;
  hitRate: number;
  avgReturnPct: number;
}

export interface EdgeReport {
  snapshots: number;
  evaluated: number;
  hitRate: number | null;
  avgReturnPct: number | null;
  byRank: EdgeBucket[];
  byDirection: EdgeBucket[];
}

export interface SnapshotSummary {
  id: number;
  createdAt: number;
  direction: 'long' | 'short';
  note: string | null;
  pickCount: number;
}

export interface PickPerformance {
  rank: number;
  symbol: string;
  score: number;
  priceAtRun: number;
  currentPrice: number | null;
  returnPct: number | null;
  win: boolean | null;
}

export interface SnapshotPerformance {
  direction: 'long' | 'short';
  picks: PickPerformance[];
  evaluated: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  hitRate: number | null;
  bestReturnPct: number | null;
  worstReturnPct: number | null;
}

export type AlertKind =
  | 'price'
  | 'change'
  | 'relvol'
  | 'rsi'
  | 'macross'
  | 'high52'
  | 'low52'
  | 'optmark'
  | 'optbid'
  | 'optask'
  | 'optdelta'
  | 'optiv';

export interface AlertPlan {
  entry?: string | null;
  exit?: string | null;
  suggestedExit?: string | null;
}

export interface Alert {
  id: number;
  symbol: string;
  assetType: 'stock' | 'option';
  kind: AlertKind;
  operator: 'above' | 'below';
  threshold: number;
  optionType: 'call' | 'put' | null;
  strike: number | null;
  expiration: string | null;
  role: 'entry' | 'exit' | null;
  plan: AlertPlan | null;
  note: string | null;
  enabled: boolean;
  triggered: boolean;
  lastValue: number | null;
  triggerMessage: string | null;
  lastTriggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Prefill payload passed via router state from the options Entry-scan to the
 * Alerts page, so a ranked contract becomes a one-click entry alert with an
 * auto-derived strategy note.
 */
export interface AlertPreset {
  symbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
  role: 'entry' | 'exit';
  kind: AlertKind;
  operator: 'above' | 'below';
  threshold?: number;
  entryPlan?: string;
}

export interface AlertSchedulerConfig {
  enabled: boolean;
  intervalSeconds: number;
}

export interface AuthStatus {
  /** Is a login required (APP_PASSWORD set server-side)? */
  required: boolean;
  /** Does this browser already have a valid session? */
  authenticated: boolean;
}

export interface WebullStatus {
  configured: boolean;
  region: string;
  hasAccessToken: boolean;
}

export interface WebullProbeResult {
  ok: boolean;
  url?: string;
  status?: number;
  code?: string;
  data?: unknown;
  error?: string;
}

/** One journal-ready position parsed from a Webull holdings payload. */
export interface WebullImportablePosition {
  assetType: 'stock' | 'option';
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  optionType?: 'call' | 'put' | null;
  strike?: number | null;
  expiration?: string | null;
}

export interface WebullPositionsPreview {
  ok: boolean;
  accountId: string;
  positions: WebullImportablePosition[];
  raw?: unknown;
  unmapped: number;
  error?: string;
}

export interface WebullImportSummary {
  ok: boolean;
  accountId: string;
  imported: number;
  skipped: number;
  unmapped: number;
  error?: string;
}

export type MoverList = 'gainers' | 'losers' | 'active' | 'unusual';
export type MoverSession = 'regular' | 'premarket' | 'afterhours';

export interface WebullMover {
  symbol: string;
  name?: string;
  price: number;
  change?: number;
  changePct?: number;
  gapPct?: number;
  volume?: number;
  relativeVolume?: number;
  marketCap?: number;
}

export interface WebullMoversResult {
  ok: boolean;
  list: MoverList;
  session: MoverSession;
  movers: WebullMover[];
  error?: string;
}

/** Live option quote (real bid/ask/size/volume/OI/greeks from OPRA via Webull). */
export interface OptionLiveQuote {
  symbol: string; // full OCC contract symbol
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  mark?: number;
  volume?: number;
  openInterest?: number;
  iv?: number; // fraction (0.147 = 14.7%)
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  changePct?: number;
  quoteTime?: number; // epoch ms
}

export interface OptionLiveQuotesResult {
  ok: boolean;
  quotes: OptionLiveQuote[];
  error?: string;
}

export interface NewsItem {
  title: string;
  publisher?: string;
  link: string;
  publishedAt?: string;
  relatedTickers?: string[];
}

export interface RatingAction {
  date?: string;
  firm: string;
  action?: string;
  fromGrade?: string;
  toGrade?: string;
}

export interface AnalystInfo {
  symbol: string;
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  recommendationKey?: string;
  numberOfAnalysts?: number;
  actions: RatingAction[];
}

export interface SymbolEvents {
  symbol: string;
  /** Next earnings date (YYYY-MM-DD), if known. */
  earningsDate?: string;
  /** True when only an estimated window is known. */
  earningsEstimated?: boolean;
  /** Ex-dividend date (YYYY-MM-DD), if known. */
  exDividendDate?: string;
}

export interface MfaStatus {
  /** Can two-factor be used (a server password is set)? */
  available: boolean;
  /** Has the user enrolled a second factor? */
  enabled: boolean;
  /** Is it actually being enforced at login (not overridden by DISABLE_MFA)? */
  enforced: boolean;
}

export interface NotificationStatus {
  /** Configured webhook destinations (Slack / Discord / generic), no URLs. */
  channels: { label: string; format: 'json' | 'slack' | 'discord' }[];
  configured: boolean;
  scheduler: AlertSchedulerConfig;
}

export interface NotificationTestResult {
  delivered: boolean;
  count: number;
  results: { label: string; delivered: boolean; error?: string }[];
}

export interface PositionExitAlert {
  positionId: number;
  symbol: string;
  rule: string;
  unrealizedPct: number | null;
  message: string;
}

export interface StrategyLeg {
  type: 'call' | 'put';
  action: 'buy' | 'sell';
  strike: number;
  quantity: number;
  premium: number;
  iv?: number;
}

export interface StrategyAnalysis {
  netPremium: number;
  maxProfit: number | null;
  maxLoss: number | null;
  unboundedProfit: boolean;
  unboundedLoss: boolean;
  breakevens: number[];
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  payoff: { price: number; pnl: number }[];
  probabilityOfProfit: number | null;
}

// --- live trading (dry-run safety surface) ---
export interface TradingConfig {
  enabled: boolean;
  killSwitch: boolean;
  maxOrderUsd: number;
  maxSymbolPositionQty: number;
  maxExposureUsd: number;
  maxOrdersPerDay: number;
  maxDailyLossUsd: number;
  fatFingerPct: number;
  allowNakedShort: boolean;
}

export interface GuardrailCheck {
  rule: string;
  passed: boolean;
  severity: 'block' | 'warn';
  detail: string;
}

export interface GuardrailReport {
  ok: boolean;
  checks: GuardrailCheck[];
}

export interface OrderIntentInput {
  symbol: string;
  assetKind: 'stock' | 'option';
  side: 'buy' | 'sell';
  openClose: 'open' | 'close';
  quantity: number;
  orderType: 'market' | 'limit' | 'stop_loss' | 'stop_loss_limit';
  /** Trading session — `core` (regular hours, default), `extended`, or `overnight`. */
  session?: 'core' | 'extended' | 'overnight';
  limitPrice?: number;
  /** Trigger price for stop / stop-limit orders. */
  stopPrice?: number;
  referencePrice?: number;
  optionType?: 'call' | 'put';
  strike?: number;
  expiration?: string;
  /** Optional protective bracket on a stock entry (take-profit / stop-loss). */
  bracket?: { takeProfitPrice?: number; stopLossPrice?: number };
  /** Option strategy (SINGLE default; VERTICAL / COVERED / IRON_CONDOR use optionLegs). */
  optionStrategy?: 'SINGLE' | 'VERTICAL' | 'COVERED' | 'IRON_CONDOR';
  /** Legs of a multi-leg option order; quantity (spreads) + net limit come from
   *  the order's `quantity`/`limitPrice`, so a leg only describes its contract. */
  optionLegs?: Array<{
    side: 'buy' | 'sell';
    optionType: 'call' | 'put';
    strike: number;
    expiration: string;
  }>;
}

export interface AccountStateInput {
  buyingPowerUsd: number;
  exposureUsd: number;
  realizedPnlTodayUsd: number;
  ordersToday: number;
  currentPositionQty: number;
}

export interface OrderIntentRecord {
  id: number;
  idempotencyKey: string;
  symbol: string;
  assetKind: 'stock' | 'option';
  side: 'buy' | 'sell';
  openClose: 'open' | 'close';
  quantity: number;
  orderType: 'market' | 'limit';
  limitPrice: number | null;
  optionType: 'call' | 'put' | null;
  strike: number | null;
  expiration: string | null;
  /** Strategy this order was placed as ('SINGLE' for a single-leg option; null for stock). */
  optionStrategy: 'SINGLE' | 'VERTICAL' | 'COVERED' | 'IRON_CONDOR' | null;
  /** True when placed as a bracket (entry + linked exits). */
  isBracket: boolean;
  state: string;
  brokerOrderId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebullOrderStatus {
  ok: boolean;
  found: boolean;
  status?: string;
  brokerOrderId?: string;
  filledQty?: number;
  totalQty?: number;
  filledPrice?: number;
  raw?: unknown;
  error?: string;
}

export interface ReconcileResult {
  ok: boolean;
  changed: boolean;
  intent?: OrderIntentRecord;
  broker?: WebullOrderStatus;
  error?: string;
}

export interface ReconcileAllResult {
  ok: boolean;
  /** How many still-working orders were checked against the broker. */
  reconciled: number;
  /** How many of those advanced to a new state. */
  changed: number;
  results: Array<{ id: number; changed: boolean; state?: string; status?: string; error?: string }>;
}

export interface CancelResult {
  ok: boolean;
  requested: boolean;
  reason: 'not_found' | 'not_open' | 'broker_rejected' | 'requested';
  intent?: OrderIntentRecord;
  broker?: { ok: boolean; raw?: unknown; error?: string };
  reconciled?: ReconcileResult;
  error?: string;
}

export interface ReplacePatch {
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
}

export interface ReplaceResult {
  ok: boolean;
  replaced: boolean;
  reason:
    | 'trading_disabled'
    | 'not_found'
    | 'not_open'
    | 'not_modifiable'
    | 'no_change'
    | 'account_error'
    | 'blocked'
    | 'broker_rejected'
    | 'replaced';
  guardrails?: GuardrailReport;
  intent?: OrderIntentRecord;
  broker?: { ok: boolean; raw?: unknown; error?: string };
  reconciled?: ReconcileResult;
  error?: string;
}

export interface DryRunResult {
  intent: OrderIntentRecord;
  guardrails: GuardrailReport;
  wouldSubmit: boolean;
  notional: number | null;
  summary: string;
}

export interface WebullAccountStateResult {
  ok: boolean;
  accountId: string;
  state?: AccountStateInput;
  optionBuyingPowerUsd?: number;
  netLiquidationUsd?: number;
  error?: string;
}

export interface WebullPreview {
  ok: boolean;
  estimate?: { costUsd?: number; commissionUsd?: number; buyingPowerAfterUsd?: number };
  raw?: unknown;
  error?: string;
}

export interface LivePreviewResult {
  ok: boolean;
  accountId: string;
  accountState?: AccountStateInput;
  guardrails?: GuardrailReport;
  notional?: number | null;
  wouldSubmit?: boolean;
  preview?: WebullPreview;
  error?: string;
}

export interface PlaceResult {
  ok: boolean;
  placed: boolean;
  reason:
    | 'trading_disabled'
    | 'unsupported'
    | 'not_confirmed'
    | 'account_error'
    | 'blocked'
    | 'broker_rejected'
    | 'placed';
  guardrails?: GuardrailReport;
  accountState?: AccountStateInput;
  intent?: OrderIntentRecord;
  broker?: { ok: boolean; orderId?: string; error?: string };
  error?: string;
}

// --- auto-trading (docs/AUTOTRADING_SPEC.md) ---

export type AutotradeRiskProfile = 'MODERATE' | 'AGGRESSIVE';

export interface AutotradeConfig {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: AutotradeRiskProfile;
  accountEquityUsd: number | null;

  // --- Phase 8: live trading ---
  liveTradingEnabled: boolean;
  liveEnabledAt: number | null;
  liveAccountId: string | null;
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
  liveFatFingerPct: number;
  liveAllowNakedShort: boolean;
  liveProbationTrades: number;
  liveProbationSizeMultiplier: number;
}

export type AutotradeExclusionSource = 'default' | 'user';

export interface AutotradeExclusion {
  symbol: string;
  reason: string | null;
  source: AutotradeExclusionSource;
  createdAt: number;
}

export interface AutotradeCandidate extends SymbolScore {
  discoverySource: 'universe' | 'movers';
}

export interface AutotradeScreenResult {
  generatedAt: number;
  candidates: AutotradeCandidate[];
  excluded: { symbol: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  discovery: { universeCount: number; moversCount: number; scannedCount: number };
}

export type AutotradeStage = 'screen' | 'decision' | 'risk_check' | 'execution' | 'config';

export interface AutotradeEvent {
  id: number;
  symbol: string | null;
  stage: AutotradeStage;
  action: string;
  detail: string | null;
  riskProfile: string | null;
  createdAt: number;
}

export type AutotradeSignalSide = 'buy' | 'sell';

export interface AutotradeSignal {
  symbol: string;
  side: AutotradeSignalSide;
  entry: number;
  stop: number;
  target: number;
  rMultiple: number;
  rationale: string;
  score: number;
}

export interface AutotradeDecisionResult {
  signals: AutotradeSignal[];
  skipped: { symbol: string; reason: string }[];
}

export interface AutotradeDecideResponse {
  screen: AutotradeScreenResult;
  decision: AutotradeDecisionResult;
}

export interface AutotradeRiskCheckRule {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface AutotradeRiskCheckResult {
  symbol: string;
  ok: boolean;
  checks: AutotradeRiskCheckRule[];
  sizing: RiskSizingResult;
  stepDownActive: boolean;
  approvedRiskAmount: number;
  approvedNotional: number;
}

// --- backtesting & walk-forward (Phase 5 — the validation gate) ---

export interface SimulatedTrade {
  symbol: string;
  side: AutotradeSignalSide;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitReason: 'stop' | 'target' | 'end_of_period';
  quantity: number;
  pnl: number;
  rMultiple: number;
}

export interface BacktestEquityPoint {
  date: string;
  equity: number;
}

export interface BacktestReport {
  trades: SimulatedTrade[];
  equityCurve: BacktestEquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  /** Symbols whose historical-bar fetch failed — every other symbol's result
   *  is still simulated normally. */
  errors: { symbol: string; message: string }[];
}

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number | null;
  totalPnl: number;
  returnPct: number;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  maxDrawdown: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface BacktestRunResponse {
  report: BacktestReport;
  stats: BacktestStats;
}

export interface WalkForwardResponse {
  inSample: BacktestRunResponse;
  outOfSample: BacktestRunResponse;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

export interface BacktestRequest {
  symbols: string[];
  from: string;
  to: string;
  riskProfile: AutotradeRiskProfile;
  startingEquity: number;
}

export interface WalkForwardRequest extends BacktestRequest {
  splitDate: string;
}

// --- Phase 6: paper execution loop ---

export type PaperExitReason = 'stop' | 'target' | 'manual';

export interface PaperPosition {
  id: number;
  symbol: string;
  side: AutotradeSignalSide;
  quantity: number;
  entryPrice: number;
  entryAt: number;
  stopPrice: number;
  targetPrice: number;
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  status: 'open' | 'closed';
  exitPrice: number | null;
  exitAt: number | null;
  exitReason: PaperExitReason | null;
  createdAt: number;
  updatedAt: number;
  /** A live quote as of the request — null for a closed position (its own
   *  exitPrice is the number that matters there) or if the quote fetch
   *  failed with nothing cached either. */
  currentPrice: number | null;
  /** True when currentPrice came from the last-known cache, not a live
   *  quote (provider rate-limited or down). */
  stale: boolean;
  /** (currentPrice - entryPrice) * quantity, sign-adjusted for side — null
   *  for a closed position (its realized P&L is computed from exitPrice
   *  instead) or when currentPrice itself is unavailable. */
  unrealizedPnl: number | null;
}

export interface LoopTickSummary {
  ranEntries: boolean;
  skippedReason?: string;
  exitsChecked: number;
  exitsClosed: number;
  liveOrdersReconciled: number;
  livePositionsClosed: number;
  candidatesScreened: number;
  candidatesPassedVolatility: number;
  signalsGenerated: number;
  entriesOpened: number;
  liveEntriesOpened: number;
}

export interface AutotradeProbationStatus {
  active: boolean;
  multiplier: number;
  tradesPlaced: number;
  tradesRemaining: number;
}

export interface AutotradeDashboard {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: AutotradeRiskProfile;
  equity: number | null;
  openPositions: PaperPosition[];
  openPositionsCount: number;
  maxConcurrentPositions: number;
  openRisk: number;
  maxAggregateOpenRisk: number;
  dailyPnl: number;
  dailyDrawdownHaltLevel: number;
  tradesToday: number;
  maxTradesPerDay: number;
  consecutiveLosses: number;
  stepDownAfterLosses: number;

  // --- Phase 8: live trading — own pool, caps shared with paper above ---
  liveTradingEnabled: boolean;
  liveAccountId: string | null;
  liveOpenPositions: Position[];
  liveOpenPositionsCount: number;
  liveOpenRisk: number;
  liveDailyPnl: number;
  liveTradesToday: number;
  liveConsecutiveLosses: number;
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
  probation: AutotradeProbationStatus;
}

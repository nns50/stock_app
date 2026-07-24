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
  /** Multi-timeframe confirmation (2026-07-16) — require price to ALSO align
   *  with the chosen direction relative to its WEEKLY moving average. */
  requireWeeklyTrendAlignment?: boolean;
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
  /** The order_intents.id whose live fill produced this position — null for
   *  a manually logged/imported trade. */
  sourceIntentId: number | null;
  /** The Webull account this lot lives in — null for a manually-logged
   *  position, or a legacy row from before this field existed. */
  accountId: string | null;
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

/** services/washSale.ts — informational only, never a trading gate. Non-null
 *  only for a closed position with a realized LOSS whose same underlying
 *  symbol was also entered within 30 days either side of when it closed. */
export interface WashSaleWarning {
  triggerPositionId: number;
  triggerEntryDate: string;
  daysApart: number;
}

export interface PositionWithPnl {
  position: Position;
  price: number | null;
  stale: boolean;
  asOf: number | null;
  pnl: PositionPnl;
  washSale: WashSaleWarning | null;
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

export interface StressScenario {
  pct: number;
  estimatedPnl: number;
}

export interface StressUnresolvedPosition {
  positionId: number;
  symbol: string;
  reason: 'no-beta' | 'no-price' | 'no-delta';
}

export interface StressResult {
  scenarios: StressScenario[];
  netDollarDeltaPerPct: number;
  unresolved: StressUnresolvedPosition[];
  resolvedCount: number;
  totalCount: number;
}

export interface CorrelationPair {
  a: string;
  b: string;
  r: number;
}

export interface PortfolioCorrelation {
  /** Uppercased underlyings, in the row/column order of `matrix`. */
  symbols: string[];
  /** symbols.length × symbols.length. matrix[i][j] = corr(symbols[i],
   *  symbols[j]); diagonal is 1; a cell is null when either symbol is
   *  unresolved or the pair has too little overlapping history. */
  matrix: (number | null)[][];
  /** Most-correlated distinct pair (highest |r|), or null when fewer than two
   *  symbols resolved. */
  topPair: CorrelationPair | null;
  /** Symbols whose daily history couldn't be fetched — never assumed
   *  uncorrelated. */
  unresolved: string[];
  lookbackDays: number;
}

export type RegimeSignal = 'risk-on' | 'neutral' | 'risk-off' | 'unknown';
export type RegimeLabel = 'risk-on' | 'neutral' | 'risk-off';

export interface RegimeComponent {
  key: 'trend200' | 'trend50' | 'breadth' | 'volatility';
  label: string;
  signal: RegimeSignal;
  detail: string;
  value: number | null;
}

export interface MarketRegime {
  proxySymbol: string;
  label: RegimeLabel;
  /** Sum of component signals (+1 risk-on, −1 risk-off, 0 otherwise). */
  score: number;
  /** How many components resolved (were not `unknown`). */
  resolvedComponents: number;
  components: RegimeComponent[];
  breadthPct: number | null;
  breadthSampleSize: number;
  marketAtrPct: number | null;
  asOf: number;
}

export type RotationBasis = 'relative-to-benchmark' | 'absolute-return';

export interface SectorRotationEntry {
  sector: string;
  medianRelStrengthPct: number;
  memberCount: number;
  sampledCount: number;
  /** Resolved member symbols — used to scope a Screener scan. */
  members: string[];
  topSymbol: { symbol: string; relStrengthPct: number } | null;
}

export interface SectorRotation {
  benchmarkSymbol: string;
  benchmarkReturnPct: number | null;
  basis: RotationBasis;
  lookbackDays: number;
  /** Sectors ranked strongest → weakest by medianRelStrengthPct. */
  sectors: SectorRotationEntry[];
  /** Sectors that had members but none resolved — never ranked 0. */
  unresolvedSectors: string[];
  asOf: number;
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

/** GET /journal/auto-tune-efficacy — did a past "Auto-tune from realized
 *  edge" risk-% adjustment actually help? before/after are full JournalStats
 *  (same shape as the Journal page's own overall stats), scoped to autotrade's
 *  own trades and split by entry date relative to `adjustedAt`. */
export interface AutoTuneRiskAdjustmentEfficacy {
  eventId: number;
  adjustedAt: number;
  from: number;
  to: number;
  kellySuggestedAtTheTime: number;
  sampleSizeAtTheTime: number;
  before: JournalStats;
  after: JournalStats;
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
  /** Gross profit ÷ gross loss within the group; null means "infinite" (wins,
   *  zero losses) — same convention as the headline profitFactor stat. */
  profitFactor: number | null;
  /** Mean R-multiple over the group's own trades that logged a stop; null
   *  when none did. */
  avgR: number | null;
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
  /** Of the unmapped rows, how many looked like an option but couldn't be
   *  fully parsed — the "why aren't my options importing" signal. */
  unmappedOptions?: number;
  /** Top-level keys of the first few unmapped rows (option-looking first), to
   *  diagnose an unrecognized payload shape without dumping the whole payload. */
  unmappedSample?: { keys: string[]; looksLikeOption: boolean }[];
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

/** Result of the full sync: reconcile working orders THIS app placed
 *  (including a bracket's stop-loss/take-profit exit leg), close positions
 *  Webull no longer shows as held, then import anything new. */
export interface WebullSyncResult {
  ok: boolean;
  accountId: string;
  ordersReconciled: number;
  ordersChanged: number;
  closed: number;
  closedSymbols: string[];
  imported: number;
  skipped: number;
  unmapped: number;
  error?: string;
}

/** One contract's side-by-side broker vs. journal quantity (positions/compare). */
export interface PositionComparisonRow {
  symbol: string;
  assetType: 'stock' | 'option';
  optionType: 'call' | 'put' | null;
  strike: number | null;
  expiration: string | null;
  brokerQty: number;
  journalQty: number;
  matches: boolean;
}

/** On-demand, read-only snapshot of every contract the broker currently
 *  shows held vs. what the journal shows open for this account — matches
 *  included, not just gaps, so a mismatch is visible immediately. */
export interface PositionComparison {
  ok: boolean;
  accountId: string;
  rows: PositionComparisonRow[];
  error?: string;
}

export interface WebullSyncConfig {
  enabled: boolean;
  intervalSeconds: number;
  /** Every Webull account the background sync reconciles each tick — list all
   *  of your real accounts (e.g. cash AND margin) so none get left un-synced. */
  accountIds: string[];
}

/** Patch shape for the scheduler config — `accountIds` is canonical; the
 *  legacy single `accountId` is still accepted server-side for back-compat. */
export type WebullSyncConfigPatch = Partial<Omit<WebullSyncConfig, 'accountIds'>> & {
  accountIds?: string[];
  accountId?: string | null;
};

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
  expectedValue: number | null;
}

export interface RollLegInput {
  optionType: 'call' | 'put';
  strike: number;
  dte: number;
  premium: number;
  iv?: number;
}

export interface RollLegOutlook {
  breakevens: number[];
  maxProfit: number | null;
  maxLoss: number | null;
  probabilityOfProfit: number | null;
  expectedValue: number | null;
  delta: number;
}

export interface RollAnalysis {
  netCost: number;
  current: RollLegOutlook;
  target: RollLegOutlook;
  breakevenShift: number | null;
  probabilityOfProfitShift: number | null;
  expectedValueShift: number | null;
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
  /** Quantity newly mirrored into Positions by this reconcile (partial fills
   *  are booked as they happen, not only once the order fully fills). */
  materialized?: number;
  /** Set when the broker's fill data couldn't be fully mirrored — e.g. it
   *  reported more filled than was ordered. Always shown to the user. */
  fillWarning?: string;
}

export interface ReconcileAllResult {
  ok: boolean;
  /** How many still-working orders were checked against the broker. */
  reconciled: number;
  /** How many of those advanced to a new state. */
  changed: number;
  results: Array<{
    id: number;
    changed: boolean;
    state?: string;
    status?: string;
    error?: string;
    materialized?: number;
    fillWarning?: string;
  }>;
  /** How many orders reported a fill the ledger couldn't fully mirror. */
  warnings: number;
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

/** POST /positions/:id/close (2026-07-16) — manually close a REAL
 *  (broker-tracked) position from the Positions page. Same shape as
 *  PlaceResult (it's a thin wrapper around placeOrder() server-side) plus
 *  whether a resting bracket had to be cancelled first. */
export interface ClosePositionResult extends PlaceResult {
  bracketCancelled?: boolean;
}

// --- auto-trading (docs/AUTOTRADING_SPEC.md) ---

export type AutotradeRiskProfile = 'MODERATE' | 'AGGRESSIVE';

export type AutotradeOptionsStrategyType = 'single_leg' | 'debit_spread' | 'auto';

/** 'long' (default): only long positions, unchanged original behavior.
 *  'short': only short positions. 'both': screens every candidate as both a
 *  long and a short and takes whichever direction actually qualifies, per
 *  symbol — can hold a long on one symbol and a short on another at once. */
export type AutotradeTradeDirectionMode = 'long' | 'short' | 'both';

export interface AutotradeConfig {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: AutotradeRiskProfile;
  accountEquityUsd: number | null;
  /** ONE combined open-position budget shared by equity + options. */
  maxConcurrentPositions: number;

  // --- Risk-check parameters — independently user-configured, no longer
  // tied to riskProfile (which is now purely a label). ---
  riskPerTradePct: number;
  maxDailyDrawdownPct: number;
  stepDownAfterLosses: number;
  stepDownSizeCutPct: number;
  maxAggregateOpenRiskPct: number;
  maxCorrelatedExposurePct: number;
  maxSectorExposurePct: number;
  maxTradesPerDay: number;
  // --- Regime-aware sizing (live + paper only; 0 disables) ---
  regimeAtrThresholdPct: number;
  regimeSizeCutPct: number;
  equityCurveDeriskEnabled: boolean;
  equityCurveLookbackDays: number;
  equityCurveDeriskCutPct: number;
  maxAdvParticipationPct: number;
  convictionGradeAMinScore: number;
  convictionGradeBMinScore: number;
  expectancyWeightingEnabled: boolean;
  expectancyMinTrades: number;
  expectancyMinMultiplier: number;
  expectancyMaxMultiplier: number;

  // --- Screening/decision thresholds ---
  tradeDirection: AutotradeTradeDirectionMode;
  minRelVol: number;
  requireWeeklyTrendAlignment: boolean;
  /** Relative-strength-vs-benchmark (2026-07-17): weight (0-100, same scale
   *  as every other screener component) given to how much a candidate has
   *  out/under-performed benchmarkSymbol over relativeStrengthLookbackDays
   *  trading days — direction-aware (a long favors outperformance, a short
   *  favors underperformance). 0 (the default) disables the component. */
  relativeStrengthWeight: number;
  /** Symbol the relativeStrength component measures out/under-performance
   *  against — e.g. 'SPY'. Only matters when relativeStrengthWeight is nonzero. */
  benchmarkSymbol: string;
  /** Trading days back for both the candidate's own and the benchmark's
   *  lookback return that relativeStrengthWeight scores. */
  relativeStrengthLookbackDays: number;
  /** News-headline sentiment (2026-07-18): weight (0-100, same scale as every
   *  other screener component) given to a simple, transparent keyword count
   *  over each candidate's recent headlines — direction-aware (a long favors
   *  net-positive headlines, a short favors net-negative ones). 0 (the
   *  default) disables the component. */
  sentimentWeight: number;
  maxTickerAtrPct: number;
  maxMarketAtrPct: number;
  stopAtrMultiple: number;
  targetRMultiple: number;
  /** Force-close a position open this many CALENDAR days without a stop/
   *  target hit. 0 disables it (hold until stop/target/manual close). */
  maxHoldDays: number;
  sessionBufferMinutes: number;
  /** Skip an equity candidate whose next known earnings date falls within
   *  this many calendar days. 0 disables it. Options entries are unaffected
   *  (IV rank already proxies for an approaching print there). */
  earningsBlackoutDays: number;
  /** Hard-block ALL new entries, paper and live, within this many hours
   *  (either side) of any date-time on the macro-events list below —
   *  market-wide, checked once per loop tick, unlike earningsBlackoutDays
   *  above. 0 (the default) disables it. No backtest equivalent. */
  macroEventBlackoutHours: number;

  // --- Trailing stop / breakeven / partial profit-taking (PAPER and
  // BACKTEST equity positions only — LIVE is untouched). All default to
  // 0/disabled. R-multiples are measured against the position's own
  // original stop distance, fixed at entry. ---------------------------------
  breakevenTriggerRMultiple: number;
  trailStartRMultiple: number;
  trailStopRMultiple: number;
  partialExitRMultiple: number;
  partialExitPct: number;
  // --- Scale into winners / pyramiding (0 disables). PAPER + BACKTEST only. ---
  addOnTriggerRMultiple: number;
  addOnSizePct: number;
  maxAddOns: number;

  // --- Correlation methodology (feeds maxCorrelatedExposurePct above) ---
  correlationLookbackDays: number;
  /** |Pearson r| at or above this counts as "correlated". 0-1, not a percentage. */
  correlationThreshold: number;
  /** Correlation-aware candidate selection (default off): re-rank so diverse
   *  high-scorers win the caps over a correlated huddle. Reorders only. */
  correlationAwareSelectionEnabled: boolean;

  // --- Regime-conditional scoring weights (default off) ---
  /** When on, the loop scores with the market regime's weight preset instead of
   *  the fixed defaults. Off = today's fixed weights. */
  regimeAdaptiveWeightsEnabled: boolean;
  /** Per-regime core screener weights (the six IndicatorKey weights).
   *  relativeStrength/sentiment stay driven by their own weight fields. */
  regimeWeightPresets: {
    riskOn: Record<IndicatorKey, number>;
    neutral: Record<IndicatorKey, number>;
    riskOff: Record<IndicatorKey, number>;
  };

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
  // --- Live scale-into-winners (nested under liveTradingEnabled) ---
  liveScaleInEnabled: boolean;
  liveMaxAddOns: number;

  // --- Task #70: live options trading (nested under liveTradingEnabled) ---
  liveOptionsEnabled: boolean;
  liveOptionsEnabledAt: number | null;
  liveOptionsMaxOrderUsd: number;
  liveOptionsMaxDailyLossUsd: number;
  liveOptionsMaxOrdersPerDay: number;
  liveOptionsFatFingerPct: number;
  liveOptionsProbationTrades: number;
  liveOptionsProbationSizeMultiplier: number;

  // --- Options strategy shape ---
  optionsStrategyType: AutotradeOptionsStrategyType;

  // --- Options entry-rule thresholds (the contract-quality screen run before
  // risk-check — delta band, spread, liquidity, DTE window, IV rank ceiling) -
  optionsDeltaMin: number;
  optionsDeltaMax: number;
  optionsMaxSpreadPct: number;
  optionsMinOpenInterest: number;
  optionsMinVolume: number;
  optionsMinDte: number;
  optionsMaxDte: number;
  optionsIvRankMax: number;

  // --- Options stop-loss / take-profit (PAPER + BACKTEST only; 0 disables) --
  optionsStopLossPct: number;
  optionsTakeProfitPct: number;

  // --- Options trailing stop / breakeven / partial profit-taking (PAPER and
  // BACKTEST only; 0 disables). Percentage-of-premium based (net debit for a
  // spread), not an R-multiple like the equity block above — an option has
  // no ATR-based stop price to measure R against. ---------------------------
  optionsBreakevenTriggerPct: number;
  optionsTrailStartPct: number;
  optionsTrailStopPct: number;
  optionsPartialExitTriggerPct: number;
  optionsPartialExitPct: number;

  // --- Movers auto-promotion ---
  autoPromoteMoversEnabled: boolean;
  autoPromoteThreshold: number;
  autoPromoteWindowDays: number;
  autoPromoteMaxSymbols: number;

  // --- Auto-tune from realized edge ---
  autoTuneEnabled: boolean;
  autoTuneMinTrades: number;
  autoTuneMaxStepPct: number;
  autoTuneSlippageExcludePct: number;
  autoTuneExitsEnabled: boolean;
  autoTuneExitMaxStep: number;
  /** Walk-forward guard (default on): only raise risk-% if the edge still holds
   *  out-of-sample. Decreases always apply. */
  autoTuneRequireOosConfirmation: boolean;
}

/** A starting-point suggestion for the live-only guardrail caps, derived from
 *  the current account equity and the already-configured maxDailyDrawdownPct/
 *  maxTradesPerDay — not an enforced value, just what the "Suggest" button
 *  offers to fill the fields below with. */
export interface SuggestedLiveCaps {
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
}

/** Which sizing assumption maps a target daily gain % to per-trade risk —
 *  mirrors server/src/services/autotrading/targetTune.ts. */
export type TuneBasis = 'expected' | 'perfectDay';
export type TuneBand = 'conservative' | 'moderate' | 'aggressive';

/** The subset of AutotradeConfig fields the "tune from target" generator
 *  writes — the risk/aggressiveness axis, contract selection, and
 *  equity-scaled dollar caps. Everything else in AutotradeConfig is left
 *  untouched by the tuner (safety gates, methodology, exit-refinement,
 *  autotune, etc.). Shape mirrors targetTune.ts's TunablePatch. */
export type TunablePatch = Pick<
  AutotradeConfig,
  | 'riskProfile'
  | 'maxConcurrentPositions'
  | 'riskPerTradePct'
  | 'maxDailyDrawdownPct'
  | 'stepDownAfterLosses'
  | 'stepDownSizeCutPct'
  | 'maxAggregateOpenRiskPct'
  | 'maxCorrelatedExposurePct'
  | 'maxSectorExposurePct'
  | 'maxTradesPerDay'
  | 'minRelVol'
  | 'maxTickerAtrPct'
  | 'maxMarketAtrPct'
  | 'targetRMultiple'
  | 'liveMaxOrderUsd'
  | 'liveMaxDailyLossUsd'
  | 'liveMaxOrdersPerDay'
  | 'liveOptionsMaxOrderUsd'
  | 'liveOptionsMaxDailyLossUsd'
  | 'liveOptionsMaxOrdersPerDay'
  | 'optionsDeltaMin'
  | 'optionsDeltaMax'
  | 'optionsMaxSpreadPct'
  | 'optionsMinDte'
  | 'optionsMaxDte'
  | 'optionsIvRankMax'
  | 'optionsStopLossPct'
  | 'optionsTakeProfitPct'
>;

export interface TargetTuneResult {
  band: TuneBand;
  basis: TuneBasis;
  targetDailyGainPct: number;
  edgeR: number;
  rawRiskPerTradePct: number;
  patch: TunablePatch;
  warnings: string[];
}

export interface EquitySyncResult {
  ok: boolean;
  accountId?: string;
  previousEquityUsd?: number | null;
  netLiquidationUsd?: number;
  buyingPowerUsd?: number;
  config?: AutotradeConfig;
  error?: string;
}

export type AutotradeExclusionSource = 'default' | 'user';

export interface AutotradeExclusion {
  symbol: string;
  reason: string | null;
  source: AutotradeExclusionSource;
  createdAt: number;
}

/** A scheduled macro event (FOMC, CPI, jobs report, ...) on the user-
 *  maintained blackout list — see AutotradeConfig.macroEventBlackoutHours. */
export interface MacroEvent {
  id: number;
  label: string;
  /** Epoch ms of the scheduled event. */
  eventAt: number;
  createdAt: number;
}

export interface AutotradeCandidate extends SymbolScore {
  discoverySource: 'universe' | 'movers';
  /** Which side this candidate qualified as — always matches the request's
   *  directionMode for 'long'/'short'; per-symbol (the direction that
   *  actually passed) for 'both'. */
  direction: 'long' | 'short';
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

export type AutotradeOptionsSignalSide = 'call' | 'put';

export interface AutotradeSingleLegOptionsSignal {
  kind: 'single_leg';
  symbol: string;
  side: AutotradeOptionsSignalSide;
  contractSymbol: string;
  strike: number;
  expiration: string;
  dte: number;
  premium: number;
  delta: number | null;
  ivRank: number;
  maxLossPerContract: number;
  rationale: string;
  score: number;
}

/** A long leg + a further out-of-the-money short leg — caps both max loss
 *  AND max gain (docs/AUTOTRADING_SPEC.md's phase 9/10 debit-spread
 *  follow-up). Opt-in via AutotradeConfig.optionsStrategyType. */
export interface AutotradeDebitSpreadOptionsSignal {
  kind: 'debit_spread';
  symbol: string;
  side: AutotradeOptionsSignalSide;
  expiration: string;
  dte: number;
  ivRank: number;
  longContractSymbol: string;
  longStrike: number;
  longPremium: number;
  longDelta: number | null;
  shortContractSymbol: string;
  shortStrike: number;
  shortPremium: number;
  shortDelta: number | null;
  width: number;
  netDebit: number;
  maxLossPerContract: number;
  maxProfitPerContract: number;
  rationale: string;
  score: number;
}

export type AutotradeOptionsSignal = AutotradeSingleLegOptionsSignal | AutotradeDebitSpreadOptionsSignal;

export interface AutotradeOptionsDecisionResult {
  signals: AutotradeOptionsSignal[];
  skipped: { symbol: string; reason: string }[];
}

export interface AutotradeDecideResponse {
  screen: AutotradeScreenResult;
  decision: AutotradeDecisionResult;
  optionsDecision: AutotradeOptionsDecisionResult;
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

/** Same shape as AutotradeRiskCheckResult, except sizing can ALSO be a
 *  SpreadSizingResult when the checked signal was a debit spread — kept
 *  separate so the equity-only AutotradeRiskCheckResult above never needs
 *  narrowing. */
export interface AutotradeOptionsRiskCheckResult {
  symbol: string;
  ok: boolean;
  checks: AutotradeRiskCheckRule[];
  sizing: RiskSizingResult | SpreadSizingResult;
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

/** Bootstrap CI + sign-flip permutation p-value on a trade list's expectancy
 *  (services/autotrading/significance.ts) — only computed for a walk-forward
 *  window (see WalkForwardWindowResult below), not a plain single-window
 *  backtest run. All-null/not-reliable, never a fabricated number, when
 *  sampleSize is 0. */
export interface SignificanceStats {
  sampleSize: number;
  expectancy: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  resamples: number;
  reliable: boolean;
}

export interface WalkForwardWindowResult extends BacktestRunResponse {
  significance: SignificanceStats;
}

export interface WalkForwardResponse {
  inSample: WalkForwardWindowResult;
  outOfSample: WalkForwardWindowResult;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

/** Optional overrides for the seven risk-check parameters — when omitted, a
 *  backtest falls back field-by-field to riskProfile's OLD MODERATE/AGGRESSIVE
 *  preset bundle (a backtest's riskProfile is a self-contained hypothesis, not
 *  an ongoing account setting, so it's kept implying this bundle unless
 *  explicitly overridden — see server's resolveBacktestRiskParams()). */
export interface BacktestRiskParams {
  riskPerTradePct?: number;
  maxDailyDrawdownPct?: number;
  stepDownAfterLosses?: number;
  stepDownSizeCutPct?: number;
  maxAggregateOpenRiskPct?: number;
  maxCorrelatedExposurePct?: number;
  maxSectorExposurePct?: number;
  maxTradesPerDay?: number;
  correlationLookbackDays?: number;
  correlationThreshold?: number;
  correlationAwareSelectionEnabled?: boolean;
}

export interface BacktestRequest extends BacktestRiskParams {
  symbols: string[];
  from: string;
  to: string;
  riskProfile: AutotradeRiskProfile;
  startingEquity: number;
  maxConcurrentPositions: number;
  /** Force-close a position open this many CALENDAR days without a stop/
   *  target hit. Omitted or 0 disables it. */
  maxHoldDays?: number;
  /** Trailing stop / breakeven / partial profit-taking — mirrors
   *  AutotradeConfig's own fields. Omitted or 0 disables each. */
  breakevenTriggerRMultiple?: number;
  trailStartRMultiple?: number;
  trailStopRMultiple?: number;
  partialExitRMultiple?: number;
  partialExitPct?: number;
  addOnTriggerRMultiple?: number;
  addOnSizePct?: number;
  maxAddOns?: number;
  /** Own value here, NOT inherited from the live Configuration's
   *  tradeDirection if omitted — a backtest is a self-contained
   *  hypothesis. Defaults to 'long' (server-side) when omitted entirely. */
  directionMode?: AutotradeTradeDirectionMode;
}

export interface WalkForwardRequest extends BacktestRequest {
  splitDate: string;
}

// --- Phase 11: options backtest ---

export interface SimulatedOptionsTrade {
  symbol: string; // underlying
  side: AutotradeOptionsSignalSide;
  /** 'single_leg' (default shape) or 'debit_spread' — a spread reuses
   *  contractTicker/strike/entryPremium/exitPremium for the LONG leg and
   *  adds the short* fields below for the short leg. */
  kind: AutotradeOptionsStrategyType;
  contractTicker: string;
  strike: number;
  shortContractTicker?: string;
  shortStrike?: number;
  expiration: string;
  signalDate: string;
  entryDate: string;
  entryPremium: number;
  shortEntryPremium?: number;
  exitDate: string;
  exitPremium: number;
  shortExitPremium?: number;
  exitReason: 'time_exit' | 'stop_loss' | 'take_profit' | 'expiration' | 'end_of_period';
  contracts: number;
  pnl: number;
  rMultiple: number;
}

export interface OptionsBacktestReport {
  trades: SimulatedOptionsTrade[];
  equityCurve: BacktestEquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  /** Candidates that cleared the equity screen but never got an options signal. */
  skipped: { symbol: string; date: string; reason: string }[];
}

// BacktestStats is reused as-is (not a new OptionsBacktestStats type) — every
// field it has (win rate, expectancy, profit factor, R-multiple stats,
// drawdown/streaks) is already 100% asset-type-blind, matching the server's
// own computeBacktestStats() reuse (services/autotrading/backtest.ts).
export interface OptionsBacktestRunResponse {
  report: OptionsBacktestReport;
  stats: BacktestStats;
}

export interface OptionsWalkForwardWindowResult extends OptionsBacktestRunResponse {
  significance: SignificanceStats;
}

export interface OptionsWalkForwardResponse {
  inSample: OptionsWalkForwardWindowResult;
  outOfSample: OptionsWalkForwardWindowResult;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

export interface OptionsBacktestRequest extends BacktestRiskParams {
  symbols: string[];
  from: string;
  to: string;
  riskProfile: AutotradeRiskProfile;
  startingEquity: number;
  maxConcurrentPositions: number;
  optionsDecisionConfig?: { strategyType?: AutotradeOptionsStrategyType };
  /** Own value here, NOT inherited from the live Configuration's
   *  tradeDirection if omitted — a backtest is a self-contained
   *  hypothesis. Governs call vs put too. Defaults to 'long' (server-side)
   *  when omitted entirely. */
  directionMode?: AutotradeTradeDirectionMode;
}

export interface OptionsWalkForwardRequest extends OptionsBacktestRequest {
  splitDate: string;
}

// --- Genuinely combined equity+options backtest (follow-up to phase 11's own
// deferral: "an independent backtest, not combined with a concurrent equity
// backtest's risk") ---

export interface CombinedBacktestReport {
  equityTrades: SimulatedTrade[];
  optionsTrades: SimulatedOptionsTrade[];
  /** ONE curve — the combined account value, not two separate ones. */
  equityCurve: BacktestEquityPoint[];
  startingEquity: number;
  finalEquity: number;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
  optionsSkipped: { symbol: string; date: string; reason: string }[];
}

// BacktestStats is reused as-is here too — the server computes it over BOTH
// trade lists concatenated (equityTrades + optionsTrades), one risk-adjusted
// read spanning the whole account, not two separate ones to add up by hand.
export interface CombinedBacktestRunResponse {
  report: CombinedBacktestReport;
  stats: BacktestStats;
}

export interface CombinedWalkForwardWindowResult extends CombinedBacktestRunResponse {
  significance: SignificanceStats;
}

export interface CombinedWalkForwardResponse {
  inSample: CombinedWalkForwardWindowResult;
  outOfSample: CombinedWalkForwardWindowResult;
  excludedSymbols: { symbol: string; reason: string }[];
  errors: { symbol: string; message: string }[];
}

export interface CombinedBacktestRequest extends BacktestRiskParams {
  symbols: string[];
  from: string;
  to: string;
  riskProfile: AutotradeRiskProfile;
  startingEquity: number;
  maxConcurrentPositions: number;
  /** Force-close an EQUITY leg position open this many CALENDAR days without
   *  a stop/target hit. Omitted or 0 disables it; no effect on the options leg. */
  maxHoldDays?: number;
  /** Trailing stop / breakeven / partial profit-taking for the EQUITY leg
   *  only — mirrors AutotradeConfig's own fields. Omitted or 0 disables each. */
  breakevenTriggerRMultiple?: number;
  trailStartRMultiple?: number;
  trailStopRMultiple?: number;
  partialExitRMultiple?: number;
  partialExitPct?: number;
  addOnTriggerRMultiple?: number;
  addOnSizePct?: number;
  maxAddOns?: number;
  optionsDecisionConfig?: { strategyType?: AutotradeOptionsStrategyType };
  /** Own value here, NOT inherited from the live Configuration's
   *  tradeDirection if omitted — a backtest is a self-contained
   *  hypothesis. Governs BOTH legs. Defaults to 'long' (server-side) when
   *  omitted entirely. */
  directionMode?: AutotradeTradeDirectionMode;
}

export interface CombinedWalkForwardRequest extends CombinedBacktestRequest {
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
  optionsExitsChecked: number;
  optionsExitsClosed: number;
  liveOrdersReconciled: number;
  livePositionsClosed: number;
  liveOptionsOrdersReconciled: number;
  liveOptionsPositionsClosed: number;
  liveOptionsExitsRequested: number;
  candidatesScreened: number;
  candidatesPassedVolatility: number;
  signalsGenerated: number;
  optionsSignalsGenerated: number;
  /** Candidates actually passed to the options decision — a subset of
   *  candidatesPassedVolatility restricted to universe-sourced candidates
   *  (Webull movers can't accumulate the real IV-rank history the options
   *  decision needs, so they never reach it). */
  optionsCandidatesConsidered: number;
  entriesOpened: number;
  optionsEntriesOpened: number;
  liveEntriesOpened: number;
  liveOptionsEntriesOpened: number;
  /** Movers-sourced symbols newly added to the persistent universe this cycle
   *  (0 on most cycles — a symbol needs several distinct days of recurrence
   *  first; see the About page / docs/AUTOTRADING_SPEC.md). */
  moversAutoPromoted: number;
}

/** The automated loop's most recently completed tick, persisted rather than
 *  recomputed — see server/src/db/autotradeLastTick.ts's header comment. */
export interface LastTickRecord {
  summary: LoopTickSummary;
  /** Epoch ms the tick that produced this summary finished. */
  ranAt: number;
}

// --- Phase 12: options paper execution ---

export type OptionsPaperExitReason = 'time_exit' | 'stop_loss' | 'take_profit' | 'manual';

export type OptionsPaperKind = 'single_leg' | 'debit_spread';

export interface OptionsPaperPosition {
  id: number;
  symbol: string;
  side: AutotradeOptionsSignalSide;
  kind: OptionsPaperKind;
  /** The long leg's contract for a debit spread. */
  contractSymbol: string;
  /** The long leg's strike for a debit spread. */
  strike: number;
  shortContractSymbol: string | null;
  shortStrike: number | null;
  expiration: string;
  /** Contracts (single_leg) or spreads (debit_spread). */
  quantity: number;
  /** The long leg's fill premium for a debit spread. */
  entryPrice: number;
  shortEntryPrice: number | null;
  entryAt: number;
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  status: 'open' | 'closed';
  /** The long leg's exit premium for a debit spread. */
  exitPrice: number | null;
  shortExitPrice: number | null;
  exitAt: number | null;
  exitReason: OptionsPaperExitReason | null;
  createdAt: number;
  updatedAt: number;
  /** A live contract mark as of the request (long leg, for a spread) — null
   *  for a closed position or if the chain fetch failed. */
  currentPrice: number | null;
  /** The short leg's live mark — null for single_leg, a closed position, or
   *  a chain-fetch failure. */
  shortCurrentPrice: number | null;
  /** The chain fetch's own underlying stock price as of this request — null
   *  for a closed position, a chain-fetch failure, or a provider that
   *  doesn't report it. Used to derive a short leg's intrinsic/extrinsic
   *  value (see components/AssignmentRiskBadge.tsx). */
  underlyingPrice: number | null;
  /** Single-leg: (currentPrice - entryPrice) * quantity * 100. Debit spread:
   *  net-value-now minus net-debit-at-entry, x quantity x 100. Null for a
   *  closed position or when a needed mark is unavailable. */
  unrealizedPnl: number | null;
}

export interface AutotradeProbationStatus {
  active: boolean;
  multiplier: number;
  tradesPlaced: number;
  tradesRemaining: number;
}

export type LiveOptionsExitReason = 'time_exit' | 'manual';

/** A REAL, live-money options position the autotrade loop itself placed
 *  (Task #70) — the options counterpart to AutotradeLivePosition, over its
 *  own autotrade_live_options_positions row (not the shared `positions`
 *  table, which has no column for a debit spread's second leg). For GET
 *  /api/autotrade/live-options-positions. */
export interface LiveOptionsPosition {
  id: number;
  symbol: string;
  side: AutotradeOptionsSignalSide;
  kind: OptionsPaperKind;
  /** The long leg's contract for a debit spread. */
  contractSymbol: string;
  /** The long leg's strike for a debit spread. */
  strike: number;
  shortContractSymbol: string | null;
  shortStrike: number | null;
  expiration: string;
  quantity: number;
  /** The long leg's filled premium for a debit spread — for a live combo
   *  fill this carries the WHOLE net debit (no per-leg breakdown is
   *  available from a single combo order), unlike paper's true per-leg
   *  fidelity. */
  entryPrice: number;
  shortEntryPrice: number | null;
  entryAt: number;
  riskAmount: number;
  riskProfile: string;
  rationale: string;
  status: 'open' | 'closed';
  exitPrice: number | null;
  shortExitPrice: number | null;
  exitAt: number | null;
  exitReason: LiveOptionsExitReason | null;
  /** The Webull account this fill executed in — null for a legacy row from
   *  before this field existed. */
  accountId: string | null;
  createdAt: number;
  updatedAt: number;
  /** A live contract mark as of the request (long leg, for a spread) — null
   *  for a closed position or if the chain fetch failed. */
  currentPrice: number | null;
  shortCurrentPrice: number | null;
  /** See OptionsPaperPosition's own doc comment — same free byproduct of the
   *  chain fetch, same null-when-unavailable semantics. */
  underlyingPrice: number | null;
  unrealizedPnl: number | null;
}

/** GET /autotrade/portfolio-greeks — a separate, on-demand endpoint from
 *  AutotradeDashboard below (see the route's own doc comment for why: it
 *  needs a live options-chain fetch, unlike every dashboard figure). */
export interface PortfolioGreeks {
  netDelta: number;
  netTheta: number;
  netVega: number;
}

export interface AutotradeDashboard {
  enabled: boolean;
  killSwitch: boolean;
  riskProfile: AutotradeRiskProfile;
  equity: number | null;
  /** The automated loop's most recently completed cycle, or null before the
   *  loop has ever run. */
  lastTick: LastTickRecord | null;
  /** Equity paper positions only — see openOptionsPositions below for the
   *  options side of this SAME combined pool. */
  openPositions: PaperPosition[];
  /** Combined equity + options paper count (phase 13) — ONE pool, not a
   *  second one the way live's own figures are. */
  openPositionsCount: number;
  maxConcurrentPositions: number;
  /** Combined equity + options paper risk $ (phase 13). */
  openRisk: number;
  maxAggregateOpenRisk: number;
  /** $ cap only — unlike every other cap here, there's no matching live
   *  "used" figure (correlation is relative to a specific candidate, not a
   *  portfolio-wide instantaneous number). See lastCorrelatedExposureCheck. */
  maxCorrelatedExposure: number;
  /** The most recent risk-check reading for this rule (null before the loop
   *  has risk-checked anything) — a point-in-time snapshot "as of the last
   *  candidate checked", not a live gauge like the tiles above it. */
  lastCorrelatedExposureCheck: {
    symbol: string;
    checkedAt: number;
    passed: boolean;
    correlatedNotional: number | null;
  } | null;
  /** UNLIKE maxCorrelatedExposure above, this genuinely IS a live,
   *  portfolio-wide instantaneous reading (sector is a static classification,
   *  not relative to a hypothetical candidate) — sorted worst-first, across
   *  the combined paper + live, equity + options autotrade book. */
  sectorExposure: { key: string; gross: number; pct: number; count: number }[];
  maxSectorExposure: number;
  /** Combined equity + options today's realized paper P&L. */
  dailyPnl: number;
  dailyDrawdownHaltLevel: number;
  /** Combined equity + options paper entries opened today. */
  tradesToday: number;
  maxTradesPerDay: number;
  /** max(equity streak, options streak) — not additive across the two books. */
  consecutiveLosses: number;
  stepDownAfterLosses: number;

  // --- Phase 13: options paper positions — folded into the SAME pool above,
  // not a second one (see openPositionsCount/openRisk doc comments). This
  // array is for per-position display (contract/strike/expiration/DTE).
  openOptionsPositions: (OptionsPaperPosition & { dte: number })[];

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

  // --- Task #70: live options — own pool nested under the live gate above,
  // own $ caps and probation window (see server dashboard.ts's header). ---
  liveOptionsEnabled: boolean;
  liveOptionsOpenPositions: LiveOptionsPosition[];
  liveOptionsOpenPositionsCount: number;
  liveOptionsOpenRisk: number;
  liveOptionsDailyPnl: number;
  liveOptionsTradesToday: number;
  liveOptionsConsecutiveLosses: number;
  liveOptionsMaxOrderUsd: number;
  liveOptionsMaxDailyLossUsd: number;
  liveOptionsMaxOrdersPerDay: number;
  liveOptionsProbation: AutotradeProbationStatus;
}

/** A real, live-money position the autotrade loop itself placed — the SAME
 *  `positions` row a human's own manual trade would use, tagged
 *  `live`+`autotrade` server-side. For GET /api/autotrade/live-positions,
 *  the Auto-Trade page's own dedicated live-positions view (distinct from
 *  the Monitoring dashboard's aggregate liveOpenPositions* figures above). */
export interface AutotradeLivePosition extends Position {
  currentPrice: number | null;
  stale: boolean;
  pnl: PositionPnl;
  /** Scale-in add-ons committed on this live position (0 unless it pyramided). */
  addOnsTaken: number;
}

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
  byTag: GroupStat[];
  byGrade: GroupStat[];
  byDiscipline: GroupStat[];
  byWeekday: GroupStat[];
  byHold: GroupStat[];
  rTrades: number;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  stdevR: number | null;
  sqn: number | null;
  rBuckets: { label: string; count: number }[];
  kelly: KellySuggestion | null;
  maxDrawdown: number;
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

export interface Alert {
  id: number;
  symbol: string;
  kind: 'price' | 'change' | 'relvol' | 'rsi';
  operator: 'above' | 'below';
  threshold: number;
  note: string | null;
  enabled: boolean;
  triggered: boolean;
  lastValue: number | null;
  triggerMessage: string | null;
  lastTriggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
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

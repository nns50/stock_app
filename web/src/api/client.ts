import type {
  AggregatePnl,
  Candle,
  BenchmarkResult,
  DayStats,
  EntryCandidate,
  EntryStrategyConfig,
  ExcursionReport,
  ExitCheckRow,
  ExitRulesConfig,
  Exposure,
  IvContext,
  OptionsIv,
  JournalStats,
  OptionsChain,
  Position,
  PositionExitAlert,
  PositionWithPnl,
  Preset,
  ProviderStatus,
  SlippageReport,
  ProviderTestResult,
  Quote,
  RiskSizingResult,
  SpreadSizingResult,
  RuinParams,
  RuinResult,
  Alert,
  AlertPlan,
  AuthStatus,
  MfaStatus,
  WebullStatus,
  WebullProbeResult,
  WebullPositionsPreview,
  WebullImportSummary,
  WebullSyncResult,
  WebullSyncConfig,
  WebullMoversResult,
  OptionLiveQuotesResult,
  MoverList,
  MoverSession,
  SymbolEvents,
  NewsItem,
  AnalystInfo,
  AlertSchedulerConfig,
  NotificationStatus,
  NotificationTestResult,
  ScreenerConfig,
  ScreenerResult,
  EdgeReport,
  SnapshotPerformance,
  SnapshotSummary,
  StrategyAnalysis,
  StrategyLeg,
  SymbolDetail,
  UniverseSymbol,
  TradingConfig,
  DryRunResult,
  OrderIntentInput,
  AccountStateInput,
  OrderIntentRecord,
  WebullAccountStateResult,
  LivePreviewResult,
  PlaceResult,
  ReconcileResult,
  ReconcileAllResult,
  CancelResult,
  ReplacePatch,
  ReplaceResult,
  AutotradeConfig,
  EquitySyncResult,
  AutotradeRiskProfile,
  AutotradeOptionsStrategyType,
  AutotradeExclusion,
  AutotradeScreenResult,
  AutotradeDecideResponse,
  AutotradeSignal,
  AutotradeOptionsSignal,
  AutotradeRiskCheckResult,
  AutotradeOptionsRiskCheckResult,
  AutotradeEvent,
  AutotradeStage,
  BacktestRequest,
  BacktestRunResponse,
  WalkForwardRequest,
  WalkForwardResponse,
  OptionsBacktestRequest,
  OptionsBacktestRunResponse,
  OptionsWalkForwardRequest,
  OptionsWalkForwardResponse,
  CombinedBacktestRequest,
  CombinedBacktestRunResponse,
  CombinedWalkForwardRequest,
  CombinedWalkForwardResponse,
  LoopTickSummary,
  PaperPosition,
  OptionsPaperPosition,
  AutotradeLivePosition,
  LiveOptionsPosition,
  AutotradeDashboard,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Fired when a protected request is rejected for lack of a session (expired or
 *  never logged in) — the AuthGate listens and shows the login screen. */
export const AUTH_REQUIRED_EVENT = 'auth-required';

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'include', // send/receive the session cookie
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // A gate rejection (not a wrong-password reply) flips the app to the login screen.
    if (res.status === 401 && body.code === 'unauthenticated') {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(res.status, body.error || `Request failed (${res.status})`, body.code);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const client = {
  // --- auth ---
  authStatus: () => api<AuthStatus>('/auth/status'),
  login: (password: string, code?: string) => api<{ ok: boolean }>('/auth/login', post({ password, code })),
  logout: () => api<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  mfaStatus: () => api<MfaStatus>('/auth/mfa'),
  mfaSetup: () => api<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: (code: string) => api<{ enabled: boolean }>('/auth/mfa/enable', post({ code })),
  mfaDisable: (code: string) => api<{ enabled: boolean }>('/auth/mfa/disable', post({ code })),

  // --- webull (integration connectivity) ---
  webullStatus: () => api<WebullStatus>('/webull/status'),
  webullProbe: (
    kind:
      | 'account-list'
      | 'snapshot'
      | 'bars'
      | 'movers'
      | 'depth'
      | 'option-snapshot'
      | 'positions'
      | 'balance'
      | 'open-orders'
      | 'order-history'
      | 'subscriptions',
    opts?: { symbol?: string; accountId?: string },
  ) => api<WebullProbeResult>('/webull/probe', post({ kind, ...opts })),
  webullPositionsPreview: (accountId: string) =>
    api<WebullPositionsPreview>('/webull/positions/preview', post({ accountId })),
  webullPositionsImport: (accountId: string) =>
    api<WebullImportSummary>('/webull/positions/import', post({ accountId })),
  webullPositionsSync: (accountId: string) => api<WebullSyncResult>('/webull/positions/sync', post({ accountId })),
  webullSyncSchedulerStatus: () => api<WebullSyncConfig>('/webull/positions/scheduler'),
  setWebullSyncScheduler: (patch: Partial<WebullSyncConfig>) =>
    api<WebullSyncConfig>('/webull/positions/scheduler', post(patch)),
  webullMovers: (list: MoverList = 'gainers', session: MoverSession = 'regular', limit = 10) =>
    api<WebullMoversResult>(`/webull/movers?list=${list}&session=${session}&limit=${limit}`),
  webullOptionQuotes: (symbols: string[]) =>
    api<OptionLiveQuotesResult>(`/webull/option-quotes?symbols=${encodeURIComponent(symbols.join(','))}`),
  events: (symbols: string[]) =>
    api<{ events: SymbolEvents[] }>(`/events?symbols=${encodeURIComponent(symbols.join(','))}`),
  news: (symbol: string) => api<{ symbol: string; news: NewsItem[] }>(`/news?symbol=${encodeURIComponent(symbol)}`),
  analyst: (symbol: string) => api<AnalystInfo>(`/analyst?symbol=${encodeURIComponent(symbol)}`),

  // --- meta ---
  provider: () => api<ProviderStatus>('/provider'),
  testProvider: (symbol?: string) =>
    api<ProviderTestResult>(`/provider/test${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
  refresh: () => api<{ ok: boolean }>('/refresh', { method: 'POST' }),

  // --- tools ---
  positionSize: (body: {
    accountSize: number;
    riskPct: number;
    entryPrice: number;
    stopPrice: number;
    assetType: 'stock' | 'option';
    side?: 'long' | 'short';
    targetRMultiple?: number;
  }) => api<RiskSizingResult>('/tools/position-size', post(body)),
  spreadSize: (body: {
    accountSize: number;
    riskPct: number;
    width: number;
    netPremium: number;
    direction: 'debit' | 'credit';
    multiplier?: number;
  }) => api<SpreadSizingResult>('/tools/spread-size', post(body)),
  analyzeStrategy: (body: {
    underlyingPrice: number;
    dte: number;
    ivForPop?: number;
    riskFreeRate?: number;
    legs: StrategyLeg[];
  }) => api<StrategyAnalysis>('/tools/strategy', post(body)),

  // --- market data ---
  quote: (symbol: string) => api<Quote>(`/quotes/${encodeURIComponent(symbol)}`),
  quotes: (symbols: string[]) => api<{ quotes: Quote[]; asOf: number }>(`/quotes?symbols=${symbols.join(',')}`),
  candles: (symbol: string, timeframe = 'daily', limit = 200) =>
    api<{ candles: Candle[] }>(`/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=${limit}`),
  symbolDetail: (symbol: string, q: { timeframe?: string; limit?: number; maShort?: number; maLong?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.timeframe) params.set('timeframe', q.timeframe);
    if (q.limit) params.set('limit', String(q.limit));
    if (q.maShort) params.set('maShort', String(q.maShort));
    if (q.maLong) params.set('maLong', String(q.maLong));
    return api<SymbolDetail>(`/symbol/${encodeURIComponent(symbol)}?${params.toString()}`);
  },

  // --- universe ---
  universe: () => api<{ symbols: UniverseSymbol[] }>('/universe'),
  universeSource: () => api<{ symbols: { symbol: string; name?: string; sector?: string }[] }>('/universe/source'),
  addSymbols: (symbols: (string | { symbol: string; name?: string; sector?: string })[]) =>
    api<{ added: number; symbols: UniverseSymbol[] }>('/universe', post({ symbols })),
  removeSymbol: (symbol: string) =>
    api<{ removed: string }>(`/universe/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),

  // --- screener ---
  screenerDefault: () => api<ScreenerConfig>('/screener/config/default'),
  runScreener: (body: {
    symbols?: string[];
    config?: Partial<ScreenerConfig>;
    maxSymbols?: number;
    includeFailed?: boolean;
  }) => api<ScreenerResult>('/screener/run', { method: 'POST', body: JSON.stringify(body) }),

  // --- presets ---
  presets: (kind?: string) => api<{ presets: Preset[] }>(`/presets${kind ? `?kind=${kind}` : ''}`),
  savePreset: (name: string, kind: string, config: unknown) =>
    api<Preset>('/presets', { method: 'POST', body: JSON.stringify({ name, kind, config }) }),
  deletePreset: (id: number) => api<{ deleted: number }>(`/presets/${id}`, { method: 'DELETE' }),

  // --- options ---
  expirations: (symbol: string) => api<{ expirations: string[] }>(`/options/${encodeURIComponent(symbol)}/expirations`),
  chain: (symbol: string, expiration: string) =>
    api<OptionsChain>(`/options/${encodeURIComponent(symbol)}/chain?expiration=${expiration}`),
  optionsIv: (symbol: string, expiration: string) =>
    api<OptionsIv>(`/options/${encodeURIComponent(symbol)}/iv?expiration=${encodeURIComponent(expiration)}`),
  entryDefault: () => api<EntryStrategyConfig>('/options/entry/default'),
  exitDefault: () => api<ExitRulesConfig>('/options/exit/default'),
  entryScan: (body: { symbol: string; expiration: string; config?: Partial<EntryStrategyConfig> }) =>
    api<{
      underlyingPrice: number | null;
      config: EntryStrategyConfig;
      ivContext: IvContext;
      candidates: EntryCandidate[];
      synthetic: boolean;
    }>('/options/entry-scan', { method: 'POST', body: JSON.stringify(body) }),
  exitCheck: (config: ExitRulesConfig) =>
    api<{ config: ExitRulesConfig; evaluations: ExitCheckRow[]; checkedAt: number; synthetic: boolean }>(
      '/options/exit-check',
      {
        method: 'POST',
        body: JSON.stringify({ config }),
      },
    ),

  // --- positions ---
  positions: (params: { status?: string; symbol?: string; assetType?: string } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ positions: Position[] }>(`/positions${qs ? `?${qs}` : ''}`);
  },
  positionsWithPnl: (params: { status?: string } = {}) => {
    const qs = new URLSearchParams({ ...params, withPnl: 'true' } as Record<string, string>).toString();
    return api<{ positions: PositionWithPnl[]; aggregate: AggregatePnl; exposure: Exposure }>(`/positions?${qs}`);
  },
  createPosition: (body: Record<string, unknown>) =>
    api<Position>('/positions', { method: 'POST', body: JSON.stringify(body) }),
  updatePosition: (id: number, patch: Record<string, unknown>) =>
    api<Position>(`/positions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePosition: (id: number) => api<{ deleted: number }>(`/positions/${id}`, { method: 'DELETE' }),
  addExit: (id: number, body: Record<string, unknown>) =>
    api<Position>(`/positions/${id}/exits`, { method: 'POST', body: JSON.stringify(body) }),

  // --- journal ---
  journalStats: () => api<JournalStats>('/journal/stats'),
  journalExcursions: () => api<ExcursionReport>('/journal/excursions'),
  journalBenchmark: (accountSize?: number, symbol = 'SPY') => {
    const qs = new URLSearchParams({ symbol });
    if (accountSize) qs.set('accountSize', String(accountSize));
    return api<BenchmarkResult>(`/journal/benchmark?${qs.toString()}`);
  },
  journalTags: () => api<{ tags: string[] }>('/journal/tags'),
  journalToday: (date: string) => api<DayStats>(`/journal/today?date=${encodeURIComponent(date)}`),
  journalSlippage: () => api<SlippageReport>('/journal/slippage'),

  // --- data export / restore ---
  importPositions: (positions: unknown[], mode: 'merge' | 'replace') =>
    api<{ imported: number; replaced: boolean; totalNow: number }>('/export/import', post({ positions, mode })),

  riskOfRuin: (body: {
    winRate?: number;
    payoffRatio?: number;
    riskPct?: number;
    ruinThresholdPct?: number;
    trades?: number;
    sims?: number;
  }) => api<{ params: RuinParams; result: RuinResult }>('/tools/risk-of-ruin', post(body)),

  // --- watchlist ---
  watchlist: () => api<{ symbols: string[] }>('/watchlist'),
  addWatch: (symbol: string) => api<{ symbols: string[] }>('/watchlist', post({ symbol })),
  removeWatch: (symbol: string) =>
    api<{ symbols: string[] }>(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),

  // --- settings (persisted UI state) ---
  settings: () => api<Record<string, unknown>>('/settings'),
  saveSetting: (key: string, value: unknown) =>
    api<{ key: string; value: unknown }>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),

  // --- screener snapshots (edge tracking) ---
  listSnapshots: () => api<{ snapshots: SnapshotSummary[] }>('/snapshots'),
  snapshotsEdge: () => api<EdgeReport>('/snapshots/edge'),
  createSnapshot: (body: {
    direction: string;
    note?: string;
    picks: { symbol: string; score: number; price: number }[];
  }) => api<{ id: number }>('/snapshots', post(body)),
  snapshotPerformance: (id: number) =>
    api<{
      snapshot: { id: number; createdAt: number; direction: 'long' | 'short'; note: string | null };
      performance: SnapshotPerformance;
    }>(`/snapshots/${id}/performance`),
  deleteSnapshot: (id: number) => api<{ deleted: number }>(`/snapshots/${id}`, { method: 'DELETE' }),

  // --- alerts ---
  alerts: () => api<{ alerts: Alert[] }>('/alerts'),
  createAlert: (body: {
    symbol: string;
    assetType?: 'stock' | 'option';
    kind: string;
    operator: string;
    threshold: number;
    optionType?: 'call' | 'put';
    strike?: number;
    expiration?: string;
    role?: 'entry' | 'exit';
    plan?: AlertPlan;
    note?: string;
  }) => api<Alert>('/alerts', post(body)),
  updateAlert: (
    id: number,
    patch: {
      threshold?: number;
      note?: string | null;
      plan?: AlertPlan | null;
      enabled?: boolean;
      triggered?: boolean;
    },
  ) => api<Alert>(`/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAlert: (id: number) => api<{ deleted: number }>(`/alerts/${id}`, { method: 'DELETE' }),
  evaluateAlerts: () =>
    api<{
      alerts: Alert[];
      newlyTriggered: { id: number; symbol: string; message: string | null }[];
      positionAlerts: PositionExitAlert[];
      checkedAt: number;
    }>('/alerts/evaluate', { method: 'POST' }),

  // Background poller + webhook notifications (server-side watching).
  notifications: () => api<NotificationStatus>('/alerts/notifications'),
  setAlertScheduler: (body: { enabled?: boolean; intervalSeconds?: number }) =>
    api<AlertSchedulerConfig>('/alerts/scheduler', { method: 'PUT', body: JSON.stringify(body) }),
  testNotification: () => api<NotificationTestResult>('/alerts/notifications/test', { method: 'POST' }),

  // --- live trading (dry-run safety surface; never submits an order) ---
  tradeConfig: () => api<TradingConfig>('/trade/config'),
  setTradeConfig: (patch: Partial<TradingConfig>) =>
    api<TradingConfig>('/trade/config', { method: 'PUT', body: JSON.stringify(patch) }),
  setKillSwitch: (on: boolean) =>
    api<TradingConfig>('/trade/kill-switch', { method: 'POST', body: JSON.stringify({ on }) }),
  dryRunOrder: (intent: OrderIntentInput, account: AccountStateInput) =>
    api<DryRunResult>('/trade/dry-run', { method: 'POST', body: JSON.stringify({ intent, account }) }),
  tradeIntents: () => api<{ intents: OrderIntentRecord[] }>('/trade/intents'),
  tradeReconcile: (id: number, accountId: string) =>
    api<ReconcileResult>(`/trade/intents/${id}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  tradeReconcileAll: (accountId: string) =>
    api<ReconcileAllResult>('/trade/intents/reconcile-all', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  tradeCancel: (id: number, accountId: string) =>
    api<CancelResult>(`/trade/intents/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  tradeReplace: (id: number, accountId: string, patch: ReplacePatch) =>
    api<ReplaceResult>(`/trade/intents/${id}/replace`, {
      method: 'POST',
      body: JSON.stringify({ accountId, patch }),
    }),
  tradeAccountState: (accountId: string, symbol?: string) =>
    api<WebullAccountStateResult>(
      `/trade/account-state?accountId=${encodeURIComponent(accountId)}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`,
    ),
  tradePreview: (intent: OrderIntentInput, accountId: string) =>
    api<LivePreviewResult>('/trade/preview', { method: 'POST', body: JSON.stringify({ intent, accountId }) }),
  tradePlace: (intent: OrderIntentInput, accountId: string, confirmation: string) =>
    api<PlaceResult>('/trade/place', { method: 'POST', body: JSON.stringify({ intent, accountId, confirmation }) }),

  // --- auto-trading (docs/AUTOTRADING_SPEC.md) ---
  autotradeConfig: () => api<AutotradeConfig>('/autotrade/config'),
  setAutotradeConfig: (body: {
    enabled?: boolean;
    riskProfile?: AutotradeRiskProfile;
    confirmAggressive?: boolean;
    accountEquityUsd?: number | null;
    liveTradingEnabled?: boolean;
    confirmLiveTrading?: string;
    liveAccountId?: string | null;
    liveMaxOrderUsd?: number;
    liveMaxDailyLossUsd?: number;
    liveMaxOrdersPerDay?: number;
    liveFatFingerPct?: number;
    liveAllowNakedShort?: boolean;
    liveProbationTrades?: number;
    liveProbationSizeMultiplier?: number;
    liveOptionsEnabled?: boolean;
    liveOptionsMaxOrderUsd?: number;
    liveOptionsMaxDailyLossUsd?: number;
    liveOptionsMaxOrdersPerDay?: number;
    liveOptionsFatFingerPct?: number;
    liveOptionsProbationTrades?: number;
    liveOptionsProbationSizeMultiplier?: number;
    optionsStrategyType?: AutotradeOptionsStrategyType;
    autoPromoteMoversEnabled?: boolean;
    autoPromoteThreshold?: number;
    autoPromoteWindowDays?: number;
    autoPromoteMaxSymbols?: number;
  }) => api<AutotradeConfig>('/autotrade/config', { method: 'PUT', body: JSON.stringify(body) }),
  autotradeExclusions: () => api<{ exclusions: AutotradeExclusion[] }>('/autotrade/exclusions'),
  addAutotradeExclusion: (body: { symbol: string; reason?: string }) =>
    api<AutotradeExclusion>('/autotrade/exclusions', post(body)),
  removeAutotradeExclusion: (symbol: string) =>
    api<{ removed: string }>(`/autotrade/exclusions/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),
  runAutotradeScreen: (body: { symbols?: string[] } = {}) =>
    api<AutotradeScreenResult>('/autotrade/screen', post(body)),
  runAutotradeDecision: (body: { symbols?: string[] } = {}) =>
    api<AutotradeDecideResponse>('/autotrade/decide', post(body)),
  runAutotradeRiskCheck: (signals: AutotradeSignal[]) =>
    api<{ results: AutotradeRiskCheckResult[] }>('/autotrade/risk-check', post({ signals })),
  runOptionsRiskCheck: (signals: AutotradeOptionsSignal[], equityResults: AutotradeRiskCheckResult[] = []) =>
    api<{ results: AutotradeOptionsRiskCheckResult[] }>(
      '/autotrade/risk-check-options',
      post({ signals, equityResults }),
    ),
  autotradeEvents: (params: { stage?: AutotradeStage; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ events: AutotradeEvent[] }>(`/autotrade/events${qs ? `?${qs}` : ''}`);
  },
  runAutotradeBacktest: (body: BacktestRequest) => api<BacktestRunResponse>('/autotrade/backtest', post(body)),
  runAutotradeWalkForward: (body: WalkForwardRequest) =>
    api<WalkForwardResponse>('/autotrade/backtest/walk-forward', post(body)),
  runOptionsBacktest: (body: OptionsBacktestRequest) =>
    api<OptionsBacktestRunResponse>('/autotrade/backtest-options', post(body)),
  runOptionsWalkForward: (body: OptionsWalkForwardRequest) =>
    api<OptionsWalkForwardResponse>('/autotrade/backtest-options/walk-forward', post(body)),
  runCombinedBacktest: (body: CombinedBacktestRequest) =>
    api<CombinedBacktestRunResponse>('/autotrade/backtest-combined', post(body)),
  runCombinedWalkForward: (body: CombinedWalkForwardRequest) =>
    api<CombinedWalkForwardResponse>('/autotrade/backtest-combined/walk-forward', post(body)),
  runAutotradeLoopOnce: () => api<LoopTickSummary>('/autotrade/loop/run-once', post({})),
  autotradePaperPositions: (params: { status?: 'open' | 'closed'; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ positions: PaperPosition[] }>(`/autotrade/paper-positions${qs ? `?${qs}` : ''}`);
  },
  autotradeOptionsPaperPositions: (params: { status?: 'open' | 'closed'; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ positions: OptionsPaperPosition[] }>(`/autotrade/options-paper-positions${qs ? `?${qs}` : ''}`);
  },
  autotradeLivePositions: (params: { status?: 'open' | 'closed'; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ positions: AutotradeLivePosition[] }>(`/autotrade/live-positions${qs ? `?${qs}` : ''}`);
  },
  autotradeLiveOptionsPositions: (params: { status?: 'open' | 'closed'; symbol?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return api<{ positions: LiveOptionsPosition[] }>(`/autotrade/live-options-positions${qs ? `?${qs}` : ''}`);
  },
  autotradeDashboard: () => api<AutotradeDashboard>('/autotrade/dashboard'),
  setAutotradeKillSwitch: (on: boolean) =>
    api<AutotradeConfig>('/autotrade/kill-switch', { method: 'POST', body: JSON.stringify({ on }) }),
  syncAutotradeEquity: () => api<EquitySyncResult>('/autotrade/sync-equity', { method: 'POST' }),
};

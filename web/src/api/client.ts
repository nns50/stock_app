import type {
  AggregatePnl,
  Candle,
  EntryCandidate,
  EntryStrategyConfig,
  ExitCheckRow,
  ExitRulesConfig,
  Exposure,
  IvContext,
  JournalStats,
  OptionsChain,
  Position,
  PositionWithPnl,
  Preset,
  ProviderStatus,
  ProviderTestResult,
  Quote,
  RiskSizingResult,
  Alert,
  ScreenerConfig,
  ScreenerResult,
  SnapshotPerformance,
  SnapshotSummary,
  StrategyAnalysis,
  StrategyLeg,
  SymbolDetail,
  UniverseSymbol,
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

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.error || `Request failed (${res.status})`, body.code);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const client = {
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
  journalTags: () => api<{ tags: string[] }>('/journal/tags'),

  // --- data export / restore ---
  importPositions: (positions: unknown[], mode: 'merge' | 'replace') =>
    api<{ imported: number; replaced: boolean; totalNow: number }>('/export/import', post({ positions, mode })),

  // --- settings (persisted UI state) ---
  settings: () => api<Record<string, unknown>>('/settings'),
  saveSetting: (key: string, value: unknown) =>
    api<{ key: string; value: unknown }>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),

  // --- screener snapshots (edge tracking) ---
  listSnapshots: () => api<{ snapshots: SnapshotSummary[] }>('/snapshots'),
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
  createAlert: (body: { symbol: string; kind: string; operator: string; threshold: number; note?: string }) =>
    api<Alert>('/alerts', post(body)),
  updateAlert: (
    id: number,
    patch: { threshold?: number; note?: string | null; enabled?: boolean; triggered?: boolean },
  ) => api<Alert>(`/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAlert: (id: number) => api<{ deleted: number }>(`/alerts/${id}`, { method: 'DELETE' }),
  evaluateAlerts: () =>
    api<{
      alerts: Alert[];
      newlyTriggered: { id: number; symbol: string; message: string | null }[];
      checkedAt: number;
    }>('/alerts/evaluate', { method: 'POST' }),
};

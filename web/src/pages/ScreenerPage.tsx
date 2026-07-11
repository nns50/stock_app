import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtCompact, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import {
  Card,
  CollapsibleCard,
  EmptyState,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  PnL,
  ScoreBar,
  SortTh,
  Spinner,
  StatTile,
  Badge,
  SortDir,
} from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { UniverseModal } from '../components/UniverseModal';
import { SnapshotsModal } from '../components/SnapshotsModal';
import type { IndicatorKey, ScreenerConfig, ScreenerResult, SymbolScore } from '../api/types';

const WEIGHT_KEYS: { key: IndicatorKey; label: string }[] = [
  { key: 'momentum', label: 'Momentum' },
  { key: 'relativeVolume', label: 'Rel. Volume' },
  { key: 'rsi', label: 'RSI' },
  { key: 'volatility', label: 'Volatility' },
  { key: 'gap', label: 'Gap' },
  { key: 'trend', label: 'Trend' },
];

type SortKey = 'rank' | 'symbol' | 'price' | 'total' | 'changePct' | 'relVolume' | 'rsi' | 'atrPct' | 'gapPct';

function sortVal(r: SymbolScore, k: SortKey): number | string {
  switch (k) {
    case 'symbol':
      return r.symbol;
    case 'price':
      return r.price;
    case 'changePct':
      return r.indicators.changePct ?? -Infinity;
    case 'relVolume':
      return r.indicators.relVolume ?? -Infinity;
    case 'rsi':
      return r.indicators.rsi ?? -Infinity;
    case 'atrPct':
      return r.indicators.atrPct ?? -Infinity;
    case 'gapPct':
      return r.indicators.gapPct ?? -Infinity;
    default:
      return r.total;
  }
}

export default function ScreenerPage() {
  const defaults = useAsync(() => client.screenerDefault(), []);
  const presets = useAsync(() => client.presets('screener'), []);
  const universe = useAsync(() => client.universe(), []);
  const settings = useAsync(() => client.settings(), []);

  const [config, setConfig] = useState<ScreenerConfig | null>(null);
  const cfg = config ?? defaults.data ?? null;

  // Initialize from the last-saved config (persisted in SQLite), falling back to
  // the server defaults.
  useEffect(() => {
    if (config !== null) return;
    const saved = settings.data?.['screener.config'] as ScreenerConfig | undefined;
    if (saved) setConfig({ ...(defaults.data ?? saved), ...saved });
    else if (defaults.data) setConfig(defaults.data);
  }, [settings.data, defaults.data, config]);

  const [useCustom, setUseCustom] = useState(false);
  const [customText, setCustomText] = useState('');
  const [maxSymbols, setMaxSymbols] = useState(75);
  const [includeFailed, setIncludeFailed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [universeOpen, setUniverseOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);

  const [result, setResult] = useState<ScreenerResult>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error>();

  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showFiltered, setShowFiltered] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const set = <K extends keyof ScreenerConfig>(k: K, v: ScreenerConfig[K]) =>
    setConfig((c) => ({ ...(c ?? (defaults.data as ScreenerConfig)), [k]: v }));
  const setWeight = (k: IndicatorKey, v: number | undefined) =>
    setConfig((c) => {
      const base = c ?? (defaults.data as ScreenerConfig);
      return { ...base, weights: { ...base.weights, [k]: v ?? 0 } };
    });
  const setFilter = (k: keyof ScreenerConfig['filters'], v: number | boolean | undefined) =>
    setConfig((c) => {
      const base = c ?? (defaults.data as ScreenerConfig);
      return { ...base, filters: { ...base.filters, [k]: v } };
    });

  const run = async () => {
    if (!cfg) return;
    setRunning(true);
    setError(undefined);
    try {
      const symbols = useCustom
        ? customText
            .split(/[\s,]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        : undefined;
      const res = await client.runScreener({ config: cfg, symbols, maxSymbols, includeFailed });
      setResult(res);
      client.saveSetting('screener.config', cfg).catch(() => {}); // remember last config
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(false);
    }
  };

  const onSort = (k: string) => {
    const key = k as SortKey;
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo(() => {
    const rows = [...(result?.results ?? [])];
    rows.sort((a, b) => {
      const va = sortVal(a, sortKey);
      const vb = sortVal(b, sortKey);
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [result, sortKey, sortDir]);

  const savePreset = async () => {
    if (!cfg) return;
    const name = window.prompt('Save screener preset as:');
    if (!name) return;
    await client.savePreset(name, 'screener', cfg);
    presets.reload();
  };

  // Save the current run's top picks so their forward performance can be tracked.
  const saveSnapshot = async () => {
    if (!result || !cfg) return;
    const picks = result.results.slice(0, 15).map((r) => ({ symbol: r.symbol, score: r.total, price: r.price }));
    if (!picks.length) {
      window.alert('No passing picks to snapshot.');
      return;
    }
    const note = window.prompt(`Snapshot the top ${picks.length} picks. Note (optional):`) ?? undefined;
    await client.createSnapshot({ direction: cfg.direction, note: note || undefined, picks });
    setSnapshotsOpen(true);
  };

  if (defaults.loading || settings.loading || !cfg) return <Spinner label="Loading screener…" />;

  return (
    <div className="flex flex-col lg:flex-row gap-5">
      {/* ---- Config sidebar ---- */}
      <aside className="lg:w-80 shrink-0 space-y-4">
        <CollapsibleCard
          id="screener.config"
          title="Screener config"
          headingLevel="h2"
          action={<Badge color="blue">{cfg.direction}</Badge>}
        >
          <div className="space-y-3">
            <Field label="Direction">
              <select
                className="input"
                value={cfg.direction}
                onChange={(e) => set('direction', e.target.value as 'long' | 'short')}
              >
                <option value="long">Long (bullish)</option>
                <option value="short">Short (bearish)</option>
              </select>
            </Field>

            <div>
              <div className="label">Scan source</div>
              <div className="flex rounded-md overflow-hidden border border-ink-600 text-sm">
                <button
                  className={cx('flex-1 px-2 py-1', !useCustom ? 'bg-ink-600 text-slate-100' : 'text-slate-400')}
                  onClick={() => setUseCustom(false)}
                >
                  Universe ({universe.data?.symbols.length ?? '…'})
                </button>
                <button
                  className={cx('flex-1 px-2 py-1', useCustom ? 'bg-ink-600 text-slate-100' : 'text-slate-400')}
                  onClick={() => setUseCustom(true)}
                >
                  Custom list
                </button>
              </div>
              {useCustom ? (
                <textarea
                  className="input mt-2 h-20"
                  placeholder="AAPL MSFT NVDA…"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                />
              ) : (
                <div className="flex items-center gap-2 mt-2">
                  <button className="btn-ghost text-xs flex-1" onClick={() => setUniverseOpen(true)}>
                    Manage universe
                  </button>
                  <div className="w-24">
                    <NumberInput value={maxSymbols} onChange={(v) => setMaxSymbols(v ?? 1)} min={1} max={500} />
                  </div>
                </div>
              )}
              {!useCustom && (
                <div className="text-[11px] text-slate-500 mt-1">Max symbols/scan (rate-limit guard).</div>
              )}
            </div>

            <div>
              <div className="label">Indicator weights</div>
              <div className="grid sm:grid-cols-2 gap-2">
                {WEIGHT_KEYS.map((w) => (
                  <label key={w.key} className="text-xs text-slate-400">
                    {w.label}
                    <NumberInput value={cfg.weights[w.key]} onChange={(v) => setWeight(w.key, v)} min={0} max={100} />
                  </label>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-4 gap-2">
              <Field label="MA-s">
                <NumberInput value={cfg.maShort} onChange={(v) => set('maShort', v ?? 20)} min={2} />
              </Field>
              <Field label="MA-l">
                <NumberInput value={cfg.maLong} onChange={(v) => set('maLong', v ?? 50)} min={2} />
              </Field>
              <Field label="RSI">
                <NumberInput value={cfg.rsiPeriod} onChange={(v) => set('rsiPeriod', v ?? 14)} min={2} />
              </Field>
              <Field label="ATR">
                <NumberInput value={cfg.atrPeriod} onChange={(v) => set('atrPeriod', v ?? 14)} min={2} />
              </Field>
            </div>

            <div>
              <div className="label">Filters (hard gates)</div>
              <div className="grid sm:grid-cols-2 gap-2">
                <label className="text-xs text-slate-400">
                  Min price
                  <NumberInput value={cfg.filters.minPrice} onChange={(v) => setFilter('minPrice', v)} />
                </label>
                <label className="text-xs text-slate-400">
                  Max price
                  <NumberInput value={cfg.filters.maxPrice} onChange={(v) => setFilter('maxPrice', v)} />
                </label>
                <label className="text-xs text-slate-400">
                  Min avg vol
                  <NumberInput value={cfg.filters.minAvgVolume} onChange={(v) => setFilter('minAvgVolume', v)} />
                </label>
                <label className="text-xs text-slate-400">
                  Min rel vol
                  <NumberInput value={cfg.filters.minRelVol} onChange={(v) => setFilter('minRelVol', v)} step={0.1} />
                </label>
                <label className="text-xs text-slate-400">
                  RSI min
                  <NumberInput value={cfg.filters.rsiMin} onChange={(v) => setFilter('rsiMin', v)} />
                </label>
                <label className="text-xs text-slate-400">
                  RSI max
                  <NumberInput value={cfg.filters.rsiMax} onChange={(v) => setFilter('rsiMax', v)} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400 mt-2">
                <input
                  type="checkbox"
                  checked={!!cfg.filters.requireTrendAlignment}
                  onChange={(e) => setFilter('requireTrendAlignment', e.target.checked)}
                />
                Require trend alignment
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                <input type="checkbox" checked={includeFailed} onChange={(e) => setIncludeFailed(e.target.checked)} />
                Include filtered-out (full breakdown)
              </label>
            </div>

            <button className="text-xs text-accent" onClick={() => setAdvanced((a) => !a)}>
              {advanced ? '▾ Hide' : '▸ Show'} score tuning
            </button>
            {advanced && (
              <div className="grid sm:grid-cols-2 gap-2">
                <label className="text-xs text-slate-400">
                  Momentum scale %
                  <NumberInput value={cfg.momentumScale} onChange={(v) => set('momentumScale', v ?? 5)} step={0.5} />
                </label>
                <label className="text-xs text-slate-400">
                  Rel-vol target ×
                  <NumberInput value={cfg.relVolTarget} onChange={(v) => set('relVolTarget', v ?? 2)} step={0.1} />
                </label>
                <label className="text-xs text-slate-400">
                  RSI sweet spot
                  <NumberInput value={cfg.rsiSweetSpot} onChange={(v) => set('rsiSweetSpot', v ?? 60)} />
                </label>
                <label className="text-xs text-slate-400">
                  RSI width
                  <NumberInput value={cfg.rsiWidth} onChange={(v) => set('rsiWidth', v ?? 25)} />
                </label>
                <label className="text-xs text-slate-400">
                  ATR% scale
                  <NumberInput value={cfg.atrPctScale} onChange={(v) => set('atrPctScale', v ?? 5)} step={0.5} />
                </label>
                <label className="text-xs text-slate-400">
                  Gap scale %<NumberInput value={cfg.gapScale} onChange={(v) => set('gapScale', v ?? 3)} step={0.5} />
                </label>
              </div>
            )}

            <button className="btn-primary w-full" onClick={run} disabled={running}>
              {running ? 'Scanning…' : 'Run screener'}
            </button>
          </div>
        </CollapsibleCard>

        {/* Presets */}
        <CollapsibleCard
          id="screener.presets"
          title="Presets"
          action={
            <button className="text-xs text-accent" onClick={savePreset}>
              + Save current
            </button>
          }
        >
          <div className="space-y-2">
            {presets.data?.presets.length ? (
              <div className="space-y-1">
                {presets.data.presets.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <button
                      className="text-slate-300 hover:text-accent text-left"
                      onClick={() => setConfig(p.config as ScreenerConfig)}
                    >
                      {p.name}
                    </button>
                    <button
                      className="text-xs text-slate-500 hover:text-bear"
                      onClick={async () => {
                        await client.deletePreset(p.id);
                        presets.reload();
                      }}
                    >
                      delete
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-500">No saved presets yet.</div>
            )}
          </div>
        </CollapsibleCard>
      </aside>

      {/* ---- Results ---- */}
      <section className="flex-1 min-w-0 space-y-4">
        <PageHeader
          title="Watch today"
          subtitle={
            result ? (
              <>
                Ranked <span className="text-slate-300">{result.results.length}</span> of {result.scannedCount} scanned
                {result.scannedCount < result.universeCount && <> · universe {result.universeCount}</>}
                {result.errors.length > 0 && (
                  <>
                    {' '}
                    ·{' '}
                    <button
                      className="text-bear underline decoration-dotted hover:opacity-80"
                      onClick={() => setShowErrors((v) => !v)}
                      title="Show which symbols failed and why"
                    >
                      {result.errors.length} errors
                    </button>
                  </>
                )}
              </>
            ) : (
              'Rank your universe with transparent, weighted indicators.'
            )
          }
          actions={
            <>
              <button className="btn-ghost" onClick={() => setSnapshotsOpen(true)}>
                Snapshots
              </button>
              {result && (
                <button
                  className="btn-ghost"
                  onClick={saveSnapshot}
                  title="Save the top picks to track their forward performance"
                >
                  Save snapshot
                </button>
              )}
              {result && (
                <RefreshBar
                  onRefresh={run}
                  lastUpdated={result.generatedAt}
                  loading={running}
                  defaultIntervalMs={null}
                />
              )}
            </>
          }
        />

        {result && showErrors && result.errors.length > 0 && (
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-bear">Skipped {result.errors.length} symbol(s)</h3>
              <button className="text-xs text-slate-500 hover:text-slate-300" onClick={() => setShowErrors(false)}>
                Hide
              </button>
            </div>
            <p className="mb-2 text-[11px] text-slate-500">
              These symbols couldn't be scored (no data, unsupported, or a provider error) and were left out of the
              ranking. The rest scanned fine.
            </p>
            <ul className="space-y-1 text-xs">
              {result.errors.map((e) => (
                <li key={e.symbol} className="flex gap-2">
                  <span className="font-mono font-medium text-slate-300">{e.symbol}</span>
                  <span className="text-slate-500 break-all">{e.message}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {error && (
          <Card>
            <ErrorState error={error} onRetry={run} />
          </Card>
        )}

        {!result && !error && (
          <Card>
            <EmptyState
              title="Run the screener to rank your universe"
              hint="Each symbol is scored from transparent, weighted indicators. Expand any row to see exactly why it ranked where it did."
              action={
                <button className="btn-primary" onClick={run} disabled={running}>
                  {running ? 'Scanning…' : 'Run screener'}
                </button>
              }
            />
          </Card>
        )}

        {result && (
          <Card className="overflow-auto max-h-[75vh]">
            <table className="w-full border-collapse">
              <thead className="sticky-thead">
                <tr>
                  <th className="th w-8"></th>
                  <SortTh label="Symbol" k="symbol" active={sortKey} dir={sortDir} onSort={onSort} />
                  <SortTh label="Price" k="price" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Score" k="total" active={sortKey} dir={sortDir} onSort={onSort} />
                  <SortTh label="Δ%" k="changePct" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="RelVol" k="relVolume" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="RSI" k="rsi" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="ATR%" k="atrPct" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Gap%" k="gapPct" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <th className="th text-right">Detail</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={10}>
                      <EmptyState
                        title="No symbols passed the filters"
                        hint="Loosen the hard filters on the left, or enable “Include filtered-out”."
                      />
                    </td>
                  </tr>
                )}
                {sorted.map((r, i) => {
                  const ind = r.indicators;
                  const open = expanded === r.symbol;
                  return (
                    <Fragment key={r.symbol}>
                      <tr className={cx('border-b border-ink-700/60 hover:bg-ink-700/40', open && 'bg-ink-700/40')}>
                        <td className="td text-slate-500">{i + 1}</td>
                        <td className="td">
                          <button
                            className="font-semibold text-slate-100 hover:text-accent"
                            onClick={() => setExpanded(open ? null : r.symbol)}
                          >
                            {open ? '▾' : '▸'} {r.symbol}
                          </button>
                        </td>
                        <td className="td text-right">{fmtUsd(r.price)}</td>
                        <td className="td">
                          <ScoreBar value={r.total} />
                        </td>
                        <td className="td text-right">
                          <PnL value={ind.changePct} format={fmtPct} />
                        </td>
                        <td className="td text-right">{ind.relVolume === null ? '—' : `${fmtNum(ind.relVolume)}×`}</td>
                        <td className="td text-right">{fmtNum(ind.rsi, 1)}</td>
                        <td className="td text-right">{ind.atrPct === null ? '—' : `${fmtNum(ind.atrPct)}%`}</td>
                        <td className={cx('td text-right', (ind.gapPct ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                          {fmtPct(ind.gapPct)}
                        </td>
                        <td className="td text-right">
                          <Link className="text-accent hover:underline" to={`/symbol/${r.symbol}`}>
                            chart →
                          </Link>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-ink-900/40">
                          <td></td>
                          <td colSpan={9} className="px-3 py-3">
                            <ScoreBreakdown row={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {result && (includeFailed ? result.filteredOut.length > 0 : result.filteredOut.length > 0) && (
          <Card className="p-4">
            <button className="text-sm text-slate-400 hover:text-slate-200" onClick={() => setShowFiltered((s) => !s)}>
              {showFiltered ? '▾' : '▸'} Filtered out ({result.filteredOut.length})
            </button>
            {showFiltered && (
              <div className="mt-2 flex flex-wrap gap-2">
                {result.filteredOut.map((f) => (
                  <span key={f.symbol} className="chip bg-ink-700 text-slate-400" title={f.filterReasons.join(', ')}>
                    {f.symbol} · {f.total.toFixed(0)} <span className="text-bear">✕ {f.filterReasons[0]}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>
        )}
      </section>

      <UniverseModal open={universeOpen} onClose={() => setUniverseOpen(false)} onChanged={() => universe.reload()} />
      <SnapshotsModal open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
    </div>
  );
}

function ScoreBreakdown({ row }: { row: SymbolScore }) {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
        <StatTile label="Total score" value={row.total.toFixed(1)} />
        <StatTile label="20/50 MA" value={`${fmtNum(row.indicators.maShort)} / ${fmtNum(row.indicators.maLong)}`} />
        <StatTile label="Avg volume" value={fmtCompact(row.indicators.avgVolume)} />
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[11px] uppercase text-slate-500">
            <th className="py-1">Component</th>
            <th>Raw</th>
            <th>Sub-score</th>
            <th className="text-right">Weight</th>
            <th className="text-right">Contribution</th>
            <th className="pl-3">Why</th>
          </tr>
        </thead>
        <tbody>
          {row.components.map((c) => (
            <tr key={c.key} className="border-t border-ink-700/60">
              <td className="py-1.5 text-sm font-medium">{c.label}</td>
              <td className="text-sm tabular-nums text-slate-300">{c.display}</td>
              <td>
                <ScoreBar value={c.score} width={56} />
              </td>
              <td className="text-right text-sm text-slate-400 tabular-nums">{c.weight}</td>
              <td className="text-right text-sm tabular-nums">{c.contribution.toFixed(1)}</td>
              <td className="pl-3 text-xs text-slate-500">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

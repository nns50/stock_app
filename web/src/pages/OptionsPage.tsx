import { Fragment, useEffect, useState } from 'react';
import { client } from '../api/client';
import { useProvider } from '../components/ProviderContext';
import { useAsync } from '../lib/hooks';
import { cx, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Field, NumberInput, ScoreBar, Spinner } from '../components/ui';
import type { EntryStrategyConfig, ExitRulesConfig, OptionContract, OptionsChain } from '../api/types';

type Tab = 'chain' | 'entry' | 'exit';

export default function OptionsPage() {
  const { status, loading } = useProvider();
  const [symbol, setSymbol] = useState('AAPL');
  const [activeSymbol, setActiveSymbol] = useState('AAPL');
  const [expiration, setExpiration] = useState<string>('');
  const [tab, setTab] = useState<Tab>('chain');

  const expirations = useAsync(() => client.expirations(activeSymbol), [activeSymbol]);

  useEffect(() => {
    if (expirations.data?.expirations.length && !expirations.data.expirations.includes(expiration)) {
      setExpiration(expirations.data.expirations[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expirations.data]);

  if (loading) return <Spinner label="Checking provider…" />;

  // Feature gate — show a clear "data not configured" state rather than faking.
  if (status && !status.configured) {
    return (
      <Card>
        <EmptyState title="Options data not configured" hint={status.message} />
      </Card>
    );
  }
  if (status && !status.capabilities.options) {
    return (
      <Card>
        <EmptyState
          title="Options data unavailable for this provider"
          hint={`The "${status.name}" provider doesn't expose option chains. Switch to a provider that does (e.g. Tradier), or use demo mode.`}
        />
      </Card>
    );
  }

  const load = () => {
    const s = symbol.trim().toUpperCase();
    if (s) setActiveSymbol(s);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Symbol">
          <div className="flex gap-2">
            <input
              className="input !w-32"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <button className="btn-primary" onClick={load}>Load</button>
          </div>
        </Field>
        <Field label="Expiration">
          <select className="input !w-44" value={expiration} onChange={(e) => setExpiration(e.target.value)}>
            {expirations.loading && <option>loading…</option>}
            {expirations.data?.expirations.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </Field>
        {status?.synthetic && <Badge color="amber">synthetic data</Badge>}
      </div>

      <div className="flex gap-1 border-b border-ink-600/60">
        {(['chain', 'entry', 'exit'] as Tab[]).map((t) => (
          <button
            key={t}
            className={cx('px-4 py-2 text-sm font-medium border-b-2 -mb-px', tab === t ? 'border-accent text-white' : 'border-transparent text-slate-400 hover:text-slate-200')}
            onClick={() => setTab(t)}
          >
            {t === 'chain' ? 'Chain' : t === 'entry' ? 'Entry scan' : 'Exit rules'}
          </button>
        ))}
      </div>

      {tab === 'chain' && <ChainView symbol={activeSymbol} expiration={expiration} />}
      {tab === 'entry' && <EntryScanView symbol={activeSymbol} expiration={expiration} />}
      {tab === 'exit' && <ExitRulesView />}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Chain
// ----------------------------------------------------------------------------
function ChainView({ symbol, expiration }: { symbol: string; expiration: string }) {
  const [side, setSide] = useState<'call' | 'put'>('call');
  const chain = useAsync<OptionsChain>(() => client.chain(symbol, expiration), [symbol, expiration]);

  if (!expiration) return <Card><EmptyState title="Pick a symbol and expiration" /></Card>;
  if (chain.loading) return <Spinner label="Loading chain…" />;
  if (chain.error) return <Card><ErrorState error={chain.error} onRetry={chain.reload} /></Card>;
  if (!chain.data) return null;

  const contracts = side === 'call' ? chain.data.calls : chain.data.puts;
  const u = chain.data.underlyingPrice ?? null;
  const anyComputed = contracts.some((c) => c.greeks?.computed);

  return (
    <Card className="overflow-x-auto">
      <div className="flex items-center justify-between p-3 border-b border-ink-600/60">
        <div className="text-sm text-slate-400">
          {symbol} {expiration} · underlying <span className="text-slate-200">{fmtUsd(u)}</span>
        </div>
        <div className="flex rounded-md overflow-hidden border border-ink-600 text-sm">
          <button className={cx('px-3 py-1', side === 'call' ? 'bg-bull/20 text-bull' : 'text-slate-400')} onClick={() => setSide('call')}>Calls</button>
          <button className={cx('px-3 py-1', side === 'put' ? 'bg-bear/20 text-bear' : 'text-slate-400')} onClick={() => setSide('put')}>Puts</button>
        </div>
      </div>
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th text-right">Strike</th>
            <th className="th text-right">Bid</th>
            <th className="th text-right">Ask</th>
            <th className="th text-right">Mark</th>
            <th className="th text-right">Vol</th>
            <th className="th text-right">OI</th>
            <th className="th text-right">IV</th>
            <th className="th text-right">Δ</th>
            <th className="th text-right">Θ</th>
            <th className="th text-right">Γ</th>
            <th className="th text-right">ν</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((c) => {
            const itm = side === 'call' ? u !== null && c.strike < u : u !== null && c.strike > u;
            return (
              <tr key={c.symbol} className={cx('border-b border-ink-700/50', itm && 'bg-ink-700/30')}>
                <td className="td text-right font-semibold">{fmtNum(c.strike)}</td>
                <td className="td text-right">{fmtNum(c.bid)}</td>
                <td className="td text-right">{fmtNum(c.ask)}</td>
                <td className="td text-right">{fmtNum(c.mark)}</td>
                <td className="td text-right text-slate-400">{c.volume ?? '—'}</td>
                <td className="td text-right text-slate-400">{c.openInterest ?? '—'}</td>
                <td className="td text-right">{c.greeks?.iv === undefined ? '—' : `${(c.greeks.iv * 100).toFixed(0)}%`}</td>
                <td className="td text-right">{fmtNum(c.greeks?.delta, 3)}</td>
                <td className="td text-right text-slate-400">{fmtNum(c.greeks?.theta, 3)}</td>
                <td className="td text-right text-slate-400">{fmtNum(c.greeks?.gamma, 4)}</td>
                <td className="td text-right text-slate-400">{fmtNum(c.greeks?.vega, 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyComputed && (
        <div className="p-2 text-[11px] text-slate-500">Greeks marked here are computed locally via Black–Scholes (provider didn't supply them).</div>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Entry scan
// ----------------------------------------------------------------------------
function EntryScanView({ symbol, expiration }: { symbol: string; expiration: string }) {
  const def = useAsync(() => client.entryDefault(), []);
  const presets = useAsync(() => client.presets('option_entry'), []);
  const [cfg, setCfg] = useState<EntryStrategyConfig | null>(null);
  const config = cfg ?? def.data ?? null;
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.entryScan>>>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error>();
  const [expanded, setExpanded] = useState<string | null>(null);

  const set = <K extends keyof EntryStrategyConfig>(k: K, v: EntryStrategyConfig[K]) =>
    setCfg((c) => ({ ...(c ?? (def.data as EntryStrategyConfig)), [k]: v }));

  const run = async () => {
    if (!config || !expiration) return;
    setRunning(true);
    setError(undefined);
    try {
      setResult(await client.entryScan({ symbol, expiration, config }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(false);
    }
  };

  if (!config) return <Spinner />;

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <Card className="p-4 lg:w-72 shrink-0 space-y-3">
        <h3 className="font-medium">Entry strategy</h3>
        <Field label="Side">
          <select className="input" value={config.side} onChange={(e) => set('side', e.target.value as 'call' | 'put')}>
            <option value="call">Long call</option>
            <option value="put">Long put</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Delta min"><NumberInput value={config.deltaMin} onChange={(v) => set('deltaMin', v ?? 0)} step={0.05} /></Field>
          <Field label="Delta max"><NumberInput value={config.deltaMax} onChange={(v) => set('deltaMax', v ?? 1)} step={0.05} /></Field>
          <Field label="Max spread %"><NumberInput value={config.maxSpreadPct} onChange={(v) => set('maxSpreadPct', v ?? 10)} /></Field>
          <Field label="Min OI"><NumberInput value={config.minOpenInterest} onChange={(v) => set('minOpenInterest', v ?? 0)} /></Field>
          <Field label="Min volume"><NumberInput value={config.minVolume} onChange={(v) => set('minVolume', v ?? 0)} /></Field>
          <Field label="Min DTE"><NumberInput value={config.minDaysToExpiration} onChange={(v) => set('minDaysToExpiration', v)} /></Field>
          <Field label="Max DTE"><NumberInput value={config.maxDaysToExpiration} onChange={(v) => set('maxDaysToExpiration', v)} /></Field>
          <Field label="IV min %"><NumberInput value={config.ivMin === undefined ? undefined : config.ivMin * 100} onChange={(v) => set('ivMin', v === undefined ? undefined : v / 100)} /></Field>
          <Field label="IV max %"><NumberInput value={config.ivMax === undefined ? undefined : config.ivMax * 100} onChange={(v) => set('ivMax', v === undefined ? undefined : v / 100)} /></Field>
        </div>
        <button className="btn-primary w-full" onClick={run} disabled={running || !expiration}>{running ? 'Scanning…' : 'Scan contracts'}</button>
        <PresetBar
          kind="option_entry"
          presets={presets.data?.presets ?? []}
          onLoad={(c) => setCfg(c as EntryStrategyConfig)}
          getConfig={() => config}
          onChanged={presets.reload}
        />
      </Card>

      <div className="flex-1 min-w-0">
        {error && <Card><ErrorState error={error} onRetry={run} /></Card>}
        {!result && !error && <Card><EmptyState title="Configure a strategy and scan" hint="Candidates are ranked by spread tightness, liquidity, and how well delta fits your band — with the full rule breakdown." /></Card>}
        {result && (
          <Card className="overflow-x-auto">
            <div className="p-3 text-sm text-slate-400 border-b border-ink-600/60">
              {result.candidates.filter((c) => c.passed).length} pass / {result.candidates.length} evaluated · underlying {fmtUsd(result.underlyingPrice)}
            </div>
            <table className="w-full">
              <thead className="border-b border-ink-600/60">
                <tr>
                  <th className="th">Contract</th>
                  <th className="th text-right">Mark</th>
                  <th className="th text-right">Δ</th>
                  <th className="th text-right">IV</th>
                  <th className="th text-right">Spread</th>
                  <th className="th text-right">OI/Vol</th>
                  <th className="th text-right">DTE</th>
                  <th className="th">Score</th>
                  <th className="th">Rules</th>
                </tr>
              </thead>
              <tbody>
                {result.candidates.map((cand) => {
                  const c: OptionContract = cand.contract;
                  const id = c.symbol;
                  const open = expanded === id;
                  return (
                    <Fragment key={id}>
                      <tr className={cx('border-b border-ink-700/50', !cand.passed && 'opacity-50')}>
                        <td className="td font-medium">{fmtNum(c.strike)} {c.type === 'call' ? 'C' : 'P'}</td>
                        <td className="td text-right">{fmtNum(cand.metrics.mark)}</td>
                        <td className="td text-right">{fmtNum(cand.metrics.delta, 3)}</td>
                        <td className="td text-right">{cand.metrics.iv === null ? '—' : `${(cand.metrics.iv * 100).toFixed(0)}%`}</td>
                        <td className="td text-right">{cand.metrics.spreadPct === null ? '—' : `${fmtNum(cand.metrics.spreadPct, 1)}%`}</td>
                        <td className="td text-right text-slate-400">{cand.metrics.openInterest ?? '—'}/{cand.metrics.volume ?? '—'}</td>
                        <td className="td text-right">{cand.metrics.dte.toFixed(0)}</td>
                        <td className="td"><ScoreBar value={cand.score} /></td>
                        <td className="td">
                          <button className="text-xs" onClick={() => setExpanded(open ? null : id)}>
                            {cand.passed ? <Badge color="green">pass</Badge> : <Badge color="red">fail</Badge>} {open ? '▾' : '▸'}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-ink-900/40">
                          <td colSpan={9} className="px-3 py-2">
                            <div className="flex flex-wrap gap-2">
                              {cand.rules.map((r) => (
                                <span key={r.rule} className={cx('chip', r.passed ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear')} title={r.detail}>
                                  {r.passed ? '✓' : '✕'} {r.rule}: {r.detail}
                                </span>
                              ))}
                            </div>
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
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Exit rules
// ----------------------------------------------------------------------------
function ExitRulesView() {
  const def = useAsync(() => client.exitDefault(), []);
  const presets = useAsync(() => client.presets('option_exit'), []);
  const [cfg, setCfg] = useState<ExitRulesConfig | null>(null);
  const config = cfg ?? def.data ?? null;
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.exitCheck>>>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error>();

  const set = <K extends keyof ExitRulesConfig>(k: K, v: ExitRulesConfig[K]) =>
    setCfg((c) => ({ ...(c ?? (def.data as ExitRulesConfig)), [k]: v }));

  const run = async () => {
    if (!config) return;
    setRunning(true);
    setError(undefined);
    try {
      setResult(await client.exitCheck(config));
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(false);
    }
  };

  if (!config) return <Spinner />;

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <Card className="p-4 lg:w-72 shrink-0 space-y-3">
        <h3 className="font-medium">Exit rules</h3>
        <Field label="Take-profit %"><NumberInput value={config.takeProfitPct} onChange={(v) => set('takeProfitPct', v)} /></Field>
        <Field label="Stop-loss %"><NumberInput value={config.stopLossPct} onChange={(v) => set('stopLossPct', v)} /></Field>
        <Field label="Exit N days before expiry"><NumberInput value={config.timeExitDaysBeforeExpiry} onChange={(v) => set('timeExitDaysBeforeExpiry', v)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="|Δ| min"><NumberInput value={config.deltaMin} onChange={(v) => set('deltaMin', v)} step={0.05} /></Field>
          <Field label="|Δ| max"><NumberInput value={config.deltaMax} onChange={(v) => set('deltaMax', v)} step={0.05} /></Field>
        </div>
        <button className="btn-primary w-full" onClick={run} disabled={running}>{running ? 'Checking…' : 'Check open positions'}</button>
        <PresetBar
          kind="option_exit"
          presets={presets.data?.presets ?? []}
          onLoad={(c) => setCfg(c as ExitRulesConfig)}
          getConfig={() => config}
          onChanged={presets.reload}
        />
      </Card>

      <div className="flex-1 min-w-0">
        {error && <Card><ErrorState error={error} onRetry={run} /></Card>}
        {!result && !error && <Card><EmptyState title="Evaluate exit rules against open option positions" hint="Add option positions in the Positions tab, then check which exit rule (if any) is currently triggered." /></Card>}
        {result && result.evaluations.length === 0 && <Card><EmptyState title="No open option positions" hint="Log an option position in the Positions tab to use the exit engine." /></Card>}
        {result && result.evaluations.length > 0 && (
          <Card className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-600/60">
                <tr>
                  <th className="th">Position</th>
                  <th className="th text-right">Entry</th>
                  <th className="th text-right">Mark</th>
                  <th className="th text-right">P&L</th>
                  <th className="th text-right">DTE</th>
                  <th className="th text-right">Δ</th>
                  <th className="th">Triggered</th>
                </tr>
              </thead>
              <tbody>
                {result.evaluations.map((ev) => (
                  <tr key={ev.position.id} className={cx('border-b border-ink-700/50', ev.evaluation.triggered && 'bg-amber-500/5')}>
                    <td className="td">{ev.position.symbol} {fmtNum(ev.position.strike)} {ev.position.optionType === 'call' ? 'C' : 'P'} {ev.position.expiration}</td>
                    <td className="td text-right">{fmtNum(ev.position.entryPrice)}</td>
                    <td className="td text-right">{fmtNum(ev.currentMark)}</td>
                    <td className={cx('td text-right', (ev.evaluation.unrealizedPct ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{fmtPct(ev.evaluation.unrealizedPct)}</td>
                    <td className="td text-right">{ev.evaluation.dte.toFixed(1)}</td>
                    <td className="td text-right">{fmtNum(ev.currentDelta, 3)}</td>
                    <td className="td">
                      {ev.evaluation.triggered ? (
                        <span title={ev.evaluation.triggers.filter((t) => t.triggered).map((t) => t.detail).join(' · ')}>
                          <Badge color="amber">{ev.evaluation.activeRule}</Badge>
                        </span>
                      ) : (
                        <span className="text-slate-500 text-xs">hold</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}

// Shared preset save/load control for option strategies.
function PresetBar({
  kind,
  presets,
  onLoad,
  getConfig,
  onChanged,
}: {
  kind: string;
  presets: { id: number; name: string; config: unknown }[];
  onLoad: (config: unknown) => void;
  getConfig: () => unknown;
  onChanged: () => void;
}) {
  return (
    <div className="border-t border-ink-700 pt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-500">Presets</span>
        <button
          className="text-xs text-accent"
          onClick={async () => {
            const name = window.prompt('Save preset as:');
            if (!name) return;
            await client.savePreset(name, kind, getConfig());
            onChanged();
          }}
        >
          + Save
        </button>
      </div>
      {presets.length ? (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <span key={p.id} className="chip bg-ink-600 text-slate-300">
              <button className="hover:text-accent" onClick={() => onLoad(p.config)}>{p.name}</button>
              <button
                className="text-slate-500 hover:text-bear ml-1"
                onClick={async () => {
                  await client.deletePreset(p.id);
                  onChanged();
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-slate-600">none saved</div>
      )}
    </div>
  );
}

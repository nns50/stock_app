import { ReactNode, useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
import { ago, cx, fmtDate, fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  Spinner,
  StatTile,
} from '../components/ui';
import type {
  AutotradeDecideResponse,
  AutotradeRiskCheckResult,
  AutotradeRiskProfile,
  BacktestEquityPoint,
  BacktestRunResponse,
  BacktestStats,
  SimulatedTrade,
  WalkForwardResponse,
} from '../api/types';

// Foundations + Research & Screen + Decision + Risk Check (Phases 1-4 of
// docs/AUTOTRADING_SPEC.md). Read-only end to end: this page configures and
// observes the auto-trading initiative, it never places an order — Execution
// is the only stage left before the live-trading gate.

// A plain value renders directly; an array/object would otherwise coerce to
// "[object Object]" in a template literal (e.g. a risk-check event's `checks`
// array) — summarize those instead so the journal never shows that.
function summarizeDetailValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) {
    if (v.every((item) => typeof item !== 'object' || item === null)) return v.join(', ');
    // A risk-check `checks` array ({rule, passed, detail}) — the common case —
    // summarizes as pass/fail counts and which rule(s) failed.
    if (v.every((item) => item && typeof item === 'object' && 'rule' in item && 'passed' in item)) {
      const checks = v as { rule: string; passed: boolean }[];
      const failed = checks.filter((c) => !c.passed);
      return failed.length === 0
        ? `${checks.length} checks, all passed`
        : `${failed.length}/${checks.length} failed: ${failed.map((c) => c.rule).join(', ')}`;
    }
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function detailText(detail: string | null): string {
  if (!detail) return '—';
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${summarizeDetailValue(v)}`)
        .join(', ');
    }
    return String(parsed);
  } catch {
    return detail;
  }
}

function ScreenSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearAgoStr(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function BacktestStatsGrid({ stats }: { stats: BacktestStats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <StatTile label="Trades" value={stats.totalTrades} sub={`${stats.wins}W / ${stats.losses}L`} />
      <StatTile label="Win rate" value={fmtPct(stats.winRate, 0, false)} />
      <StatTile
        label="Expectancy"
        value={fmtSignedUsd(stats.expectancy)}
        valueClass={stats.expectancy >= 0 ? 'text-bull' : 'text-bear'}
      />
      <StatTile label="Profit factor" value={stats.profitFactor === null ? '—' : fmtNum(stats.profitFactor)} />
      <StatTile
        label="Avg R"
        value={stats.avgR === null ? '—' : `${fmtNum(stats.avgR)}R`}
        valueClass={stats.avgR !== null && stats.avgR >= 0 ? 'text-bull' : 'text-bear'}
      />
      <StatTile
        label="Return"
        value={fmtPct(stats.returnPct, 1)}
        valueClass={stats.returnPct >= 0 ? 'text-bull' : 'text-bear'}
      />
      <StatTile label="Max drawdown" value={fmtUsd(stats.maxDrawdown)} valueClass="text-bear" />
      <StatTile label="Streaks" value={`${stats.longestWinStreak}W / ${stats.longestLossStreak}L`} />
    </div>
  );
}

function BacktestEquityChart({ equityCurve, gradientId }: { equityCurve: BacktestEquityPoint[]; gradientId: string }) {
  if (equityCurve.length === 0) {
    return <p className="text-xs text-slate-500 py-6 text-center">No simulated trading days in this window.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={equityCurve} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--chart-grid)' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          domain={['auto', 'auto']}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--chart-tooltip-bg)',
            border: '1px solid var(--chart-grid)',
            borderRadius: 10,
            fontSize: 12,
            boxShadow: '0 12px 34px -12px rgb(0 0 0 / 0.45)',
          }}
          labelStyle={{ color: 'var(--txt-300)' }}
          formatter={(v) => [fmtUsd(Number(v)), 'Equity']}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#38bdf8"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function BacktestTradesTable({ trades }: { trades: SimulatedTrade[] }) {
  if (trades.length === 0) return <p className="text-xs text-slate-500">No trades in this window.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th">Symbol</th>
            <th className="th">Side</th>
            <th className="th">Entry</th>
            <th className="th text-right">Entry $</th>
            <th className="th">Exit</th>
            <th className="th text-right">Exit $</th>
            <th className="th">Reason</th>
            <th className="th text-right">Qty</th>
            <th className="th text-right">P&amp;L</th>
            <th className="th text-right">R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.symbol}-${t.entryDate}-${i}`} className="border-b border-ink-700/50">
              <td className="td font-semibold">{t.symbol}</td>
              <td className="td">
                <Badge color={t.side === 'buy' ? 'green' : 'red'}>{t.side}</Badge>
              </td>
              <td className="td text-slate-400">{fmtDate(t.entryDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(t.entryPrice)}</td>
              <td className="td text-slate-400">{fmtDate(t.exitDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(t.exitPrice)}</td>
              <td className="td">
                <Badge color={t.exitReason === 'target' ? 'green' : t.exitReason === 'stop' ? 'red' : 'slate'}>
                  {t.exitReason.replace('_', ' ')}
                </Badge>
              </td>
              <td className="td text-right tabular-nums">{t.quantity}</td>
              <td className={cx('td text-right tabular-nums', t.pnl >= 0 ? 'text-bull' : 'text-bear')}>
                {fmtSignedUsd(t.pnl)}
              </td>
              <td className={cx('td text-right tabular-nums', t.rMultiple >= 0 ? 'text-bull' : 'text-bear')}>
                {fmtNum(t.rMultiple)}R
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BacktestWindowResult({
  title,
  hint,
  run,
  gradientId,
}: {
  title: string;
  hint: string;
  run: BacktestRunResponse;
  gradientId: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-400">{title}</h4>
        <p className="text-[11px] text-slate-500">{hint}</p>
      </div>
      <BacktestStatsGrid stats={run.stats} />
      <BacktestEquityChart equityCurve={run.report.equityCurve} gradientId={gradientId} />
      <BacktestTradesTable trades={run.report.trades} />
    </div>
  );
}

export default function AutoTradePage() {
  const config = useAsync(() => client.autotradeConfig(), []);
  const exclusions = useAsync(() => client.autotradeExclusions(), []);
  const events = useAsync(() => client.autotradeEvents({ limit: 50 }), []);
  const { toast } = useToast();
  const confirm = useConfirm();

  const [enabled, setEnabled] = useState(false);
  const [riskProfile, setRiskProfile] = useState<AutotradeRiskProfile>('MODERATE');
  const [equityDraft, setEquityDraft] = useState<number | undefined>();
  useEffect(() => {
    if (!config.data) return;
    setEnabled(config.data.enabled);
    setRiskProfile(config.data.riskProfile);
    setEquityDraft(config.data.accountEquityUsd ?? undefined);
  }, [config.data]);

  const saveConfig = async (patch: {
    enabled?: boolean;
    riskProfile?: AutotradeRiskProfile;
    accountEquityUsd?: number | null;
  }) => {
    if (patch.riskProfile === 'AGGRESSIVE' && riskProfile !== 'AGGRESSIVE') {
      const ok = await confirm({
        title: 'Switch to AGGRESSIVE?',
        body: 'Aggressive raises per-trade risk, the daily drawdown halt, concurrent positions, max aggregate open risk, correlated-ticker exposure, and the daily trade cap. This should be a deliberate choice, not a default.',
        confirmLabel: 'Switch to Aggressive',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const saved = await client.setAutotradeConfig({
        ...patch,
        confirmAggressive: patch.riskProfile === 'AGGRESSIVE' ? true : undefined,
      });
      setEnabled(saved.enabled);
      setRiskProfile(saved.riskProfile);
      config.reload(); // keeps config.data — the equity-not-set warning's source of truth — fresh
      toast('Auto-trading settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save settings', { type: 'error' });
    }
  };

  const [newSymbol, setNewSymbol] = useState('');
  const [newReason, setNewReason] = useState('');
  const addExclusion = async () => {
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol) return;
    try {
      await client.addAutotradeExclusion({ symbol, reason: newReason.trim() || undefined });
      setNewSymbol('');
      setNewReason('');
      exclusions.reload();
      toast(`${symbol} added to the exclusion list`, { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not add exclusion', { type: 'error' });
    }
  };
  const removeExclusion = async (symbol: string) => {
    const ok = await confirm({
      title: `Remove ${symbol} from the exclusion list?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await client.removeAutotradeExclusion(symbol);
      exclusions.reload();
      toast(`${symbol} removed`, { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not remove exclusion', { type: 'error' });
    }
  };

  const [screenBusy, setScreenBusy] = useState(false);
  const [result, setResult] = useState<AutotradeDecideResponse>();
  const [riskResults, setRiskResults] = useState<AutotradeRiskCheckResult[]>([]);
  const [screenErr, setScreenErr] = useState<string>();
  const runScreen = async () => {
    setScreenBusy(true);
    setScreenErr(undefined);
    try {
      const decided = await client.runAutotradeDecision();
      setResult(decided);
      setRiskResults(
        decided.decision.signals.length ? (await client.runAutotradeRiskCheck(decided.decision.signals)).results : [],
      );
      events.reload();
    } catch (e) {
      setScreenErr((e as Error).message || 'Screen failed');
    } finally {
      setScreenBusy(false);
    }
  };

  const exclusionRows = exclusions.data?.exclusions ?? [];
  const eventRows = events.data?.events ?? [];
  const screenResult = result?.screen;
  const signalBySymbol = new Map((result?.decision.signals ?? []).map((s) => [s.symbol, s]));
  const riskBySymbol = new Map(riskResults.map((r) => [r.symbol, r]));

  const [btSymbols, setBtSymbols] = useState('');
  const [btFrom, setBtFrom] = useState(yearAgoStr);
  const [btTo, setBtTo] = useState(todayStr);
  const [btSplitDate, setBtSplitDate] = useState('');
  const [btRiskProfile, setBtRiskProfile] = useState<AutotradeRiskProfile>('MODERATE');
  const [btEquity, setBtEquity] = useState<number | undefined>(100_000);
  const [btBusy, setBtBusy] = useState(false);
  const [btErr, setBtErr] = useState<string>();
  const [btResult, setBtResult] = useState<BacktestRunResponse>();
  const [btWfResult, setBtWfResult] = useState<WalkForwardResponse>();
  // The from/to/splitDate a result actually came from — captured at submit time so
  // the "In-sample (X → Y)" labels below never drift from the form if it's edited
  // again before the response comes back.
  const [btSubmitted, setBtSubmitted] = useState<{ from: string; to: string; splitDate: string }>();

  const runBacktest = async () => {
    const symbols = Array.from(
      new Set(
        btSymbols
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!symbols.length) {
      setBtErr('Enter at least one symbol');
      return;
    }
    if (!btFrom || !btTo || !btEquity) {
      setBtErr('From, to, and starting equity are required');
      return;
    }
    setBtBusy(true);
    setBtErr(undefined);
    setBtResult(undefined);
    setBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = { symbols, from: btFrom, to: btTo, riskProfile: btRiskProfile, startingEquity: btEquity };
      if (btSplitDate) {
        setBtWfResult(await client.runAutotradeWalkForward({ ...body, splitDate: btSplitDate }));
      } else {
        setBtResult(await client.runAutotradeBacktest(body));
      }
    } catch (e) {
      setBtErr((e as Error).message || 'Backtest failed');
    } finally {
      setBtBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Auto-Trade"
        subtitle="Foundations for the automated-trading initiative (docs/AUTOTRADING_SPEC.md). Screening,
          real-estate exclusion, and signal generation are wired up; risk checks and execution are later phases.
          Nothing here places an order."
      />

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Configuration</h3>
        {config.loading ? (
          <Spinner />
        ) : config.error ? (
          <ErrorState error={config.error} onRetry={config.reload} />
        ) : (
          <div className="grid sm:grid-cols-2 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => saveConfig({ enabled: e.target.checked })} />
              Auto-trading enabled
            </label>
            <Field
              label="Risk profile"
              hint={
                riskProfile === 'AGGRESSIVE'
                  ? 'Higher risk/trade, drawdown halt, position count, aggregate risk, and trade caps.'
                  : 'Default — the conservative caps.'
              }
            >
              <select
                className="input"
                value={riskProfile}
                onChange={(e) => saveConfig({ riskProfile: e.target.value as AutotradeRiskProfile })}
              >
                <option value="MODERATE">Moderate (default)</option>
                <option value="AGGRESSIVE">Aggressive</option>
              </select>
            </Field>
            <Field
              label="Account equity ($)"
              hint="The risk engine sizes trades and computes its % caps against this. No live broker balance is wired in yet — set it manually."
            >
              <div className="flex gap-2">
                <NumberInput value={equityDraft} onChange={setEquityDraft} placeholder="e.g. 25000" />
                <button
                  className="btn-ghost shrink-0"
                  onClick={() => saveConfig({ accountEquityUsd: equityDraft ?? null })}
                  disabled={equityDraft === (config.data?.accountEquityUsd ?? undefined)}
                >
                  Save
                </button>
              </div>
            </Field>
          </div>
        )}
        {config.data && config.data.accountEquityUsd === null && (
          <p className="text-[11px] text-bear mt-3">
            Account equity isn&apos;t set — the risk engine blocks every trade until it is (fails closed rather than
            guessing).
          </p>
        )}
        {enabled && (
          <p className="text-[11px] text-amber-400 mt-3">
            Auto-trading is enabled, but nothing acts on it yet — the execution loop (a later phase) hasn&apos;t been
            built.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Real-estate exclusion list</h3>
        <div className="grid sm:grid-cols-4 gap-2 items-end mb-3">
          <Field label="Symbol">
            <input
              className="input"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="O"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason (optional)">
              <input
                className="input"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="REIT"
              />
            </Field>
          </div>
          <button className="btn-primary" onClick={addExclusion}>
            Add
          </button>
        </div>
        {exclusions.loading ? (
          <Spinner />
        ) : exclusions.error ? (
          <ErrorState error={exclusions.error} onRetry={exclusions.reload} />
        ) : exclusionRows.length === 0 ? (
          <EmptyState
            title="No exclusions"
            hint="Add a symbol above — the sector/industry classification check also catches unlisted REITs."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Symbol</th>
                <th className="th">Reason</th>
                <th className="th">Source</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {exclusionRows.map((e) => (
                <tr key={e.symbol} className="border-b border-ink-700/50">
                  <td className="td font-semibold">{e.symbol}</td>
                  <td className="td text-slate-400">{e.reason || '—'}</td>
                  <td className="td">
                    <Badge color={e.source === 'default' ? 'slate' : 'blue'}>{e.source}</Badge>
                  </td>
                  <td className="td text-right">
                    <button
                      className="text-xs text-slate-500 hover:text-bear"
                      onClick={() => removeExclusion(e.symbol)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-sm">Research, Screen &amp; Decide</h3>
          <button className="btn-primary" onClick={runScreen} disabled={screenBusy}>
            {screenBusy ? 'Scanning…' : 'Run screen'}
          </button>
        </div>
        {screenErr && <div className="text-bear text-sm mb-2">{screenErr}</div>}
        {screenResult ? (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Scanned {screenResult.discovery.scannedCount} symbols ({screenResult.discovery.universeCount} universe
              {screenResult.discovery.moversCount > 0 ? ` + ${screenResult.discovery.moversCount} movers` : ''}) ·
              generated {ago(screenResult.generatedAt)}
            </p>
            <ScreenSection title={`Candidates (${screenResult.candidates.length})`}>
              {screenResult.candidates.length === 0 ? (
                <p className="text-xs text-slate-500">No candidates passed screening this run.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-ink-600/60">
                      <tr>
                        <th className="th">Symbol</th>
                        <th className="th text-right">Price</th>
                        <th className="th text-right">Score</th>
                        <th className="th text-right">Gap</th>
                        <th className="th text-right">Rel Vol</th>
                        <th className="th">Source</th>
                        <th className="th text-right">Entry</th>
                        <th className="th text-right">Stop</th>
                        <th className="th text-right">Target</th>
                        <th className="th text-right">R</th>
                        <th className="th text-right">Qty</th>
                        <th className="th">Risk check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {screenResult.candidates.map((c) => {
                        const signal = signalBySymbol.get(c.symbol);
                        const risk = riskBySymbol.get(c.symbol);
                        const failing = risk?.checks.filter((chk) => !chk.passed) ?? [];
                        return (
                          <tr key={c.symbol} className="border-b border-ink-700/50">
                            <td className="td font-semibold">{c.symbol}</td>
                            <td className="td text-right tabular-nums">{fmtUsd(c.price)}</td>
                            <td className="td text-right tabular-nums">{fmtNum(c.total, 1)}</td>
                            <td className="td text-right tabular-nums">
                              {c.indicators.gapPct === null ? '—' : fmtPct(c.indicators.gapPct)}
                            </td>
                            <td className="td text-right tabular-nums">
                              {c.indicators.relVolume === null ? '—' : `${fmtNum(c.indicators.relVolume)}×`}
                            </td>
                            <td className="td">
                              <Badge color={c.discoverySource === 'movers' ? 'green' : 'slate'}>
                                {c.discoverySource}
                              </Badge>
                            </td>
                            <td className="td text-right tabular-nums" title={signal?.rationale}>
                              {signal ? fmtUsd(signal.entry) : '—'}
                            </td>
                            <td className="td text-right tabular-nums text-bear">
                              {signal ? fmtUsd(signal.stop) : '—'}
                            </td>
                            <td className="td text-right tabular-nums text-bull">
                              {signal ? fmtUsd(signal.target) : '—'}
                            </td>
                            <td className="td text-right tabular-nums">{signal ? `${signal.rMultiple}R` : '—'}</td>
                            <td className="td text-right tabular-nums">
                              {risk && risk.ok ? risk.sizing.suggestedQuantity : '—'}
                            </td>
                            <td className="td">
                              {!risk ? (
                                '—'
                              ) : risk.ok ? (
                                <Badge color="green">approved</Badge>
                              ) : (
                                <span title={failing.map((chk) => `${chk.rule}: ${chk.detail}`).join('\n')}>
                                  <Badge color="red">blocked</Badge>{' '}
                                  <span className="text-[11px] text-slate-500">{failing[0]?.rule}</span>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </ScreenSection>
            {result && result.decision.skipped.length > 0 && (
              <ScreenSection title={`No signal — insufficient volatility history (${result.decision.skipped.length})`}>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  {result.decision.skipped.map((s) => (
                    <li key={s.symbol}>
                      <span className="font-semibold text-slate-300">{s.symbol}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
            {screenResult.excluded.length > 0 && (
              <ScreenSection title={`Excluded — real estate (${screenResult.excluded.length})`}>
                <ul className="text-xs text-slate-400 space-y-0.5">
                  {screenResult.excluded.map((e) => (
                    <li key={e.symbol}>
                      <span className="font-semibold text-slate-300">{e.symbol}</span> — {e.reason}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
            {screenResult.skipped.length > 0 && (
              <ScreenSection title={`Skipped — unverified sector (${screenResult.skipped.length})`}>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  {screenResult.skipped.map((s) => (
                    <li key={s.symbol}>
                      <span className="font-semibold text-slate-300">{s.symbol}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
            {screenResult.errors.length > 0 && (
              <ScreenSection title={`Errors (${screenResult.errors.length})`}>
                <ul className="text-xs text-bear space-y-0.5">
                  {screenResult.errors.map((e) => (
                    <li key={e.symbol}>
                      <span className="font-semibold">{e.symbol}</span> — {e.message}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
          </div>
        ) : (
          !screenErr && (
            <p className="text-xs text-slate-500">
              Scans the universe (plus Webull&apos;s pre-market movers, if configured) for volume-breakout candidates,
              screening out real estate first, then computes an ATR-based stop and reward:risk target for each one that
              clears, then sizes and risk-checks it against the active profile&apos;s caps (daily drawdown, concurrent
              positions, max aggregate open risk, correlated-ticker exposure, daily trade cap). Read-only — nothing here
              places an order.
            </p>
          )
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Backtest &amp; walk-forward</h3>
        <p className="text-xs text-slate-500 mb-3">
          Replays Screen → Decision → Risk Check day-by-day over historical daily bars, using the exact same logic the
          live loop uses — the validation gate docs/AUTOTRADING_SPEC.md requires before any paper or live trading. Leave
          &quot;Out-of-sample split&quot; blank for a single-window backtest, or set it to split the run into in-sample
          vs out-of-sample windows (a strategy that only performs in-sample should look weak or negative out-of-sample).
          Read-only — nothing here places an order.
        </p>
        <div className="grid sm:grid-cols-3 gap-3 items-end mb-3">
          <div className="sm:col-span-3">
            <Field label="Symbols (comma-separated)">
              <input
                className="input"
                value={btSymbols}
                onChange={(e) => setBtSymbols(e.target.value.toUpperCase())}
                placeholder="AAPL, MSFT, NVDA"
              />
            </Field>
          </div>
          <Field label="From">
            <input type="date" className="input" value={btFrom} onChange={(e) => setBtFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" className="input" value={btTo} onChange={(e) => setBtTo(e.target.value)} />
          </Field>
          <Field label="Out-of-sample split (optional)" hint="Splits into in-sample / out-of-sample when set.">
            <input type="date" className="input" value={btSplitDate} onChange={(e) => setBtSplitDate(e.target.value)} />
          </Field>
          <Field label="Backtest risk profile" hint="Independent of the live Configuration risk profile above.">
            <select
              className="input"
              value={btRiskProfile}
              onChange={(e) => setBtRiskProfile(e.target.value as AutotradeRiskProfile)}
            >
              <option value="MODERATE">Moderate</option>
              <option value="AGGRESSIVE">Aggressive</option>
            </select>
          </Field>
          <Field label="Starting equity ($)">
            <NumberInput value={btEquity} onChange={setBtEquity} placeholder="e.g. 100000" />
          </Field>
          <button className="btn-primary" onClick={runBacktest} disabled={btBusy}>
            {btBusy ? 'Running…' : btSplitDate ? 'Run walk-forward' : 'Run backtest'}
          </button>
        </div>
        {btErr && <div className="text-bear text-sm mb-2">{btErr}</div>}
        {btResult && (
          <div className="space-y-3">
            {btResult.report.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {btResult.report.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            <BacktestStatsGrid stats={btResult.stats} />
            <BacktestEquityChart equityCurve={btResult.report.equityCurve} gradientId="btEquityPlain" />
            <BacktestTradesTable trades={btResult.report.trades} />
          </div>
        )}
        {btWfResult && btSubmitted && (
          <div className="space-y-5">
            {btWfResult.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {btWfResult.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            <BacktestWindowResult
              title={`In-sample (${btSubmitted.from} → ${btSubmitted.splitDate})`}
              hint="The tuning window — strong performance here alone proves nothing."
              run={btWfResult.inSample}
              gradientId="btEquityIn"
            />
            <BacktestWindowResult
              title={`Out-of-sample (${btSubmitted.splitDate} → ${btSubmitted.to})`}
              hint="Unseen data — this is the number that matters for the validation gate."
              run={btWfResult.outOfSample}
              gradientId="btEquityOut"
            />
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Recent activity</h3>
        {events.loading ? (
          <Spinner />
        ) : events.error ? (
          <ErrorState error={events.error} onRetry={events.reload} />
        ) : eventRows.length === 0 ? (
          <EmptyState
            title="No activity yet"
            hint="Run a screen above, or change a setting, to see journal entries here."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">When</th>
                <th className="th">Stage</th>
                <th className="th">Action</th>
                <th className="th">Symbol</th>
                <th className="th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {eventRows.map((e) => (
                <tr key={e.id} className="border-b border-ink-700/50">
                  <td className="td text-slate-500 text-xs whitespace-nowrap">{ago(e.createdAt)}</td>
                  <td className="td">
                    <Badge>{e.stage}</Badge>
                  </td>
                  <td className="td">{e.action}</td>
                  <td className="td font-semibold">{e.symbol || '—'}</td>
                  <td className="td text-slate-500 text-xs max-w-[280px] truncate" title={detailText(e.detail)}>
                    {detailText(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-[11px] text-slate-500">
        Decision-support and tracking only — this scans, sizes, and journals but never places an order. See
        docs/AUTOTRADING_SPEC.md for the full plan; the execution loop and live-trading gate are still upcoming phases.
      </p>
    </div>
  );
}

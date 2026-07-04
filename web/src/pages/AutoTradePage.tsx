import { ReactNode, useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
import { RefreshBar } from '../components/RefreshBar';
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
  AutotradeConfig,
  AutotradeDashboard,
  AutotradeDecideResponse,
  AutotradeLivePosition,
  AutotradeOptionsRiskCheckResult,
  AutotradeOptionsStrategyType,
  AutotradeRiskCheckResult,
  AutotradeRiskProfile,
  BacktestEquityPoint,
  BacktestRunResponse,
  BacktestStats,
  CombinedBacktestRunResponse,
  CombinedWalkForwardResponse,
  LoopTickSummary,
  OptionsBacktestRunResponse,
  OptionsPaperPosition,
  OptionsWalkForwardResponse,
  PaperPosition,
  SimulatedOptionsTrade,
  SimulatedTrade,
  WalkForwardResponse,
} from '../api/types';

// Phases 1-8 of docs/AUTOTRADING_SPEC.md: config, real-estate exclusions,
// Screen/Decision/Risk-Check preview, backtesting, the paper execution loop,
// a real-time monitoring dashboard + kill switch, and live trading. Paper
// trading is always a local simulation, independent of live trading — which
// DOES place real orders once explicitly enabled (a typed confirmation phrase,
// not per-order, per Phase 8's confirmed design).

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

function OptionsBacktestTradesTable({ trades }: { trades: SimulatedOptionsTrade[] }) {
  if (trades.length === 0) return <p className="text-xs text-slate-500">No trades in this window.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th">Symbol</th>
            <th className="th">Contract</th>
            <th className="th">Entry</th>
            <th className="th text-right">Entry $</th>
            <th className="th">Exit</th>
            <th className="th text-right">Exit $</th>
            <th className="th">Reason</th>
            <th className="th text-right">Contracts</th>
            <th className="th text-right">P&amp;L</th>
            <th className="th text-right">R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.symbol}-${t.entryDate}-${i}`} className="border-b border-ink-700/50">
              <td className="td font-semibold">{t.symbol}</td>
              <td className="td">
                <Badge color={t.side === 'call' ? 'green' : 'red'}>
                  {t.side} {t.strike}
                </Badge>{' '}
                <span className="text-[11px] text-slate-500">{fmtDate(t.expiration)}</span>
              </td>
              <td className="td text-slate-400">{fmtDate(t.entryDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(t.entryPremium)}</td>
              <td className="td text-slate-400">{fmtDate(t.exitDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(t.exitPremium)}</td>
              <td className="td">
                <Badge color={t.exitReason === 'end_of_period' ? 'slate' : 'blue'}>
                  {t.exitReason.replace('_', ' ')}
                </Badge>
              </td>
              <td className="td text-right tabular-nums">{t.contracts}</td>
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

function OptionsBacktestWindowResult({
  title,
  hint,
  run,
  gradientId,
}: {
  title: string;
  hint: string;
  run: OptionsBacktestRunResponse;
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
      <OptionsBacktestTradesTable trades={run.report.trades} />
    </div>
  );
}

/** Unlike the two independent overlays above, ONE stats grid/equity chart —
 *  computed server-side over BOTH trade lists together — plus two trade
 *  tables underneath it (equity's own shape and options' own shape are too
 *  different to merge into one table without losing fields either side needs). */
function CombinedBacktestWindowResult({
  title,
  hint,
  run,
  gradientId,
}: {
  title: string;
  hint: string;
  run: CombinedBacktestRunResponse;
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
      <BacktestTradesTable trades={run.report.equityTrades} />
      <OptionsBacktestTradesTable trades={run.report.optionsTrades} />
    </div>
  );
}

/** Realized P&L for a closed position (from its own exitPrice); unrealized
 *  P&L for an open one, from the live quote the server resolved this request
 *  (server/src/routes/autotrade.ts's withLivePrices) — null only when that
 *  quote itself couldn't be resolved (provider down, nothing cached either). */
function paperPnl(p: PaperPosition): number | null {
  if (p.status === 'open') return p.unrealizedPnl;
  if (p.exitPrice === null) return null;
  const sign = p.side === 'buy' ? 1 : -1;
  return (p.exitPrice - p.entryPrice) * p.quantity * sign;
}

function PaperPositionsTable({ positions }: { positions: PaperPosition[] }) {
  if (positions.length === 0) {
    return (
      <EmptyState
        title="No paper trades yet"
        hint='Enable auto-trading above, or click "Run one cycle now" below, to see paper fills here.'
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th">Symbol</th>
            <th className="th">Side</th>
            <th className="th">Status</th>
            <th className="th">Entry</th>
            <th className="th text-right">Entry $</th>
            <th className="th text-right">Current $</th>
            <th className="th">Exit</th>
            <th className="th text-right">Exit $</th>
            <th className="th">Reason</th>
            <th className="th text-right">Qty</th>
            <th className="th text-right">P&amp;L</th>
            <th className="th text-right">R</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const pnl = paperPnl(p);
            const rMultiple = pnl !== null && p.riskAmount > 0 ? pnl / p.riskAmount : null;
            return (
              <tr key={p.id} className="border-b border-ink-700/50">
                <td className="td font-semibold" title={p.rationale}>
                  {p.symbol}
                </td>
                <td className="td">
                  <Badge color={p.side === 'buy' ? 'green' : 'red'}>{p.side}</Badge>
                </td>
                <td className="td">
                  <Badge color={p.status === 'open' ? 'blue' : 'slate'}>{p.status}</Badge>
                </td>
                <td className="td text-slate-400">{ago(p.entryAt)}</td>
                <td className="td text-right tabular-nums">{fmtUsd(p.entryPrice)}</td>
                <td className="td text-right tabular-nums">
                  {p.status === 'open' && p.currentPrice !== null ? (
                    <>
                      {fmtUsd(p.currentPrice)}
                      {p.stale && (
                        <span className="chip bg-amber-500/15 text-amber-400 ml-1" title="last-known cached price">
                          stale
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="td text-slate-400">{p.exitAt ? ago(p.exitAt) : '—'}</td>
                <td className="td text-right tabular-nums">{p.exitPrice === null ? '—' : fmtUsd(p.exitPrice)}</td>
                <td className="td">
                  {p.exitReason ? (
                    <Badge color={p.exitReason === 'target' ? 'green' : p.exitReason === 'stop' ? 'red' : 'slate'}>
                      {p.exitReason}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="td text-right tabular-nums">{p.quantity}</td>
                <td
                  className={cx('td text-right tabular-nums', pnl === null ? '' : pnl >= 0 ? 'text-bull' : 'text-bear')}
                >
                  {pnl === null ? '—' : fmtSignedUsd(pnl)}
                </td>
                <td
                  className={cx(
                    'td text-right tabular-nums',
                    rMultiple === null ? '' : rMultiple >= 0 ? 'text-bull' : 'text-bear',
                  )}
                >
                  {rMultiple === null ? '—' : `${fmtNum(rMultiple)}R`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The position's own $ value — entry cost, live mark, or exit value — as ONE
 *  unit: the raw premium for single_leg, or long-minus-short for a debit
 *  spread. Null when a needed leg's price isn't available. */
function optionsPaperEntryValue(p: OptionsPaperPosition): number {
  return p.kind === 'debit_spread' ? p.entryPrice - (p.shortEntryPrice ?? 0) : p.entryPrice;
}
function optionsPaperCurrentValue(p: OptionsPaperPosition): number | null {
  if (p.status !== 'open' || p.currentPrice === null) return null;
  if (p.kind === 'debit_spread') {
    if (p.shortCurrentPrice === null) return null;
    return p.currentPrice - p.shortCurrentPrice;
  }
  return p.currentPrice;
}
function optionsPaperExitValue(p: OptionsPaperPosition): number | null {
  if (p.exitPrice === null) return null;
  return p.kind === 'debit_spread' ? p.exitPrice - (p.shortExitPrice ?? 0) : p.exitPrice;
}

/** Realized P&L for a closed options paper position; unrealized for an open
 *  one, from the live contract mark(s) the server resolved this request
 *  (server/src/routes/autotrade.ts's withLiveOptionMarks). No sign flip for
 *  single_leg — every single-leg position is long the contract itself; a
 *  debit spread nets its two legs' values first (optionsPaperExitValue/
 *  optionsPaperEntryValue above). */
function optionsPaperPnl(p: OptionsPaperPosition): number | null {
  if (p.status === 'open') return p.unrealizedPnl;
  const exitValue = optionsPaperExitValue(p);
  if (exitValue === null) return null;
  return (exitValue - optionsPaperEntryValue(p)) * p.quantity * 100;
}

function OptionsPaperPositionsTable({ positions }: { positions: OptionsPaperPosition[] }) {
  if (positions.length === 0) {
    return (
      <EmptyState
        title="No options paper trades yet"
        hint='Enable auto-trading above, or click "Run one cycle now" below, to see options paper fills here.'
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th">Symbol</th>
            <th className="th">Contract</th>
            <th className="th">Status</th>
            <th className="th">Entry</th>
            <th className="th text-right">Entry $</th>
            <th className="th text-right">Current $</th>
            <th className="th">Exit</th>
            <th className="th text-right">Exit $</th>
            <th className="th">Reason</th>
            <th className="th text-right">Qty</th>
            <th className="th text-right">P&amp;L</th>
            <th className="th text-right">R</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const pnl = optionsPaperPnl(p);
            const rMultiple = pnl !== null && p.riskAmount > 0 ? pnl / p.riskAmount : null;
            const currentValue = optionsPaperCurrentValue(p);
            const exitValue = optionsPaperExitValue(p);
            return (
              <tr key={p.id} className="border-b border-ink-700/50">
                <td className="td font-semibold" title={p.rationale}>
                  {p.symbol}
                </td>
                <td className="td">
                  <Badge color={p.side === 'call' ? 'green' : 'red'}>
                    {p.side} {p.strike}
                    {p.kind === 'debit_spread' ? `/${p.shortStrike}` : ''}
                  </Badge>{' '}
                  <span className="text-[11px] text-slate-500">{fmtDate(p.expiration)}</span>
                </td>
                <td className="td">
                  <Badge color={p.status === 'open' ? 'blue' : 'slate'}>{p.status}</Badge>
                </td>
                <td className="td text-slate-400">{ago(p.entryAt)}</td>
                <td className="td text-right tabular-nums">{fmtUsd(optionsPaperEntryValue(p))}</td>
                <td className="td text-right tabular-nums">{currentValue === null ? '—' : fmtUsd(currentValue)}</td>
                <td className="td text-slate-400">{p.exitAt ? ago(p.exitAt) : '—'}</td>
                <td className="td text-right tabular-nums">{exitValue === null ? '—' : fmtUsd(exitValue)}</td>
                <td className="td">
                  {p.exitReason ? (
                    <Badge color={p.exitReason === 'time_exit' ? 'blue' : 'slate'}>
                      {p.exitReason.replace('_', ' ')}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="td text-right tabular-nums">{p.quantity}</td>
                <td
                  className={cx('td text-right tabular-nums', pnl === null ? '' : pnl >= 0 ? 'text-bull' : 'text-bear')}
                >
                  {pnl === null ? '—' : fmtSignedUsd(pnl)}
                </td>
                <td
                  className={cx(
                    'td text-right tabular-nums',
                    rMultiple === null ? '' : rMultiple >= 0 ? 'text-bull' : 'text-bear',
                  )}
                >
                  {rMultiple === null ? '—' : `${fmtNum(rMultiple)}R`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** REAL, live-money positions the autotrade loop itself placed — the exact
 *  same `positions` table row a manual trade uses, filtered server-side to
 *  the `autotrade` tag (server/src/routes/autotrade.ts's /live-positions).
 *  Distinct from every paper table on this page: nothing here is simulated. */
function LivePositionsTable({ positions }: { positions: AutotradeLivePosition[] }) {
  if (positions.length === 0) {
    return (
      <EmptyState
        title="No live positions yet"
        hint="Once live trading places a real order and it fills, it shows up here."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-ink-600/60">
          <tr>
            <th className="th">Symbol</th>
            <th className="th">Side</th>
            <th className="th">Status</th>
            <th className="th">Entry</th>
            <th className="th text-right">Entry $</th>
            <th className="th text-right">Current $</th>
            <th className="th text-right">Qty</th>
            <th className="th text-right">P&amp;L</th>
            <th className="th text-right">R</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const isOption = p.assetType === 'option';
            const qty = p.remainingQuantity === p.quantity ? p.quantity : `${p.remainingQuantity}/${p.quantity}`;
            return (
              <tr key={p.id} className="border-b border-ink-700/50">
                <td className="td font-semibold" title={p.notes ?? undefined}>
                  {p.symbol}
                  {isOption && (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {fmtNum(p.strike)} {p.optionType === 'call' ? 'C' : 'P'} {p.expiration}
                    </span>
                  )}
                </td>
                <td className="td">
                  <Badge color={p.side === 'long' ? 'green' : 'red'}>{p.side}</Badge>
                </td>
                <td className="td">
                  <Badge color={p.status === 'open' ? 'blue' : 'slate'}>{p.status}</Badge>
                </td>
                <td className="td text-slate-400">{fmtDate(p.entryDate)}</td>
                <td className="td text-right tabular-nums">{fmtUsd(p.entryPrice)}</td>
                <td className="td text-right tabular-nums">
                  {p.currentPrice !== null ? (
                    <>
                      {fmtUsd(p.currentPrice)}
                      {p.stale && (
                        <span className="chip bg-amber-500/15 text-amber-400 ml-1" title="last-known cached price">
                          stale
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="td text-right tabular-nums">{qty}</td>
                <td className={cx('td text-right tabular-nums', p.pnl.totalPnl >= 0 ? 'text-bull' : 'text-bear')}>
                  {fmtSignedUsd(p.pnl.totalPnl)}
                </td>
                <td
                  className={cx(
                    'td text-right tabular-nums',
                    p.pnl.rMultiple === null ? '' : p.pnl.rMultiple >= 0 ? 'text-bull' : 'text-bear',
                  )}
                >
                  {p.pnl.rMultiple === null ? '—' : `${fmtNum(p.pnl.rMultiple)}R`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PaperTrackRecord {
  total: number;
  closed: number;
  wins: number;
  /** 0-100 scale (a %), matching services/pnl.ts's own winRate convention and
   *  fmtPct()'s expected input — NOT a 0-1 fraction. */
  winRate: number | null;
  earliestEntry: number | null;
  latestEntry: number | null;
}

/** Surfaced next to the live-enable control so a human can review the paper
 *  track record before flipping the switch — NOT a code-enforced gate (the
 *  Phase 8 "track record gate" resolved decision: purely the user's judgment
 *  call, matching how AGGRESSIVE-vs-MODERATE has no enforced graduation
 *  criteria either). */
function paperTrackRecord(positions: PaperPosition[]): PaperTrackRecord {
  const closedPositions = positions.filter((p) => p.status === 'closed');
  const wins = closedPositions.filter((p) => (paperPnl(p) ?? 0) > 0);
  const entryTimes = positions.map((p) => p.entryAt);
  return {
    total: positions.length,
    closed: closedPositions.length,
    wins: wins.length,
    winRate: closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : null,
    earliestEntry: entryTimes.length ? Math.min(...entryTimes) : null,
    latestEntry: entryTimes.length ? Math.max(...entryTimes) : null,
  };
}

interface LiveTradingSectionProps {
  config: AutotradeConfig;
  paperPositions: PaperPosition[];
  liveAccountIdDraft: string;
  setLiveAccountIdDraft: (v: string) => void;
  liveMaxOrderUsdDraft: number | undefined;
  setLiveMaxOrderUsdDraft: (v: number | undefined) => void;
  liveMaxDailyLossUsdDraft: number | undefined;
  setLiveMaxDailyLossUsdDraft: (v: number | undefined) => void;
  liveMaxOrdersPerDayDraft: number | undefined;
  setLiveMaxOrdersPerDayDraft: (v: number | undefined) => void;
  liveFatFingerPctDraft: number | undefined;
  setLiveFatFingerPctDraft: (v: number | undefined) => void;
  liveAllowNakedShortDraft: boolean;
  setLiveAllowNakedShortDraft: (v: boolean) => void;
  liveProbationTradesDraft: number | undefined;
  setLiveProbationTradesDraft: (v: number | undefined) => void;
  liveProbationSizeMultiplierDraft: number | undefined;
  setLiveProbationSizeMultiplierDraft: (v: number | undefined) => void;
  liveCapsBusy: boolean;
  onSaveLiveCaps: () => void;
  confirmLiveText: string;
  setConfirmLiveText: (v: string) => void;
  confirmPhrase: string;
  liveEnableBusy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  dashboard: AutotradeDashboard | undefined;
}

function LiveTradingSection(p: LiveTradingSectionProps) {
  const track = paperTrackRecord(p.paperPositions);
  const canEnable =
    p.liveAccountIdDraft.trim() !== '' && p.confirmLiveText.trim().toUpperCase() === p.confirmPhrase.toUpperCase();

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3 items-end">
        <Field
          label="Webull account ID"
          hint="Server-side only — never sourced from the browser, unlike the Trade page."
        >
          <input
            className="input"
            value={p.liveAccountIdDraft}
            onChange={(e) => p.setLiveAccountIdDraft(e.target.value)}
            placeholder="e.g. 1234567_INDIVIDUAL_CASH"
            disabled={p.config.liveTradingEnabled}
          />
        </Field>
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Live guardrail caps</h4>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Max order ($)">
            <NumberInput value={p.liveMaxOrderUsdDraft} onChange={p.setLiveMaxOrderUsdDraft} placeholder="e.g. 20000" />
          </Field>
          <Field label="Max daily loss ($)">
            <NumberInput
              value={p.liveMaxDailyLossUsdDraft}
              onChange={p.setLiveMaxDailyLossUsdDraft}
              placeholder="e.g. 3000"
            />
          </Field>
          <Field label="Max orders/day">
            <NumberInput
              value={p.liveMaxOrdersPerDayDraft}
              onChange={p.setLiveMaxOrdersPerDayDraft}
              placeholder="e.g. 6"
            />
          </Field>
          <Field label="Fat-finger (%)" hint="Limit price must sit within this % of the reference price.">
            <NumberInput value={p.liveFatFingerPctDraft} onChange={p.setLiveFatFingerPctDraft} placeholder="e.g. 10" />
          </Field>
          <Field label="Probation trades" hint="First N live trades after enabling get an extra size cut.">
            <NumberInput
              value={p.liveProbationTradesDraft}
              onChange={p.setLiveProbationTradesDraft}
              placeholder="e.g. 20"
            />
          </Field>
          <Field label="Probation size multiplier" hint="e.g. 0.5 = half size during probation.">
            <NumberInput
              value={p.liveProbationSizeMultiplierDraft}
              onChange={p.setLiveProbationSizeMultiplierDraft}
              placeholder="e.g. 0.5"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm mt-3">
          <input
            type="checkbox"
            checked={p.liveAllowNakedShortDraft}
            onChange={(e) => p.setLiveAllowNakedShortDraft(e.target.checked)}
          />
          Allow naked short (defined-risk only is strongly recommended — leave unchecked)
        </label>
        <button className="btn-ghost mt-3" onClick={p.onSaveLiveCaps} disabled={p.liveCapsBusy}>
          {p.liveCapsBusy ? 'Saving…' : 'Save live-trading settings'}
        </button>
      </div>

      <div className="rounded-lg border border-ink-600 bg-ink-700/40 p-3">
        <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-1">Paper track record (for your review)</h4>
        <p className="text-[11px] text-slate-500 mb-2">
          Not an enforced gate — reviewing this before enabling live trading is your call.
        </p>
        {track.total === 0 ? (
          <p className="text-sm text-slate-400">No paper trades yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="Paper trades" value={track.total} sub={`${track.closed} closed`} />
            <StatTile label="Win rate" value={track.winRate === null ? '—' : fmtPct(track.winRate, 0, false)} />
            <StatTile
              label="From"
              value={track.earliestEntry ? fmtDate(new Date(track.earliestEntry).toISOString()) : '—'}
            />
            <StatTile label="To" value={track.latestEntry ? fmtDate(new Date(track.latestEntry).toISOString()) : '—'} />
          </div>
        )}
      </div>

      {p.config.liveTradingEnabled ? (
        <div className="rounded-lg border border-bear/60 bg-bear/10 p-3 space-y-2">
          <p className="text-sm font-semibold text-bear">● LIVE TRADING ENABLED</p>
          <p className="text-[11px] text-slate-400">
            Account {p.config.liveAccountId} — the loop places real orders on its own schedule, no per-order
            confirmation.
          </p>
          {p.dashboard?.probation.active && (
            <p className="text-[11px] text-amber-400">
              Probation active: {p.dashboard.probation.tradesRemaining} of {p.config.liveProbationTrades} trades
              remaining at {p.dashboard.probation.multiplier}× size.
            </p>
          )}
          <button className="btn-ghost" onClick={p.onDisable} disabled={p.liveEnableBusy}>
            {p.liveEnableBusy ? 'Disabling…' : 'Disable live trading'}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-ink-600 bg-ink-700/40 p-3 space-y-2">
          <p className="text-sm font-medium">Enable live trading</p>
          <p className="text-[11px] text-slate-500">
            One-time confirmation, not per-order — type <strong>{p.confirmPhrase}</strong> below and set an account ID
            above to arm it.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="input max-w-[260px] font-mono"
              value={p.confirmLiveText}
              onChange={(e) => p.setConfirmLiveText(e.target.value.toUpperCase())}
              placeholder={p.confirmPhrase}
              aria-label="type to confirm enabling live trading"
            />
            <button
              className="btn-primary !bg-bear !border-bear disabled:opacity-40"
              onClick={p.onEnable}
              disabled={p.liveEnableBusy || !canEnable}
            >
              {p.liveEnableBusy ? 'Enabling…' : 'Enable live trading'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Phase 7's real-time panel (docs/AUTOTRADING_SPEC.md — MONITORING & KILL
 *  SWITCH): active profile, open paper positions vs the concurrent cap,
 *  aggregate open risk used vs limit, day P&L vs the drawdown halt, trade
 *  count vs max, and the consecutive-loss streak. Every "used vs limit" pair
 *  here is a direct read of the server's own risk-check math (dashboard.ts),
 *  not re-derived in the UI. */
function MonitoringDashboard({ dash }: { dash: AutotradeDashboard }) {
  const riskBusy = dash.maxAggregateOpenRisk > 0 && dash.openRisk >= dash.maxAggregateOpenRisk;
  const positionsBusy = dash.openPositionsCount >= dash.maxConcurrentPositions;
  const tradesBusy = dash.tradesToday >= dash.maxTradesPerDay;
  const stepDownActive = dash.consecutiveLosses >= dash.stepDownAfterLosses;
  // dailyDrawdownHaltLevel is 0 (equity unset) when the halt has no real
  // meaning yet — guard the same way riskBusy guards an unconfigured $0 cap,
  // so a fresh/unconfigured account never misreads as "halted."
  const haltActive = dash.dailyDrawdownHaltLevel < 0 && dash.dailyPnl <= dash.dailyDrawdownHaltLevel;

  // Phase 8: live is its OWN pool (see dashboard.ts's header comment) — the
  // caps are the same profile numbers as paper's above, but "used" is never
  // combined with paper's, matching how runLiveExecution()/runPaperExecution()
  // each risk-check against only their own snapshot.
  const liveRiskBusy = dash.maxAggregateOpenRisk > 0 && dash.liveOpenRisk >= dash.maxAggregateOpenRisk;
  const livePositionsBusy = dash.liveOpenPositionsCount >= dash.maxConcurrentPositions;
  const liveTradesBusy = dash.liveTradesToday >= dash.maxTradesPerDay;
  const liveStepDownActive = dash.liveConsecutiveLosses >= dash.stepDownAfterLosses;
  const liveHaltActive = dash.dailyDrawdownHaltLevel < 0 && dash.liveDailyPnl <= dash.dailyDrawdownHaltLevel;

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Paper</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <StatTile
            label="Risk profile"
            value={dash.riskProfile === 'AGGRESSIVE' ? 'Aggressive' : 'Moderate'}
            sub={dash.killSwitch ? 'kill switch engaged' : dash.enabled ? 'loop enabled' : 'loop disabled'}
            valueClass={dash.killSwitch ? 'text-bear' : undefined}
          />
          <StatTile
            label="Open positions"
            value={`${dash.openPositionsCount} / ${dash.maxConcurrentPositions}`}
            sub={`${dash.openPositions.length} equity + ${dash.openOptionsPositions.length} options`}
            valueClass={positionsBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Aggregate open risk"
            value={fmtUsd(dash.openRisk)}
            sub={`of ${fmtUsd(dash.maxAggregateOpenRisk)} cap (equity + options combined)`}
            valueClass={riskBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Day P&L"
            value={fmtSignedUsd(dash.dailyPnl)}
            sub={
              haltActive ? (
                <span className="text-bear font-semibold">HALT TRIGGERED — new entries blocked</span>
              ) : (
                `halt at ${fmtUsd(dash.dailyDrawdownHaltLevel)}`
              )
            }
            valueClass={dash.dailyPnl >= 0 ? 'text-bull' : 'text-bear'}
          />
          <StatTile
            label="Trades today"
            value={`${dash.tradesToday} / ${dash.maxTradesPerDay}`}
            valueClass={tradesBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Consecutive losses"
            value={dash.consecutiveLosses}
            sub={stepDownActive ? 'step-down active' : `of ${dash.stepDownAfterLosses} to step-down`}
            valueClass={stepDownActive ? 'text-bear' : undefined}
          />
        </div>
      </div>

      {dash.openOptionsPositions.length > 0 && (
        <div>
          <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">
            Options expirations — folded into the combined caps above, not a second pool
          </h4>
          <div className="space-y-1">
            {dash.openOptionsPositions
              .slice()
              .sort((a, b) => a.dte - b.dte)
              .map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <span>
                    <span className="font-semibold">{p.symbol}</span>{' '}
                    <Badge color={p.side === 'call' ? 'green' : 'red'}>
                      {p.side} {p.strike}
                    </Badge>{' '}
                    <span className="text-[11px] text-slate-500">{fmtDate(p.expiration)}</span>
                  </span>
                  <span className={cx('tabular-nums', p.dte <= 7 ? 'text-bear font-semibold' : 'text-slate-400')}>
                    {p.dte.toFixed(1)}d
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">
          Live{' '}
          {dash.liveTradingEnabled ? (
            <span className="text-bear normal-case">● enabled</span>
          ) : (
            <span className="normal-case">(disabled)</span>
          )}
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <StatTile
            label="Open positions"
            value={`${dash.liveOpenPositionsCount} / ${dash.maxConcurrentPositions}`}
            valueClass={livePositionsBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Aggregate open risk"
            value={fmtUsd(dash.liveOpenRisk)}
            sub={`of ${fmtUsd(dash.maxAggregateOpenRisk)} cap`}
            valueClass={liveRiskBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Day P&L"
            value={fmtSignedUsd(dash.liveDailyPnl)}
            sub={
              liveHaltActive ? (
                <span className="text-bear font-semibold">HALT TRIGGERED</span>
              ) : (
                `halt at ${fmtUsd(dash.dailyDrawdownHaltLevel)}`
              )
            }
            valueClass={dash.liveDailyPnl >= 0 ? 'text-bull' : 'text-bear'}
          />
          <StatTile
            label="Trades today"
            value={`${dash.liveTradesToday} / ${dash.maxTradesPerDay}`}
            valueClass={liveTradesBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Consecutive losses"
            value={dash.liveConsecutiveLosses}
            sub={liveStepDownActive ? 'step-down active' : `of ${dash.stepDownAfterLosses} to step-down`}
            valueClass={liveStepDownActive ? 'text-bear' : undefined}
          />
          <StatTile
            label="Probation"
            value={dash.probation.active ? `${dash.probation.multiplier}× size` : 'complete'}
            sub={dash.probation.active ? `${dash.probation.tradesRemaining} trades left` : undefined}
            valueClass={dash.probation.active ? 'text-amber-400' : undefined}
          />
        </div>
      </div>
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
  const paperPositions = useAsync(() => client.autotradePaperPositions({ limit: 100 }), []);
  const optionsPaperPositions = useAsync(() => client.autotradeOptionsPaperPositions({ limit: 100 }), []);
  const livePositions = useAsync(() => client.autotradeLivePositions({ limit: 100 }), []);
  const dashboard = useAsync(() => client.autotradeDashboard(), []);
  const { toast } = useToast();
  const confirm = useConfirm();

  // Monitoring, Paper trading, and Recent activity all reflect state the
  // background loop can change on its own, every 60s, with nothing the user
  // clicked — unlike Configuration/exclusions/backtest, which only change in
  // response to a direct action. One shared refresh (manual + opt-in polling,
  // matching this app's "polling is opt-in" convention) covers all three
  // instead of three separate controls a user could easily leave out of sync.
  const [liveDataLastUpdated, setLiveDataLastUpdated] = useState<number | null>(null);
  const refreshLiveData = () => {
    setLiveDataLastUpdated(Date.now());
    dashboard.reload();
    paperPositions.reload();
    optionsPaperPositions.reload();
    livePositions.reload();
    events.reload();
  };

  const [enabled, setEnabled] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [riskProfile, setRiskProfile] = useState<AutotradeRiskProfile>('MODERATE');
  const [optionsStrategyType, setOptionsStrategyType] = useState<AutotradeOptionsStrategyType>('single_leg');
  const [equityDraft, setEquityDraft] = useState<number | undefined>();
  const [liveAccountIdDraft, setLiveAccountIdDraft] = useState('');
  const [liveMaxOrderUsdDraft, setLiveMaxOrderUsdDraft] = useState<number | undefined>();
  const [liveMaxDailyLossUsdDraft, setLiveMaxDailyLossUsdDraft] = useState<number | undefined>();
  const [liveMaxOrdersPerDayDraft, setLiveMaxOrdersPerDayDraft] = useState<number | undefined>();
  const [liveFatFingerPctDraft, setLiveFatFingerPctDraft] = useState<number | undefined>();
  const [liveAllowNakedShortDraft, setLiveAllowNakedShortDraft] = useState(false);
  const [liveProbationTradesDraft, setLiveProbationTradesDraft] = useState<number | undefined>();
  const [liveProbationSizeMultiplierDraft, setLiveProbationSizeMultiplierDraft] = useState<number | undefined>();
  useEffect(() => {
    if (!config.data) return;
    setEnabled(config.data.enabled);
    setKillSwitch(config.data.killSwitch);
    setRiskProfile(config.data.riskProfile);
    setOptionsStrategyType(config.data.optionsStrategyType);
    setEquityDraft(config.data.accountEquityUsd ?? undefined);
    setLiveAccountIdDraft(config.data.liveAccountId ?? '');
    setLiveMaxOrderUsdDraft(config.data.liveMaxOrderUsd);
    setLiveMaxDailyLossUsdDraft(config.data.liveMaxDailyLossUsd);
    setLiveMaxOrdersPerDayDraft(config.data.liveMaxOrdersPerDay);
    setLiveFatFingerPctDraft(config.data.liveFatFingerPct);
    setLiveAllowNakedShortDraft(config.data.liveAllowNakedShort);
    setLiveProbationTradesDraft(config.data.liveProbationTrades);
    setLiveProbationSizeMultiplierDraft(config.data.liveProbationSizeMultiplier);
  }, [config.data]);

  const saveConfig = async (patch: {
    enabled?: boolean;
    riskProfile?: AutotradeRiskProfile;
    accountEquityUsd?: number | null;
    optionsStrategyType?: AutotradeOptionsStrategyType;
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
      setOptionsStrategyType(saved.optionsStrategyType);
      config.reload(); // keeps config.data — the equity-not-set warning's source of truth — fresh
      refreshLiveData(); // risk profile / equity changes shift the dashboard's caps, and get journaled
      toast('Auto-trading settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save settings', { type: 'error' });
    }
  };

  const [equitySyncBusy, setEquitySyncBusy] = useState(false);
  const syncEquityFromBroker = async () => {
    setEquitySyncBusy(true);
    try {
      const result = await client.syncAutotradeEquity();
      if (!result.ok) {
        toast(result.error ?? 'Could not sync equity from Webull', { type: 'error' });
        return;
      }
      setEquityDraft(result.netLiquidationUsd);
      config.reload();
      refreshLiveData(); // synced equity shifts the dashboard's caps, same as a manual edit
      const prevLabel =
        result.previousEquityUsd != null ? `$${result.previousEquityUsd.toLocaleString('en-US')}` : 'unset';
      toast(`Synced from Webull — ${prevLabel} → $${result.netLiquidationUsd!.toLocaleString('en-US')}`, {
        type: 'success',
      });
    } catch (e) {
      toast((e as Error).message || 'Could not sync equity from Webull', { type: 'error' });
    } finally {
      setEquitySyncBusy(false);
    }
  };

  const [killBusy, setKillBusy] = useState(false);
  const toggleKillSwitch = async () => {
    setKillBusy(true);
    try {
      const next = await client.setAutotradeKillSwitch(!killSwitch);
      setKillSwitch(next.killSwitch);
      config.reload();
      refreshLiveData();
      toast(next.killSwitch ? 'Kill switch engaged — new entries halted' : 'Kill switch released', {
        type: next.killSwitch ? 'info' : 'success',
      });
    } catch (e) {
      toast((e as Error).message || 'Could not toggle the kill switch', { type: 'error' });
    } finally {
      setKillBusy(false);
    }
  };

  const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';
  const [confirmLiveText, setConfirmLiveText] = useState('');
  const [liveCapsBusy, setLiveCapsBusy] = useState(false);
  const [liveEnableBusy, setLiveEnableBusy] = useState(false);

  const saveLiveCaps = async () => {
    setLiveCapsBusy(true);
    try {
      await client.setAutotradeConfig({
        liveAccountId: liveAccountIdDraft.trim() || null,
        liveMaxOrderUsd: liveMaxOrderUsdDraft,
        liveMaxDailyLossUsd: liveMaxDailyLossUsdDraft,
        liveMaxOrdersPerDay: liveMaxOrdersPerDayDraft,
        liveFatFingerPct: liveFatFingerPctDraft,
        liveAllowNakedShort: liveAllowNakedShortDraft,
        liveProbationTrades: liveProbationTradesDraft,
        liveProbationSizeMultiplier: liveProbationSizeMultiplierDraft,
      });
      config.reload();
      refreshLiveData();
      toast('Live-trading settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save live-trading settings', { type: 'error' });
    } finally {
      setLiveCapsBusy(false);
    }
  };

  const enableLiveTrading = async () => {
    setLiveEnableBusy(true);
    try {
      await client.setAutotradeConfig({
        liveAccountId: liveAccountIdDraft.trim() || null,
        liveTradingEnabled: true,
        confirmLiveTrading: confirmLiveText.trim(),
      });
      setConfirmLiveText('');
      config.reload();
      refreshLiveData();
      toast('Live trading enabled — the loop will place real orders on its next cycle', { type: 'info' });
    } catch (e) {
      toast((e as Error).message || 'Could not enable live trading', { type: 'error' });
    } finally {
      setLiveEnableBusy(false);
    }
  };

  const disableLiveTrading = async () => {
    setLiveEnableBusy(true);
    try {
      await client.setAutotradeConfig({ liveTradingEnabled: false });
      config.reload();
      refreshLiveData();
      toast('Live trading disabled', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not disable live trading', { type: 'error' });
    } finally {
      setLiveEnableBusy(false);
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
  const [optionsRiskResults, setOptionsRiskResults] = useState<AutotradeOptionsRiskCheckResult[]>([]);
  const [screenErr, setScreenErr] = useState<string>();
  const runScreen = async () => {
    setScreenBusy(true);
    setScreenErr(undefined);
    setResult(undefined); // clear the last run's candidates so a failure can't look like it also ran
    setRiskResults([]);
    setOptionsRiskResults([]);
    try {
      const decided = await client.runAutotradeDecision();
      setResult(decided);
      // Equity risk-check runs first so its approvals can be threaded into the
      // options risk-check's combined budget (services/autotrading/
      // optionsRiskCheck.ts) — an approved equity signal's risk correctly
      // counts against an options candidate's cap this same cycle.
      const equityRisk = decided.decision.signals.length
        ? (await client.runAutotradeRiskCheck(decided.decision.signals)).results
        : [];
      setRiskResults(equityRisk);
      setOptionsRiskResults(
        decided.optionsDecision.signals.length
          ? (await client.runOptionsRiskCheck(decided.optionsDecision.signals, equityRisk)).results
          : [],
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
  const optionsSignalBySymbol = new Map((result?.optionsDecision.signals ?? []).map((s) => [s.symbol, s]));
  const optionsRiskBySymbol = new Map(optionsRiskResults.map((r) => [r.symbol, r]));

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

  const [optBtBusy, setOptBtBusy] = useState(false);
  const [optBtErr, setOptBtErr] = useState<string>();
  const [optBtResult, setOptBtResult] = useState<OptionsBacktestRunResponse>();
  const [optBtWfResult, setOptBtWfResult] = useState<OptionsWalkForwardResponse>();

  // Same form fields as the equity backtest above (symbols/from/to/splitDate/
  // riskProfile/equity) — a human comparing the two overlays wants to run
  // both against the identical window, not fill out a second form.
  const runOptionsBacktest = async () => {
    const symbols = Array.from(
      new Set(
        btSymbols
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!symbols.length) {
      setOptBtErr('Enter at least one symbol');
      return;
    }
    if (!btFrom || !btTo || !btEquity) {
      setOptBtErr('From, to, and starting equity are required');
      return;
    }
    setOptBtBusy(true);
    setOptBtErr(undefined);
    setOptBtResult(undefined);
    setOptBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = { symbols, from: btFrom, to: btTo, riskProfile: btRiskProfile, startingEquity: btEquity };
      if (btSplitDate) {
        setOptBtWfResult(await client.runOptionsWalkForward({ ...body, splitDate: btSplitDate }));
      } else {
        setOptBtResult(await client.runOptionsBacktest(body));
      }
    } catch (e) {
      setOptBtErr((e as Error).message || 'Options backtest failed');
    } finally {
      setOptBtBusy(false);
    }
  };

  const [combinedBtBusy, setCombinedBtBusy] = useState(false);
  const [combinedBtErr, setCombinedBtErr] = useState<string>();
  const [combinedBtResult, setCombinedBtResult] = useState<CombinedBacktestRunResponse>();
  const [combinedBtWfResult, setCombinedBtWfResult] = useState<CombinedWalkForwardResponse>();

  // Same form fields as the two backtests above — additive, not a replacement:
  // genuinely combines equity+options risk in ONE run, rather than the two
  // independent overlays above, which each size against their OWN pool only.
  const runCombinedBacktestClick = async () => {
    const symbols = Array.from(
      new Set(
        btSymbols
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!symbols.length) {
      setCombinedBtErr('Enter at least one symbol');
      return;
    }
    if (!btFrom || !btTo || !btEquity) {
      setCombinedBtErr('From, to, and starting equity are required');
      return;
    }
    setCombinedBtBusy(true);
    setCombinedBtErr(undefined);
    setCombinedBtResult(undefined);
    setCombinedBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = { symbols, from: btFrom, to: btTo, riskProfile: btRiskProfile, startingEquity: btEquity };
      if (btSplitDate) {
        setCombinedBtWfResult(await client.runCombinedWalkForward({ ...body, splitDate: btSplitDate }));
      } else {
        setCombinedBtResult(await client.runCombinedBacktest(body));
      }
    } catch (e) {
      setCombinedBtErr((e as Error).message || 'Combined backtest failed');
    } finally {
      setCombinedBtBusy(false);
    }
  };

  const [loopBusy, setLoopBusy] = useState(false);
  const [loopSummary, setLoopSummary] = useState<LoopTickSummary>();
  const [loopErr, setLoopErr] = useState<string>();
  const runLoopOnce = async () => {
    setLoopBusy(true);
    setLoopErr(undefined);
    setLoopSummary(undefined); // clear the last run's numbers so a failure can't look like it also ran
    try {
      setLoopSummary(await client.runAutotradeLoopOnce());
      refreshLiveData();
    } catch (e) {
      setLoopErr((e as Error).message || 'Loop cycle failed');
    } finally {
      setLoopBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Auto-Trade"
        subtitle="The automated-trading initiative (docs/AUTOTRADING_SPEC.md): screening, signal generation, risk
          checks, backtesting, a paper execution loop, a monitoring dashboard + kill switch, and live trading are all
          wired up. Paper trading never places a real order — it's a local simulation, and runs independently of
          live trading below."
        actions={
          <RefreshBar
            onRefresh={refreshLiveData}
            lastUpdated={liveDataLastUpdated}
            loading={
              dashboard.loading ||
              paperPositions.loading ||
              optionsPaperPositions.loading ||
              livePositions.loading ||
              events.loading
            }
          />
        }
      />

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Configuration</h3>
        {/* Deliberately OUTSIDE the loading/error branch below: it renders
            from local `killSwitch` state, not `config.data`, so a transient
            reload failure (e.g. right after a toggle — saveConfig/
            toggleKillSwitch both fire config.reload() without awaiting it)
            can never hide the one control that releases it. */}
        <button
          onClick={toggleKillSwitch}
          disabled={killBusy}
          className={cx(
            'w-full rounded-lg border px-3 py-2 text-sm font-semibold transition-colors mb-3',
            killSwitch
              ? 'border-bear bg-bear/20 text-bear'
              : 'border-ink-600 bg-ink-700/40 text-slate-300 hover:border-bear/60',
          )}
        >
          {killSwitch ? '■ Kill switch ENGAGED — release' : 'Kill switch — engage halt'}
        </button>
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
              label="Options strategy"
              hint={
                optionsStrategyType === 'debit_spread'
                  ? 'Long leg + a further out-of-the-money short leg — caps both max loss and max gain.'
                  : 'Long call/put only (default) — uncapped upside, simplest structure.'
              }
            >
              <select
                className="input"
                value={optionsStrategyType}
                onChange={(e) => saveConfig({ optionsStrategyType: e.target.value as AutotradeOptionsStrategyType })}
              >
                <option value="single_leg">Single leg (default)</option>
                <option value="debit_spread">Debit spread</option>
              </select>
            </Field>
            <Field
              label="Account equity ($)"
              hint={
                config.data?.liveAccountId
                  ? 'The risk engine sizes trades and computes its % caps against this. Set manually, or sync it from your live Webull account below.'
                  : 'The risk engine sizes trades and computes its % caps against this. Set manually — or set a Webull account ID under Live trading below to sync it instead.'
              }
            >
              <div className="flex flex-col gap-2">
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
                <button
                  className="btn-ghost self-start text-xs"
                  onClick={syncEquityFromBroker}
                  disabled={equitySyncBusy || !config.data?.liveAccountId}
                  title={!config.data?.liveAccountId ? 'Set a Webull account ID under Live trading first' : undefined}
                >
                  {equitySyncBusy ? 'Syncing…' : 'Sync from Webull (net liquidation value)'}
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
        {killSwitch && (
          <p className="text-[11px] text-bear mt-3">
            <strong>Kill switch engaged</strong> — new entries are halted regardless of the settings above. Existing
            paper positions keep working: their stop/target levels are still checked every cycle (see &quot;Paper
            trading&quot; below).
          </p>
        )}
        {enabled && !killSwitch && (
          <p className="text-[11px] text-amber-400 mt-3">
            Auto-trading is enabled — the background loop below is now actively scanning and placing{' '}
            <strong>paper</strong> trades on a schedule. It never touches a real broker (see &quot;Paper trading&quot;
            below); going live is configured separately (see &quot;Live trading&quot; below).
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Live trading</h3>
        <p className="text-[11px] text-slate-500 mb-3">
          Places REAL orders through Webull once enabled — no per-order confirmation, only the guardrails configured
          here plus the kill switch. Independent of paper trading above (both can run at once). See
          docs/AUTOTRADING_SPEC.md&apos;s Phase 8 design for the full reasoning.
        </p>
        {/* No separate loading/error rendering here — this card is driven by
            the SAME config request as Configuration above, which already
            shows its own Spinner/ErrorState; repeating it here would just
            show "Something went wrong" twice for one failed request. */}
        {config.data && (
          <LiveTradingSection
            config={config.data}
            paperPositions={paperPositions.data?.positions ?? []}
            liveAccountIdDraft={liveAccountIdDraft}
            setLiveAccountIdDraft={setLiveAccountIdDraft}
            liveMaxOrderUsdDraft={liveMaxOrderUsdDraft}
            setLiveMaxOrderUsdDraft={setLiveMaxOrderUsdDraft}
            liveMaxDailyLossUsdDraft={liveMaxDailyLossUsdDraft}
            setLiveMaxDailyLossUsdDraft={setLiveMaxDailyLossUsdDraft}
            liveMaxOrdersPerDayDraft={liveMaxOrdersPerDayDraft}
            setLiveMaxOrdersPerDayDraft={setLiveMaxOrdersPerDayDraft}
            liveFatFingerPctDraft={liveFatFingerPctDraft}
            setLiveFatFingerPctDraft={setLiveFatFingerPctDraft}
            liveAllowNakedShortDraft={liveAllowNakedShortDraft}
            setLiveAllowNakedShortDraft={setLiveAllowNakedShortDraft}
            liveProbationTradesDraft={liveProbationTradesDraft}
            setLiveProbationTradesDraft={setLiveProbationTradesDraft}
            liveProbationSizeMultiplierDraft={liveProbationSizeMultiplierDraft}
            setLiveProbationSizeMultiplierDraft={setLiveProbationSizeMultiplierDraft}
            liveCapsBusy={liveCapsBusy}
            onSaveLiveCaps={saveLiveCaps}
            confirmLiveText={confirmLiveText}
            setConfirmLiveText={setConfirmLiveText}
            confirmPhrase={LIVE_TRADING_CONFIRMATION_PHRASE}
            liveEnableBusy={liveEnableBusy}
            onEnable={enableLiveTrading}
            onDisable={disableLiveTrading}
            dashboard={dashboard.data}
          />
        )}

        <h4 className="font-medium text-sm mt-5 mb-3 text-bear">
          Live positions — real money, no per-order confirmation
        </h4>
        <p className="text-xs text-slate-500 mb-3">
          The real fills the loop has actually placed through Webull — the same{' '}
          <code className="text-[11px]">positions</code> rows your own manual trades use, tagged so only
          autotrade&apos;s own are shown here. Nothing here is simulated; see the Positions and Journal pages for your
          full real book (autotrade&apos;s fills included, unmarked there).
        </p>
        {livePositions.loading ? (
          <Spinner />
        ) : livePositions.error ? (
          <ErrorState error={livePositions.error} onRetry={livePositions.reload} />
        ) : (
          (() => {
            const rows = livePositions.data?.positions ?? [];
            const open = rows.filter((p) => p.status === 'open');
            const closed = rows.filter((p) => p.status === 'closed');
            const totalRealized = rows.reduce((s, p) => s + p.pnl.realizedPnl, 0);
            const unrealizedTotal = open.reduce((s, p) => s + (p.pnl.unrealizedPnl ?? 0), 0);
            const unrealizedKnown = open.some((p) => p.pnl.unrealizedPnl !== null);
            return (
              <>
                {rows.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <StatTile label="Open" value={open.length} />
                    <StatTile label="Closed" value={closed.length} />
                    <StatTile
                      label="Realized P&L"
                      value={fmtSignedUsd(totalRealized)}
                      valueClass={totalRealized >= 0 ? 'text-bull' : 'text-bear'}
                    />
                    <StatTile
                      label="Unrealized P&L"
                      value={unrealizedKnown ? fmtSignedUsd(unrealizedTotal) : '—'}
                      valueClass={unrealizedKnown ? (unrealizedTotal >= 0 ? 'text-bull' : 'text-bear') : undefined}
                    />
                  </div>
                )}
                <LivePositionsTable positions={rows} />
              </>
            );
          })()
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Monitoring</h3>
        {dashboard.loading && !dashboard.data ? (
          <Spinner />
        ) : dashboard.error ? (
          <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
        ) : dashboard.data ? (
          <MonitoringDashboard dash={dashboard.data} />
        ) : null}
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
                        <th className="th">Options</th>
                      </tr>
                    </thead>
                    <tbody>
                      {screenResult.candidates.map((c) => {
                        const signal = signalBySymbol.get(c.symbol);
                        const risk = riskBySymbol.get(c.symbol);
                        const optSignal = optionsSignalBySymbol.get(c.symbol);
                        const optRisk = optionsRiskBySymbol.get(c.symbol);
                        const failing = risk?.checks.filter((chk) => !chk.passed) ?? [];
                        const optFailing = optRisk?.checks.filter((chk) => !chk.passed) ?? [];
                        const optRiskIsSpread = !!optRisk && 'suggestedContracts' in optRisk.sizing;
                        const optRiskQty = !optRisk
                          ? 0
                          : 'suggestedContracts' in optRisk.sizing
                            ? optRisk.sizing.suggestedContracts
                            : optRisk.sizing.suggestedQuantity;
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
                            <td className="td" title={optSignal?.rationale}>
                              {optSignal ? (
                                <div className="space-y-0.5">
                                  <span className="whitespace-nowrap">
                                    {optSignal.kind === 'single_leg' ? (
                                      <>
                                        <Badge color={optSignal.side === 'call' ? 'green' : 'red'}>
                                          {optSignal.side} {optSignal.strike}
                                        </Badge>{' '}
                                        <span className="text-[11px] text-slate-500">
                                          {fmtUsd(optSignal.premium)} · {fmtDate(optSignal.expiration)}
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <Badge color={optSignal.side === 'call' ? 'green' : 'red'}>
                                          {optSignal.side} {optSignal.longStrike}/{optSignal.shortStrike}
                                        </Badge>{' '}
                                        <span className="text-[11px] text-slate-500">
                                          {fmtUsd(optSignal.netDebit)} debit · {fmtDate(optSignal.expiration)}
                                        </span>
                                      </>
                                    )}
                                  </span>
                                  {optRisk && (
                                    <div>
                                      {optRisk.ok ? (
                                        <span className="whitespace-nowrap">
                                          <Badge color="green">approved</Badge>{' '}
                                          <span className="text-[11px] text-slate-500">
                                            {optRiskQty} {optRiskIsSpread ? 'spread' : 'contract'}
                                            {optRiskQty === 1 ? '' : 's'}
                                          </span>
                                        </span>
                                      ) : (
                                        <span title={optFailing.map((chk) => `${chk.rule}: ${chk.detail}`).join('\n')}>
                                          <Badge color="red">blocked</Badge>{' '}
                                          <span className="text-[11px] text-slate-500">{optFailing[0]?.rule}</span>
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[11px] text-slate-500">—</span>
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
            {result && result.optionsDecision.skipped.length > 0 && (
              <ScreenSection title={`No options signal (${result.optionsDecision.skipped.length})`}>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  {result.optionsDecision.skipped.map((s) => (
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
          &quot;Run options backtest&quot; replays the same window through the options overlay instead (single-leg long
          calls/puts only, gated by the same equity screen) — a separate, independent run, not combined with the equity
          book above. &quot;Run combined backtest&quot; replays the SAME window with both books sharing ONE risk budget
          instead — an approved equity position&apos;s risk counts against an options candidate&apos;s cap that same
          day, and vice versa, exactly like the live loop&apos;s paper execution already enforces. Read-only — nothing
          here places an order.
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
          <div className="flex gap-2 flex-wrap">
            <button className="btn-primary" onClick={runBacktest} disabled={btBusy}>
              {btBusy ? 'Running…' : btSplitDate ? 'Run walk-forward' : 'Run backtest'}
            </button>
            <button
              className="btn-ghost"
              onClick={runOptionsBacktest}
              disabled={optBtBusy}
              title="Replays the same window through the options overlay (phases 9-11) instead of the equity strategy."
            >
              {optBtBusy ? 'Running…' : btSplitDate ? 'Run options walk-forward' : 'Run options backtest'}
            </button>
            <button
              className="btn-ghost"
              onClick={runCombinedBacktestClick}
              disabled={combinedBtBusy}
              title="Replays the same window with equity and options sharing ONE combined risk budget, instead of the two independent overlays above."
            >
              {combinedBtBusy ? 'Running…' : btSplitDate ? 'Run combined walk-forward' : 'Run combined backtest'}
            </button>
          </div>
        </div>
        {btErr && <div className="text-bear text-sm mb-2">{btErr}</div>}
        {btResult && (
          <div className="space-y-3">
            {btResult.report.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {btResult.report.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            {btResult.report.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {btResult.report.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
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
            {btWfResult.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {btWfResult.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
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
        {optBtErr && <div className="text-bear text-sm mb-2">{optBtErr}</div>}
        {optBtResult && (
          <div className="space-y-3">
            <h4 className="text-xs uppercase tracking-wide text-slate-400">Options overlay</h4>
            {optBtResult.report.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {optBtResult.report.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            {optBtResult.report.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {optBtResult.report.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
              </p>
            )}
            <BacktestStatsGrid stats={optBtResult.stats} />
            <BacktestEquityChart equityCurve={optBtResult.report.equityCurve} gradientId="optBtEquityPlain" />
            <OptionsBacktestTradesTable trades={optBtResult.report.trades} />
          </div>
        )}
        {optBtWfResult && btSubmitted && (
          <div className="space-y-5">
            <h4 className="text-xs uppercase tracking-wide text-slate-400">Options overlay</h4>
            {optBtWfResult.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {optBtWfResult.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            {optBtWfResult.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {optBtWfResult.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
              </p>
            )}
            <OptionsBacktestWindowResult
              title={`In-sample (${btSubmitted.from} → ${btSubmitted.splitDate})`}
              hint="The tuning window — strong performance here alone proves nothing."
              run={optBtWfResult.inSample}
              gradientId="optBtEquityIn"
            />
            <OptionsBacktestWindowResult
              title={`Out-of-sample (${btSubmitted.splitDate} → ${btSubmitted.to})`}
              hint="Unseen data — this is the number that matters for the validation gate."
              run={optBtWfResult.outOfSample}
              gradientId="optBtEquityOut"
            />
          </div>
        )}
        {combinedBtErr && <div className="text-bear text-sm mb-2">{combinedBtErr}</div>}
        {combinedBtResult && (
          <div className="space-y-3">
            <h4 className="text-xs uppercase tracking-wide text-slate-400">Combined (one shared risk budget)</h4>
            {combinedBtResult.report.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {combinedBtResult.report.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            {combinedBtResult.report.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {combinedBtResult.report.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
              </p>
            )}
            <BacktestStatsGrid stats={combinedBtResult.stats} />
            <BacktestEquityChart equityCurve={combinedBtResult.report.equityCurve} gradientId="combinedBtEquityPlain" />
            <BacktestTradesTable trades={combinedBtResult.report.equityTrades} />
            <OptionsBacktestTradesTable trades={combinedBtResult.report.optionsTrades} />
          </div>
        )}
        {combinedBtWfResult && btSubmitted && (
          <div className="space-y-5">
            <h4 className="text-xs uppercase tracking-wide text-slate-400">Combined (one shared risk budget)</h4>
            {combinedBtWfResult.excludedSymbols.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Excluded (real estate): {combinedBtWfResult.excludedSymbols.map((e) => e.symbol).join(', ')}
              </p>
            )}
            {combinedBtWfResult.errors.length > 0 && (
              <p className="text-[11px] text-bear">
                Couldn&apos;t fetch data — excluded from this run:{' '}
                {combinedBtWfResult.errors.map((e) => `${e.symbol} (${e.message})`).join(', ')}
              </p>
            )}
            <CombinedBacktestWindowResult
              title={`In-sample (${btSubmitted.from} → ${btSubmitted.splitDate})`}
              hint="The tuning window — strong performance here alone proves nothing."
              run={combinedBtWfResult.inSample}
              gradientId="combinedBtEquityIn"
            />
            <CombinedBacktestWindowResult
              title={`Out-of-sample (${btSubmitted.splitDate} → ${btSubmitted.to})`}
              hint="Unseen data — this is the number that matters for the validation gate."
              run={combinedBtWfResult.outOfSample}
              gradientId="combinedBtEquityOut"
            />
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-sm">Paper trading</h3>
          <button className="btn-primary" onClick={runLoopOnce} disabled={loopBusy}>
            {loopBusy ? 'Running…' : 'Run one cycle now'}
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          When enabled above, the server runs this same Screen → Decision → Risk Check → Execution cycle on its own
          every minute — this button just runs one cycle immediately, so you can watch it work without waiting. Every
          fill here is a local simulation from a live quote; it never places a real order (see
          docs/AUTOTRADING_SPEC.md). No entries in the first/last 15 minutes of the session, and a volatility filter
          (per-ticker and broad-market) can skip a cycle&apos;s entries entirely.
        </p>
        {loopErr && <div className="text-bear text-sm mb-2">{loopErr}</div>}
        {loopSummary && (
          <p className="text-[11px] text-slate-500 mb-3">
            {loopSummary.skippedReason ? (
              <>New entries skipped — {loopSummary.skippedReason}. </>
            ) : (
              <>
                Screened {loopSummary.candidatesScreened}, {loopSummary.candidatesPassedVolatility} passed the
                volatility filter, {loopSummary.signalsGenerated} signal(s) generated, {loopSummary.entriesOpened}{' '}
                opened ({loopSummary.optionsEntriesOpened} options).{' '}
              </>
            )}
            Exits checked: {loopSummary.exitsChecked} ({loopSummary.exitsClosed} closed) — options:{' '}
            {loopSummary.optionsExitsChecked} ({loopSummary.optionsExitsClosed} closed).
          </p>
        )}
        {paperPositions.loading ? (
          <Spinner />
        ) : paperPositions.error ? (
          <ErrorState error={paperPositions.error} onRetry={paperPositions.reload} />
        ) : (
          (() => {
            const rows = paperPositions.data?.positions ?? [];
            const open = rows.filter((p) => p.status === 'open');
            const closed = rows.filter((p) => p.status === 'closed');
            const totalPnl = closed.reduce((s, p) => s + (paperPnl(p) ?? 0), 0);
            const unrealizedTotal = open.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
            const unrealizedKnown = open.some((p) => p.unrealizedPnl !== null);
            return (
              <>
                {rows.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <StatTile label="Open" value={open.length} />
                    <StatTile label="Closed" value={closed.length} />
                    <StatTile
                      label="Realized P&L"
                      value={fmtSignedUsd(totalPnl)}
                      valueClass={totalPnl >= 0 ? 'text-bull' : 'text-bear'}
                    />
                    <StatTile
                      label="Unrealized P&L"
                      value={unrealizedKnown ? fmtSignedUsd(unrealizedTotal) : '—'}
                      valueClass={unrealizedKnown ? (unrealizedTotal >= 0 ? 'text-bull' : 'text-bear') : undefined}
                    />
                  </div>
                )}
                <PaperPositionsTable positions={rows} />
              </>
            );
          })()
        )}

        <h4 className="font-medium text-sm mt-5 mb-3">Options paper positions</h4>
        <p className="text-xs text-slate-500 mb-3">
          Long calls/puts or debit spreads (whichever the Options strategy setting above builds), gated by the same
          combined risk budget as equity. A spread's Entry/Current/Exit $ show its net value (long leg minus short leg).
          Automated exit is time-based only (close as expiration approaches, no roll) — take-profit/stop-loss/
          delta-drift stay human-review-only on the Options page.
        </p>
        {optionsPaperPositions.loading ? (
          <Spinner />
        ) : optionsPaperPositions.error ? (
          <ErrorState error={optionsPaperPositions.error} onRetry={optionsPaperPositions.reload} />
        ) : (
          (() => {
            const rows = optionsPaperPositions.data?.positions ?? [];
            const open = rows.filter((p) => p.status === 'open');
            const closed = rows.filter((p) => p.status === 'closed');
            const totalPnl = closed.reduce((s, p) => s + (optionsPaperPnl(p) ?? 0), 0);
            const unrealizedTotal = open.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
            const unrealizedKnown = open.some((p) => p.unrealizedPnl !== null);
            return (
              <>
                {rows.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <StatTile label="Open" value={open.length} />
                    <StatTile label="Closed" value={closed.length} />
                    <StatTile
                      label="Realized P&L"
                      value={fmtSignedUsd(totalPnl)}
                      valueClass={totalPnl >= 0 ? 'text-bull' : 'text-bear'}
                    />
                    <StatTile
                      label="Unrealized P&L"
                      value={unrealizedKnown ? fmtSignedUsd(unrealizedTotal) : '—'}
                      valueClass={unrealizedKnown ? (unrealizedTotal >= 0 ? 'text-bull' : 'text-bear') : undefined}
                    />
                  </div>
                )}
                <OptionsPaperPositionsTable positions={rows} />
              </>
            );
          })()
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
        Decision-support and tracking, not financial advice. Paper trading above is always a local simulation that never
        reaches a real broker. Live trading (below) does place real orders once explicitly enabled — review backtest and
        paper-trading results first. See docs/AUTOTRADING_SPEC.md for the full plan.
      </p>
    </div>
  );
}

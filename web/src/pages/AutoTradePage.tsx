import { lazy, memo, ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
import { RefreshBar } from '../components/RefreshBar';
import { CloseModal } from '../components/PositionForms';
import { ago, cx, fmtDate, fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import {
  Badge,
  CollapsibleCard,
  EmptyState,
  ErrorState,
  Field,
  Modal,
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
  AutotradeTradeDirectionMode,
  BacktestEquityPoint,
  BacktestRunResponse,
  BacktestStats,
  ClosePositionResult,
  CombinedBacktestRunResponse,
  CombinedWalkForwardResponse,
  LiveOptionsPosition,
  LoopTickSummary,
  OptionsBacktestRunResponse,
  OptionsPaperPosition,
  OptionsWalkForwardResponse,
  PaperPosition,
  Position,
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

// Its real implementation lives in its own file so it can be lazy-loaded —
// recharts (~92kB gzip) is only needed once a backtest has actually been
// run, not on every visit to this page. A thin Suspense-wrapping shim here
// (rather than updating each call site below) keeps every existing
// <BacktestEquityChart equityCurve={...} gradientId={...} /> usage unchanged.
const LazyBacktestEquityChart = lazy(() => import('../components/BacktestEquityChart'));
function BacktestEquityChart(props: { equityCurve: BacktestEquityPoint[]; gradientId: string }) {
  return (
    <Suspense
      fallback={<div className="h-[180px] flex items-center justify-center text-xs text-slate-500">Loading chart…</div>}
    >
      <LazyBacktestEquityChart {...props} />
    </Suspense>
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

/** A backtest trade's own $ value as ONE unit — the raw premium for
 *  single_leg, or long-minus-short for a debit spread (matches
 *  optionsPaperEntryValue/optionsPaperExitValue's convention above). */
function backtestEntryValue(t: SimulatedOptionsTrade): number {
  return t.kind === 'debit_spread' ? t.entryPremium - (t.shortEntryPremium ?? 0) : t.entryPremium;
}
function backtestExitValue(t: SimulatedOptionsTrade): number {
  return t.kind === 'debit_spread' ? t.exitPremium - (t.shortExitPremium ?? 0) : t.exitPremium;
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
                  {t.kind === 'debit_spread' ? `/${t.shortStrike}` : ''}
                </Badge>{' '}
                <span className="text-[11px] text-slate-500">{fmtDate(t.expiration)}</span>
              </td>
              <td className="td text-slate-400">{fmtDate(t.entryDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(backtestEntryValue(t))}</td>
              <td className="td text-slate-400">{fmtDate(t.exitDate)}</td>
              <td className="td text-right tabular-nums">{fmtUsd(backtestExitValue(t))}</td>
              <td className="td">
                <Badge
                  color={
                    t.exitReason === 'take_profit'
                      ? 'green'
                      : t.exitReason === 'stop_loss'
                        ? 'red'
                        : t.exitReason === 'end_of_period'
                          ? 'slate'
                          : 'blue'
                  }
                >
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

/** Every poll tick hands these tables a brand-new array/object graph even
 *  when nothing actually changed (the fetch layer never preserves row
 *  identity) — a plain React.memo keyed on prop identity would never skip a
 *  render. Comparing serialized content instead of identity is deliberately
 *  simple over hand-picking "the fields that matter": these position shapes
 *  gain fields over time, and a hand-picked field list silently going stale
 *  (missing a newly-relevant field) would mean a real change stops
 *  re-rendering — a worse, quieter bug than the wasted re-renders this fixes. */
function samePositions<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const PaperPositionsTable = memo(
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
                    className={cx(
                      'td text-right tabular-nums',
                      pnl === null ? '' : pnl >= 0 ? 'text-bull' : 'text-bear',
                    )}
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
  },
  (prev, next) => samePositions(prev.positions, next.positions),
);

/** The position's own $ value — entry cost, live mark, or exit value — as ONE
 *  unit: the raw premium for single_leg, or long-minus-short for a debit
 *  spread. Null when a needed leg's price isn't available. */
/** Structural, not nominal — OptionsPaperPosition and LiveOptionsPosition
 *  both satisfy this (same net-debit/net-value math regardless of paper vs
 *  live), so these helpers work for either without a duplicate live copy —
 *  matching the server's own computeOptionsPaperUnrealizedPnl(), which takes
 *  the same kind of structural shape rather than a nominal paper-only type. */
interface OptionsValueShape {
  kind: 'single_leg' | 'debit_spread';
  status: 'open' | 'closed';
  entryPrice: number;
  shortEntryPrice: number | null;
  currentPrice: number | null;
  shortCurrentPrice: number | null;
  exitPrice: number | null;
  shortExitPrice: number | null;
  quantity: number;
  unrealizedPnl: number | null;
}

function optionsPaperEntryValue(p: OptionsValueShape): number {
  return p.kind === 'debit_spread' ? p.entryPrice - (p.shortEntryPrice ?? 0) : p.entryPrice;
}
function optionsPaperCurrentValue(p: OptionsValueShape): number | null {
  if (p.status !== 'open' || p.currentPrice === null) return null;
  if (p.kind === 'debit_spread') {
    if (p.shortCurrentPrice === null) return null;
    return p.currentPrice - p.shortCurrentPrice;
  }
  return p.currentPrice;
}
function optionsPaperExitValue(p: OptionsValueShape): number | null {
  if (p.exitPrice === null) return null;
  return p.kind === 'debit_spread' ? p.exitPrice - (p.shortExitPrice ?? 0) : p.exitPrice;
}

/** Realized P&L for a closed options position; unrealized for an open one,
 *  from the live contract mark(s) the server resolved this request
 *  (server/src/routes/autotrade.ts's withLiveOptionMarks /
 *  withLiveOptionsPositionMarks). No sign flip for single_leg — every
 *  single-leg position is long the contract itself; a debit spread nets its
 *  two legs' values first (optionsPaperExitValue/optionsPaperEntryValue
 *  above). */
function optionsPaperPnl(p: OptionsValueShape): number | null {
  if (p.status === 'open') return p.unrealizedPnl;
  const exitValue = optionsPaperExitValue(p);
  if (exitValue === null) return null;
  return (exitValue - optionsPaperEntryValue(p)) * p.quantity * 100;
}

const OptionsPaperPositionsTable = memo(
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
                      <Badge
                        color={
                          p.exitReason === 'take_profit'
                            ? 'green'
                            : p.exitReason === 'stop_loss'
                              ? 'red'
                              : p.exitReason === 'time_exit'
                                ? 'blue'
                                : 'slate'
                        }
                      >
                        {p.exitReason.replace('_', ' ')}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td text-right tabular-nums">{p.quantity}</td>
                  <td
                    className={cx(
                      'td text-right tabular-nums',
                      pnl === null ? '' : pnl >= 0 ? 'text-bull' : 'text-bear',
                    )}
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
  },
  (prev, next) => samePositions(prev.positions, next.positions),
);

/** Manually close a live options position autotrade itself opened
 *  (2026-07-16) — places a REAL closing order through the same
 *  TRADING_ENABLED + type-to-confirm + guardrails pipeline the Trade page
 *  and the equity CloseModal (components/PositionForms.tsx) use. A separate
 *  component from CloseModal rather than a reused one: LiveOptionsPosition's
 *  shape has no overlap with Position (strike/shortStrike/kind/side:
 *  'call'|'put' instead of remainingQuantity/side:'long'|'short'), so there's
 *  nothing to share beyond the same visual pattern. */
function CloseLiveOptionsPositionModal({
  position,
  onClose,
  onSaved,
}: {
  position: LiveOptionsPosition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useLocalStorage('trade.accountId', '');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClosePositionResult>();
  const { toast } = useToast();

  // Re-sync when a different position is opened — mirrors CloseModal's own
  // re-sync-on-key-change pattern.
  const key = position?.id;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setConfirmText('');
    setResult(undefined);
  }

  // Every autotrade options position is opened LONG (single_leg or
  // debit_spread alike), so closing is always a sell — no long/short branch
  // needed the way CloseModal's equity phrase has.
  const phrase = position ? `SELL ${position.quantity} ${position.symbol.toUpperCase()}` : '';
  const armed = confirmText.trim().toUpperCase() === phrase;

  const submit = async () => {
    if (!position || !armed || !accountId.trim()) return;
    setBusy(true);
    try {
      const r = await client.closeLiveOptionsPosition(position.id, accountId.trim(), confirmText.trim());
      setResult(r);
      if (r.placed) {
        toast(`Close order placed for ${position.symbol}`, { type: 'success' });
        onSaved();
      }
    } catch (e) {
      setResult({ ok: false, placed: false, reason: 'account_error', error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!position}
      onClose={onClose}
      title={position ? `Close ${position.symbol} options — real order` : 'Close options position'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {result?.placed ? 'Done' : 'Cancel'}
          </button>
          {!result?.placed && (
            <button
              className="btn-primary !bg-bear !border-bear disabled:opacity-40"
              disabled={busy || !armed || !accountId.trim()}
              onClick={submit}
            >
              {busy ? 'Placing…' : 'Close position'}
            </button>
          )}
        </>
      }
    >
      {position && (
        <div className="space-y-3">
          <div className="text-sm text-slate-400">
            {position.quantity} {position.kind === 'debit_spread' ? 'spreads' : 'contracts'} of{' '}
            <span className="text-slate-200">{position.symbol}</span> ({position.side} {position.strike}
            {position.kind === 'debit_spread' ? `/${position.shortStrike}` : ''}, {fmtDate(position.expiration)})
          </div>
          <Field label="Webull cash account_id">
            <input
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="e.g. 12345678"
            />
          </Field>
          <div className="rounded-md bg-bear/10 border border-bear/40 p-3 space-y-2">
            <p className="text-xs text-slate-400">
              This places a <b>real</b> closing order at your broker — a marketable limit near the current market price
              when submitted, for the full position. Type <code className="text-slate-200">{phrase}</code> to arm. The
              server re-checks every guardrail, the kill switch, and <code>TRADING_ENABLED</code> before it fires.
            </p>
            <input
              className="input font-mono"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
              placeholder={phrase}
              aria-label="type to confirm closing this options position"
            />
          </div>
          {result &&
            (result.placed ? (
              <div className="rounded-md bg-bull/15 text-bull text-sm p-2">
                ✓ Close order placed{result.broker?.orderId ? ` · broker order ${result.broker.orderId}` : ''}. It can
                take a few minutes to fill and show here as closed.
              </div>
            ) : (
              <div className="rounded-md bg-bear/15 text-bear text-sm p-2">
                ✕ Not placed — {result.error || result.broker?.error || `reason: ${result.reason}`}
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}

/** REAL, live-money OPTIONS positions the autotrade loop itself placed
 *  (Task #70) — its own table (autotrade_live_options_positions), not the
 *  shared `positions` row LivePositionsTable below reads, since a debit
 *  spread has no column there for its second leg. Nothing here is
 *  simulated — mirrors OptionsPaperPositionsTable's rendering exactly. */
const LiveOptionsPositionsTable = memo(
  function LiveOptionsPositionsTable({
    positions,
    onClose,
  }: {
    positions: LiveOptionsPosition[];
    onClose: (p: LiveOptionsPosition) => void;
  }) {
    if (positions.length === 0) {
      return (
        <EmptyState
          title="No live options positions yet"
          hint="Once live options trading places a real order and it fills, it shows up here."
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
              <th className="th text-right">Actions</th>
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
                    {p.accountId && (
                      <span
                        className="ml-2 chip bg-ink-700 text-slate-400 font-mono text-[10px] font-normal"
                        title={`Webull account ${p.accountId}`}
                      >
                        {p.accountId.length > 14 ? `…${p.accountId.slice(-11)}` : p.accountId}
                      </span>
                    )}
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
                    className={cx(
                      'td text-right tabular-nums',
                      pnl === null ? '' : pnl >= 0 ? 'text-bull' : 'text-bear',
                    )}
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
                  <td className="td text-right">
                    {p.status === 'open' && (
                      <button className="text-xs text-bear hover:underline" onClick={() => onClose(p)}>
                        close
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  },
  (prev, next) => samePositions(prev.positions, next.positions),
);

/** REAL, live-money positions the autotrade loop itself placed — the exact
 *  same `positions` table row a manual trade uses, filtered server-side to
 *  the `autotrade` tag (server/src/routes/autotrade.ts's /live-positions).
 *  Distinct from every paper table on this page: nothing here is simulated. */
const LivePositionsTable = memo(
  function LivePositionsTable({
    positions,
    onClose,
  }: {
    positions: AutotradeLivePosition[];
    onClose: (p: AutotradeLivePosition) => void;
  }) {
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
              <th className="th text-right">Actions</th>
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
                    {p.accountId && (
                      <span
                        className="ml-2 chip bg-ink-700 text-slate-400 font-mono text-[10px] font-normal"
                        title={`Webull account ${p.accountId}`}
                      >
                        {p.accountId.length > 14 ? `…${p.accountId.slice(-11)}` : p.accountId}
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
                  <td className="td text-right">
                    {p.status === 'open' && (
                      <button className="text-xs text-bear hover:underline" onClick={() => onClose(p)}>
                        close
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  },
  (prev, next) => samePositions(prev.positions, next.positions),
);

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
  suggestLiveCapsBusy: boolean;
  onSuggestLiveCaps: () => void;
  confirmLiveText: string;
  setConfirmLiveText: (v: string) => void;
  confirmPhrase: string;
  liveEnableBusy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  dashboard: AutotradeDashboard | undefined;
  // --- Task #70: live options, nested under liveTradingEnabled above ---
  liveOptionsEnabledDraft: boolean;
  setLiveOptionsEnabledDraft: (v: boolean) => void;
  liveOptionsMaxOrderUsdDraft: number | undefined;
  setLiveOptionsMaxOrderUsdDraft: (v: number | undefined) => void;
  liveOptionsMaxDailyLossUsdDraft: number | undefined;
  setLiveOptionsMaxDailyLossUsdDraft: (v: number | undefined) => void;
  liveOptionsMaxOrdersPerDayDraft: number | undefined;
  setLiveOptionsMaxOrdersPerDayDraft: (v: number | undefined) => void;
  liveOptionsFatFingerPctDraft: number | undefined;
  setLiveOptionsFatFingerPctDraft: (v: number | undefined) => void;
  liveOptionsProbationTradesDraft: number | undefined;
  setLiveOptionsProbationTradesDraft: (v: number | undefined) => void;
  liveOptionsProbationSizeMultiplierDraft: number | undefined;
  setLiveOptionsProbationSizeMultiplierDraft: (v: number | undefined) => void;
  liveOptionsSaveBusy: boolean;
  onSaveLiveOptionsCaps: () => void;
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
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs uppercase tracking-wide text-slate-400">Live guardrail caps</h4>
          <button
            className="btn-ghost text-xs"
            onClick={p.onSuggestLiveCaps}
            disabled={p.suggestLiveCapsBusy || p.config.accountEquityUsd == null}
            title={
              p.config.accountEquityUsd == null
                ? 'Set account equity in Configuration above first'
                : 'Fills the fields below from account equity — review before saving, doesn’t save by itself.'
            }
          >
            {p.suggestLiveCapsBusy ? 'Suggesting…' : 'Suggest from equity'}
          </button>
        </div>
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

          <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-3 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={p.liveOptionsEnabledDraft}
                onChange={(e) => p.setLiveOptionsEnabledDraft(e.target.checked)}
              />
              Live options trading
            </label>
            <p className="text-[11px] text-slate-500">
              Single-leg calls/puts and debit spreads, no second confirmation phrase — live trading itself already
              covers that. Uses the same Webull account above; caps below are dedicated to options, separate from the
              equity caps above.
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Max order ($)">
                <NumberInput
                  value={p.liveOptionsMaxOrderUsdDraft}
                  onChange={p.setLiveOptionsMaxOrderUsdDraft}
                  placeholder="e.g. 2000"
                />
              </Field>
              <Field label="Max daily loss ($)">
                <NumberInput
                  value={p.liveOptionsMaxDailyLossUsdDraft}
                  onChange={p.setLiveOptionsMaxDailyLossUsdDraft}
                  placeholder="e.g. 500"
                />
              </Field>
              <Field label="Max orders/day">
                <NumberInput
                  value={p.liveOptionsMaxOrdersPerDayDraft}
                  onChange={p.setLiveOptionsMaxOrdersPerDayDraft}
                  placeholder="e.g. 6"
                />
              </Field>
              <Field label="Fat-finger (%)" hint="Options bid/ask spreads run wider than equity's — size accordingly.">
                <NumberInput
                  value={p.liveOptionsFatFingerPctDraft}
                  onChange={p.setLiveOptionsFatFingerPctDraft}
                  placeholder="e.g. 10"
                />
              </Field>
              <Field label="Probation trades" hint="Own window — can go live weeks after equity did.">
                <NumberInput
                  value={p.liveOptionsProbationTradesDraft}
                  onChange={p.setLiveOptionsProbationTradesDraft}
                  placeholder="e.g. 20"
                />
              </Field>
              <Field label="Probation size multiplier">
                <NumberInput
                  value={p.liveOptionsProbationSizeMultiplierDraft}
                  onChange={p.setLiveOptionsProbationSizeMultiplierDraft}
                  placeholder="e.g. 0.5"
                />
              </Field>
            </div>
            {p.dashboard?.liveOptionsProbation.active && (
              <p className="text-[11px] text-amber-400">
                Options probation active: {p.dashboard.liveOptionsProbation.tradesRemaining} of{' '}
                {p.config.liveOptionsProbationTrades} trades remaining at {p.dashboard.liveOptionsProbation.multiplier}×
                size.
              </p>
            )}
            <button className="btn-ghost" onClick={p.onSaveLiveOptionsCaps} disabled={p.liveOptionsSaveBusy}>
              {p.liveOptionsSaveBusy ? 'Saving…' : 'Save live options settings'}
            </button>
          </div>

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

  // Task #70: live options — its own pool nested under live, same reasoning
  // as the live block above, just its own caps/probation (dashboard.ts's
  // header comment).
  const liveOptRiskBusy = dash.maxAggregateOpenRisk > 0 && dash.liveOptionsOpenRisk >= dash.maxAggregateOpenRisk;
  const liveOptPositionsBusy = dash.liveOptionsOpenPositionsCount >= dash.maxConcurrentPositions;
  const liveOptTradesBusy = dash.liveOptionsTradesToday >= dash.maxTradesPerDay;
  const liveOptStepDownActive = dash.liveOptionsConsecutiveLosses >= dash.stepDownAfterLosses;
  const liveOptHaltActive = dash.dailyDrawdownHaltLevel < 0 && dash.liveOptionsDailyPnl <= dash.dailyDrawdownHaltLevel;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink-600 bg-ink-800/40 p-3">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs uppercase tracking-wide text-slate-400">Last cycle</h4>
          {dash.lastTick && <span className="text-[11px] text-slate-500">{ago(dash.lastTick.ranAt)}</span>}
        </div>
        {!dash.lastTick ? (
          <p className="text-xs text-slate-500">The automated loop hasn&apos;t run yet.</p>
        ) : (
          <div className="space-y-1 text-xs text-slate-400">
            {dash.lastTick.summary.skippedReason && (
              <p className="text-amber-400">{dash.lastTick.summary.skippedReason}</p>
            )}
            <p>
              {dash.lastTick.summary.candidatesScreened} screened → {dash.lastTick.summary.candidatesPassedVolatility}{' '}
              passed volatility → {dash.lastTick.summary.signalsGenerated} signals
              {dash.lastTick.summary.optionsSignalsGenerated > 0 &&
                ` (+${dash.lastTick.summary.optionsSignalsGenerated} options)`}
            </p>
            <p>
              Opened: {dash.lastTick.summary.entriesOpened} equity + {dash.lastTick.summary.optionsEntriesOpened}{' '}
              options paper, {dash.lastTick.summary.liveEntriesOpened} equity +{' '}
              {dash.lastTick.summary.liveOptionsEntriesOpened} options live
            </p>
            <p>
              Exits: {dash.lastTick.summary.exitsClosed}/{dash.lastTick.summary.exitsChecked} equity,{' '}
              {dash.lastTick.summary.optionsExitsClosed}/{dash.lastTick.summary.optionsExitsChecked} options
              {dash.lastTick.summary.moversAutoPromoted > 0 &&
                ` · ${dash.lastTick.summary.moversAutoPromoted} movers promoted`}
            </p>
          </div>
        )}
      </div>
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
          <StatTile
            label="Correlated exposure"
            value={
              dash.lastCorrelatedExposureCheck?.correlatedNotional != null
                ? fmtUsd(dash.lastCorrelatedExposureCheck.correlatedNotional)
                : '—'
            }
            sub={
              dash.lastCorrelatedExposureCheck ? (
                <>
                  of {fmtUsd(dash.maxCorrelatedExposure)} cap — {dash.lastCorrelatedExposureCheck.symbol},{' '}
                  {ago(dash.lastCorrelatedExposureCheck.checkedAt)}
                  {dash.lastCorrelatedExposureCheck.passed === false && (
                    <span className="text-bear font-semibold"> BLOCKED</span>
                  )}
                </>
              ) : (
                `of ${fmtUsd(dash.maxCorrelatedExposure)} cap — no candidate checked yet`
              )
            }
            valueClass={dash.lastCorrelatedExposureCheck?.passed === false ? 'text-bear' : undefined}
          />
          <StatTile
            label="Sector exposure"
            value={dash.sectorExposure[0] ? fmtUsd(dash.sectorExposure[0].gross) : '—'}
            sub={
              dash.sectorExposure[0] ? (
                <>
                  of {fmtUsd(dash.maxSectorExposure)} cap — {dash.sectorExposure[0].key} ({dash.sectorExposure[0].count}{' '}
                  position{dash.sectorExposure[0].count === 1 ? '' : 's'})
                </>
              ) : (
                `of ${fmtUsd(dash.maxSectorExposure)} cap — no open positions`
              )
            }
            valueClass={
              dash.sectorExposure[0] && dash.sectorExposure[0].gross > dash.maxSectorExposure ? 'text-bear' : undefined
            }
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

      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">
          Live options{' '}
          {dash.liveOptionsEnabled ? (
            <span className="text-bear normal-case">● enabled</span>
          ) : (
            <span className="normal-case">(disabled)</span>
          )}
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <StatTile
            label="Open positions"
            value={`${dash.liveOptionsOpenPositionsCount} / ${dash.maxConcurrentPositions}`}
            valueClass={liveOptPositionsBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Aggregate open risk"
            value={fmtUsd(dash.liveOptionsOpenRisk)}
            sub={`of ${fmtUsd(dash.maxAggregateOpenRisk)} cap`}
            valueClass={liveOptRiskBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Day P&L"
            value={fmtSignedUsd(dash.liveOptionsDailyPnl)}
            sub={
              liveOptHaltActive ? (
                <span className="text-bear font-semibold">HALT TRIGGERED</span>
              ) : (
                `halt at ${fmtUsd(dash.dailyDrawdownHaltLevel)}`
              )
            }
            valueClass={dash.liveOptionsDailyPnl >= 0 ? 'text-bull' : 'text-bear'}
          />
          <StatTile
            label="Trades today"
            value={`${dash.liveOptionsTradesToday} / ${dash.maxTradesPerDay}`}
            valueClass={liveOptTradesBusy ? 'text-bear' : undefined}
          />
          <StatTile
            label="Consecutive losses"
            value={dash.liveOptionsConsecutiveLosses}
            sub={liveOptStepDownActive ? 'step-down active' : `of ${dash.stepDownAfterLosses} to step-down`}
            valueClass={liveOptStepDownActive ? 'text-bear' : undefined}
          />
          <StatTile
            label="Probation"
            value={dash.liveOptionsProbation.active ? `${dash.liveOptionsProbation.multiplier}× size` : 'complete'}
            sub={
              dash.liveOptionsProbation.active ? `${dash.liveOptionsProbation.tradesRemaining} trades left` : undefined
            }
            valueClass={dash.liveOptionsProbation.active ? 'text-amber-400' : undefined}
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
  const liveOptionsPositions = useAsync(() => client.autotradeLiveOptionsPositions({ limit: 100 }), []);
  const dashboard = useAsync(() => client.autotradeDashboard(), []);
  const [view, setView] = useLocalStorage<'config' | 'dashboard'>('autotrade.view', 'config');
  const { toast } = useToast();
  const confirm = useConfirm();
  // Manually close a REAL live position from this page — reuses the same
  // CloseModal/POST /positions/:id/close the human Positions page uses for
  // equity (autotrade's own live equity positions are the exact same
  // `positions` table rows, just tag-filtered — see LivePositionsTable's own
  // doc comment); live OPTIONS positions get their own modal + route below,
  // since autotrade_live_options_positions is a structurally different table
  // (debit spreads have a second leg) with no equity-shaped equivalent.
  const [closeEquityPos, setCloseEquityPos] = useState<Position | null>(null);
  const [closeOptionsPos, setCloseOptionsPos] = useState<LiveOptionsPosition | null>(null);

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
    liveOptionsPositions.reload();
    events.reload();
  };

  const [enabled, setEnabled] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [riskProfile, setRiskProfile] = useState<AutotradeRiskProfile>('MODERATE');
  const [optionsStrategyType, setOptionsStrategyType] = useState<AutotradeOptionsStrategyType>('single_leg');
  const [tradeDirection, setTradeDirection] = useState<AutotradeTradeDirectionMode>('long');
  const [equityDraft, setEquityDraft] = useState<number | undefined>();
  const [maxPositionsDraft, setMaxPositionsDraft] = useState<number | undefined>();
  const [riskPerTradePctDraft, setRiskPerTradePctDraft] = useState<number | undefined>();
  const [maxDailyDrawdownPctDraft, setMaxDailyDrawdownPctDraft] = useState<number | undefined>();
  const [stepDownAfterLossesDraft, setStepDownAfterLossesDraft] = useState<number | undefined>();
  const [stepDownSizeCutPctDraft, setStepDownSizeCutPctDraft] = useState<number | undefined>();
  const [maxAggregateOpenRiskPctDraft, setMaxAggregateOpenRiskPctDraft] = useState<number | undefined>();
  const [maxCorrelatedExposurePctDraft, setMaxCorrelatedExposurePctDraft] = useState<number | undefined>();
  const [maxSectorExposurePctDraft, setMaxSectorExposurePctDraft] = useState<number | undefined>();
  const [maxTradesPerDayDraft, setMaxTradesPerDayDraft] = useState<number | undefined>();
  const [regimeAtrThresholdPctDraft, setRegimeAtrThresholdPctDraft] = useState<number | undefined>();
  const [regimeSizeCutPctDraft, setRegimeSizeCutPctDraft] = useState<number | undefined>();
  const [minRelVolDraft, setMinRelVolDraft] = useState<number | undefined>();
  const [requireWeeklyTrendAlignment, setRequireWeeklyTrendAlignment] = useState(false);
  const [relativeStrengthWeightDraft, setRelativeStrengthWeightDraft] = useState<number | undefined>();
  const [benchmarkSymbolDraft, setBenchmarkSymbolDraft] = useState('');
  const [relativeStrengthLookbackDaysDraft, setRelativeStrengthLookbackDaysDraft] = useState<number | undefined>();
  const [maxTickerAtrPctDraft, setMaxTickerAtrPctDraft] = useState<number | undefined>();
  const [maxMarketAtrPctDraft, setMaxMarketAtrPctDraft] = useState<number | undefined>();
  const [stopAtrMultipleDraft, setStopAtrMultipleDraft] = useState<number | undefined>();
  const [targetRMultipleDraft, setTargetRMultipleDraft] = useState<number | undefined>();
  const [maxHoldDaysDraft, setMaxHoldDaysDraft] = useState<number | undefined>();
  const [breakevenTriggerRMultipleDraft, setBreakevenTriggerRMultipleDraft] = useState<number | undefined>();
  const [trailStartRMultipleDraft, setTrailStartRMultipleDraft] = useState<number | undefined>();
  const [trailStopRMultipleDraft, setTrailStopRMultipleDraft] = useState<number | undefined>();
  const [partialExitRMultipleDraft, setPartialExitRMultipleDraft] = useState<number | undefined>();
  const [partialExitPctDraft, setPartialExitPctDraft] = useState<number | undefined>();
  const [optionsStopLossPctDraft, setOptionsStopLossPctDraft] = useState<number | undefined>();
  const [optionsTakeProfitPctDraft, setOptionsTakeProfitPctDraft] = useState<number | undefined>();
  const [optionsBreakevenTriggerPctDraft, setOptionsBreakevenTriggerPctDraft] = useState<number | undefined>();
  const [optionsTrailStartPctDraft, setOptionsTrailStartPctDraft] = useState<number | undefined>();
  const [optionsTrailStopPctDraft, setOptionsTrailStopPctDraft] = useState<number | undefined>();
  const [optionsPartialExitTriggerPctDraft, setOptionsPartialExitTriggerPctDraft] = useState<number | undefined>();
  const [optionsPartialExitPctDraft, setOptionsPartialExitPctDraft] = useState<number | undefined>();
  const [sessionBufferMinutesDraft, setSessionBufferMinutesDraft] = useState<number | undefined>();
  const [earningsBlackoutDaysDraft, setEarningsBlackoutDaysDraft] = useState<number | undefined>();
  const [correlationLookbackDaysDraft, setCorrelationLookbackDaysDraft] = useState<number | undefined>();
  const [correlationThresholdDraft, setCorrelationThresholdDraft] = useState<number | undefined>();
  const [liveAccountIdDraft, setLiveAccountIdDraft] = useState('');
  const [liveMaxOrderUsdDraft, setLiveMaxOrderUsdDraft] = useState<number | undefined>();
  const [liveMaxDailyLossUsdDraft, setLiveMaxDailyLossUsdDraft] = useState<number | undefined>();
  const [liveMaxOrdersPerDayDraft, setLiveMaxOrdersPerDayDraft] = useState<number | undefined>();
  const [liveFatFingerPctDraft, setLiveFatFingerPctDraft] = useState<number | undefined>();
  const [liveAllowNakedShortDraft, setLiveAllowNakedShortDraft] = useState(false);
  const [liveProbationTradesDraft, setLiveProbationTradesDraft] = useState<number | undefined>();
  const [liveProbationSizeMultiplierDraft, setLiveProbationSizeMultiplierDraft] = useState<number | undefined>();
  const [liveOptionsEnabledDraft, setLiveOptionsEnabledDraft] = useState(false);
  const [liveOptionsMaxOrderUsdDraft, setLiveOptionsMaxOrderUsdDraft] = useState<number | undefined>();
  const [liveOptionsMaxDailyLossUsdDraft, setLiveOptionsMaxDailyLossUsdDraft] = useState<number | undefined>();
  const [liveOptionsMaxOrdersPerDayDraft, setLiveOptionsMaxOrdersPerDayDraft] = useState<number | undefined>();
  const [liveOptionsFatFingerPctDraft, setLiveOptionsFatFingerPctDraft] = useState<number | undefined>();
  const [liveOptionsProbationTradesDraft, setLiveOptionsProbationTradesDraft] = useState<number | undefined>();
  const [liveOptionsProbationSizeMultiplierDraft, setLiveOptionsProbationSizeMultiplierDraft] = useState<
    number | undefined
  >();
  const [autoPromoteMoversEnabled, setAutoPromoteMoversEnabled] = useState(true);
  const [autoPromoteThresholdDraft, setAutoPromoteThresholdDraft] = useState<number | undefined>();
  const [autoPromoteWindowDaysDraft, setAutoPromoteWindowDaysDraft] = useState<number | undefined>();
  const [autoPromoteMaxSymbolsDraft, setAutoPromoteMaxSymbolsDraft] = useState<number | undefined>();
  const [autoTuneEnabled, setAutoTuneEnabled] = useState(false);
  const [autoTuneMinTradesDraft, setAutoTuneMinTradesDraft] = useState<number | undefined>();
  const [autoTuneMaxStepPctDraft, setAutoTuneMaxStepPctDraft] = useState<number | undefined>();
  const [autoTuneSlippageExcludePctDraft, setAutoTuneSlippageExcludePctDraft] = useState<number | undefined>();
  useEffect(() => {
    if (!config.data) return;
    setEnabled(config.data.enabled);
    setKillSwitch(config.data.killSwitch);
    setRiskProfile(config.data.riskProfile);
    setOptionsStrategyType(config.data.optionsStrategyType);
    setTradeDirection(config.data.tradeDirection);
    setEquityDraft(config.data.accountEquityUsd ?? undefined);
    setMaxPositionsDraft(config.data.maxConcurrentPositions);
    setRiskPerTradePctDraft(config.data.riskPerTradePct);
    setMaxDailyDrawdownPctDraft(config.data.maxDailyDrawdownPct);
    setStepDownAfterLossesDraft(config.data.stepDownAfterLosses);
    setStepDownSizeCutPctDraft(config.data.stepDownSizeCutPct);
    setMaxAggregateOpenRiskPctDraft(config.data.maxAggregateOpenRiskPct);
    setMaxCorrelatedExposurePctDraft(config.data.maxCorrelatedExposurePct);
    setMaxSectorExposurePctDraft(config.data.maxSectorExposurePct);
    setMaxTradesPerDayDraft(config.data.maxTradesPerDay);
    setRegimeAtrThresholdPctDraft(config.data.regimeAtrThresholdPct);
    setRegimeSizeCutPctDraft(config.data.regimeSizeCutPct);
    setMinRelVolDraft(config.data.minRelVol);
    setRequireWeeklyTrendAlignment(config.data.requireWeeklyTrendAlignment);
    setRelativeStrengthWeightDraft(config.data.relativeStrengthWeight);
    setBenchmarkSymbolDraft(config.data.benchmarkSymbol ?? '');
    setRelativeStrengthLookbackDaysDraft(config.data.relativeStrengthLookbackDays);
    setMaxTickerAtrPctDraft(config.data.maxTickerAtrPct);
    setMaxMarketAtrPctDraft(config.data.maxMarketAtrPct);
    setStopAtrMultipleDraft(config.data.stopAtrMultiple);
    setTargetRMultipleDraft(config.data.targetRMultiple);
    setMaxHoldDaysDraft(config.data.maxHoldDays);
    setBreakevenTriggerRMultipleDraft(config.data.breakevenTriggerRMultiple);
    setTrailStartRMultipleDraft(config.data.trailStartRMultiple);
    setTrailStopRMultipleDraft(config.data.trailStopRMultiple);
    setPartialExitRMultipleDraft(config.data.partialExitRMultiple);
    setPartialExitPctDraft(config.data.partialExitPct);
    setOptionsStopLossPctDraft(config.data.optionsStopLossPct);
    setOptionsTakeProfitPctDraft(config.data.optionsTakeProfitPct);
    setOptionsBreakevenTriggerPctDraft(config.data.optionsBreakevenTriggerPct);
    setOptionsTrailStartPctDraft(config.data.optionsTrailStartPct);
    setOptionsTrailStopPctDraft(config.data.optionsTrailStopPct);
    setOptionsPartialExitTriggerPctDraft(config.data.optionsPartialExitTriggerPct);
    setOptionsPartialExitPctDraft(config.data.optionsPartialExitPct);
    setSessionBufferMinutesDraft(config.data.sessionBufferMinutes);
    setEarningsBlackoutDaysDraft(config.data.earningsBlackoutDays);
    setCorrelationLookbackDaysDraft(config.data.correlationLookbackDays);
    setCorrelationThresholdDraft(config.data.correlationThreshold);
    setLiveAccountIdDraft(config.data.liveAccountId ?? '');
    setLiveMaxOrderUsdDraft(config.data.liveMaxOrderUsd);
    setLiveMaxDailyLossUsdDraft(config.data.liveMaxDailyLossUsd);
    setLiveMaxOrdersPerDayDraft(config.data.liveMaxOrdersPerDay);
    setLiveFatFingerPctDraft(config.data.liveFatFingerPct);
    setLiveAllowNakedShortDraft(config.data.liveAllowNakedShort);
    setLiveProbationTradesDraft(config.data.liveProbationTrades);
    setLiveProbationSizeMultiplierDraft(config.data.liveProbationSizeMultiplier);
    setLiveOptionsEnabledDraft(config.data.liveOptionsEnabled);
    setLiveOptionsMaxOrderUsdDraft(config.data.liveOptionsMaxOrderUsd);
    setLiveOptionsMaxDailyLossUsdDraft(config.data.liveOptionsMaxDailyLossUsd);
    setLiveOptionsMaxOrdersPerDayDraft(config.data.liveOptionsMaxOrdersPerDay);
    setLiveOptionsFatFingerPctDraft(config.data.liveOptionsFatFingerPct);
    setLiveOptionsProbationTradesDraft(config.data.liveOptionsProbationTrades);
    setLiveOptionsProbationSizeMultiplierDraft(config.data.liveOptionsProbationSizeMultiplier);
    setAutoPromoteMoversEnabled(config.data.autoPromoteMoversEnabled);
    setAutoPromoteThresholdDraft(config.data.autoPromoteThreshold);
    setAutoPromoteWindowDaysDraft(config.data.autoPromoteWindowDays);
    setAutoPromoteMaxSymbolsDraft(config.data.autoPromoteMaxSymbols);
    setAutoTuneEnabled(config.data.autoTuneEnabled);
    setAutoTuneMinTradesDraft(config.data.autoTuneMinTrades);
    setAutoTuneMaxStepPctDraft(config.data.autoTuneMaxStepPct);
    setAutoTuneSlippageExcludePctDraft(config.data.autoTuneSlippageExcludePct);
  }, [config.data]);

  const saveConfig = async (patch: {
    enabled?: boolean;
    riskProfile?: AutotradeRiskProfile;
    accountEquityUsd?: number | null;
    maxConcurrentPositions?: number;
    riskPerTradePct?: number;
    maxDailyDrawdownPct?: number;
    stepDownAfterLosses?: number;
    stepDownSizeCutPct?: number;
    maxAggregateOpenRiskPct?: number;
    maxCorrelatedExposurePct?: number;
    maxSectorExposurePct?: number;
    maxTradesPerDay?: number;
    regimeAtrThresholdPct?: number;
    regimeSizeCutPct?: number;
    tradeDirection?: AutotradeTradeDirectionMode;
    minRelVol?: number;
    requireWeeklyTrendAlignment?: boolean;
    relativeStrengthWeight?: number;
    benchmarkSymbol?: string;
    relativeStrengthLookbackDays?: number;
    maxTickerAtrPct?: number;
    maxMarketAtrPct?: number;
    stopAtrMultiple?: number;
    targetRMultiple?: number;
    maxHoldDays?: number;
    breakevenTriggerRMultiple?: number;
    trailStartRMultiple?: number;
    trailStopRMultiple?: number;
    partialExitRMultiple?: number;
    partialExitPct?: number;
    optionsStopLossPct?: number;
    optionsTakeProfitPct?: number;
    optionsBreakevenTriggerPct?: number;
    optionsTrailStartPct?: number;
    optionsTrailStopPct?: number;
    optionsPartialExitTriggerPct?: number;
    optionsPartialExitPct?: number;
    sessionBufferMinutes?: number;
    earningsBlackoutDays?: number;
    correlationLookbackDays?: number;
    correlationThreshold?: number;
    optionsStrategyType?: AutotradeOptionsStrategyType;
    autoPromoteMoversEnabled?: boolean;
    autoPromoteThreshold?: number;
    autoPromoteWindowDays?: number;
    autoPromoteMaxSymbols?: number;
    autoTuneEnabled?: boolean;
    autoTuneMinTrades?: number;
    autoTuneMaxStepPct?: number;
    autoTuneSlippageExcludePct?: number;
  }) => {
    if (patch.riskProfile === 'AGGRESSIVE' && riskProfile !== 'AGGRESSIVE') {
      const ok = await confirm({
        title: 'Switch to AGGRESSIVE?',
        body: 'AGGRESSIVE is just a label now — per-trade risk, the daily drawdown halt, max aggregate open risk, correlated-ticker exposure, max concurrent positions, and the daily trade cap are all set independently below and won’t change when you switch. This confirmation exists because the label itself is journaled with every trade, so it should still be a deliberate choice, not a default.',
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
      setTradeDirection(saved.tradeDirection);
      setMaxPositionsDraft(saved.maxConcurrentPositions);
      setRiskPerTradePctDraft(saved.riskPerTradePct);
      setMaxDailyDrawdownPctDraft(saved.maxDailyDrawdownPct);
      setStepDownAfterLossesDraft(saved.stepDownAfterLosses);
      setStepDownSizeCutPctDraft(saved.stepDownSizeCutPct);
      setMaxAggregateOpenRiskPctDraft(saved.maxAggregateOpenRiskPct);
      setMaxCorrelatedExposurePctDraft(saved.maxCorrelatedExposurePct);
      setMaxSectorExposurePctDraft(saved.maxSectorExposurePct);
      setMaxTradesPerDayDraft(saved.maxTradesPerDay);
      setRegimeAtrThresholdPctDraft(saved.regimeAtrThresholdPct);
      setRegimeSizeCutPctDraft(saved.regimeSizeCutPct);
      setMinRelVolDraft(saved.minRelVol);
      setRequireWeeklyTrendAlignment(saved.requireWeeklyTrendAlignment);
      setRelativeStrengthWeightDraft(saved.relativeStrengthWeight);
      setBenchmarkSymbolDraft(saved.benchmarkSymbol ?? '');
      setRelativeStrengthLookbackDaysDraft(saved.relativeStrengthLookbackDays);
      setMaxTickerAtrPctDraft(saved.maxTickerAtrPct);
      setMaxMarketAtrPctDraft(saved.maxMarketAtrPct);
      setStopAtrMultipleDraft(saved.stopAtrMultiple);
      setTargetRMultipleDraft(saved.targetRMultiple);
      setMaxHoldDaysDraft(saved.maxHoldDays);
      setBreakevenTriggerRMultipleDraft(saved.breakevenTriggerRMultiple);
      setTrailStartRMultipleDraft(saved.trailStartRMultiple);
      setTrailStopRMultipleDraft(saved.trailStopRMultiple);
      setPartialExitRMultipleDraft(saved.partialExitRMultiple);
      setPartialExitPctDraft(saved.partialExitPct);
      setOptionsStopLossPctDraft(saved.optionsStopLossPct);
      setOptionsTakeProfitPctDraft(saved.optionsTakeProfitPct);
      setOptionsBreakevenTriggerPctDraft(saved.optionsBreakevenTriggerPct);
      setOptionsTrailStartPctDraft(saved.optionsTrailStartPct);
      setOptionsTrailStopPctDraft(saved.optionsTrailStopPct);
      setOptionsPartialExitTriggerPctDraft(saved.optionsPartialExitTriggerPct);
      setOptionsPartialExitPctDraft(saved.optionsPartialExitPct);
      setSessionBufferMinutesDraft(saved.sessionBufferMinutes);
      setEarningsBlackoutDaysDraft(saved.earningsBlackoutDays);
      setCorrelationLookbackDaysDraft(saved.correlationLookbackDays);
      setCorrelationThresholdDraft(saved.correlationThreshold);
      setAutoPromoteMoversEnabled(saved.autoPromoteMoversEnabled);
      setAutoPromoteThresholdDraft(saved.autoPromoteThreshold);
      setAutoPromoteWindowDaysDraft(saved.autoPromoteWindowDays);
      setAutoPromoteMaxSymbolsDraft(saved.autoPromoteMaxSymbols);
      setAutoTuneEnabled(saved.autoTuneEnabled);
      setAutoTuneMinTradesDraft(saved.autoTuneMinTrades);
      setAutoTuneMaxStepPctDraft(saved.autoTuneMaxStepPct);
      setAutoTuneSlippageExcludePctDraft(saved.autoTuneSlippageExcludePct);
      config.reload(); // keeps config.data — the equity-not-set warning's source of truth — fresh
      refreshLiveData(); // risk profile / equity changes shift the dashboard's caps, and get journaled
      toast('Auto-trading settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save settings', { type: 'error' });
    }
  };

  const [equitySyncBusy, setEquitySyncBusy] = useState(false);
  // `silent` is used by the 1-minute auto-refresh below: same sync, but
  // without a toast firing every minute regardless of whether equity actually
  // moved (the manual button click below always wants the toast).
  const syncEquityFromBroker = async (opts?: { silent?: boolean }) => {
    setEquitySyncBusy(true);
    try {
      const result = await client.syncAutotradeEquity();
      if (!result.ok) {
        if (!opts?.silent) toast(result.error ?? 'Could not sync equity from Webull', { type: 'error' });
        return;
      }
      setEquityDraft(result.netLiquidationUsd);
      config.reload();
      refreshLiveData(); // synced equity shifts the dashboard's caps, same as a manual edit
      if (!opts?.silent) {
        const prevLabel =
          result.previousEquityUsd != null ? `$${result.previousEquityUsd.toLocaleString('en-US')}` : 'unset';
        toast(`Synced from Webull — ${prevLabel} → $${result.netLiquidationUsd!.toLocaleString('en-US')}`, {
          type: 'success',
        });
      }
    } catch (e) {
      if (!opts?.silent) toast((e as Error).message || 'Could not sync equity from Webull', { type: 'error' });
    } finally {
      setEquitySyncBusy(false);
    }
  };

  // Auto-refresh account equity from Webull instead of requiring the "Sync
  // from Webull" button — mirrors what the loop tick already does
  // server-side for accountEquityUsd itself (loop.ts), this just reflects
  // that in the UI sooner than the next unrelated reload. Folded into
  // refreshLiveDataAndMaybeSyncEquity below (RefreshBar's own tick) rather
  // than a second, independently-phased 60s timer — that used to mean this
  // page's "one refresh" (see the comment above refreshLiveData) actually
  // fired twice as often as either timer alone suggested, on two
  // uncoordinated schedules. Throttled to at most once every 60 REAL
  // seconds regardless of RefreshBar's own chosen cadence, so picking a
  // faster display-refresh interval doesn't also hit Webull that much more
  // often. Skipped when there's no live account to sync from (same gate as
  // the button), or while equityDraft has an unsaved manual edit
  // (equityDraft !== the last value we know the server has), so it never
  // clobbers in-progress typing.
  const lastEquitySyncAttemptRef = useRef(0);
  const refreshLiveDataAndMaybeSyncEquity = () => {
    refreshLiveData();
    const now = Date.now();
    if (
      config.data?.liveAccountId &&
      equityDraft === (config.data?.accountEquityUsd ?? undefined) &&
      now - lastEquitySyncAttemptRef.current >= 60_000
    ) {
      lastEquitySyncAttemptRef.current = now;
      void syncEquityFromBroker({ silent: true }); // best-effort; its own success path calls refreshLiveData() again
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
  const [liveOptionsSaveBusy, setLiveOptionsSaveBusy] = useState(false);
  const [suggestLiveCapsBusy, setSuggestLiveCapsBusy] = useState(false);

  // Fills the draft fields only — it never saves by itself, so a suggestion
  // is always reviewed (and can be tweaked or ignored) before it takes effect.
  const applySuggestedLiveCaps = async () => {
    setSuggestLiveCapsBusy(true);
    try {
      const suggested = await client.suggestAutotradeLiveCaps();
      setLiveMaxOrderUsdDraft(suggested.liveMaxOrderUsd);
      setLiveMaxDailyLossUsdDraft(suggested.liveMaxDailyLossUsd);
      setLiveMaxOrdersPerDayDraft(suggested.liveMaxOrdersPerDay);
      toast('Suggested caps filled in below — review, then Save live-trading settings.', { type: 'info' });
    } catch (e) {
      toast((e as Error).message || 'Could not suggest live caps', { type: 'error' });
    } finally {
      setSuggestLiveCapsBusy(false);
    }
  };

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

  // Bundles the liveOptionsEnabled checkbox with its caps in one save — unlike
  // liveTradingEnabled, it needs no typed confirmation phrase (the master
  // gate above already covers that), so there's no separate "Enable" action
  // to keep in sync with a "Save caps" one the way LIVE_TRADING_CONFIRMATION_
  // PHRASE requires.
  const saveLiveOptionsCaps = async () => {
    setLiveOptionsSaveBusy(true);
    try {
      await client.setAutotradeConfig({
        liveOptionsEnabled: liveOptionsEnabledDraft,
        liveOptionsMaxOrderUsd: liveOptionsMaxOrderUsdDraft,
        liveOptionsMaxDailyLossUsd: liveOptionsMaxDailyLossUsdDraft,
        liveOptionsMaxOrdersPerDay: liveOptionsMaxOrdersPerDayDraft,
        liveOptionsFatFingerPct: liveOptionsFatFingerPctDraft,
        liveOptionsProbationTrades: liveOptionsProbationTradesDraft,
        liveOptionsProbationSizeMultiplier: liveOptionsProbationSizeMultiplierDraft,
      });
      config.reload();
      refreshLiveData();
      toast('Live options settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save live options settings', { type: 'error' });
    } finally {
      setLiveOptionsSaveBusy(false);
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
  const [btMaxPositions, setBtMaxPositions] = useState<number | undefined>(3);
  // Own value here, NOT synced from Configuration's tradeDirection above —
  // a backtest is a self-contained hypothesis, same reasoning as
  // btRiskProfile being independent of the live risk profile. Shared by all
  // three run buttons below, same as every other field in this form.
  const [btDirectionMode, setBtDirectionMode] = useState<AutotradeTradeDirectionMode>('long');
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
    if (!btFrom || !btTo || !btEquity || !btMaxPositions) {
      setBtErr('From, to, starting equity, and max concurrent positions are required');
      return;
    }
    setBtBusy(true);
    setBtErr(undefined);
    setBtResult(undefined);
    setBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = {
        symbols,
        from: btFrom,
        to: btTo,
        riskProfile: btRiskProfile,
        startingEquity: btEquity,
        maxConcurrentPositions: btMaxPositions,
        directionMode: btDirectionMode,
      };
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
    if (!btFrom || !btTo || !btEquity || !btMaxPositions) {
      setOptBtErr('From, to, starting equity, and max concurrent positions are required');
      return;
    }
    setOptBtBusy(true);
    setOptBtErr(undefined);
    setOptBtResult(undefined);
    setOptBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = {
        symbols,
        from: btFrom,
        to: btTo,
        riskProfile: btRiskProfile,
        startingEquity: btEquity,
        maxConcurrentPositions: btMaxPositions,
        // Same Options strategy setting the Configuration card + paper loop
        // use above — a human backtesting wants the SAME shape they've
        // configured live, not a hidden separate default.
        optionsDecisionConfig: { strategyType: optionsStrategyType },
        directionMode: btDirectionMode,
      };
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
    if (!btFrom || !btTo || !btEquity || !btMaxPositions) {
      setCombinedBtErr('From, to, starting equity, and max concurrent positions are required');
      return;
    }
    setCombinedBtBusy(true);
    setCombinedBtErr(undefined);
    setCombinedBtResult(undefined);
    setCombinedBtWfResult(undefined);
    setBtSubmitted({ from: btFrom, to: btTo, splitDate: btSplitDate });
    try {
      const body = {
        symbols,
        from: btFrom,
        to: btTo,
        riskProfile: btRiskProfile,
        startingEquity: btEquity,
        maxConcurrentPositions: btMaxPositions,
        optionsDecisionConfig: { strategyType: optionsStrategyType },
        directionMode: btDirectionMode,
      };
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
            onRefresh={refreshLiveDataAndMaybeSyncEquity}
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

      <div className="flex gap-1 border-b border-ink-600/60">
        {(['config', 'dashboard'] as const).map((v) => (
          <button
            key={v}
            className={cx(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px',
              view === v ? 'border-accent text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200',
            )}
            onClick={() => setView(v)}
          >
            {v === 'config' ? 'Configuration' : 'Dashboard'}
          </button>
        ))}
      </div>

      {/* Deliberately OUTSIDE the config/dashboard split below: it renders
          from local `killSwitch` state, not `config.data`, so a transient
          reload failure (e.g. right after a toggle — saveConfig/
          toggleKillSwitch both fire config.reload() without awaiting it)
          can never hide the one control that releases it — and a halt you
          need in a hurry shouldn't be a tab-switch away. */}
      <button
        onClick={toggleKillSwitch}
        disabled={killBusy}
        className={cx(
          'w-full rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
          killSwitch
            ? 'border-bear bg-bear/20 text-bear'
            : 'border-ink-600 bg-ink-700/40 text-slate-300 hover:border-bear/60',
        )}
      >
        {killSwitch ? '■ Kill switch ENGAGED — release' : 'Kill switch — engage halt'}
      </button>

      {view === 'config' && (
        <>
          {config.loading ? (
            <Spinner />
          ) : config.error ? (
            <ErrorState error={config.error} onRetry={config.reload} />
          ) : (
            <>
              <CollapsibleCard id="autotrade.config.core" title="Core settings">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => saveConfig({ enabled: e.target.checked })}
                    />
                    Auto-trading enabled
                  </label>
                  <Field
                    label="Risk profile"
                    hint="Just a label, journaled with every trade — per-trade risk, drawdown halt, position count, aggregate risk, correlated exposure, and trade caps are all set independently below and don't change with this switch."
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
                      onChange={(e) =>
                        saveConfig({ optionsStrategyType: e.target.value as AutotradeOptionsStrategyType })
                      }
                    >
                      <option value="single_leg">Single leg (default)</option>
                      <option value="debit_spread">Debit spread</option>
                    </select>
                  </Field>
                  <Field
                    label="Account equity ($)"
                    hint={
                      config.data?.liveAccountId
                        ? 'The risk engine sizes trades and computes its % caps against this. Auto-syncs from your live Webull account every 1 minute — set manually, or sync it now below.'
                        : 'The risk engine sizes trades and computes its % caps against this. Set manually — or set a Webull account ID under Live trading below to sync it automatically instead.'
                    }
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <NumberInput value={equityDraft} onChange={setEquityDraft} placeholder="e.g. 25000" />
                        <button
                          className="btn-ghost shrink-0"
                          aria-label="Save account equity"
                          onClick={() => saveConfig({ accountEquityUsd: equityDraft ?? null })}
                          disabled={equityDraft === (config.data?.accountEquityUsd ?? undefined)}
                        >
                          Save
                        </button>
                      </div>
                      <button
                        className="btn-ghost self-start text-xs"
                        onClick={() => syncEquityFromBroker()}
                        disabled={equitySyncBusy || !config.data?.liveAccountId}
                        title={
                          !config.data?.liveAccountId ? 'Set a Webull account ID under Live trading first' : undefined
                        }
                      >
                        {equitySyncBusy ? 'Syncing…' : 'Sync from Webull (net liquidation value)'}
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max concurrent positions"
                    hint="ONE combined budget for open positions — a stock position and an option position draw from the same pool. Applies to paper and live, equity and options alike."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={maxPositionsDraft} onChange={setMaxPositionsDraft} min={1} step={1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max concurrent positions"
                        onClick={() =>
                          maxPositionsDraft != null && saveConfig({ maxConcurrentPositions: maxPositionsDraft })
                        }
                        disabled={
                          maxPositionsDraft == null ||
                          maxPositionsDraft < 1 ||
                          maxPositionsDraft === config.data?.maxConcurrentPositions
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.risk" title="Position sizing & risk guardrails">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <Field
                    label="Risk per trade (%)"
                    hint="% of account equity risked per trade, before any step-down cut. For options, this is premium paid, not notional exposure — sizing stays consistent with the equity risk model."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={riskPerTradePctDraft}
                        onChange={setRiskPerTradePctDraft}
                        min={0}
                        max={100}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save risk per trade"
                        onClick={() =>
                          riskPerTradePctDraft != null && saveConfig({ riskPerTradePct: riskPerTradePctDraft })
                        }
                        disabled={
                          riskPerTradePctDraft == null ||
                          riskPerTradePctDraft < 0 ||
                          riskPerTradePctDraft > 100 ||
                          riskPerTradePctDraft === config.data?.riskPerTradePct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max daily drawdown (%)"
                    hint="Today's realized P&L crossing below this % of equity halts new entries for the rest of the day — existing positions' stops/targets keep working regardless."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxDailyDrawdownPctDraft}
                        onChange={setMaxDailyDrawdownPctDraft}
                        min={0}
                        max={100}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max daily drawdown"
                        onClick={() =>
                          maxDailyDrawdownPctDraft != null &&
                          saveConfig({ maxDailyDrawdownPct: maxDailyDrawdownPctDraft })
                        }
                        disabled={
                          maxDailyDrawdownPctDraft == null ||
                          maxDailyDrawdownPctDraft < 0 ||
                          maxDailyDrawdownPctDraft > 100 ||
                          maxDailyDrawdownPctDraft === config.data?.maxDailyDrawdownPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Step-down after (consecutive losses)"
                    hint="Once your current losing streak reaches this count, new positions size down by the cut below — until a win breaks the streak."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={stepDownAfterLossesDraft}
                        onChange={setStepDownAfterLossesDraft}
                        min={0}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save step-down loss trigger"
                        onClick={() =>
                          stepDownAfterLossesDraft != null &&
                          saveConfig({ stepDownAfterLosses: stepDownAfterLossesDraft })
                        }
                        disabled={
                          stepDownAfterLossesDraft == null ||
                          stepDownAfterLossesDraft < 0 ||
                          stepDownAfterLossesDraft === config.data?.stepDownAfterLosses
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Step-down size cut (%)"
                    hint="How much smaller a position sizes once step-down is active — e.g. 50 halves risk per trade for the duration of the streak."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={stepDownSizeCutPctDraft}
                        onChange={setStepDownSizeCutPctDraft}
                        min={0}
                        max={100}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save step-down size cut"
                        onClick={() =>
                          stepDownSizeCutPctDraft != null && saveConfig({ stepDownSizeCutPct: stepDownSizeCutPctDraft })
                        }
                        disabled={
                          stepDownSizeCutPctDraft == null ||
                          stepDownSizeCutPctDraft < 0 ||
                          stepDownSizeCutPctDraft > 100 ||
                          stepDownSizeCutPctDraft === config.data?.stepDownSizeCutPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max aggregate open risk (%)"
                    hint="Pre-trade cap on total open risk (size × stop distance) across every open position plus the one being proposed — blocks a trade that would push the combined total over this % of equity, even if per-trade risk and position count are individually fine. ONE combined budget shared by stocks and options."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxAggregateOpenRiskPctDraft}
                        onChange={setMaxAggregateOpenRiskPctDraft}
                        min={0}
                        max={100}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max aggregate open risk"
                        onClick={() =>
                          maxAggregateOpenRiskPctDraft != null &&
                          saveConfig({ maxAggregateOpenRiskPct: maxAggregateOpenRiskPctDraft })
                        }
                        disabled={
                          maxAggregateOpenRiskPctDraft == null ||
                          maxAggregateOpenRiskPctDraft < 0 ||
                          maxAggregateOpenRiskPctDraft > 100 ||
                          maxAggregateOpenRiskPctDraft === config.data?.maxAggregateOpenRiskPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max correlated exposure (%)"
                    hint="Cap on capital (not risk) already concentrated in tickers statistically correlated with a candidate, per the correlation lookback/threshold settings below — guards against several correlated names getting stopped out together."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxCorrelatedExposurePctDraft}
                        onChange={setMaxCorrelatedExposurePctDraft}
                        min={0}
                        max={100}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max correlated exposure"
                        onClick={() =>
                          maxCorrelatedExposurePctDraft != null &&
                          saveConfig({ maxCorrelatedExposurePct: maxCorrelatedExposurePctDraft })
                        }
                        disabled={
                          maxCorrelatedExposurePctDraft == null ||
                          maxCorrelatedExposurePctDraft < 0 ||
                          maxCorrelatedExposurePctDraft > 100 ||
                          maxCorrelatedExposurePctDraft === config.data?.maxCorrelatedExposurePct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Correlation lookback (trading days)"
                    hint="How many trading days of daily-return history are compared when measuring correlation between two symbols, for the max correlated exposure cap above."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={correlationLookbackDaysDraft}
                        onChange={setCorrelationLookbackDaysDraft}
                        min={1}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save correlation lookback"
                        onClick={() =>
                          correlationLookbackDaysDraft != null &&
                          saveConfig({ correlationLookbackDays: correlationLookbackDaysDraft })
                        }
                        disabled={
                          correlationLookbackDaysDraft == null ||
                          correlationLookbackDaysDraft < 1 ||
                          correlationLookbackDaysDraft === config.data?.correlationLookbackDays
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Correlation threshold (|r|)"
                    hint="|Pearson r| at or above this counts two tickers as 'correlated' for the max correlated exposure cap above. 0-1, not a percentage."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={correlationThresholdDraft}
                        onChange={setCorrelationThresholdDraft}
                        min={0}
                        max={1}
                        step={0.05}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save correlation threshold"
                        onClick={() =>
                          correlationThresholdDraft != null &&
                          saveConfig({ correlationThreshold: correlationThresholdDraft })
                        }
                        disabled={
                          correlationThresholdDraft == null ||
                          correlationThresholdDraft < 0 ||
                          correlationThresholdDraft > 1 ||
                          correlationThresholdDraft === config.data?.correlationThreshold
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max sector exposure (%)"
                    hint="Cap on capital (not risk) already concentrated in the candidate's own universe sector, regardless of price correlation — a cheaper backstop to the correlation cap above (two names in the same sector can carry low price correlation and still share the same macro risk)."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxSectorExposurePctDraft}
                        onChange={setMaxSectorExposurePctDraft}
                        min={0}
                        max={100}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max sector exposure"
                        onClick={() =>
                          maxSectorExposurePctDraft != null &&
                          saveConfig({ maxSectorExposurePct: maxSectorExposurePctDraft })
                        }
                        disabled={
                          maxSectorExposurePctDraft == null ||
                          maxSectorExposurePctDraft < 0 ||
                          maxSectorExposurePctDraft > 100 ||
                          maxSectorExposurePctDraft === config.data?.maxSectorExposurePct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max trades per day"
                    hint="Hard cap on new entries risk-check will approve per day — paper and live, stocks and options, all combined."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={maxTradesPerDayDraft} onChange={setMaxTradesPerDayDraft} min={0} step={1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max trades per day"
                        onClick={() =>
                          maxTradesPerDayDraft != null && saveConfig({ maxTradesPerDay: maxTradesPerDayDraft })
                        }
                        disabled={
                          maxTradesPerDayDraft == null ||
                          maxTradesPerDayDraft < 0 ||
                          maxTradesPerDayDraft === config.data?.maxTradesPerDay
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Regime ATR threshold (%)"
                    hint="A softer, graduated companion to Max market ATR (%) below: once the broad-market proxy's own ATR% crosses THIS lower threshold, new positions size down (see Regime size cut below) instead of being blocked outright — Max market ATR (%) still blocks everything once volatility gets more extreme. Stacks with step-down sizing above if both are active at once. Live + paper only — no backtest equivalent. Check Recent activity's risk_check entries to see it fire."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={regimeAtrThresholdPctDraft}
                        onChange={setRegimeAtrThresholdPctDraft}
                        min={0}
                        max={100}
                        step={0.5}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save regime ATR threshold"
                        onClick={() =>
                          regimeAtrThresholdPctDraft != null &&
                          saveConfig({ regimeAtrThresholdPct: regimeAtrThresholdPctDraft })
                        }
                        disabled={
                          regimeAtrThresholdPctDraft == null ||
                          regimeAtrThresholdPctDraft < 0 ||
                          regimeAtrThresholdPctDraft > 100 ||
                          regimeAtrThresholdPctDraft === config.data?.regimeAtrThresholdPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Regime size cut (%)"
                    hint="% cut to risk-per-trade once the regime ATR threshold above is active. 0 disables it (default) — leaving this at 0 means Regime ATR threshold has no effect regardless of its own value."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={regimeSizeCutPctDraft}
                        onChange={setRegimeSizeCutPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (no cut)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save regime size cut"
                        onClick={() =>
                          regimeSizeCutPctDraft != null && saveConfig({ regimeSizeCutPct: regimeSizeCutPctDraft })
                        }
                        disabled={
                          regimeSizeCutPctDraft == null ||
                          regimeSizeCutPctDraft < 0 ||
                          regimeSizeCutPctDraft > 100 ||
                          regimeSizeCutPctDraft === config.data?.regimeSizeCutPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.screening" title="Screening & entry filters">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <Field
                    label="Trade direction"
                    hint={
                      tradeDirection === 'both'
                        ? 'Screens every candidate as both a long and a short and takes whichever direction actually qualifies, per symbol — can hold a long on one stock and a short on another at once. Live shorts also need "Allow naked short" enabled below (a short\'s downside is unlimited, unlike a long); paper shorts work either way.'
                        : tradeDirection === 'short'
                          ? 'Only takes short setups. Live shorts also need "Allow naked short" enabled below (a short\'s downside is unlimited, unlike a long); paper shorts work either way.'
                          : 'Only takes long setups (default) — unchanged original behavior.'
                    }
                  >
                    <select
                      className="input"
                      value={tradeDirection}
                      onChange={(e) => saveConfig({ tradeDirection: e.target.value as AutotradeTradeDirectionMode })}
                    >
                      <option value="long">Long only (default)</option>
                      <option value="short">Short only</option>
                      <option value="both">Both</option>
                    </select>
                  </Field>
                  <Field
                    label="Min relative volume (×)"
                    hint="Screener's relative-volume floor — a candidate's volume must be at least this many times its average to pass. 0 disables this specific filter."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={minRelVolDraft} onChange={setMinRelVolDraft} min={0} step={0.1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save min relative volume"
                        onClick={() => minRelVolDraft != null && saveConfig({ minRelVol: minRelVolDraft })}
                        disabled={
                          minRelVolDraft == null || minRelVolDraft < 0 || minRelVolDraft === config.data?.minRelVol
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={requireWeeklyTrendAlignment}
                        onChange={(e) => saveConfig({ requireWeeklyTrendAlignment: e.target.checked })}
                      />
                      Require weekly trend alignment
                    </label>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      A second, longer-horizon confirmation on top of the daily setup: price must ALSO be on the right
                      side of its own weekly moving average. Live, paper, and backtest — check Recent activity to see it
                      fire.
                    </p>
                  </div>
                  <Field
                    label="Relative strength weight (0-100)"
                    hint="How much a candidate's out/under-performance vs. the benchmark below counts toward its total screener score — same 0-100 scale as every other scoring component. 0 (default) disables it entirely, including the extra benchmark-quote fetch."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={relativeStrengthWeightDraft}
                        onChange={setRelativeStrengthWeightDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save relative strength weight"
                        onClick={() =>
                          relativeStrengthWeightDraft != null &&
                          saveConfig({ relativeStrengthWeight: relativeStrengthWeightDraft })
                        }
                        disabled={
                          relativeStrengthWeightDraft == null ||
                          relativeStrengthWeightDraft < 0 ||
                          relativeStrengthWeightDraft > 100 ||
                          relativeStrengthWeightDraft === config.data?.relativeStrengthWeight
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Benchmark symbol"
                    hint="What relative strength above is measured against — e.g. SPY. Only matters when that weight is nonzero."
                  >
                    <div className="flex gap-2">
                      <input
                        className="input"
                        value={benchmarkSymbolDraft}
                        onChange={(e) => setBenchmarkSymbolDraft(e.target.value.toUpperCase())}
                        placeholder="SPY"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save benchmark symbol"
                        onClick={() =>
                          benchmarkSymbolDraft.trim() !== '' &&
                          saveConfig({ benchmarkSymbol: benchmarkSymbolDraft.trim() })
                        }
                        disabled={
                          benchmarkSymbolDraft.trim() === '' ||
                          benchmarkSymbolDraft.trim() === config.data?.benchmarkSymbol
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Relative strength lookback (days)"
                    hint="Trading days back for both the candidate's own and the benchmark's return that relative strength compares."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={relativeStrengthLookbackDaysDraft}
                        onChange={setRelativeStrengthLookbackDaysDraft}
                        min={1}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save relative strength lookback"
                        onClick={() =>
                          relativeStrengthLookbackDaysDraft != null &&
                          saveConfig({ relativeStrengthLookbackDays: relativeStrengthLookbackDaysDraft })
                        }
                        disabled={
                          relativeStrengthLookbackDaysDraft == null ||
                          relativeStrengthLookbackDaysDraft < 1 ||
                          relativeStrengthLookbackDaysDraft === config.data?.relativeStrengthLookbackDays
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max ticker ATR (%)"
                    hint="Skip a candidate whose own ATR% (of price) exceeds this — the loop's own volatility guard, stricter than the manual Screen/Decision preview applies."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxTickerAtrPctDraft}
                        onChange={setMaxTickerAtrPctDraft}
                        min={0}
                        max={100}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max ticker ATR"
                        onClick={() =>
                          maxTickerAtrPctDraft != null && saveConfig({ maxTickerAtrPct: maxTickerAtrPctDraft })
                        }
                        disabled={
                          maxTickerAtrPctDraft == null ||
                          maxTickerAtrPctDraft < 0 ||
                          maxTickerAtrPctDraft > 100 ||
                          maxTickerAtrPctDraft === config.data?.maxTickerAtrPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max market ATR (%)"
                    hint="Skip ALL new entries this cycle if SPY's own ATR% exceeds this — a broad-market volatility circuit breaker."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={maxMarketAtrPctDraft}
                        onChange={setMaxMarketAtrPctDraft}
                        min={0}
                        max={100}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max market ATR"
                        onClick={() =>
                          maxMarketAtrPctDraft != null && saveConfig({ maxMarketAtrPct: maxMarketAtrPctDraft })
                        }
                        disabled={
                          maxMarketAtrPctDraft == null ||
                          maxMarketAtrPctDraft < 0 ||
                          maxMarketAtrPctDraft > 100 ||
                          maxMarketAtrPctDraft === config.data?.maxMarketAtrPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.equityExits" title="Equity exits">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <Field
                    label="Stop distance (× ATR)"
                    hint="Stop distance = this × the candidate's own ATR — e.g. 1.5 places the stop 1.5 ATRs away from entry."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={stopAtrMultipleDraft} onChange={setStopAtrMultipleDraft} min={0} step={0.1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save stop distance"
                        onClick={() =>
                          stopAtrMultipleDraft != null && saveConfig({ stopAtrMultiple: stopAtrMultipleDraft })
                        }
                        disabled={
                          stopAtrMultipleDraft == null ||
                          stopAtrMultipleDraft <= 0 ||
                          stopAtrMultipleDraft === config.data?.stopAtrMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Target (R-multiple)"
                    hint="Target distance = stop distance × this — e.g. 2 places the target twice as far out as the stop (2R)."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={targetRMultipleDraft} onChange={setTargetRMultipleDraft} min={0} step={0.1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save target R-multiple"
                        onClick={() =>
                          targetRMultipleDraft != null && saveConfig({ targetRMultiple: targetRMultipleDraft })
                        }
                        disabled={
                          targetRMultipleDraft == null ||
                          targetRMultipleDraft <= 0 ||
                          targetRMultipleDraft === config.data?.targetRMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max hold time (days)"
                    hint="Force-close a position after this many calendar days if neither the stop nor target has been hit yet. 0 disables this check (hold until stop/target/manual close, as before this existed)."
                  >
                    <div className="flex gap-2">
                      <NumberInput value={maxHoldDaysDraft} onChange={setMaxHoldDaysDraft} min={0} step={1} />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max hold time"
                        onClick={() => maxHoldDaysDraft != null && saveConfig({ maxHoldDays: maxHoldDaysDraft })}
                        disabled={
                          maxHoldDaysDraft == null ||
                          maxHoldDaysDraft < 0 ||
                          maxHoldDaysDraft === config.data?.maxHoldDays
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Breakeven trigger (R-multiple)"
                    hint="Once unrealized gain reaches this many R, move the stop to exactly the entry price — a one-time move, never applied if it would loosen the current stop. 0 disables it. Paper and backtest only; live positions are untouched."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={breakevenTriggerRMultipleDraft}
                        onChange={setBreakevenTriggerRMultipleDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save breakeven trigger"
                        onClick={() =>
                          breakevenTriggerRMultipleDraft != null &&
                          saveConfig({ breakevenTriggerRMultiple: breakevenTriggerRMultipleDraft })
                        }
                        disabled={
                          breakevenTriggerRMultipleDraft == null ||
                          breakevenTriggerRMultipleDraft < 0 ||
                          breakevenTriggerRMultipleDraft === config.data?.breakevenTriggerRMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Trailing start (R-multiple)"
                    hint="Once unrealized gain reaches this many R, start trailing the stop (see trailing distance below) behind the best price seen since entry. 0 disables trailing — independent of the breakeven trigger above."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={trailStartRMultipleDraft}
                        onChange={setTrailStartRMultipleDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save trailing start"
                        onClick={() =>
                          trailStartRMultipleDraft != null &&
                          saveConfig({ trailStartRMultiple: trailStartRMultipleDraft })
                        }
                        disabled={
                          trailStartRMultipleDraft == null ||
                          trailStartRMultipleDraft < 0 ||
                          trailStartRMultipleDraft === config.data?.trailStartRMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Trailing distance (R-multiple)"
                    hint="Once trailing is active, the stop trails this many R (in the position's own original risk-distance terms) behind the best price seen — ratcheting only favorably, same as the breakeven trigger. Meaningless if trailing start above is 0."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={trailStopRMultipleDraft}
                        onChange={setTrailStopRMultipleDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save trailing distance"
                        onClick={() =>
                          trailStopRMultipleDraft != null && saveConfig({ trailStopRMultiple: trailStopRMultipleDraft })
                        }
                        disabled={
                          trailStopRMultipleDraft == null ||
                          trailStopRMultipleDraft < 0 ||
                          trailStopRMultipleDraft === config.data?.trailStopRMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Partial exit trigger (R-multiple)"
                    hint="Once unrealized gain reaches this many R, close the percentage below once — the rest keeps running toward its original target (or continues trailing). 0 disables it."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={partialExitRMultipleDraft}
                        onChange={setPartialExitRMultipleDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save partial exit trigger"
                        onClick={() =>
                          partialExitRMultipleDraft != null &&
                          saveConfig({ partialExitRMultiple: partialExitRMultipleDraft })
                        }
                        disabled={
                          partialExitRMultipleDraft == null ||
                          partialExitRMultipleDraft < 0 ||
                          partialExitRMultipleDraft === config.data?.partialExitRMultiple
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Partial exit size (%)"
                    hint="% of the position closed at the partial-exit trigger above. Only meaningful when that trigger is nonzero."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={partialExitPctDraft}
                        onChange={setPartialExitPctDraft}
                        min={0}
                        max={100}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save partial exit size"
                        onClick={() =>
                          partialExitPctDraft != null && saveConfig({ partialExitPct: partialExitPctDraft })
                        }
                        disabled={
                          partialExitPctDraft == null ||
                          partialExitPctDraft < 0 ||
                          partialExitPctDraft > 100 ||
                          partialExitPctDraft === config.data?.partialExitPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.optionsExits" title="Options exits">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <Field
                    label="Options stop-loss (%)"
                    hint="Close a PAPER/BACKTEST options position once unrealized loss reaches this % of premium paid (net debit, for a spread). 0 disables it — LIVE options positions are unaffected and stay time-exit-only."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsStopLossPctDraft}
                        onChange={setOptionsStopLossPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options stop-loss"
                        onClick={() =>
                          optionsStopLossPctDraft != null && saveConfig({ optionsStopLossPct: optionsStopLossPctDraft })
                        }
                        disabled={
                          optionsStopLossPctDraft == null ||
                          optionsStopLossPctDraft < 0 ||
                          optionsStopLossPctDraft > 100 ||
                          optionsStopLossPctDraft === config.data?.optionsStopLossPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options take-profit (%)"
                    hint="Close a PAPER/BACKTEST options position once unrealized gain reaches this % of premium paid (net debit, for a spread). 0 disables it — LIVE options positions are unaffected and stay time-exit-only."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsTakeProfitPctDraft}
                        onChange={setOptionsTakeProfitPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options take-profit"
                        onClick={() =>
                          optionsTakeProfitPctDraft != null &&
                          saveConfig({ optionsTakeProfitPct: optionsTakeProfitPctDraft })
                        }
                        disabled={
                          optionsTakeProfitPctDraft == null ||
                          optionsTakeProfitPctDraft < 0 ||
                          optionsTakeProfitPctDraft > 100 ||
                          optionsTakeProfitPctDraft === config.data?.optionsTakeProfitPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options breakeven trigger (%)"
                    hint="Once unrealized gain (% of premium paid, net debit for a spread) reaches this level, move the stop-loss floor to breakeven (0% — no gain, no loss) — a one-time move, never applied if it would loosen an already-ratcheted floor. 0 disables it. Paper and backtest only; live positions are untouched."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsBreakevenTriggerPctDraft}
                        onChange={setOptionsBreakevenTriggerPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options breakeven trigger"
                        onClick={() =>
                          optionsBreakevenTriggerPctDraft != null &&
                          saveConfig({ optionsBreakevenTriggerPct: optionsBreakevenTriggerPctDraft })
                        }
                        disabled={
                          optionsBreakevenTriggerPctDraft == null ||
                          optionsBreakevenTriggerPctDraft < 0 ||
                          optionsBreakevenTriggerPctDraft > 100 ||
                          optionsBreakevenTriggerPctDraft === config.data?.optionsBreakevenTriggerPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options trailing start (%)"
                    hint="Once unrealized gain reaches this %, start trailing the stop-loss floor (see trailing distance below) behind the best gain % seen since entry. 0 disables trailing — independent of the breakeven trigger above."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsTrailStartPctDraft}
                        onChange={setOptionsTrailStartPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options trailing start"
                        onClick={() =>
                          optionsTrailStartPctDraft != null &&
                          saveConfig({ optionsTrailStartPct: optionsTrailStartPctDraft })
                        }
                        disabled={
                          optionsTrailStartPctDraft == null ||
                          optionsTrailStartPctDraft < 0 ||
                          optionsTrailStartPctDraft > 100 ||
                          optionsTrailStartPctDraft === config.data?.optionsTrailStartPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options trailing distance (%)"
                    hint="Once trailing is active, the stop-loss floor trails this many percentage points behind the best unrealized gain % seen — ratcheting only favorably, same as the breakeven trigger. Meaningless if trailing start above is 0."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsTrailStopPctDraft}
                        onChange={setOptionsTrailStopPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options trailing distance"
                        onClick={() =>
                          optionsTrailStopPctDraft != null &&
                          saveConfig({ optionsTrailStopPct: optionsTrailStopPctDraft })
                        }
                        disabled={
                          optionsTrailStopPctDraft == null ||
                          optionsTrailStopPctDraft < 0 ||
                          optionsTrailStopPctDraft > 100 ||
                          optionsTrailStopPctDraft === config.data?.optionsTrailStopPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options partial exit trigger (%)"
                    hint="Once unrealized gain reaches this %, close the percentage below once — the rest keeps running toward its original take-profit (or continues trailing). 0 disables it."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsPartialExitTriggerPctDraft}
                        onChange={setOptionsPartialExitTriggerPctDraft}
                        min={0}
                        max={100}
                        step={1}
                        placeholder="0 (disabled)"
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options partial exit trigger"
                        onClick={() =>
                          optionsPartialExitTriggerPctDraft != null &&
                          saveConfig({ optionsPartialExitTriggerPct: optionsPartialExitTriggerPctDraft })
                        }
                        disabled={
                          optionsPartialExitTriggerPctDraft == null ||
                          optionsPartialExitTriggerPctDraft < 0 ||
                          optionsPartialExitTriggerPctDraft > 100 ||
                          optionsPartialExitTriggerPctDraft === config.data?.optionsPartialExitTriggerPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Options partial exit size (%)"
                    hint="% of the contracts closed at the partial-exit trigger above. Only meaningful when that trigger is nonzero."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={optionsPartialExitPctDraft}
                        onChange={setOptionsPartialExitPctDraft}
                        min={0}
                        max={100}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save options partial exit size"
                        onClick={() =>
                          optionsPartialExitPctDraft != null &&
                          saveConfig({ optionsPartialExitPct: optionsPartialExitPctDraft })
                        }
                        disabled={
                          optionsPartialExitPctDraft == null ||
                          optionsPartialExitPctDraft < 0 ||
                          optionsPartialExitPctDraft > 100 ||
                          optionsPartialExitPctDraft === config.data?.optionsPartialExitPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.entryTiming" title="Entry timing">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <Field
                    label="Session buffer (minutes)"
                    hint="No new entries within this many minutes of the session open or close — the opening auction and closing imbalance both distort prices."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={sessionBufferMinutesDraft}
                        onChange={setSessionBufferMinutesDraft}
                        min={0}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save session buffer"
                        onClick={() =>
                          sessionBufferMinutesDraft != null &&
                          saveConfig({ sessionBufferMinutes: sessionBufferMinutesDraft })
                        }
                        disabled={
                          sessionBufferMinutesDraft == null ||
                          sessionBufferMinutesDraft < 0 ||
                          sessionBufferMinutesDraft === config.data?.sessionBufferMinutes
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Earnings blackout (days)"
                    hint="Skip an equity candidate whose next known earnings date falls within this many calendar days — an unattended loop can't react to an earnings-driven overnight gap. 0 disables this check. Options entries are unaffected (IV rank already covers this there)."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={earningsBlackoutDaysDraft}
                        onChange={setEarningsBlackoutDaysDraft}
                        min={0}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save earnings blackout"
                        onClick={() =>
                          earningsBlackoutDaysDraft != null &&
                          saveConfig({ earningsBlackoutDays: earningsBlackoutDaysDraft })
                        }
                        disabled={
                          earningsBlackoutDaysDraft == null ||
                          earningsBlackoutDaysDraft < 0 ||
                          earningsBlackoutDaysDraft === config.data?.earningsBlackoutDays
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>

              <CollapsibleCard id="autotrade.config.autoPromote" title="Auto-promote recurring movers">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoPromoteMoversEnabled}
                      onChange={(e) => saveConfig({ autoPromoteMoversEnabled: e.target.checked })}
                    />
                    Auto-promote recurring movers
                  </label>
                  <Field
                    label="Promotion threshold"
                    hint="A movers-sourced symbol (Webull's daily gainers/unusual-volume feed) that clears screening this many DISTINCT days within the window earns a permanent spot in your universe — automatically, from the automated loop only, never from a manual Run screen."
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <NumberInput
                        value={autoPromoteThresholdDraft}
                        onChange={setAutoPromoteThresholdDraft}
                        min={1}
                        step={1}
                      />
                      <span className="text-xs text-slate-500">times within</span>
                      <NumberInput
                        value={autoPromoteWindowDaysDraft}
                        onChange={setAutoPromoteWindowDaysDraft}
                        min={1}
                        step={1}
                      />
                      <span className="text-xs text-slate-500">days</span>
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save promotion threshold"
                        onClick={() =>
                          autoPromoteThresholdDraft != null &&
                          autoPromoteWindowDaysDraft != null &&
                          saveConfig({
                            autoPromoteThreshold: autoPromoteThresholdDraft,
                            autoPromoteWindowDays: autoPromoteWindowDaysDraft,
                          })
                        }
                        disabled={
                          autoPromoteThresholdDraft == null ||
                          autoPromoteWindowDaysDraft == null ||
                          autoPromoteThresholdDraft < 1 ||
                          autoPromoteWindowDaysDraft < 1 ||
                          (autoPromoteThresholdDraft === config.data?.autoPromoteThreshold &&
                            autoPromoteWindowDaysDraft === config.data?.autoPromoteWindowDays)
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max auto-promoted symbols"
                    hint="Lifetime cap on symbols added by this mechanism specifically — doesn't count your seeded or manually-added universe. Once a symbol is promoted (or you remove one later), it's never reconsidered again either way."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={autoPromoteMaxSymbolsDraft}
                        onChange={setAutoPromoteMaxSymbolsDraft}
                        min={0}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max auto-promoted symbols"
                        onClick={() =>
                          autoPromoteMaxSymbolsDraft != null &&
                          saveConfig({ autoPromoteMaxSymbols: autoPromoteMaxSymbolsDraft })
                        }
                        disabled={
                          autoPromoteMaxSymbolsDraft == null ||
                          autoPromoteMaxSymbolsDraft < 0 ||
                          autoPromoteMaxSymbolsDraft === config.data?.autoPromoteMaxSymbols
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>
              <CollapsibleCard id="autotrade.config.autoTune" title="Auto-tune from realized edge">
                <div className="grid sm:grid-cols-2 gap-3 items-end">
                  <label className="flex items-start gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={autoTuneEnabled}
                      onChange={(e) => saveConfig({ autoTuneEnabled: e.target.checked })}
                    />
                    <span>
                      Auto-tune from realized edge
                      <span className="block text-[11px] text-slate-500">
                        Off by default. Once a day, nudges risk-per-trade toward the Journal page&apos;s own Kelly
                        suggestion and auto-excludes any symbol whose average live-fill slippage crosses the threshold
                        below — both bounded by the settings here, and both journaled to Recent Activity (Dashboard tab)
                        every time they fire, same as every other automated action this loop takes.
                      </span>
                    </span>
                  </label>
                  <Field
                    label="Min sample size"
                    hint="Decisive closed trades (for the risk-% tune) or live fills with a comparable limit price (for the slippage exclusion) required before a reading is trusted — matches the Journal page's own Kelly reliability floor by default."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={autoTuneMinTradesDraft}
                        onChange={setAutoTuneMinTradesDraft}
                        min={1}
                        step={1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save min sample size"
                        onClick={() =>
                          autoTuneMinTradesDraft != null && saveConfig({ autoTuneMinTrades: autoTuneMinTradesDraft })
                        }
                        disabled={
                          autoTuneMinTradesDraft == null ||
                          autoTuneMinTradesDraft < 1 ||
                          autoTuneMinTradesDraft === config.data?.autoTuneMinTrades
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Max daily risk-% step"
                    hint="Largest change to risk-per-trade allowed in a single day's adjustment (percentage points) — bounds how fast auto-tune can move live position sizing even if the Kelly suggestion itself jumps sharply."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={autoTuneMaxStepPctDraft}
                        onChange={setAutoTuneMaxStepPctDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save max daily risk-% step"
                        onClick={() =>
                          autoTuneMaxStepPctDraft != null && saveConfig({ autoTuneMaxStepPct: autoTuneMaxStepPctDraft })
                        }
                        disabled={
                          autoTuneMaxStepPctDraft == null ||
                          autoTuneMaxStepPctDraft < 0 ||
                          autoTuneMaxStepPctDraft === config.data?.autoTuneMaxStepPct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Slippage exclusion threshold (%)"
                    hint="A symbol whose average live-fill slippage (% of the limit price you set, same sign convention as the Journal's Execution quality report — positive always cost you money) is at or above this gets auto-excluded from future autotrade candidates."
                  >
                    <div className="flex gap-2">
                      <NumberInput
                        value={autoTuneSlippageExcludePctDraft}
                        onChange={setAutoTuneSlippageExcludePctDraft}
                        min={0}
                        step={0.1}
                      />
                      <button
                        className="btn-ghost shrink-0"
                        aria-label="Save slippage exclusion threshold"
                        onClick={() =>
                          autoTuneSlippageExcludePctDraft != null &&
                          saveConfig({ autoTuneSlippageExcludePct: autoTuneSlippageExcludePctDraft })
                        }
                        disabled={
                          autoTuneSlippageExcludePctDraft == null ||
                          autoTuneSlippageExcludePctDraft < 0 ||
                          autoTuneSlippageExcludePctDraft === config.data?.autoTuneSlippageExcludePct
                        }
                      >
                        Save
                      </button>
                    </div>
                  </Field>
                </div>
              </CollapsibleCard>
            </>
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
              paper positions keep working: their stop/target levels are still checked every cycle (see the &quot;Paper
              trading&quot; card on the Dashboard tab).
            </p>
          )}
          {enabled && !killSwitch && (
            <p className="text-[11px] text-amber-400 mt-3">
              Auto-trading is enabled — the background loop is now actively scanning and placing <strong>paper</strong>{' '}
              trades on a schedule. It never touches a real broker (see &quot;Paper trading&quot; on the Dashboard tab);
              going live is configured separately (see &quot;Live trading&quot; below).
            </p>
          )}

          <CollapsibleCard id="autotrade.liveTrading" title="Live trading">
            <p className="text-[11px] text-slate-500 mb-3">
              Places REAL orders through Webull once enabled — no per-order confirmation, only the guardrails configured
              here plus the kill switch. Independent of paper trading (both can run at once — see the Dashboard tab).
              See docs/AUTOTRADING_SPEC.md&apos;s Phase 8 design for the full reasoning.
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
                suggestLiveCapsBusy={suggestLiveCapsBusy}
                onSuggestLiveCaps={applySuggestedLiveCaps}
                confirmLiveText={confirmLiveText}
                setConfirmLiveText={setConfirmLiveText}
                confirmPhrase={LIVE_TRADING_CONFIRMATION_PHRASE}
                liveEnableBusy={liveEnableBusy}
                onEnable={enableLiveTrading}
                onDisable={disableLiveTrading}
                dashboard={dashboard.data}
                liveOptionsEnabledDraft={liveOptionsEnabledDraft}
                setLiveOptionsEnabledDraft={setLiveOptionsEnabledDraft}
                liveOptionsMaxOrderUsdDraft={liveOptionsMaxOrderUsdDraft}
                setLiveOptionsMaxOrderUsdDraft={setLiveOptionsMaxOrderUsdDraft}
                liveOptionsMaxDailyLossUsdDraft={liveOptionsMaxDailyLossUsdDraft}
                setLiveOptionsMaxDailyLossUsdDraft={setLiveOptionsMaxDailyLossUsdDraft}
                liveOptionsMaxOrdersPerDayDraft={liveOptionsMaxOrdersPerDayDraft}
                setLiveOptionsMaxOrdersPerDayDraft={setLiveOptionsMaxOrdersPerDayDraft}
                liveOptionsFatFingerPctDraft={liveOptionsFatFingerPctDraft}
                setLiveOptionsFatFingerPctDraft={setLiveOptionsFatFingerPctDraft}
                liveOptionsProbationTradesDraft={liveOptionsProbationTradesDraft}
                setLiveOptionsProbationTradesDraft={setLiveOptionsProbationTradesDraft}
                liveOptionsProbationSizeMultiplierDraft={liveOptionsProbationSizeMultiplierDraft}
                setLiveOptionsProbationSizeMultiplierDraft={setLiveOptionsProbationSizeMultiplierDraft}
                liveOptionsSaveBusy={liveOptionsSaveBusy}
                onSaveLiveOptionsCaps={saveLiveOptionsCaps}
              />
            )}
          </CollapsibleCard>
        </>
      )}

      {view === 'dashboard' && (
        <>
          <CollapsibleCard id="autotrade.livePositions" title="Live positions">
            <h4 className="font-medium text-sm mb-3 text-bear">
              Live positions — real money, no per-order confirmation
            </h4>
            <p className="text-xs text-slate-500 mb-3">
              The real fills the loop has actually placed through Webull — the same{' '}
              <code className="text-[11px]">positions</code> rows your own manual trades use, tagged so only
              autotrade&apos;s own are shown here. Nothing here is simulated; see the Positions and Journal pages for
              your full real book (autotrade&apos;s fills included, unmarked there).
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
                    <LivePositionsTable positions={rows} onClose={setCloseEquityPos} />
                  </>
                );
              })()
            )}

            <h4 className="font-medium text-sm mt-5 mb-3 text-bear">
              Live options positions — real money, no per-order confirmation
            </h4>
            <p className="text-xs text-slate-500 mb-3">
              The real options fills the loop has actually placed through Webull — its own ledger (
              <code className="text-[11px]">autotrade_live_options_positions</code>), separate from the equity live
              positions above since a debit spread needs a second leg&apos;s columns.
            </p>
            {liveOptionsPositions.loading ? (
              <Spinner />
            ) : liveOptionsPositions.error ? (
              <ErrorState error={liveOptionsPositions.error} onRetry={liveOptionsPositions.reload} />
            ) : (
              (() => {
                const rows = liveOptionsPositions.data?.positions ?? [];
                const open = rows.filter((p) => p.status === 'open');
                const closed = rows.filter((p) => p.status === 'closed');
                const pnls = closed.map((p) => optionsPaperPnl(p)).filter((v): v is number => v !== null);
                const totalRealized = pnls.reduce((s, v) => s + v, 0);
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
                    <LiveOptionsPositionsTable positions={rows} onClose={setCloseOptionsPos} />
                  </>
                );
              })()
            )}
          </CollapsibleCard>

          <CollapsibleCard id="autotrade.monitoring" title="Monitoring">
            {dashboard.loading && !dashboard.data ? (
              <Spinner />
            ) : dashboard.error ? (
              <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
            ) : dashboard.data ? (
              <MonitoringDashboard dash={dashboard.data} />
            ) : null}
          </CollapsibleCard>
        </>
      )}

      {view === 'config' && (
        <>
          <CollapsibleCard id="autotrade.realEstateExclusion" title="Real-estate exclusion list">
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
          </CollapsibleCard>
        </>
      )}

      {view === 'dashboard' && (
        <>
          <CollapsibleCard
            id="autotrade.screen"
            title="Research, Screen & Decide"
            action={
              <button className="btn-primary" onClick={runScreen} disabled={screenBusy}>
                {screenBusy ? 'Scanning…' : 'Run screen'}
              </button>
            }
          >
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
                            <th className="th">Dir</th>
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
                                <td className="td">
                                  <Badge color={c.direction === 'long' ? 'green' : 'red'}>{c.direction}</Badge>
                                </td>
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
                                            <span
                                              title={optFailing.map((chk) => `${chk.rule}: ${chk.detail}`).join('\n')}
                                            >
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
                  <ScreenSection
                    title={`No signal — insufficient volatility history (${result.decision.skipped.length})`}
                  >
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
                  Scans the universe (plus Webull&apos;s pre-market movers, if configured) for volume-breakout
                  candidates, screening out real estate first, then computes an ATR-based stop and reward:risk target
                  for each one that clears, then sizes and risk-checks it against the active profile&apos;s caps (daily
                  drawdown, concurrent positions, max aggregate open risk, correlated-ticker exposure, daily trade cap).
                  Read-only — nothing here places an order.
                </p>
              )
            )}
          </CollapsibleCard>

          <CollapsibleCard id="autotrade.backtest" title="Backtest & walk-forward">
            <p className="text-xs text-slate-500 mb-3">
              Replays Screen → Decision → Risk Check day-by-day over historical daily bars, using the exact same logic
              the live loop uses — the validation gate docs/AUTOTRADING_SPEC.md requires before any paper or live
              trading. Leave &quot;Out-of-sample split&quot; blank for a single-window backtest, or set it to split the
              run into in-sample vs out-of-sample windows (a strategy that only performs in-sample should look weak or
              negative out-of-sample). &quot;Run options backtest&quot; replays the same window through the options
              overlay instead — single leg or debit spread, whichever the Options strategy setting above is set to,
              gated by the same equity screen — a separate, independent run, not combined with the equity book above.
              &quot;Run combined backtest&quot; replays the SAME window with both books sharing ONE risk budget instead
              — an approved equity position&apos;s risk counts against an options candidate&apos;s cap that same day,
              and vice versa, exactly like the live loop&apos;s paper execution already enforces. Read-only — nothing
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
                <input
                  type="date"
                  className="input"
                  value={btSplitDate}
                  onChange={(e) => setBtSplitDate(e.target.value)}
                />
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
              <Field
                label="Backtest trade direction"
                hint="Independent of the live Configuration's Trade direction above. In Both, each candidate is scored as long and short and the run trades whichever side qualifies — governs options call/put too."
              >
                <select
                  className="input"
                  value={btDirectionMode}
                  onChange={(e) => setBtDirectionMode(e.target.value as AutotradeTradeDirectionMode)}
                >
                  <option value="long">Long only (default)</option>
                  <option value="short">Short only</option>
                  <option value="both">Both</option>
                </select>
              </Field>
              <Field label="Starting equity ($)">
                <NumberInput value={btEquity} onChange={setBtEquity} placeholder="e.g. 100000" />
              </Field>
              <Field label="Max concurrent positions" hint="Independent of the live Configuration cap above.">
                <NumberInput
                  value={btMaxPositions}
                  onChange={setBtMaxPositions}
                  min={1}
                  step={1}
                  placeholder="e.g. 3"
                />
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
                <BacktestEquityChart
                  equityCurve={combinedBtResult.report.equityCurve}
                  gradientId="combinedBtEquityPlain"
                />
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
          </CollapsibleCard>

          <CollapsibleCard
            id="autotrade.paperTrading"
            title="Paper trading"
            action={
              <button className="btn-primary" onClick={runLoopOnce} disabled={loopBusy}>
                {loopBusy ? 'Running…' : 'Run one cycle now'}
              </button>
            }
          >
            <p className="text-xs text-slate-500 mb-3">
              When enabled above, the server runs this same Screen → Decision → Risk Check → Execution cycle on its own
              every minute — this button just runs one cycle immediately, so you can watch it work without waiting.
              Every fill here is a local simulation from a live quote; it never places a real order (see
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
                    opened ({loopSummary.optionsEntriesOpened} options). Options decision considered{' '}
                    {loopSummary.optionsCandidatesConsidered} candidate(s) (universe-sourced only — movers can't
                    accumulate real IV-rank history) and generated {loopSummary.optionsSignalsGenerated} signal(s).{' '}
                    {loopSummary.moversAutoPromoted > 0 && (
                      <>{loopSummary.moversAutoPromoted} recurring mover(s) promoted to the universe. </>
                    )}
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
              combined risk budget as equity. A spread's Entry/Current/Exit $ show its net value (long leg minus short
              leg). Automated exit is time-based only (close as expiration approaches, no roll) — take-profit/stop-loss/
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
          </CollapsibleCard>

          <CollapsibleCard id="autotrade.recentActivity" title="Recent activity">
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
          </CollapsibleCard>
        </>
      )}

      <p className="text-[11px] text-slate-500">
        Decision-support and tracking, not financial advice. Paper trading is always a local simulation that never
        reaches a real broker. Live trading does place real orders once explicitly enabled — review backtest and
        paper-trading results first. See docs/AUTOTRADING_SPEC.md for the full plan.
      </p>

      <CloseModal
        position={closeEquityPos}
        onClose={() => setCloseEquityPos(null)}
        onSaved={() => livePositions.reload()}
      />
      <CloseLiveOptionsPositionModal
        position={closeOptionsPos}
        onClose={() => setCloseOptionsPos(null)}
        onSaved={() => liveOptionsPositions.reload()}
      />
    </div>
  );
}

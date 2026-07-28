import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import { contractToOrder } from '../lib/tradePrefill';
import { useProvider } from '../components/ProviderContext';
import { useAsync, usePolling } from '../lib/hooks';
import { cx, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { daysUntil } from '../components/EarningsBadge';
import {
  Badge,
  Card,
  CollapsibleCard,
  EmptyState,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  ScoreBar,
  Spinner,
} from '../components/ui';
// Lazy-loaded: it (and the recharts payload it drags in, ~92kB gzip) is only
// needed on the non-default "strategy" tab, not the chain view most visits
// use — see the .then() adapter below since it's a named, not default, export.
const StrategyBuilder = lazy(() =>
  import('../components/StrategyBuilder').then((m) => ({ default: m.StrategyBuilder })),
);
const RollAnalyzer = lazy(() => import('../components/RollAnalyzer').then((m) => ({ default: m.RollAnalyzer })));
import type {
  AlertPreset,
  EntryCandidate,
  EntryStrategyConfig,
  ExitRulesConfig,
  OptionContract,
  OptionsChain,
} from '../api/types';

type Tab = 'chain' | 'entry' | 'exit' | 'strategy';

export default function OptionsPage() {
  const { status, loading } = useProvider();
  const [symbol, setSymbol] = useState('AAPL');
  const [activeSymbol, setActiveSymbol] = useState('AAPL');
  const [expiration, setExpiration] = useState<string>('');
  const [tab, setTab] = useState<Tab>('chain');

  const expirations = useAsync(() => client.expirations(activeSymbol), [activeSymbol]);
  const settings = useAsync(() => client.settings(), []);
  const inited = useRef(false);

  useEffect(() => {
    if (expirations.data?.expirations.length && !expirations.data.expirations.includes(expiration)) {
      setExpiration(expirations.data.expirations[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expirations.data]);

  // Restore the last-used options symbol (persisted in SQLite).
  useEffect(() => {
    if (inited.current || !settings.data) return;
    inited.current = true;
    const saved = settings.data['options.symbol'] as string | undefined;
    if (saved) {
      setSymbol(saved);
      setActiveSymbol(saved);
    }
  }, [settings.data]);

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
    if (s) {
      setActiveSymbol(s);
      client.saveSetting('options.symbol', s).catch(() => {}); // remember last symbol
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Options" subtitle="Chain, entry scan, exit rules, and multi-leg strategy analytics." />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Symbol">
          <div className="flex gap-2">
            <input
              className="input !w-32"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            <button className="btn-primary" onClick={load}>
              Load
            </button>
          </div>
        </Field>
        <Field label="Expiration">
          <select className="input !w-44" value={expiration} onChange={(e) => setExpiration(e.target.value)}>
            {expirations.loading && <option>loading…</option>}
            {expirations.data?.expirations.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
        {status?.synthetic && <Badge color="amber">synthetic data</Badge>}
      </div>

      {expiration && <OptionsTimingBanner symbol={activeSymbol} expiration={expiration} />}

      <div className="flex gap-1 border-b border-ink-600/60">
        {(['chain', 'entry', 'exit', 'strategy'] as Tab[]).map((t) => (
          <button
            key={t}
            className={cx(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px',
              tab === t ? 'border-accent text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200',
            )}
            onClick={() => setTab(t)}
          >
            {t === 'chain' ? 'Chain' : t === 'entry' ? 'Entry scan' : t === 'exit' ? 'Exit rules' : 'Strategy'}
          </button>
        ))}
      </div>

      {/* Both views fetch with `expiration` in their deps, so mounting them
          before the expirations list has resolved fires a guaranteed-400
          request with expiration='' (and flashes its error state) on every
          visit. Hold them behind a spinner until a real expiration is set. */}
      {tab === 'chain' &&
        (expiration ? (
          <ChainView symbol={activeSymbol} expiration={expiration} />
        ) : (
          <Spinner label="Loading expirations…" />
        ))}
      {tab === 'entry' &&
        (expiration ? (
          <EntryScanView symbol={activeSymbol} expiration={expiration} />
        ) : (
          <Spinner label="Loading expirations…" />
        ))}
      {tab === 'exit' && <ExitRulesView />}
      {tab === 'strategy' && (
        <Suspense fallback={<Spinner label="Loading strategy tools…" />}>
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-semibold text-slate-300 mb-2">Strategy builder</h2>
              <StrategyBuilder />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-300 mb-2">Roll analyzer</h2>
              <RollAnalyzer />
            </div>
          </div>
        </Suspense>
      )}
    </div>
  );
}

export interface OptionsTimingRead {
  kind: 'warn' | 'sell' | 'buy' | 'neutral';
  text: string;
}

/**
 * The decision rule behind the timing banner, as a pure function so it can be
 * tested directly — it is a recommendation shown to a person about to sell or
 * buy premium, which makes it worth pinning rather than reaching through the
 * page to exercise.
 *
 * Order matters. `earningsUnknown` is checked BEFORE the IV-rank branches
 * because it is not the same as "no earnings before expiry": when the events
 * lookup fails we do not know, and the rich-IV branch states the absence as
 * fact ("and no earnings fall before expiry") on its way to recommending
 * selling premium. That is precisely the trade an unflagged earnings event ruins
 * via IV crush — the risk the warn branch exists to surface. So an unanswered
 * earnings question has to warn, not fall through to advice.
 */
export function optionsTimingRead(a: {
  symbol: string;
  expiration: string;
  ivRank: number | null;
  earningsDate?: string;
  earningsDte: number | null;
  earningsUnknown: boolean;
}): OptionsTimingRead {
  const earningsBeforeExpiry = !!(
    a.earningsDate &&
    a.earningsDte != null &&
    a.earningsDte >= 0 &&
    a.earningsDate <= a.expiration
  );
  if (earningsBeforeExpiry) {
    return {
      kind: 'warn',
      text: `Earnings ${a.earningsDate} fall before this expiry — expect an IV drop (crush) right after the report. Long premium is exposed to it; defined-risk or post-event structures tend to be favored.`,
    };
  }
  if (a.earningsUnknown) {
    return {
      kind: 'warn',
      text: `Couldn't check earnings for ${a.symbol}, so whether any fall before this expiry is unknown — check the calendar yourself before selling premium here. IV rank ${
        a.ivRank == null ? 'is still building history' : a.ivRank.toFixed(0)
      }.`,
    };
  }
  if (a.ivRank == null) return { kind: 'neutral', text: 'IV rank is still building history for this name.' };
  if (a.ivRank >= 50) {
    return {
      kind: 'sell',
      text: `IV rank ${a.ivRank.toFixed(0)} — options are richly priced vs this name's own range, and no earnings fall before expiry. Context tends to favor selling premium.`,
    };
  }
  if (a.ivRank <= 25) {
    return {
      kind: 'buy',
      text: `IV rank ${a.ivRank.toFixed(0)} — options are cheap vs this name's own range. Context tends to favor buying premium (long optionality).`,
    };
  }
  return {
    kind: 'neutral',
    text: `IV rank ${a.ivRank.toFixed(0)} — middling vs this name's own range; no strong premium-side edge from IV alone.`,
  };
}

/**
 * IV-rank + earnings timing context for the selected symbol/expiry. Combines the
 * underlying's IV rank (rich vs cheap vs its own range) with whether earnings
 * fall before expiry — the "sell premium when IV is rich / don't buy into
 * earnings" read. Decision-support, not advice.
 */
function OptionsTimingBanner({ symbol, expiration }: { symbol: string; expiration: string }) {
  const iv = useAsync(() => client.optionsIv(symbol, expiration), [symbol, expiration]);
  const events = useAsync(() => client.events([symbol]), [symbol]);
  if (iv.loading) return null;
  if (iv.error || !iv.data) {
    // Returning null here made the whole banner vanish on a failed IV lookup,
    // which reads as "nothing worth saying about this expiry" — the same
    // silence-as-reassurance the earnings branch below had.
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        ⚠ No IV or earnings timing context for this expiry — the lookup failed.
        {iv.error ? ` ${iv.error.message}` : ''}{' '}
        <button className="underline hover:text-amber-100" onClick={iv.reload}>
          Retry
        </button>
      </div>
    );
  }

  const { ivRank, method } = iv.data.ivContext;
  const earningsDate = events.data?.events?.[0]?.earningsDate;
  const { kind, text } = optionsTimingRead({
    symbol,
    expiration,
    ivRank,
    earningsDate,
    earningsDte: daysUntil(earningsDate),
    // Distinct from "no earnings before expiry": a failed lookup means we don't
    // know. See optionsTimingRead's own note.
    earningsUnknown: !events.loading && !events.data,
  });

  const S = {
    warn: { box: 'border-amber-500/40 bg-amber-500/10', label: 'text-amber-400', name: 'Event risk' },
    sell: { box: 'border-bull/40 bg-bull/10', label: 'text-bull', name: 'Rich IV' },
    buy: { box: 'border-accent/40 bg-accent/10', label: 'text-accent', name: 'Cheap IV' },
    neutral: { box: 'border-ink-600 bg-ink-700/30', label: 'text-slate-400', name: 'IV context' },
  }[kind];

  return (
    <div className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', S.box)}>
      <span className={cx('shrink-0 font-semibold uppercase tracking-wide', S.label)}>{S.name}</span>
      <span className="text-slate-300">
        {text}
        {method === 'hv-estimate' && (
          <span className="text-amber-400"> · est. from realized vol until history builds</span>
        )}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Chain
// ----------------------------------------------------------------------------
function ChainView({ symbol, expiration }: { symbol: string; expiration: string }) {
  const [side, setSide] = useState<'call' | 'put'>('call');
  const chain = useAsync<OptionsChain>(() => client.chain(symbol, expiration), [symbol, expiration]);
  // Live option quotes overlay the (delayed) chain — only when Webull is wired up.
  const wb = useAsync(() => client.webullStatus(), []);
  const liveAvailable = !!wb.data?.configured;
  const [live, setLive] = useState<string | null>(null);
  const navigate = useNavigate();

  if (!expiration)
    return (
      <Card>
        <EmptyState title="Pick a symbol and expiration" />
      </Card>
    );
  if (chain.loading) return <Spinner label="Loading chain…" />;
  if (chain.error)
    return (
      <Card>
        <ErrorState error={chain.error} onRetry={chain.reload} />
      </Card>
    );
  if (!chain.data) return null;

  const contracts = side === 'call' ? chain.data.calls : chain.data.puts;
  const u = chain.data.underlyingPrice ?? null;
  const anyComputed = contracts.some((c) => c.greeks?.computed);

  return (
    <Card>
      <div className="flex items-center justify-between p-3 border-b border-ink-600/60">
        <div className="text-sm text-slate-400">
          {symbol} {expiration} · underlying <span className="text-slate-200">{fmtUsd(u)}</span>
          {chain.data.atmIv != null && (
            <>
              {' '}
              · ATM IV <span className="text-slate-200">{(chain.data.atmIv * 100).toFixed(0)}%</span>
            </>
          )}
          {liveAvailable && <span className="text-slate-600"> · click a contract for a live quote</span>}
        </div>
        <div className="flex rounded-md overflow-hidden border border-ink-600 text-sm">
          <button
            className={cx('px-3 py-1', side === 'call' ? 'bg-bull/20 text-bull' : 'text-slate-400')}
            onClick={() => setSide('call')}
          >
            Calls
          </button>
          <button
            className={cx('px-3 py-1', side === 'put' ? 'bg-bear/20 text-bear' : 'text-slate-400')}
            onClick={() => setSide('put')}
          >
            Puts
          </button>
        </div>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <table className="w-full">
          <thead className="sticky-thead">
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
              <th className="th text-right">Trade</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => {
              const itm = side === 'call' ? u !== null && c.strike < u : u !== null && c.strike > u;
              const open = live === c.symbol;
              return (
                <Fragment key={c.symbol}>
                  <tr
                    className={cx(
                      'border-b border-ink-700/50',
                      itm && 'bg-ink-700/30',
                      open && 'bg-accent/10',
                      liveAvailable && 'cursor-pointer hover:bg-ink-700/40',
                    )}
                    onClick={liveAvailable ? () => setLive(open ? null : c.symbol) : undefined}
                  >
                    <td className="td text-right font-semibold">{fmtNum(c.strike)}</td>
                    <td className="td text-right">{fmtNum(c.bid)}</td>
                    <td className="td text-right">{fmtNum(c.ask)}</td>
                    <td className="td text-right">{fmtNum(c.mark)}</td>
                    <td className="td text-right text-slate-400">{c.volume ?? '—'}</td>
                    <td className="td text-right text-slate-400">{c.openInterest ?? '—'}</td>
                    <td className="td text-right">
                      {c.greeks?.iv === undefined ? '—' : `${(c.greeks.iv * 100).toFixed(0)}%`}
                    </td>
                    <td className="td text-right">{fmtNum(c.greeks?.delta, 3)}</td>
                    <td className="td text-right text-slate-400">{fmtNum(c.greeks?.theta, 3)}</td>
                    <td className="td text-right text-slate-400">{fmtNum(c.greeks?.gamma, 4)}</td>
                    <td className="td text-right text-slate-400">{fmtNum(c.greeks?.vega, 3)}</td>
                    <td className="td text-right">
                      <button
                        className="text-xs text-accent hover:underline"
                        title="Prefill the Trade builder with this contract"
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigate('/trade', { state: { prefill: contractToOrder(c) } });
                        }}
                      >
                        Trade
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-ink-900/40">
                      <td colSpan={12} className="px-3 py-2">
                        <LiveOptionQuote contract={c} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {anyComputed && (
        <div className="p-2 text-[11px] text-slate-500">
          Greeks marked here are computed locally via Black–Scholes (provider didn't supply them).
        </div>
      )}
    </Card>
  );
}

/**
 * Live option quote (real bid/ask/size/volume/OI/greeks from OPRA via Webull),
 * overlaid on the focused chain contract. Auto-refreshes while open; the chain's
 * own (delayed, Yahoo-sourced) value is shown beneath each live stat so the
 * delayed-vs-live gap is obvious at a glance.
 */
function LiveOptionQuote({ contract }: { contract: OptionContract }) {
  const q = useAsync(() => client.webullOptionQuotes([contract.symbol]), [contract.symbol]);
  usePolling(() => q.reload(), 5000); // markets move — keep it fresh while open

  const quote = q.data?.quotes?.[0];
  const failed = q.data && !q.data.ok;

  const ivPct = (v?: number | null) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(0)}%`);
  const size = (n?: number) => (n === undefined ? undefined : `×${n}`);
  const spread = quote && quote.bid !== undefined && quote.ask !== undefined ? quote.ask - quote.bid : undefined;
  const spreadPct = spread !== undefined && quote?.mark ? (spread / quote.mark) * 100 : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="green">live · OPRA</Badge>
        <span className="font-mono text-xs text-slate-400">{contract.symbol}</span>
        {quote?.changePct !== undefined && (
          <span className={cx('text-xs font-semibold', quote.changePct >= 0 ? 'text-bull' : 'text-bear')}>
            {fmtPct(quote.changePct)}
          </span>
        )}
        {!!quote?.quoteTime && (
          <span className="text-[11px] text-slate-500">as of {new Date(quote.quoteTime).toLocaleTimeString()}</span>
        )}
        <button
          className="ml-auto text-xs text-accent disabled:text-slate-600"
          onClick={() => q.reload()}
          disabled={q.loading}
        >
          {q.loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {q.loading && !quote && !failed ? (
        <Spinner label="Loading live quote…" />
      ) : failed ? (
        <div className="text-xs text-amber-400">Live quote unavailable — {q.data?.error ?? 'no data returned'}.</div>
      ) : !quote ? (
        <div className="text-xs text-slate-500">No live quote for this contract right now.</div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Bid" value={fmtNum(quote.bid)} sub={size(quote.bidSize)} chain={fmtNum(contract.bid)} />
          <Stat label="Ask" value={fmtNum(quote.ask)} sub={size(quote.askSize)} chain={fmtNum(contract.ask)} />
          <Stat label="Mark" value={fmtNum(quote.mark)} chain={fmtNum(contract.mark)} />
          <Stat label="Last" value={fmtNum(quote.last)} chain={fmtNum(contract.last)} />
          <Stat
            label="Spread"
            value={fmtNum(spread)}
            sub={spreadPct !== undefined ? `${spreadPct.toFixed(1)}%` : undefined}
          />
          <Stat label="Vol" value={fmtNum(quote.volume, 0)} chain={fmtNum(contract.volume, 0)} />
          <Stat label="OI" value={fmtNum(quote.openInterest, 0)} chain={fmtNum(contract.openInterest, 0)} />
          <Stat label="IV" value={ivPct(quote.iv)} chain={ivPct(contract.greeks?.iv)} />
          <Stat label="Δ" value={fmtNum(quote.delta, 3)} chain={fmtNum(contract.greeks?.delta, 3)} />
          <Stat label="Θ" value={fmtNum(quote.theta, 3)} chain={fmtNum(contract.greeks?.theta, 3)} />
          <Stat label="Γ" value={fmtNum(quote.gamma, 4)} chain={fmtNum(contract.greeks?.gamma, 4)} />
          <Stat label="ν" value={fmtNum(quote.vega, 3)} chain={fmtNum(contract.greeks?.vega, 3)} />
        </div>
      )}
    </div>
  );
}

// One live stat with the chain's (delayed) value beneath it. The chain line is
// suppressed when the chain has no comparable value ('—').
function Stat({ label, value, sub, chain }: { label: string; value: string; sub?: string; chain?: string }) {
  return (
    <div className="rounded-md bg-ink-800/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-100">
        {value}
        {sub && <span className="ml-1 text-[10px] font-normal text-slate-500">{sub}</span>}
      </div>
      {chain && chain !== '—' && <div className="text-[10px] text-slate-500">chain {chain}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Entry scan
// ----------------------------------------------------------------------------
function EntryScanView({ symbol, expiration }: { symbol: string; expiration: string }) {
  const navigate = useNavigate();
  const def = useAsync(() => client.entryDefault(), []);
  const presets = useAsync(() => client.presets('option_entry'), []);
  const [cfg, setCfg] = useState<EntryStrategyConfig | null>(null);
  const config = cfg ?? def.data ?? null;
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.entryScan>>>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error>();
  const [expanded, setExpanded] = useState<string | null>(null);

  // Turn a ranked contract into a one-click entry alert: default to an
  // underlying-price breakout in the trade's direction, with a strategy note
  // summarizing the scan. The server attaches the suggested exit.
  const alertContract = (cand: EntryCandidate) => {
    const c = cand.contract;
    const m = cand.metrics;
    const note = [
      `Long ${c.type} ${fmtNum(c.strike)} (${m.dte.toFixed(0)}d)`,
      m.delta !== null ? `|Δ| ${Math.abs(m.delta).toFixed(2)}` : null,
      m.iv !== null ? `IV ${(m.iv * 100).toFixed(0)}%` : null,
      m.spreadPct !== null ? `spread ${m.spreadPct.toFixed(1)}%` : null,
      `entry-scan ${cand.score.toFixed(0)}/100`,
    ]
      .filter(Boolean)
      .join(' · ');
    const preset: AlertPreset = {
      symbol,
      optionType: c.type,
      strike: c.strike,
      expiration: c.expiration,
      role: 'entry',
      kind: 'price',
      operator: c.type === 'call' ? 'above' : 'below',
      threshold: result?.underlyingPrice ?? undefined,
      entryPlan: note,
    };
    void navigate('/alerts', { state: { presetAlert: preset } });
  };

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
      <CollapsibleCard id="options.entryStrategy" title="Entry strategy">
        <div className="space-y-3">
          <Field label="Side">
            <select
              className="input"
              value={config.side}
              onChange={(e) => set('side', e.target.value as 'call' | 'put')}
            >
              <option value="call">Long call</option>
              <option value="put">Long put</option>
            </select>
          </Field>
          <div className="grid sm:grid-cols-2 gap-2">
            <Field label="Delta min">
              <NumberInput value={config.deltaMin} onChange={(v) => set('deltaMin', v ?? 0)} step={0.05} />
            </Field>
            <Field label="Delta max">
              <NumberInput value={config.deltaMax} onChange={(v) => set('deltaMax', v ?? 1)} step={0.05} />
            </Field>
            <Field label="Max spread %">
              <NumberInput value={config.maxSpreadPct} onChange={(v) => set('maxSpreadPct', v ?? 10)} />
            </Field>
            <Field label="Min OI">
              <NumberInput value={config.minOpenInterest} onChange={(v) => set('minOpenInterest', v ?? 0)} />
            </Field>
            <Field label="Min volume">
              <NumberInput value={config.minVolume} onChange={(v) => set('minVolume', v ?? 0)} />
            </Field>
            <Field label="Min DTE">
              <NumberInput value={config.minDaysToExpiration} onChange={(v) => set('minDaysToExpiration', v)} />
            </Field>
            <Field label="Max DTE">
              <NumberInput value={config.maxDaysToExpiration} onChange={(v) => set('maxDaysToExpiration', v)} />
            </Field>
            <Field label="IV min %">
              <NumberInput
                value={config.ivMin === undefined ? undefined : config.ivMin * 100}
                onChange={(v) => set('ivMin', v === undefined ? undefined : v / 100)}
              />
            </Field>
            <Field label="IV max %">
              <NumberInput
                value={config.ivMax === undefined ? undefined : config.ivMax * 100}
                onChange={(v) => set('ivMax', v === undefined ? undefined : v / 100)}
              />
            </Field>
            <Field label="IV rank min">
              <NumberInput value={config.ivRankMin} onChange={(v) => set('ivRankMin', v)} min={0} max={100} />
            </Field>
            <Field label="IV rank max">
              <NumberInput value={config.ivRankMax} onChange={(v) => set('ivRankMax', v)} min={0} max={100} />
            </Field>
          </div>
          <button className="btn-primary w-full" onClick={run} disabled={running || !expiration}>
            {running ? 'Scanning…' : 'Scan contracts'}
          </button>
          <PresetBar
            kind="option_entry"
            presets={presets.data?.presets ?? []}
            onLoad={(c) => setCfg(c as EntryStrategyConfig)}
            getConfig={() => config}
            onChanged={presets.reload}
          />
        </div>
      </CollapsibleCard>

      <div className="flex-1 min-w-0">
        {error && (
          <Card>
            <ErrorState error={error} onRetry={run} />
          </Card>
        )}
        {!result && !error && (
          <Card>
            <EmptyState
              title="Configure a strategy and scan"
              hint="Candidates are ranked by spread tightness, liquidity, and how well delta fits your band — with the full rule breakdown."
            />
          </Card>
        )}
        {result && (
          <Card className="overflow-x-auto">
            <div className="p-3 border-b border-ink-600/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
              <span>
                {result.candidates.filter((c) => c.passed).length} pass / {result.candidates.length} evaluated
              </span>
              <span>underlying {fmtUsd(result.underlyingPrice)}</span>
              {result.ivContext.atmIv !== null && (
                <span>
                  ATM IV <b className="text-slate-200">{(result.ivContext.atmIv * 100).toFixed(0)}%</b>
                </span>
              )}
              {result.ivContext.ivRank !== null ? (
                <span title={`${result.ivContext.method} · ${result.ivContext.samples} samples`}>
                  IV rank <b className="text-slate-200">{result.ivContext.ivRank.toFixed(0)}</b> · pctile{' '}
                  {result.ivContext.ivPercentile?.toFixed(0)}
                  {result.ivContext.method === 'hv-estimate' && <span className="text-amber-400"> (est.)</span>}
                </span>
              ) : (
                <span className="text-slate-600">IV rank: building history ({result.ivContext.samples})</span>
              )}
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
                        <td className="td font-medium">
                          {fmtNum(c.strike)} {c.type === 'call' ? 'C' : 'P'}
                        </td>
                        <td className="td text-right">{fmtNum(cand.metrics.mark)}</td>
                        <td className="td text-right">{fmtNum(cand.metrics.delta, 3)}</td>
                        <td className="td text-right">
                          {cand.metrics.iv === null ? '—' : `${(cand.metrics.iv * 100).toFixed(0)}%`}
                        </td>
                        <td className="td text-right">
                          {cand.metrics.spreadPct === null ? '—' : `${fmtNum(cand.metrics.spreadPct, 1)}%`}
                        </td>
                        <td className="td text-right text-slate-400">
                          {cand.metrics.openInterest ?? '—'}/{cand.metrics.volume ?? '—'}
                        </td>
                        <td className="td text-right">{cand.metrics.dte.toFixed(0)}</td>
                        <td className="td">
                          <ScoreBar value={cand.score} />
                        </td>
                        <td className="td whitespace-nowrap">
                          <button className="text-xs" onClick={() => setExpanded(open ? null : id)}>
                            {cand.passed ? <Badge color="green">pass</Badge> : <Badge color="red">fail</Badge>}{' '}
                            {open ? '▾' : '▸'}
                          </button>
                          <button
                            className="text-xs text-accent ml-2"
                            title="Create an entry alert for this contract"
                            onClick={() => alertContract(cand)}
                          >
                            ＋ Alert
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-ink-900/40">
                          <td colSpan={9} className="px-3 py-2">
                            <div className="flex flex-wrap gap-2">
                              {cand.rules.map((r) => (
                                <span
                                  key={r.rule}
                                  className={cx('chip', r.passed ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear')}
                                  title={r.detail}
                                >
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
      <CollapsibleCard id="options.exitRules" title="Exit rules">
        <div className="space-y-3">
          <Field label="Take-profit %">
            <NumberInput value={config.takeProfitPct} onChange={(v) => set('takeProfitPct', v)} />
          </Field>
          <Field label="Stop-loss %">
            <NumberInput value={config.stopLossPct} onChange={(v) => set('stopLossPct', v)} />
          </Field>
          <Field label="Exit N days before expiry">
            <NumberInput value={config.timeExitDaysBeforeExpiry} onChange={(v) => set('timeExitDaysBeforeExpiry', v)} />
          </Field>
          <div className="grid sm:grid-cols-2 gap-2">
            <Field label="|Δ| min">
              <NumberInput value={config.deltaMin} onChange={(v) => set('deltaMin', v)} step={0.05} />
            </Field>
            <Field label="|Δ| max">
              <NumberInput value={config.deltaMax} onChange={(v) => set('deltaMax', v)} step={0.05} />
            </Field>
          </div>
          <button className="btn-primary w-full" onClick={run} disabled={running}>
            {running ? 'Checking…' : 'Check open positions'}
          </button>
          <PresetBar
            kind="option_exit"
            presets={presets.data?.presets ?? []}
            onLoad={(c) => setCfg(c as ExitRulesConfig)}
            getConfig={() => config}
            onChanged={presets.reload}
          />
        </div>
      </CollapsibleCard>

      <div className="flex-1 min-w-0">
        {error && (
          <Card>
            <ErrorState error={error} onRetry={run} />
          </Card>
        )}
        {!result && !error && (
          <Card>
            <EmptyState
              title="Evaluate exit rules against open option positions"
              hint="Add option positions in the Positions tab, then check which exit rule (if any) is currently triggered."
            />
          </Card>
        )}
        {result && result.evaluations.length === 0 && (
          <Card>
            <EmptyState
              title="No open option positions"
              hint="Log an option position in the Positions tab to use the exit engine."
            />
          </Card>
        )}
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
                  <tr
                    key={ev.position.id}
                    className={cx('border-b border-ink-700/50', ev.evaluation.triggered && 'bg-amber-500/5')}
                  >
                    <td className="td">
                      {ev.position.symbol} {fmtNum(ev.position.strike)} {ev.position.optionType === 'call' ? 'C' : 'P'}{' '}
                      {ev.position.expiration}
                    </td>
                    <td className="td text-right">{fmtNum(ev.position.entryPrice)}</td>
                    <td className="td text-right">{fmtNum(ev.currentMark)}</td>
                    <td
                      className={cx(
                        'td text-right',
                        (ev.evaluation.unrealizedPct ?? 0) >= 0 ? 'text-bull' : 'text-bear',
                      )}
                    >
                      {fmtPct(ev.evaluation.unrealizedPct)}
                    </td>
                    <td className="td text-right">{ev.evaluation.dte.toFixed(1)}</td>
                    <td className="td text-right">{fmtNum(ev.currentDelta, 3)}</td>
                    <td className="td">
                      {ev.evaluation.triggered ? (
                        <span
                          title={ev.evaluation.triggers
                            .filter((t) => t.triggered)
                            .map((t) => t.detail)
                            .join(' · ')}
                        >
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
              <button className="hover:text-accent" onClick={() => onLoad(p.config)}>
                {p.name}
              </button>
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

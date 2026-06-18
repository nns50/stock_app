import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, TrendingUp } from 'lucide-react';
import { client } from '../api/client';
import { ago, fmtNum, fmtPct } from '../lib/format';
import { Card, ScoreBar, Segmented, Spinner } from './ui';
import { OPEN_LOG_TRADE_EVENT } from './GlobalLogTrade';
import type { ScreenerResult, SymbolScore } from '../api/types';

// "Today's setups" — a one-click morning shortlist. Runs the screener against
// the user's universe and ranks the passing names; the Long/Short toggle and the
// Sort control (Score / Gap / Rel-vol) surface the four things people watch at
// the open. It's a transparent rule-based ranking, NOT a buy signal.

type Dir = 'long' | 'short';
type SortMode = 'score' | 'gap' | 'volume';
const ROWS = 6;
// Auto-scan once when you first land on Today in a session (sessionStorage, so it
// survives navigating away/back but resets in a new tab — and doesn't re-scan on
// every visit, to respect provider rate limits).
const AUTO_SCAN_KEY = 'todaysSetups.autoScanned';

function rank(rows: SymbolScore[], mode: SortMode): SymbolScore[] {
  const copy = [...rows];
  if (mode === 'gap') copy.sort((a, b) => Math.abs(b.indicators.gapPct ?? 0) - Math.abs(a.indicators.gapPct ?? 0));
  else if (mode === 'volume') copy.sort((a, b) => (b.indicators.relVolume ?? 0) - (a.indicators.relVolume ?? 0));
  else copy.sort((a, b) => b.total - a.total);
  return copy.slice(0, ROWS);
}

export function TodaysSetups() {
  const [dir, setDir] = useState<Dir>('long');
  const [sort, setSort] = useState<SortMode>('score');
  const [result, setResult] = useState<ScreenerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const scan = async (d: Dir) => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await client.runScreener({ config: { direction: d }, maxSymbols: 60 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const onDir = (d: Dir) => {
    setDir(d);
    setResult(null);
    void scan(d);
  };

  useEffect(() => {
    if (sessionStorage.getItem(AUTO_SCAN_KEY)) return;
    sessionStorage.setItem(AUTO_SCAN_KEY, '1');
    void scan('long');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const top = result ? rank(result.results, sort) : [];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-medium text-sm flex items-center gap-2 text-slate-200">
          <TrendingUp className="h-4 w-4 text-accent" /> Today&apos;s setups
        </h3>
        <div className="flex items-center gap-2">
          <Segmented
            options={[
              { value: 'long', label: 'Long' },
              { value: 'short', label: 'Short' },
            ]}
            value={dir}
            onChange={onDir}
          />
          {result && (
            <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => scan(dir)} disabled={loading}>
              {loading ? 'Scanning…' : '↻ Rescan'}
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="text-bear text-sm py-2">{error}</div>
      ) : loading && !result ? (
        <Spinner label="Ranking your universe…" />
      ) : !result ? (
        <div className="text-sm text-slate-500 py-6 text-center">
          Scan your universe for the best-ranked {dir} setups right now.
          <div className="mt-3">
            <button className="btn-primary" onClick={() => scan(dir)}>
              Scan today&apos;s setups
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <span className="text-slate-500">Sort:</span>
            <Segmented
              options={[
                { value: 'score', label: 'Score' },
                { value: 'gap', label: 'Gap' },
                { value: 'volume', label: 'Rel-vol' },
              ]}
              value={sort}
              onChange={setSort}
            />
            <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
              {result.scannedCount} scanned · {ago(result.generatedAt)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-left border-b border-ink-600/60">
                  <th className="py-1">Symbol</th>
                  <th className="py-1 text-right">Score</th>
                  <th className="py-1 text-right">Gap</th>
                  <th className="py-1 text-right">Rel-vol</th>
                  <th className="py-1 text-right">RSI</th>
                  <th className="py-1 text-right">~Stop</th>
                </tr>
              </thead>
              <tbody>
                {top.map((s) => (
                  <tr key={s.symbol} className="border-b border-ink-700/40 last:border-0">
                    <td className="py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Link to={`/symbol/${s.symbol}`} className="font-semibold hover:text-accent">
                          {s.symbol}
                        </Link>
                        <button
                          className="text-slate-500 hover:text-accent"
                          title={`Log a trade in ${s.symbol}`}
                          aria-label={`Log a trade in ${s.symbol}`}
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent(OPEN_LOG_TRADE_EVENT, { detail: { symbol: s.symbol } }),
                            )
                          }
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="py-1.5 text-right">
                      <div className="inline-flex justify-end">
                        <ScoreBar value={s.total} width={48} />
                      </div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {s.indicators.gapPct == null ? '—' : fmtPct(s.indicators.gapPct)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">
                      {s.indicators.relVolume == null ? '—' : `${fmtNum(s.indicators.relVolume)}×`}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">
                      {s.indicators.rsi == null ? '—' : fmtNum(s.indicators.rsi, 0)}
                    </td>
                    <td
                      className="py-1.5 text-right tabular-nums text-slate-400"
                      title="Suggested stop distance ≈ one ATR, as % of price"
                    >
                      {s.indicators.atrPct == null ? '—' : `${fmtNum(s.indicators.atrPct, 1)}%`}
                    </td>
                  </tr>
                ))}
                {top.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-center text-slate-500">
                      No symbols passed the filters — loosen them on the screener.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            A transparent rule-based ranking from your screener — <strong>not a buy signal</strong>. Click a symbol to
            check the chart and size it.{' '}
            <Link to="/screener" className="text-accent">
              Full screener →
            </Link>
          </p>
        </>
      )}
    </Card>
  );
}

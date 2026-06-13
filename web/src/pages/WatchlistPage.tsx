import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { fmtCompact, fmtPct, fmtUsd } from '../lib/format';
import { Card, EmptyState, PnL, Spinner } from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import type { Quote } from '../api/types';

export default function WatchlistPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string>();

  const loadQuotes = useCallback(async (syms: string[]) => {
    if (!syms.length) {
      setQuotes([]);
      setAsOf(Date.now());
      return;
    }
    try {
      const r = await client.quotes(syms);
      setQuotes(r.quotes);
      setAsOf(r.asOf);
    } catch {
      /* keep last-known quotes */
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await client.watchlist();
      setSymbols(r.symbols);
      await loadQuotes(r.symbols);
    } finally {
      setLoading(false);
    }
  }, [loadQuotes]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async () => {
    const s = input.trim().toUpperCase();
    if (!s) return;
    setErr(undefined);
    try {
      const r = await client.addWatch(s);
      setSymbols(r.symbols);
      setInput('');
      await loadQuotes(r.symbols);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (sym: string) => {
    try {
      const r = await client.removeWatch(sym);
      setSymbols(r.symbols);
      setQuotes((q) => q.filter((x) => x.symbol !== sym));
    } catch {
      /* ignore */
    }
  };

  const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <RefreshBar onRefresh={() => loadQuotes(symbols)} lastUpdated={asOf} loading={loading} />
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-2">
          <input
            className="input max-w-[180px]"
            placeholder="Add symbol (e.g. AAPL)"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn-primary" onClick={add} disabled={!input.trim()}>
            Add
          </button>
          {err && <span className="text-bear text-sm">{err}</span>}
        </div>
      </Card>

      {loading && symbols.length === 0 ? (
        <Spinner label="Loading watchlist…" />
      ) : symbols.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing on your watchlist yet"
            hint="Add symbols above, or use the ☆ on a symbol's detail page. Your list is saved on the server."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Symbol</th>
                <th className="th text-right">Last</th>
                <th className="th text-right">Change</th>
                <th className="th text-right">Bid</th>
                <th className="th text-right">Ask</th>
                <th className="th text-right">Volume</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((sym) => {
                const q = bySymbol.get(sym);
                return (
                  <tr key={sym} className="border-b border-ink-700/50 hover:bg-ink-700/30">
                    <td className="td">
                      <Link to={`/symbol/${sym}`} className="font-semibold hover:text-accent">
                        {sym}
                      </Link>
                    </td>
                    <td className="td text-right tabular-nums">{q ? fmtUsd(q.last) : '—'}</td>
                    <td className="td text-right">
                      {q && q.changePct !== undefined ? <PnL value={q.changePct} format={fmtPct} /> : '—'}
                    </td>
                    <td className="td text-right tabular-nums text-slate-400">
                      {q?.bid != null ? fmtUsd(q.bid) : '—'}
                    </td>
                    <td className="td text-right tabular-nums text-slate-400">
                      {q?.ask != null ? fmtUsd(q.ask) : '—'}
                    </td>
                    <td className="td text-right tabular-nums text-slate-400">
                      {q?.volume != null ? fmtCompact(q.volume) : '—'}
                    </td>
                    <td className="td text-right">
                      <button
                        className="text-slate-500 hover:text-bear text-xs"
                        onClick={() => remove(sym)}
                        aria-label={`Remove ${sym}`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

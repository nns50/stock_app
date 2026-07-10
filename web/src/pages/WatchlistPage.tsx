import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useSort } from '../lib/hooks';
import { fmtCompact, fmtPct, fmtUsd } from '../lib/format';
import { Card, CollapsibleCard, EmptyState, PageHeader, PnL, SortTh, Spinner } from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { useToast } from '../components/ToastContext';
import type { Quote } from '../api/types';

type WatchRow = { sym: string; q?: Quote };

/** Comparable value for a sortable Watchlist column (module-level → stable). */
function watchSortVal(row: WatchRow, key: string): number | string | null {
  switch (key) {
    case 'symbol':
      return row.sym;
    case 'last':
      return row.q?.last ?? null;
    case 'change':
      return row.q?.changePct ?? null;
    case 'bid':
      return row.q?.bid ?? null;
    case 'ask':
      return row.q?.ask ?? null;
    case 'volume':
      return row.q?.volume ?? null;
    default:
      return null;
  }
}

export default function WatchlistPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string>();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

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
      toast(`Removed ${sym}`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: async () => {
            const back = await client.addWatch(sym);
            setSymbols(back.symbols);
            await loadQuotes(back.symbols);
          },
        },
      });
    } catch {
      /* ignore */
    }
  };

  const watchRows = useMemo<WatchRow[]>(() => {
    const m = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));
    return symbols.map((sym) => ({ sym, q: m.get(sym) }));
  }, [symbols, quotes]);
  const { sorted: sortedWatch, sortKey, sortDir, onSort } = useSort(watchRows, watchSortVal);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Watchlist"
        subtitle="Symbols you're tracking, with live quotes."
        actions={<RefreshBar onRefresh={() => loadQuotes(symbols)} lastUpdated={asOf} loading={loading} />}
      />

      <Card className="p-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
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

      <CollapsibleCard id="watchlist.table" title="Watchlist">
        {loading && symbols.length === 0 ? (
          <Spinner label="Loading watchlist…" />
        ) : symbols.length === 0 ? (
          <EmptyState
            title="Nothing on your watchlist yet"
            hint="Add symbols above, or use the ☆ on a symbol's detail page. Your list is saved on the server."
            action={
              <button className="btn-primary" onClick={() => inputRef.current?.focus()}>
                Add your first symbol
              </button>
            }
          />
        ) : (
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full table-zebra">
              <thead className="sticky-thead">
                <tr>
                  <SortTh label="Symbol" k="symbol" active={sortKey} dir={sortDir} onSort={onSort} />
                  <SortTh label="Last" k="last" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Change" k="change" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Bid" k="bid" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Ask" k="ask" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <SortTh label="Volume" k="volume" active={sortKey} dir={sortDir} onSort={onSort} align="right" />
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {sortedWatch.map(({ sym, q }) => {
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
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx, fmtCompact, fmtPct } from '../lib/format';
import { Card, Spinner } from './ui';

type List = 'gainers' | 'losers' | 'active';
const TABS: { key: List; label: string }[] = [
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'active', label: 'Active' },
];

const SHOW = 12; // rows shown after filtering

/**
 * Dashboard panel of Webull's top market movers (gainers / losers / most-active)
 * — whole-market, distinct from the Screener's universe ranking. Renders nothing
 * when Webull isn't configured, since it's the only feature that needs it.
 *
 * Top %-gainers skew toward micro-cap/penny pumps, so optional min-price and
 * min-market-cap filters narrow to liquid names (nothing is excluded by
 * default). Filtering is client-side over a deeper fetch.
 */
export function MarketMovers() {
  const [list, setList] = useState<List>('gainers');
  // Persisted, shared across tabs. 0 = off.
  const [minPrice, setMinPrice] = useLocalStorage<number>('movers.minPrice', 0);
  const [minCapM, setMinCapM] = useLocalStorage<number>('movers.minCapM', 0); // millions
  const movers = useAsync(() => client.webullMovers(list, 50), [list]);
  const result = movers.data;

  if (result && !result.ok && /not configured/i.test(result.error ?? '')) return null;

  const minCap = minCapM > 0 ? minCapM * 1e6 : 0;
  const filtered = (result?.movers ?? [])
    .filter((m) => (minPrice <= 0 || m.price >= minPrice) && (minCap <= 0 || (m.marketCap ?? 0) >= minCap))
    .slice(0, SHOW);
  const filtersOn = minPrice > 0 || minCapM > 0;

  const numCls = 'input h-6 w-16 px-1.5 text-xs';

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-ink-700/50">
        <h3 className="font-medium text-sm flex items-center gap-2 text-slate-200">
          <TrendingUp className="h-4 w-4 text-slate-500" /> Market movers
          <span className="text-[10px] uppercase tracking-wide text-slate-500 font-normal">Webull</span>
        </h3>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setList(t.key)}
              className={cx(
                'text-xs px-2 py-0.5 rounded transition-colors',
                list === t.key ? 'bg-ink-600 text-slate-200' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2 text-xs text-slate-500">
        <span>Filter</span>
        <label className="flex items-center gap-1">
          min&nbsp;$
          <input
            type="number"
            min={0}
            step="0.5"
            className={numCls}
            value={minPrice || ''}
            placeholder="0"
            onChange={(e) => setMinPrice(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="flex items-center gap-1">
          min&nbsp;cap&nbsp;$M
          <input
            type="number"
            min={0}
            step="50"
            className={numCls}
            value={minCapM || ''}
            placeholder="0"
            onChange={(e) => setMinCapM(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        {filtersOn && (
          <button
            className="text-slate-500 hover:text-slate-300 underline"
            onClick={() => {
              setMinPrice(0);
              setMinCapM(0);
            }}
          >
            clear
          </button>
        )}
      </div>

      {movers.loading ? (
        <Spinner />
      ) : !result?.ok ? (
        <div className="text-xs text-bear">{result?.error ?? 'Could not load movers.'}</div>
      ) : filtered.length === 0 ? (
        <div className="text-xs text-slate-500">
          {filtersOn ? 'No movers match your filter.' : 'No movers right now.'}
        </div>
      ) : (
        <ul className="divide-y divide-ink-800">
          {filtered.map((m) => (
            <li key={m.symbol} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <Link to={`/symbol/${m.symbol}`} className="min-w-0 hover:underline">
                <span className="font-medium text-slate-200">{m.symbol}</span>
                {m.name && <span className="ml-2 text-xs text-slate-500">{m.name}</span>}
              </Link>
              <div className="flex items-center gap-3 shrink-0 tabular-nums">
                {m.marketCap != null && m.marketCap > 0 && (
                  <span className="text-[11px] text-slate-500 w-12 text-right">{fmtCompact(m.marketCap)}</span>
                )}
                <span className="text-slate-300">${m.price}</span>
                {m.changePct != null && (
                  <span className={cx('w-20 text-right', m.changePct >= 0 ? 'text-bull' : 'text-bear')}>
                    {fmtPct(m.changePct)}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

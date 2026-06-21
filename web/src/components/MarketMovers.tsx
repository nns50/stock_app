import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtPct } from '../lib/format';
import { Card, Spinner } from './ui';

type List = 'gainers' | 'losers' | 'active';
const TABS: { key: List; label: string }[] = [
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'active', label: 'Active' },
];

/**
 * Dashboard panel of Webull's top market movers (gainers / losers / most-active)
 * — whole-market, distinct from the Screener's universe ranking. Renders nothing
 * when Webull isn't configured, since it's the only feature that needs it.
 */
export function MarketMovers() {
  const [list, setList] = useState<List>('gainers');
  const movers = useAsync(() => client.webullMovers(list, 8), [list]);
  const result = movers.data;

  if (result && !result.ok && /not configured/i.test(result.error ?? '')) return null;

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

      {movers.loading ? (
        <Spinner />
      ) : !result?.ok ? (
        <div className="text-xs text-bear">{result?.error ?? 'Could not load movers.'}</div>
      ) : result.movers.length === 0 ? (
        <div className="text-xs text-slate-500">No movers right now.</div>
      ) : (
        <ul className="divide-y divide-ink-800">
          {result.movers.map((m) => (
            <li key={m.symbol} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <Link to={`/symbol/${m.symbol}`} className="min-w-0 hover:underline">
                <span className="font-medium text-slate-200">{m.symbol}</span>
                {m.name && <span className="ml-2 text-xs text-slate-500">{m.name}</span>}
              </Link>
              <div className="flex items-center gap-3 shrink-0 tabular-nums">
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

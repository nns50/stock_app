import { useMemo, useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { Modal, Spinner } from './ui';

export function UniverseModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const universe = useAsync(() => client.universe(), []);
  const source = useAsync(() => client.universeSource(), []);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => new Set((universe.data?.symbols ?? []).map((s) => s.symbol)), [universe.data]);
  const sourceFiltered = useMemo(() => {
    const list = source.data?.symbols ?? [];
    const f = filter.trim().toUpperCase();
    return list.filter((s) => !f || s.symbol.includes(f) || (s.name ?? '').toUpperCase().includes(f)).slice(0, 60);
  }, [source.data, filter]);

  const refresh = () => {
    universe.reload();
    onChanged();
  };

  const addFromText = async () => {
    const syms = text.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!syms.length) return;
    setBusy(true);
    try {
      await client.addSymbols(syms);
      setText('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const addOne = async (symbol: string, name?: string, sector?: string) => {
    await client.addSymbols([{ symbol, name, sector }]);
    refresh();
  };

  const remove = async (symbol: string) => {
    await client.removeSymbol(symbol);
    refresh();
  };

  return (
    <Modal open={open} onClose={onClose} title="Manage universe" wide>
      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-medium text-sm">Current ({universe.data?.symbols.length ?? 0})</h4>
          </div>
          <div className="flex gap-2 mb-3">
            <input
              className="input"
              placeholder="Add symbols: AAPL, MSFT…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFromText()}
            />
            <button className="btn-primary" onClick={addFromText} disabled={busy}>
              Add
            </button>
          </div>
          {universe.loading ? (
            <Spinner />
          ) : (
            <div className="max-h-72 overflow-y-auto flex flex-wrap gap-1.5 content-start">
              {(universe.data?.symbols ?? []).map((s) => (
                <button
                  key={s.symbol}
                  className="chip bg-ink-600 text-slate-300 hover:bg-bear/20 hover:text-bear"
                  title={`Remove ${s.symbol}`}
                  onClick={() => remove(s.symbol)}
                >
                  {s.symbol} ✕
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="font-medium text-sm mb-2">Add from S&amp;P 500 reference</h4>
          <input className="input mb-3" placeholder="Search symbol or name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {source.loading ? (
            <Spinner />
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-ink-700">
              {sourceFiltered.map((s) => {
                const have = current.has(s.symbol);
                return (
                  <div key={s.symbol} className="flex items-center justify-between py-1.5 text-sm">
                    <span>
                      <span className="font-medium">{s.symbol}</span>{' '}
                      <span className="text-slate-500 text-xs">{s.name}</span>
                    </span>
                    <button
                      className="text-xs px-2 py-0.5 rounded bg-ink-700 hover:bg-ink-600 disabled:opacity-40"
                      disabled={have}
                      onClick={() => addOne(s.symbol, s.name, s.sector)}
                    >
                      {have ? 'added' : '+ add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

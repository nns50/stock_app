import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import { cx } from '../lib/format';

// Fuzzy "jump to" palette: Cmd/Ctrl+K (or the header ⌘K chip) opens it; type to
// filter pages and symbols, arrow keys to move, Enter to go. Frontend-only.

interface Item {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const NAV: { label: string; to: string }[] = [
  { label: 'Screener', to: '/screener' },
  { label: 'Watchlist', to: '/watchlist' },
  { label: 'Options', to: '/options' },
  { label: 'Positions', to: '/positions' },
  { label: 'Journal', to: '/journal' },
  { label: 'Alerts', to: '/alerts' },
  { label: 'Settings', to: '/settings' },
  { label: 'About / How it works', to: '/about' },
];

/** Dispatch this to open the palette from elsewhere (e.g. the header chip). */
export const OPEN_PALETTE_EVENT = 'open-command-palette';

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [symbols, setSymbols] = useState<{ symbol: string; name?: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  // Load the symbol pool (universe + watchlist) the first time it opens.
  useEffect(() => {
    if (!open || symbols.length) return;
    let active = true;
    Promise.all([
      client.universe().catch(() => ({ symbols: [] as { symbol: string; name: string | null }[] })),
      client.watchlist().catch(() => ({ symbols: [] as string[] })),
    ]).then(([u, w]) => {
      if (!active) return;
      const map = new Map<string, { symbol: string; name?: string }>();
      for (const s of u.symbols) map.set(s.symbol, { symbol: s.symbol, name: s.name ?? undefined });
      for (const sym of w.symbols) if (!map.has(sym)) map.set(sym, { symbol: sym });
      setSymbols([...map.values()]);
    });
    return () => {
      active = false;
    };
  }, [open, symbols.length]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const items: Item[] = useMemo(() => {
    const query = q.trim().toLowerCase();
    const navItems: Item[] = NAV.filter((n) => !query || n.label.toLowerCase().includes(query)).map((n) => ({
      id: `nav:${n.to}`,
      label: n.label,
      hint: 'Go to',
      run: () => navigate(n.to),
    }));
    if (!query) return navItems;

    const symItems = symbols
      .map((s) => {
        const sym = s.symbol.toLowerCase();
        const name = (s.name ?? '').toLowerCase();
        let score = -1;
        if (sym === query) score = 100;
        else if (sym.startsWith(query)) score = 80;
        else if (sym.includes(query)) score = 60;
        else if (name.includes(query)) score = 40;
        return { s, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.s.symbol.localeCompare(b.s.symbol))
      .slice(0, 8)
      .map(({ s }) => ({
        id: `sym:${s.symbol}`,
        label: s.symbol,
        hint: s.name,
        run: () => navigate(`/symbol/${s.symbol}`),
      }));
    return [...navItems, ...symItems];
  }, [q, symbols, navigate]);

  useEffect(() => {
    setSel((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;
  const exec = (i: number) => {
    const it = items[i];
    if (it) {
      it.run();
      setOpen(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div className="card w-full max-w-lg overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full bg-transparent px-4 py-3 text-sm outline-none border-b border-ink-600/60"
          placeholder="Jump to a page or symbol…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              exec(sel);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500">No matches.</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.id}
                className={cx(
                  'w-full flex items-center justify-between gap-3 px-4 py-2 text-left text-sm',
                  i === sel ? 'bg-ink-600 text-slate-100' : 'text-slate-300 hover:bg-ink-700',
                )}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(i)}
              >
                <span className="font-medium">{it.label}</span>
                {it.hint && <span className="text-xs text-slate-500 truncate">{it.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

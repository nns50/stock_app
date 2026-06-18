import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './ui';

// Global keyboard shortcuts: GitHub-style "g then key" quick-nav, plus "?" for
// this cheat sheet. Typing in a field is never hijacked, and ⌘/Ctrl/Alt combos
// are left to the browser (and the ⌘K palette). Mounted once in the Layout.

const NAV: { key: string; to: string; label: string }[] = [
  { key: 't', to: '/today', label: 'Today' },
  { key: 's', to: '/screener', label: 'Screener' },
  { key: 'w', to: '/watchlist', label: 'Watchlist' },
  { key: 'o', to: '/options', label: 'Options' },
  { key: 'p', to: '/positions', label: 'Positions' },
  { key: 'j', to: '/journal', label: 'Journal' },
  { key: 'a', to: '/alerts', label: 'Alerts' },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-slate-300">{desc}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="px-1.5 py-0.5 rounded bg-ink-700 border border-ink-500 text-[11px] text-slate-200 tabular-nums"
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);
  const gPending = useRef(false);
  const gTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;

      if (gPending.current) {
        gPending.current = false;
        clearTimeout(gTimer.current);
        const dest = NAV.find((n) => n.key === e.key.toLowerCase());
        if (dest) {
          e.preventDefault();
          navigate(dest.to);
        }
        return;
      }
      if (e.key === 'g') {
        gPending.current = true;
        gTimer.current = setTimeout(() => (gPending.current = false), 1200);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
      <div className="text-sm space-y-3">
        <Row keys={['⌘', 'K']} desc="Command palette — jump to any page or symbol" />
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Go to (press g, then…)</div>
          <div className="grid sm:grid-cols-2 gap-x-6">
            {NAV.map((n) => (
              <Row key={n.key} keys={['g', n.key]} desc={n.label} />
            ))}
          </div>
        </div>
        <Row keys={['?']} desc="Show this help" />
        <Row keys={['Esc']} desc="Close a dialog" />
      </div>
    </Modal>
  );
}

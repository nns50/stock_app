import { ReactNode, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../lib/format';
import { useProvider } from './ProviderContext';
import { ProviderStatusModal } from './ProviderStatusModal';

const TABS = [
  { to: '/screener', label: 'Screener' },
  { to: '/options', label: 'Options' },
  { to: '/positions', label: 'Positions' },
  { to: '/journal', label: 'Journal' },
];

function ProviderChip({ onClick }: { onClick: () => void }) {
  const { status } = useProvider();
  if (!status) return null;
  const color = !status.configured ? 'bg-bear/15 text-bear' : status.synthetic ? 'bg-amber-500/15 text-amber-400' : 'bg-bull/15 text-bull';
  const label = !status.configured ? `${status.name} · not configured` : `${status.name}${status.synthetic ? ' · demo' : ' · live'}`;
  return (
    <button className={cx('chip hover:ring-1 hover:ring-ink-500', color)} title="Provider status & connection test" onClick={onClick}>
      {label}
    </button>
  );
}

function ProviderBanner() {
  const { status } = useProvider();
  if (!status) return null;
  if (!status.configured) {
    return (
      <div className="bg-bear/10 border-b border-bear/30 text-bear text-sm px-4 py-2 text-center">
        {status.message ?? 'Market-data provider is not configured.'}
      </div>
    );
  }
  if (status.synthetic) {
    return (
      <div className="bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm px-4 py-2 text-center">
        Demo mode — showing <strong>synthetic</strong> data from the mock provider. Set a Tradier token in{' '}
        <code className="text-amber-200">server/.env</code> for live data.
      </div>
    );
  }
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  const [providerOpen, setProviderOpen] = useState(false);
  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-40 bg-ink-800/95 backdrop-blur border-b border-ink-600/60">
        <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-6 h-14">
          <div className="flex items-center gap-2">
            <span className="text-accent text-lg">◧</span>
            <span className="font-semibold tracking-tight">stock-app</span>
            <span className="hidden sm:inline text-[11px] text-slate-500">trading assistant</span>
          </div>
          <nav className="flex items-center gap-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  cx(
                    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                    isActive ? 'bg-ink-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-ink-700',
                  )
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ProviderChip onClick={() => setProviderOpen(true)} />
          </div>
        </div>
      </header>

      <ProviderStatusModal open={providerOpen} onClose={() => setProviderOpen(false)} />

      <ProviderBanner />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 py-5">{children}</main>

      <footer className="border-t border-ink-700 bg-ink-800/60">
        <div className="max-w-[1400px] mx-auto px-4 py-3 text-[12px] text-slate-500 text-center">
          ⚠️ Rule-based heuristics for personal research — <strong className="text-slate-400">not financial advice</strong>. No
          guarantees of accuracy or performance. This tool does not place trades.
        </div>
      </footer>
    </div>
  );
}

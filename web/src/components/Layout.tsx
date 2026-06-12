import { ReactNode, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../lib/format';
import { useProvider } from './ProviderContext';
import { ProviderStatusModal } from './ProviderStatusModal';
import { useAlerts } from './AlertsContext';

const TABS = [
  { to: '/screener', label: 'Screener' },
  { to: '/options', label: 'Options' },
  { to: '/positions', label: 'Positions' },
  { to: '/journal', label: 'Journal' },
  { to: '/alerts', label: 'Alerts' },
];

function ProviderChip({ onClick }: { onClick: () => void }) {
  const { status } = useProvider();
  if (!status) return null;
  const color = !status.configured
    ? 'bg-bear/15 text-bear'
    : status.synthetic
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-bull/15 text-bull';
  const label = !status.configured
    ? `${status.name} · not configured`
    : `${status.name}${status.synthetic ? ' · demo' : ' · live'}`;
  return (
    <button
      className={cx('chip hover:ring-1 hover:ring-ink-500', color)}
      title="Provider status & connection test"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function AlertsBell() {
  const { triggeredCount, intervalMs, setIntervalMs, checkNow } = useAlerts();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        className="relative p-1.5 rounded hover:bg-ink-700 text-slate-300"
        title="Alerts"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-lg leading-none">🔔</span>
        {triggeredCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-bear text-white text-[9px] leading-none rounded-full px-1 py-0.5">
            {triggeredCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 card p-3 z-50 text-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium">Alerts</span>
            {triggeredCount > 0 ? (
              <span className="chip bg-amber-500/15 text-amber-400">{triggeredCount} triggered</span>
            ) : (
              <span className="text-xs text-slate-500">none triggered</span>
            )}
          </div>
          <label className="block text-xs text-slate-400">
            Auto-check
            <select
              className="input mt-1"
              value={intervalMs ?? 'off'}
              onChange={(e) => setIntervalMs(e.target.value === 'off' ? null : Number(e.target.value))}
            >
              <option value="off">Off</option>
              <option value="30000">Every 30s</option>
              <option value="60000">Every 1m</option>
              <option value="300000">Every 5m</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button className="btn-ghost flex-1 text-xs" onClick={() => checkNow()}>
              Check now
            </button>
            <NavLink to="/alerts" className="btn-ghost flex-1 text-xs text-center" onClick={() => setOpen(false)}>
              View all
            </NavLink>
          </div>
        </div>
      )}
    </div>
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
          <div className="ml-auto flex items-center gap-2">
            <AlertsBell />
            <ProviderChip onClick={() => setProviderOpen(true)} />
          </div>
        </div>
      </header>

      <ProviderStatusModal open={providerOpen} onClose={() => setProviderOpen(false)} />

      <ProviderBanner />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 py-5">{children}</main>

      <footer className="border-t border-ink-700 bg-ink-800/60">
        <div className="max-w-[1400px] mx-auto px-4 py-3 text-[12px] text-slate-500 text-center">
          ⚠️ Rule-based heuristics for personal research —{' '}
          <strong className="text-slate-400">not financial advice</strong>. No guarantees of accuracy or performance.
          This tool does not place trades.
        </div>
      </footer>
    </div>
  );
}

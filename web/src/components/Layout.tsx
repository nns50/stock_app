import { ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Bell,
  BellRing,
  BookOpen,
  Briefcase,
  CandlestickChart,
  Command,
  Layers,
  LayoutDashboard,
  Moon,
  Search,
  Settings,
  Star,
  Sun,
} from 'lucide-react';
import { cx } from '../lib/format';
import { useProvider } from './ProviderContext';
import { ProviderStatusModal } from './ProviderStatusModal';
import { useAlerts } from './AlertsContext';
import { useTheme } from './ThemeContext';
import { ErrorBoundary } from './ErrorBoundary';
import { CommandPalette, OPEN_PALETTE_EVENT } from './CommandPalette';

const TABS = [
  { to: '/today', label: 'Today', Icon: LayoutDashboard },
  { to: '/screener', label: 'Screener', Icon: Search },
  { to: '/watchlist', label: 'Watch', Icon: Star },
  { to: '/options', label: 'Options', Icon: Layers },
  { to: '/positions', label: 'Positions', Icon: Briefcase },
  { to: '/journal', label: 'Journal', Icon: BookOpen },
  { to: '/alerts', label: 'Alerts', Icon: BellRing },
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
        className="relative p-2 rounded-lg hover:bg-ink-700 text-slate-300 hover:text-slate-100 transition-colors"
        title="Alerts"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="h-[18px] w-[18px]" />
        {triggeredCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-bear text-white text-[9px] font-semibold leading-none rounded-full px-1 py-0.5 ring-2 ring-ink-800">
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

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      className="p-2 rounded-lg hover:bg-ink-700 text-slate-300 hover:text-slate-100 transition-colors"
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle color theme"
    >
      {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
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
  const { pathname } = useLocation();
  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-40 bg-ink-900/80 backdrop-blur-md border-b border-ink-600/60">
        <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-4 h-14">
          <Link to="/today" className="flex items-center gap-2 shrink-0 group">
            <span className="grid place-items-center h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-accent-muted text-white shadow-glow">
              <CandlestickChart className="h-[18px] w-[18px]" />
            </span>
            <span className="font-semibold tracking-tight hidden sm:inline">stock-app</span>
          </Link>
          <nav className="flex items-center gap-0.5 overflow-x-auto">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }: { isActive: boolean }) =>
                  cx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap',
                    isActive
                      ? 'bg-ink-700 text-slate-100 ring-1 ring-ink-500/60'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-ink-700/60',
                  )
                }
              >
                <t.Icon className="h-4 w-4" />
                <span className="hidden md:inline">{t.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-slate-400 bg-ink-800 border border-ink-600 hover:text-slate-200 hover:border-ink-500 transition-colors"
              onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
              title="Command palette"
            >
              <Command className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Jump to</span>
              <kbd className="text-[10px] px-1 rounded bg-ink-700 border border-ink-500">⌘K</kbd>
            </button>
            <ThemeToggle />
            <AlertsBell />
            <NavLink
              to="/settings"
              className={({ isActive }: { isActive: boolean }) =>
                cx(
                  'p-2 rounded-lg hover:bg-ink-700 transition-colors',
                  isActive ? 'text-accent bg-ink-700' : 'text-slate-300 hover:text-slate-100',
                )
              }
              title="Settings"
              aria-label="Settings"
            >
              <Settings className="h-[18px] w-[18px]" />
            </NavLink>
            <ProviderChip onClick={() => setProviderOpen(true)} />
          </div>
        </div>
      </header>

      <ProviderStatusModal open={providerOpen} onClose={() => setProviderOpen(false)} />
      <CommandPalette />

      <ProviderBanner />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 py-5">
        {/* Keyed by route so a crashed page resets when you navigate away. */}
        <div key={pathname} className="animate-fade-in">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </main>

      <footer className="border-t border-ink-700 bg-ink-800/60">
        <div className="max-w-[1400px] mx-auto px-4 py-3 text-[12px] text-slate-500 text-center">
          ⚠️ Rule-based heuristics for personal research —{' '}
          <strong className="text-slate-400">not financial advice</strong>. No guarantees of accuracy or performance.
          This tool does not place trades.{' '}
          <Link to="/about" className="text-slate-400 underline decoration-dotted underline-offset-2 hover:text-accent">
            How it works &amp; disclaimers
          </Link>
        </div>
      </footer>
    </div>
  );
}

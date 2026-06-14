import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { Card } from './ui';

// A dismissible getting-started checklist for the dashboard. Each step reflects
// real state (does the user have a watchlist? any trades? a snapshot? an
// alert?), so it doubles as a live "what haven't I set up yet" guide. Once every
// step is done it disappears on its own; the ✕ hides it for good.

interface Step {
  key: string;
  label: string;
  hint: string;
  to: string;
  cta: string;
  done: boolean;
}

export function GettingStarted() {
  const [dismissed, setDismissed] = useLocalStorage('onboarding.dismissed', false);

  // Only fetch while still relevant — a dismissed banner does no work.
  const state = useAsync(async () => {
    if (dismissed) return null;
    const [watch, positions, snaps, alerts] = await Promise.all([
      client.watchlist().catch(() => ({ symbols: [] as string[] })),
      client.positionsWithPnl({}).catch(() => ({ positions: [] as unknown[] })),
      client.listSnapshots().catch(() => ({ snapshots: [] as unknown[] })),
      client.alerts().catch(() => ({ alerts: [] as unknown[] })),
    ]);
    return {
      watch: watch.symbols.length > 0,
      positions: positions.positions.length > 0,
      snaps: snaps.snapshots.length > 0,
      alerts: alerts.alerts.length > 0,
    };
  }, [dismissed]);

  if (dismissed || state.loading || !state.data) return null;
  const d = state.data;

  const steps: Step[] = [
    {
      key: 'watch',
      label: 'Build a watchlist',
      hint: 'Track the symbols you care about.',
      to: '/watchlist',
      cta: 'Add symbols',
      done: d.watch,
    },
    {
      key: 'screener',
      label: 'Run the screener',
      hint: 'Rank your universe, then save a snapshot to measure its edge.',
      to: '/screener',
      cta: 'Open screener',
      done: d.snaps,
    },
    {
      key: 'positions',
      label: 'Log your first trade',
      hint: 'Track live P&L and build your journal.',
      to: '/positions',
      cta: 'Log a trade',
      done: d.positions,
    },
    {
      key: 'alerts',
      label: 'Set a price alert',
      hint: 'Get notified when a symbol hits your level.',
      to: '/alerts',
      cta: 'Create alert',
      done: d.alerts,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  // Fully set up — nothing to nag about.
  if (doneCount === steps.length) return null;

  return (
    <Card className="p-4 ring-1 ring-accent/20">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-medium text-sm">Getting started</h2>
          <p className="text-xs text-slate-500">A few steps to get the most out of your trading workspace.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 tabular-nums">
            {doneCount}/{steps.length}
          </span>
          <button
            className="text-slate-500 hover:text-slate-300 text-sm"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss getting started"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="h-1 rounded bg-ink-600 overflow-hidden mb-3">
        <div className="h-full bg-accent transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>

      <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-3 rounded-md border border-ink-700/60 p-2.5 bg-ink-800/40">
            <span
              className={
                s.done
                  ? 'mt-0.5 h-5 w-5 shrink-0 rounded-full bg-bull/20 text-bull grid place-items-center text-xs'
                  : 'mt-0.5 h-5 w-5 shrink-0 rounded-full border border-ink-500 text-slate-500 grid place-items-center text-xs'
              }
              aria-hidden="true"
            >
              {s.done ? '✓' : ''}
            </span>
            <div className="min-w-0 flex-1">
              <div className={s.done ? 'text-sm text-slate-400 line-through' : 'text-sm text-slate-200'}>{s.label}</div>
              {!s.done && (
                <>
                  <div className="text-xs text-slate-500">{s.hint}</div>
                  <Link to={s.to} className="text-xs text-accent hover:underline mt-0.5 inline-block">
                    {s.cta} →
                  </Link>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

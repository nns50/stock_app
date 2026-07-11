import { useState } from 'react';
import { ago, cx } from '../lib/format';
import { usePolling } from '../lib/hooks';

const INTERVALS: { label: string; ms: number | null }[] = [
  { label: 'Off', ms: null },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
];

/**
 * Manual Refresh button + polling interval (default 1m, unless overridden) +
 * last-updated indicator. The 1m default assumes a single cheap server-side
 * read — provider calls are cached, so polling at that cadence doesn't risk
 * rate limits — but that assumption doesn't hold for every consumer (e.g. the
 * Screener re-runs an up-to-500-symbol external-provider scan), so a page
 * whose own refresh is heavier can pass `defaultIntervalMs` to start Off (or
 * any other cadence) instead of inheriting a one-size-fits-all default.
 */
export function RefreshBar({
  onRefresh,
  lastUpdated,
  loading,
  defaultIntervalMs = 60_000,
}: {
  onRefresh: () => void;
  lastUpdated: number | null;
  loading?: boolean;
  defaultIntervalMs?: number | null;
}) {
  const [intervalMs, setIntervalMs] = useState<number | null>(defaultIntervalMs);
  usePolling(onRefresh, intervalMs);

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-500 text-xs">
        Updated <span className="text-slate-300">{ago(lastUpdated)}</span>
      </span>
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-500">Auto</span>
        <select
          className="input !w-auto py-0.5"
          value={intervalMs === null ? 'off' : String(intervalMs)}
          onChange={(e) => setIntervalMs(e.target.value === 'off' ? null : Number(e.target.value))}
          title="Optional polling interval (respects provider rate limits via caching)"
        >
          {INTERVALS.map((i) => (
            <option key={i.label} value={i.ms === null ? 'off' : String(i.ms)}>
              {i.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn-primary" onClick={onRefresh} disabled={loading}>
        <span className={cx(loading && 'animate-spin')}>↻</span> Refresh
      </button>
    </div>
  );
}

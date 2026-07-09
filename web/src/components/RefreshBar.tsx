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
 * Manual Refresh button + polling interval (default 1m) + last-updated
 * indicator. Provider calls are cached server-side, so polling at the
 * default cadence doesn't risk rate limits.
 */
export function RefreshBar({
  onRefresh,
  lastUpdated,
  loading,
}: {
  onRefresh: () => void;
  lastUpdated: number | null;
  loading?: boolean;
}) {
  const [intervalMs, setIntervalMs] = useState<number | null>(60_000);
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

import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtPct } from '../lib/format';
import type { SectorRotationEntry } from '../api/types';
import { CollapsibleCard, EmptyState, ErrorState, Spinner } from './ui';

/**
 * "Which sectors are leading right now?" — a read-only leaderboard ranking the
 * universe's sectors by the median relative strength of their members over a
 * lookback window (server: services/sectorRotation.ts). Clicking a sector hands
 * its members to the Screener for a scoped scan. Collapsed by default and
 * fetched only once expanded (its own per-symbol candle fan-out).
 */
export function SectorRotationPanel({ onPickSector }: { onPickSector: (sector: string, members: string[]) => void }) {
  return (
    <CollapsibleCard id="screener.sectorRotation" title="Sector rotation" defaultCollapsed>
      <RotationBody onPickSector={onPickSector} />
    </CollapsibleCard>
  );
}

function RotationBody({ onPickSector }: { onPickSector: (sector: string, members: string[]) => void }) {
  const data = useAsync(() => client.sectorRotation(), []);

  if (data.loading) return <Spinner label="Ranking sectors…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || data.data.sectors.length === 0) {
    return (
      <EmptyState
        title="No sector data to rank"
        hint="Your universe needs symbols with a sector classification and fetchable price history."
      />
    );
  }

  const { sectors, basis, benchmarkSymbol, lookbackDays, unresolvedSectors } = data.data;
  const strongest = Math.max(...sectors.map((s) => Math.abs(s.medianRelStrengthPct)), 1);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Sectors ranked by the <strong className="text-slate-300">median</strong> {lookbackDays}-day{' '}
        {basis === 'relative-to-benchmark' ? (
          <>
            relative strength of their members (each member's return minus{' '}
            <strong className="text-slate-300">{benchmarkSymbol}</strong>'s over the same window)
          </>
        ) : (
          <>
            absolute return of their members ({benchmarkSymbol} history was unavailable, so this falls back to plain
            momentum)
          </>
        )}
        . Click a sector to scan just its members. Momentum is backward-looking — not a forecast.
      </p>

      <ul className="space-y-1">
        {sectors.map((s, i) => (
          <SectorRow key={s.sector} entry={s} rank={i + 1} strongest={strongest} onPick={onPickSector} />
        ))}
      </ul>

      {unresolvedSectors.length > 0 && (
        <p className="text-[11px] text-amber-400/90">⚠ No fetchable history: {unresolvedSectors.join(', ')}</p>
      )}
    </div>
  );
}

function SectorRow({
  entry,
  rank,
  strongest,
  onPick,
}: {
  entry: SectorRotationEntry;
  rank: number;
  strongest: number;
  onPick: (sector: string, members: string[]) => void;
}) {
  const pct = entry.medianRelStrengthPct;
  const barWidth = `${(Math.abs(pct) / strongest) * 100}%`;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(entry.sector, entry.members)}
        title={`Scan ${entry.members.length} ${entry.sector} names in the screener`}
        className="w-full rounded px-2 py-1.5 text-left hover:bg-ink-700/40 focus:bg-ink-700/40 focus:outline-none"
      >
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate">
            <span className="text-slate-500 tabular-nums">{rank}.</span>{' '}
            <span className="text-slate-200">{entry.sector}</span>{' '}
            <span className="text-[11px] text-slate-500">({entry.memberCount})</span>
          </span>
          <span className={cx('shrink-0 font-semibold tabular-nums', pct >= 0 ? 'text-bull' : 'text-bear')}>
            {fmtPct(pct, 1)}
          </span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-ink-700/40">
          <div className={cx('h-full', pct >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: barWidth }} />
        </div>
      </button>
    </li>
  );
}

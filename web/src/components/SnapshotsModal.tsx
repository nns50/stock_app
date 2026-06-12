import { useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtPct, fmtUsd, pnlClass } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Modal, Spinner, StatTile } from './ui';
import type { SnapshotSummary } from '../api/types';

export function SnapshotsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snaps = useAsync(() => client.listSnapshots(), [open]);
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Modal open={open} onClose={onClose} title="Screener snapshots" wide>
      {snaps.loading ? (
        <Spinner />
      ) : !snaps.data?.snapshots.length ? (
        <EmptyState
          title="No snapshots yet"
          hint="Run the screener and click “Save snapshot” to track how those picks actually perform over time — so you can tell whether your rules have edge."
        />
      ) : (
        <div className="space-y-2">
          {snaps.data.snapshots.map((s) => (
            <SnapshotRow
              key={s.id}
              s={s}
              open={expanded === s.id}
              onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
              onDeleted={() => snaps.reload()}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function SnapshotRow({
  s,
  open,
  onToggle,
  onDeleted,
}: {
  s: SnapshotSummary;
  open: boolean;
  onToggle: () => void;
  onDeleted: () => void;
}) {
  return (
    <Card className="p-2">
      <div className="flex items-center gap-2 text-sm">
        <button className="text-slate-300 hover:text-accent" onClick={onToggle}>
          {open ? '▾' : '▸'} {fmtDate(s.createdAt)}
        </button>
        <Badge color={s.direction === 'long' ? 'green' : 'red'}>{s.direction}</Badge>
        <span className="text-slate-500">{s.pickCount} picks</span>
        {s.note && <span className="text-slate-400 italic truncate">“{s.note}”</span>}
        <button
          className="ml-auto text-xs text-slate-500 hover:text-bear"
          onClick={async () => {
            if (window.confirm('Delete this snapshot?')) {
              await client.deleteSnapshot(s.id);
              onDeleted();
            }
          }}
        >
          delete
        </button>
      </div>
      {open && <SnapshotPerf id={s.id} />}
    </Card>
  );
}

function SnapshotPerf({ id }: { id: number }) {
  const perf = useAsync(() => client.snapshotPerformance(id), [id]);
  if (perf.loading) return <Spinner />;
  if (perf.error) return <ErrorState error={perf.error} onRetry={perf.reload} />;
  const p = perf.data!.performance;

  return (
    <div className="mt-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <StatTile
          label="Hit rate"
          value={p.hitRate === null ? '—' : `${p.hitRate}%`}
          sub={`${p.evaluated} evaluated`}
        />
        <StatTile
          label="Avg return"
          value={fmtPct(p.avgReturnPct)}
          valueClass={pnlClass(p.avgReturnPct)}
          sub={`median ${fmtPct(p.medianReturnPct)}`}
        />
        <StatTile label="Best" value={fmtPct(p.bestReturnPct)} valueClass="text-bull" />
        <StatTile label="Worst" value={fmtPct(p.worstReturnPct)} valueClass="text-bear" />
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[11px] uppercase text-slate-500">
            <th className="py-1">#</th>
            <th>Symbol</th>
            <th className="text-right">Score</th>
            <th className="text-right">Entry</th>
            <th className="text-right">Now</th>
            <th className="text-right">Return</th>
          </tr>
        </thead>
        <tbody>
          {p.picks.map((pk) => (
            <tr key={pk.symbol} className="border-t border-ink-700/50">
              <td className="py-1 text-slate-500">{pk.rank}</td>
              <td className="font-medium">{pk.symbol}</td>
              <td className="text-right tabular-nums">{pk.score.toFixed(1)}</td>
              <td className="text-right tabular-nums">{fmtUsd(pk.priceAtRun)}</td>
              <td className="text-right tabular-nums">{pk.currentPrice === null ? '—' : fmtUsd(pk.currentPrice)}</td>
              <td className={cx('text-right tabular-nums', pnlClass(pk.returnPct))}>{fmtPct(pk.returnPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500 mt-1">
        Returns are direction-adjusted — positive means the symbol moved the way the screener expected.
      </p>
    </div>
  );
}

import { useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtNum, fmtPct, fmtUsd, pnlClass } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Modal, Spinner, StatTile } from './ui';
import { useConfirm } from './ConfirmContext';
import { useToast } from './ToastContext';
import type { EdgeReport, SnapshotSummary } from '../api/types';

export function SnapshotsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snaps = useAsync(() => client.listSnapshots(), [open]);
  const edge = useAsync(() => client.snapshotsEdge(), [open]);
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
          <EdgeSummary data={edge.data} loading={edge.loading} />
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

function EdgeSummary({ data, loading }: { data?: EdgeReport; loading: boolean }) {
  if (loading) return <Spinner label="Computing edge…" />;
  if (!data || data.evaluated === 0) return null;
  return (
    <Card className="p-3 mb-1 ring-1 ring-accent/20">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">Edge across {data.snapshots} snapshots</h3>
        <span className="text-xs text-slate-500">{data.evaluated} picks evaluated</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <StatTile
          label="Avg forward return"
          value={fmtPct(data.avgReturnPct)}
          valueClass={pnlClass(data.avgReturnPct)}
        />
        <StatTile label="Hit rate" value={data.hitRate == null ? '—' : `${fmtNum(data.hitRate, 0)}%`} />
      </div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">By rank tier — do top picks lead?</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-left border-b border-ink-600/60">
            <th className="py-1 font-medium">Tier</th>
            <th className="py-1 font-medium text-right">Picks</th>
            <th className="py-1 font-medium text-right">Hit%</th>
            <th className="py-1 font-medium text-right">Avg return</th>
          </tr>
        </thead>
        <tbody>
          {data.byRank.map((b) => (
            <tr key={b.label} className="border-b border-ink-700/40 last:border-0">
              <td className="py-1 text-slate-200">{b.label}</td>
              <td className="py-1 text-right tabular-nums text-slate-400">{b.picks}</td>
              <td className="py-1 text-right tabular-nums text-slate-400">{fmtNum(b.hitRate, 0)}%</td>
              <td className={cx('py-1 text-right tabular-nums', pnlClass(b.avgReturnPct))}>{fmtPct(b.avgReturnPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500 mt-1.5">
        Forward return = direction-adjusted move from each pick’s snapshot price to now. Higher tiers should out-return
        lower ones if the score has edge.
      </p>
    </Card>
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
  const confirm = useConfirm();
  const { toast } = useToast();
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
            const ok = await confirm({ title: 'Delete snapshot?', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            await client.deleteSnapshot(s.id);
            onDeleted();
            toast('Snapshot deleted', { type: 'success' });
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

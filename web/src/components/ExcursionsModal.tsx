import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtNum } from '../lib/format';
import { EmptyState, ErrorState, Modal, Spinner, StatTile } from './ui';

const r = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}R`);
const rClass = (v: number | null) => (v == null ? '' : v >= 0 ? 'text-bull' : 'text-bear');

/**
 * MAE/MFE excursion analysis: how far each closed stock trade ran for/against you
 * over its holding period (in R), and how much of the favorable move you kept.
 */
export function ExcursionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useAsync(() => (open ? client.journalExcursions() : Promise.resolve(null)), [open]);

  return (
    <Modal open={open} onClose={onClose} title="Trade excursions (MAE / MFE)" wide>
      {data.loading ? (
        <Spinner label="Fetching candles per trade…" />
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !data.data || data.data.trades === 0 ? (
        <EmptyState
          title="No closed stock trades to analyze"
          hint="Excursions use daily candles over each closed stock trade's holding period (options are skipped). Log a stop to see results in R."
        />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Over each trade’s holding period: how far price ran in your favor (MFE) and against you (MAE), in R. Compare
            avg MFE to avg realized — a big gap means winners ran further than you held.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="Avg MFE" value={r(data.data.avgMfeR)} valueClass="text-bull" sub="best run" />
            <StatTile label="Avg MAE" value={r(data.data.avgMaeR)} valueClass="text-bear" sub="worst dip" />
            <StatTile
              label="Avg realized"
              value={r(data.data.avgRealizedR)}
              valueClass={rClass(data.data.avgRealizedR)}
            />
            <StatTile
              label="Capture"
              value={data.data.capturePct == null ? '—' : `${fmtNum(data.data.capturePct, 0)}%`}
              sub="of the move kept"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
                  <th className="py-1 pr-2 font-medium">Symbol</th>
                  <th className="py-1 px-2 font-medium">Entry</th>
                  <th className="py-1 px-2 font-medium text-right">MFE</th>
                  <th className="py-1 px-2 font-medium text-right">MAE</th>
                  <th className="py-1 px-2 font-medium text-right">Realized</th>
                  <th className="py-1 pl-2 font-medium text-right">Captured</th>
                </tr>
              </thead>
              <tbody>
                {data.data.rows.map((row) => (
                  <tr key={row.positionId} className="border-b border-ink-700/40 last:border-0">
                    <td className="py-1 pr-2 font-medium text-slate-200">
                      {row.symbol} <span className="text-[11px] text-slate-500">{row.side}</span>
                    </td>
                    <td className="py-1 px-2 text-slate-400 text-xs">{row.entryDate}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-bull">{r(row.mfeR)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-bear">{r(row.maeR)}</td>
                    <td className={cx('py-1 px-2 text-right tabular-nums', rClass(row.realizedR))}>
                      {r(row.realizedR)}
                    </td>
                    <td className="py-1 pl-2 text-right tabular-nums text-slate-400">
                      {row.capturedPct == null ? '—' : `${fmtNum(row.capturedPct, 0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            R needs a logged stop. “Captured” = realized ÷ MFE on winners — low values suggest exiting winners early;
            small MAE vs your −1R stop suggests room to tighten.
          </p>
        </div>
      )}
    </Modal>
  );
}

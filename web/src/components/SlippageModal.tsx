import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtDate, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { EmptyState, ErrorState, Modal, Spinner, StatTile } from './ui';

// Positive $/% always means the fill cost you money (regardless of buy/sell);
// see server/src/services/slippage.ts. Color follows that sign.
const costClass = (v: number) => (v > 0 ? 'text-bear' : v < 0 ? 'text-bull' : '');

/**
 * Execution quality: for each live-traded fill that came from an order with a
 * limit price, how the actual broker fill compared to the price you committed
 * to. Surfaces silent slippage cost — worst fills first.
 */
export function SlippageModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = useAsync(() => (open ? client.journalSlippage() : Promise.resolve(null)), [open]);

  return (
    <Modal open={open} onClose={onClose} title="Execution quality (slippage)" wide>
      {data.loading ? (
        <Spinner label="Comparing fills to order limits…" />
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !data.data || data.data.trades === 0 ? (
        <EmptyState
          title="No live fills to analyze yet"
          hint="This compares each live-traded fill to the order's limit price. It only covers orders placed through this app with a limit (stop-market fills and manually logged/imported trades have no reference price to compare against)."
        />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            For each live fill, the actual broker price vs. the limit you set — positive always means it cost you money,
            whichever side you were on.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <StatTile
              label="Total slippage"
              value={fmtSignedUsd(data.data.totalUsd)}
              valueClass={costClass(data.data.totalUsd)}
              sub={data.data.totalUsd > 0 ? 'cost you' : data.data.totalUsd < 0 ? 'saved you' : undefined}
            />
            <StatTile
              label="Avg %"
              value={data.data.avgPct == null ? '—' : fmtPct(data.data.avgPct)}
              valueClass={data.data.avgPct == null ? '' : costClass(data.data.avgPct)}
            />
            <StatTile label="Fills with data" value={data.data.trades} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-ink-600/60">
                  <th className="py-1 pr-2 font-medium">Symbol</th>
                  <th className="py-1 px-2 font-medium">Date</th>
                  <th className="py-1 px-2 font-medium">Kind</th>
                  <th className="py-1 px-2 font-medium text-right">Limit</th>
                  <th className="py-1 px-2 font-medium text-right">Fill</th>
                  <th className="py-1 px-2 font-medium text-right">$</th>
                  <th className="py-1 pl-2 font-medium text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {data.data.rows.map((row, i) => (
                  <tr key={`${row.positionId}-${row.kind}-${i}`} className="border-b border-ink-700/40 last:border-0">
                    <td className="py-1 pr-2 font-medium text-slate-200">
                      {row.symbol} <span className="text-[11px] text-slate-500">{row.side}</span>
                    </td>
                    <td className="py-1 px-2 text-slate-400 text-xs">{fmtDate(row.date)}</td>
                    <td className="py-1 px-2 text-slate-400 text-xs">{row.kind}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-slate-400">{fmtUsd(row.limitPrice)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-slate-200">{fmtUsd(row.fillPrice)}</td>
                    <td className={cx('py-1 px-2 text-right tabular-nums', costClass(row.totalUsd))}>
                      {fmtSignedUsd(row.totalUsd)}
                    </td>
                    <td className={cx('py-1 pl-2 text-right tabular-nums', costClass(row.pct))}>{fmtPct(row.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            Sorted worst-first. A consistent positive bias suggests marketable limits or wide spreads at entry/exit —
            tighter limits or more liquid strikes reduce it.
          </p>
        </div>
      )}
    </Modal>
  );
}

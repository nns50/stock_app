import { useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useToast } from './ToastContext';
import type { ExpiredOptionFinding } from '../api/types';

// ---------------------------------------------------------------------------
// Option positions whose expiry has passed but that are still sitting OPEN.
//
// Exits are only ever recorded from a real closing order, and an option held
// through expiry never produces one — so without this the position stays open
// forever, quietly inflating open exposure, the risk caps, the position count
// and the unrealized P&L tiles with a contract that no longer exists.
//
// Closing is a deliberate action, not a background one: writing $0 exits
// changes realized P&L in the journal AND the tax export, so the user sees
// exactly what would be closed and presses the button themselves. Anything the
// server couldn't call unambiguously worthless is listed separately and is
// never closed by this flow at all.
// ---------------------------------------------------------------------------

function FindingRow({ f }: { f: ExpiredOptionFinding }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium">{f.label}</span>
      <span className="opacity-70">
        ×{f.remainingQuantity} {f.side}
      </span>
      <span className="opacity-70">— {f.reason}</span>
    </li>
  );
}

/** `reloadKey` changes when the book changes, so recording the real outcome of
 *  an expired contract by hand (the "needs you" path below tells you to) drops
 *  it off this list. Keyed on `[]` it never re-checked, so a position you had
 *  just exited stayed listed here as still open until a full page reload. */
export function ExpiredOptionsBanner({
  onChanged,
  reloadKey = 0,
}: {
  onChanged: () => void;
  reloadKey?: number | string;
}) {
  const found = useAsync(() => client.expiredOptions(), [reloadKey]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const worthless = found.data?.closed ?? [];
  const review = found.data?.needsReview ?? [];
  if (found.loading || (!worthless.length && !review.length)) return null;

  const sweep = async () => {
    setBusy(true);
    try {
      const r = await client.sweepExpiredOptions();
      toast(
        r.closed.length
          ? `Closed ${r.closed.length} expired position${r.closed.length === 1 ? '' : 's'} at $0.`
          : 'Nothing was closed.',
        { type: 'success' },
      );
      found.reload();
      onChanged();
    } catch (e) {
      toast((e as Error).message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-2">
      <div className="font-semibold">
        {worthless.length + review.length} option position
        {worthless.length + review.length === 1 ? '' : 's'} expired but still showing as open
      </div>

      {worthless.length > 0 && (
        <div className="space-y-1">
          <div>
            These expired <b>worthless</b> — closing them records a $0 exit dated on the expiry, so your realized
            P&amp;L and open-risk figures stop counting a contract that no longer exists:
          </div>
          <ul className="space-y-0.5 pl-4 list-disc">
            {worthless.map((f) => (
              <FindingRow key={f.positionId} f={f} />
            ))}
          </ul>
          <button className="btn-ghost text-xs" onClick={sweep} disabled={busy}>
            {busy ? 'Closing…' : `Close ${worthless.length} at $0`}
          </button>
        </div>
      )}

      {review.length > 0 && (
        <div className="space-y-1">
          <div>
            These need <b>you</b> — an option that finished in the money was exercised or assigned, which creates or
            removes a stock position this app doesn&apos;t track, so nothing is closed automatically:
          </div>
          <ul className="space-y-0.5 pl-4 list-disc">
            {review.map((f) => (
              <FindingRow key={f.positionId} f={f} />
            ))}
          </ul>
          <div className="opacity-70">
            Record the real outcome with <b>exit</b> on the position (or <b>del</b> it if it never existed).
          </div>
        </div>
      )}
    </div>
  );
}

import { TriangleAlert } from 'lucide-react';
import type { PositionWithPnl } from '../api/types';

/** services/washSale.ts — informational only, never a trading gate (see the
 *  tooltip copy below). Renders nothing when the row has no warning.
 *
 *  Shared by the Journal and the Positions table: the API returns `washSale`
 *  on every row of both, so a closed loss that may be disallowed shouldn't be
 *  visible on one page and silently dropped on the other. */
export function WashSaleBadge({ washSale }: { washSale: PositionWithPnl['washSale'] }) {
  if (!washSale) return null;
  const when =
    washSale.daysApart >= 0
      ? `reopened ${washSale.daysApart} day${washSale.daysApart === 1 ? '' : 's'} after this closed`
      : `already open ${Math.abs(washSale.daysApart)} day${Math.abs(washSale.daysApart) === 1 ? '' : 's'} before this closed`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-400"
      title={`Same symbol was ${when} (on ${washSale.triggerEntryDate}) — this loss may be wash-sale disallowed. Not tax advice; confirm against your 1099-B or a tax professional.`}
    >
      <TriangleAlert className="h-3 w-3" />
      wash sale?
    </span>
  );
}

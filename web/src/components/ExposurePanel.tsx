import type { Exposure } from '../api/types';
import { fmtNum, fmtSignedUsd, fmtUsd } from '../lib/format';
import { Card } from './ui';

/** Concentration view over the open book: long/short split + sector breakdown. */
export function ExposurePanel({ exposure }: { exposure: Exposure }) {
  if (exposure.gross <= 0) return null;
  const { gross, net, long, short, bySector, largest } = exposure;
  const longPct = gross ? (long / gross) * 100 : 0;

  const warnings: string[] = [];
  if (bySector[0] && bySector[0].pct >= 50) warnings.push(`${fmtNum(bySector[0].pct, 0)}% in ${bySector[0].key}`);
  if (largest && largest.pct >= 40) warnings.push(`${fmtNum(largest.pct, 0)}% in ${largest.symbol}`);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Open exposure</h3>
        <span className="text-xs text-slate-500 tabular-nums">
          gross {fmtUsd(gross)} · net {fmtSignedUsd(net)}
        </span>
      </div>

      <div>
        <div className="flex justify-between text-[11px] mb-1">
          <span className="text-bull">▲ Long {fmtUsd(long)}</span>
          <span className="text-bear">▼ Short {fmtUsd(short)}</span>
        </div>
        <div className="flex h-2 rounded overflow-hidden bg-ink-600">
          <div className="bg-bull" style={{ width: `${longPct}%` }} />
          <div className="bg-bear" style={{ width: `${100 - longPct}%` }} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">By sector</div>
        {bySector.map((s) => (
          <div key={s.key}>
            <div className="flex justify-between text-xs mb-0.5">
              <span className="text-slate-300">
                {s.key} <span className="text-slate-500">({s.count})</span>
              </span>
              <span className="tabular-nums text-slate-400">
                {fmtUsd(s.gross)} · {fmtNum(s.pct, 0)}%
              </span>
            </div>
            <div className="h-1.5 rounded bg-ink-600 overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${s.pct}%` }} />
            </div>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-400/90">⚠ Concentrated — {warnings.join(' · ')}</div>
      )}
    </Card>
  );
}

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtPct, fmtUsd } from '../lib/format';
import { Card, Spinner } from './ui';

const RATING_LABEL: Record<string, string> = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  hold: 'Hold',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
};

function ratingTone(k?: string): string {
  if (!k) return 'text-slate-400';
  if (k.includes('buy')) return 'text-bull';
  if (k.includes('sell')) return 'text-bear';
  return 'text-slate-300';
}

function actionIcon(a?: string) {
  if (a === 'up') return <ArrowUpRight className="h-3.5 w-3.5 text-bull" />;
  if (a === 'down') return <ArrowDownRight className="h-3.5 w-3.5 text-bear" />;
  return <Minus className="h-3.5 w-3.5 text-slate-500" />;
}

/** Analyst consensus target/rating + recent upgrades/downgrades (Yahoo). */
export function AnalystPanel({ symbol, price }: { symbol: string; price?: number | null }) {
  const a = useAsync(() => client.analyst(symbol), [symbol]);
  const d = a.data;

  if (a.loading)
    return (
      <Card className="p-4">
        <Spinner />
      </Card>
    );
  // Nothing to show (e.g. an ETF or thinly-covered name) → render no card.
  if (!d || (d.targetMean == null && d.recommendationKey == null && d.actions.length === 0)) return null;

  const upside = d.targetMean != null && price ? (d.targetMean / price - 1) * 100 : null;

  return (
    <Card className="p-4">
      <h3 className="font-medium text-sm mb-3 text-slate-200">
        Analyst <span className="text-[10px] uppercase tracking-wide text-slate-500 font-normal">Yahoo</span>
      </h3>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm mb-3">
        {d.recommendationKey && (
          <div>
            <div className="label">Consensus</div>
            <div className={cx('font-medium', ratingTone(d.recommendationKey))}>
              {RATING_LABEL[d.recommendationKey] ?? d.recommendationKey}
              {d.numberOfAnalysts != null && (
                <span className="text-slate-500 font-normal"> · {d.numberOfAnalysts} analysts</span>
              )}
            </div>
          </div>
        )}
        {d.targetMean != null && (
          <div>
            <div className="label">Price target</div>
            <div className="font-medium tabular-nums">
              {fmtUsd(d.targetMean)}
              {upside != null && (
                <span className={cx('ml-1 text-xs', upside >= 0 ? 'text-bull' : 'text-bear')}>({fmtPct(upside)})</span>
              )}
            </div>
          </div>
        )}
        {(d.targetLow != null || d.targetHigh != null) && (
          <div>
            <div className="label">Target range</div>
            <div className="tabular-nums text-slate-300">
              {fmtUsd(d.targetLow)}–{fmtUsd(d.targetHigh)}
            </div>
          </div>
        )}
      </div>
      {d.actions.length > 0 && (
        <div>
          <div className="label mb-1">Recent rating changes</div>
          <ul className="space-y-1 text-xs">
            {d.actions.map((act, i) => (
              <li key={i} className="flex items-center gap-2">
                {actionIcon(act.action)}
                <span className="font-medium text-slate-300">{act.firm}</span>
                {(act.fromGrade || act.toGrade) && (
                  <span className="text-slate-500">
                    {act.fromGrade ? `${act.fromGrade} → ` : ''}
                    {act.toGrade}
                  </span>
                )}
                {act.date && <span className="ml-auto text-slate-600">{act.date}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

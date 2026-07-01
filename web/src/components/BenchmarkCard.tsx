import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { fmtPct, fmtUsd } from '../lib/format';
import { Card, PnL, StatTile } from './ui';

/**
 * "Am I beating the index?" — realized return over the trading period vs SPY
 * buy-and-hold. Account size (shared with the risk sizer) turns realized $ into %.
 */
export function BenchmarkCard() {
  const [accountSize] = useLocalStorage<number>('risk.accountSize', 25000);
  const [benchSymbol] = useLocalStorage<string>('benchmark.symbol', 'SPY');
  const b = useAsync(() => client.journalBenchmark(accountSize, benchSymbol || 'SPY'), [accountSize, benchSymbol]);
  const d = b.data;
  if (!d || d.benchmarkReturnPct === null) return null;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">You vs {d.symbol} (buy &amp; hold)</h3>
        <span className="text-xs text-slate-500">
          {d.startDate} → {d.endDate}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatTile
          label="Your return"
          value={<PnL value={d.userReturnPct} format={fmtPct} />}
          sub={d.accountSize ? `on ${fmtUsd(d.accountSize)}` : 'set account size'}
        />
        <StatTile label={`${d.symbol} buy & hold`} value={<PnL value={d.benchmarkReturnPct} format={fmtPct} />} />
        <StatTile
          label="Alpha"
          value={<PnL value={d.alphaPct} format={fmtPct} />}
          sub={d.alphaPct == null ? undefined : d.alphaPct >= 0 ? 'beating the index' : 'behind the index'}
        />
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5">
        Your return uses your account size (edit it in the risk sizer). Alpha &lt; 0 means buy-and-hold would have
        beaten your trading over this period.
      </p>
    </Card>
  );
}

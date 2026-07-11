import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtUsd } from '../lib/format';
import type { BacktestEquityPoint } from '../api/types';

// Its own file (not just a function inside AutoTradePage.tsx) so it can be
// React.lazy-loaded — recharts (~92kB gzip) is only needed once a backtest
// has actually been run, not on every visit to the Auto-Trade page.
export default function BacktestEquityChart({
  equityCurve,
  gradientId,
}: {
  equityCurve: BacktestEquityPoint[];
  gradientId: string;
}) {
  if (equityCurve.length === 0) {
    return <p className="text-xs text-slate-500 py-6 text-center">No simulated trading days in this window.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={equityCurve} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--chart-grid)' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          domain={['auto', 'auto']}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--chart-tooltip-bg)',
            border: '1px solid var(--chart-grid)',
            borderRadius: 10,
            fontSize: 12,
            boxShadow: '0 12px 34px -12px rgb(0 0 0 / 0.45)',
          }}
          labelStyle={{ color: 'var(--txt-300)' }}
          formatter={(v) => [fmtUsd(Number(v)), 'Equity']}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#38bdf8"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

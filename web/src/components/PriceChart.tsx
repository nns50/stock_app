import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from 'recharts';
import type { Candle } from '../api/types';
import { fmtCompact, fmtNum, fmtDate } from '../lib/format';

interface Row {
  i: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  maShort: number | null;
  maLong: number | null;
}

const UP = '#22c55e';
const DOWN = '#ef4444';

/**
 * Candlestick layer. recharts 3 renders arbitrary children directly (no
 * `Customized`), and exposes the axis scales via hooks rather than passing
 * xAxisMap/yAxisMap, so we read them with useXAxisScale / useYAxisScale.
 */
function Candles({ rows }: { rows: Row[] }) {
  const xScaleFn = useXAxisScale();
  const yScaleFn = useYAxisScale('price');
  if (!xScaleFn || !yScaleFn || rows.length === 0) return null;
  // recharts 3 scales return `number | undefined`; coerce to a safe number.
  const xs = (v: number) => xScaleFn(v) ?? 0;
  const ys = (v: number) => yScaleFn(v) ?? 0;
  const step = rows.length > 1 ? Math.abs(xs(rows[1].i) - xs(rows[0].i)) : 8;
  const w = Math.max(1, Math.min(14, step * 0.62));

  return (
    <g>
      {rows.map((d) => {
        const xc = xs(d.i);
        const up = d.close >= d.open;
        const color = up ? UP : DOWN;
        const yO = ys(d.open);
        const yC = ys(d.close);
        const top = Math.min(yO, yC);
        const h = Math.max(1, Math.abs(yC - yO));
        return (
          <g key={d.i}>
            <line x1={xc} x2={xc} y1={ys(d.high)} y2={ys(d.low)} stroke={color} strokeWidth={1} />
            <rect x={xc - w / 2} y={top} width={w} height={h} fill={color} />
          </g>
        );
      })}
    </g>
  );
}

function CandleTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d: Row = payload[0].payload;
  return (
    <div className="card px-3 py-2 text-xs space-y-0.5 shadow-xl">
      <div className="text-slate-300 font-medium">{fmtDate(d.time)}</div>
      <div className="grid grid-cols-2 gap-x-4 tabular-nums">
        <span className="text-slate-500">O {fmtNum(d.open)}</span>
        <span className="text-slate-500">H {fmtNum(d.high)}</span>
        <span className="text-slate-500">L {fmtNum(d.low)}</span>
        <span className={d.close >= d.open ? 'text-bull' : 'text-bear'}>C {fmtNum(d.close)}</span>
      </div>
      {d.maShort !== null && <div className="text-accent">MA-s {fmtNum(d.maShort)}</div>}
      {d.maLong !== null && <div className="text-violet-400">MA-l {fmtNum(d.maLong)}</div>}
      <div className="text-slate-500">Vol {fmtCompact(d.volume)}</div>
    </div>
  );
}

export function PriceChart({
  candles,
  maShort,
  maLong,
  mode = 'candles',
  height = 380,
}: {
  candles: Candle[];
  maShort: (number | null)[];
  maLong: (number | null)[];
  mode?: 'candles' | 'line';
  height?: number;
}) {
  const rows: Row[] = useMemo(
    () =>
      candles.map((c, i) => ({
        i,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        maShort: maShort[i] ?? null,
        maLong: maLong[i] ?? null,
      })),
    [candles, maShort, maLong],
  );

  const priceDomain = useMemo(() => {
    if (!rows.length) return [0, 1] as [number, number];
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      lo = Math.min(lo, mode === 'candles' ? r.low : r.close);
      hi = Math.max(hi, mode === 'candles' ? r.high : r.close);
    }
    const pad = (hi - lo) * 0.06 || 1;
    return [Number((lo - pad).toFixed(2)), Number((hi + pad).toFixed(2))] as [number, number];
  }, [rows, mode]);

  const maxVol = useMemo(() => Math.max(1, ...rows.map((r) => r.volume)), [rows]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="i"
          type="number"
          domain={[0, Math.max(0, rows.length - 1)]}
          tick={false}
          axisLine={{ stroke: 'var(--chart-grid)' }}
          height={6}
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          domain={priceDomain}
          width={56}
          tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis yAxisId="vol" domain={[0, maxVol * 4.5]} hide />
        <Tooltip content={<CandleTooltip />} isAnimationActive={false} />
        <Bar yAxisId="vol" dataKey="volume" fill="var(--ink-500)" opacity={0.5} isAnimationActive={false} />
        {mode === 'candles' && <Candles rows={rows} />}
        {mode === 'line' && (
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="close"
            stroke="#38bdf8"
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        )}
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="maShort"
          stroke="#38bdf8"
          dot={false}
          strokeWidth={1}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="maLong"
          stroke="#a78bfa"
          dot={false}
          strokeWidth={1}
          isAnimationActive={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

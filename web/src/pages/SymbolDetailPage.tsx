import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { cx, fmtCompact, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { Card, ErrorState, Spinner, StatTile } from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { PriceChart } from '../components/PriceChart';

const TIMEFRAMES = ['daily', 'weekly', '15min', '5min', '1min'];

export default function SymbolDetailPage() {
  const { symbol = '' } = useParams();
  const [timeframe, setTimeframe] = useState('daily');
  const [maShort, setMaShort] = useState(20);
  const [maLong, setMaLong] = useState(50);
  const [mode, setMode] = useState<'candles' | 'line'>('candles');

  const detail = useAsync(
    () => client.symbolDetail(symbol, { timeframe, limit: 200, maShort, maLong }),
    [symbol, timeframe, maShort, maLong],
  );

  const ind = detail.data?.indicators;
  const quote = detail.data?.quote;
  const fundamentals = (detail.data?.fundamentals ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link to="/screener" className="text-slate-500 hover:text-slate-300 text-sm">
            ← Screener
          </Link>
          <h1 className="text-2xl font-semibold">{symbol.toUpperCase()}</h1>
          {quote && (
            <span className="text-lg tabular-nums">
              {fmtUsd(quote.last)}{' '}
              <span className={cx('text-sm', (quote.changePct ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                {fmtPct(quote.changePct)}
              </span>
            </span>
          )}
          {detail.data?.synthetic && <span className="chip bg-amber-500/15 text-amber-400">synthetic</span>}
        </div>
        <RefreshBar onRefresh={detail.reload} lastUpdated={quote?.timestamp ?? null} loading={detail.loading} />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <div className="flex rounded-md overflow-hidden border border-ink-600">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={cx(
                  'px-2.5 py-1',
                  timeframe === tf ? 'bg-ink-600 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
          <div className="flex rounded-md overflow-hidden border border-ink-600">
            <button
              className={cx('px-2.5 py-1', mode === 'candles' ? 'bg-ink-600 text-white' : 'text-slate-400')}
              onClick={() => setMode('candles')}
            >
              Candles
            </button>
            <button
              className={cx('px-2.5 py-1', mode === 'line' ? 'bg-ink-600 text-white' : 'text-slate-400')}
              onClick={() => setMode('line')}
            >
              Line
            </button>
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <span className="text-accent">MA</span>
            <input
              type="number"
              className="input !w-16 py-0.5"
              value={maShort}
              min={2}
              onChange={(e) => setMaShort(Number(e.target.value) || 20)}
            />
            <span className="text-violet-400">MA</span>
            <input
              type="number"
              className="input !w-16 py-0.5"
              value={maLong}
              min={2}
              onChange={(e) => setMaLong(Number(e.target.value) || 50)}
            />
          </label>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
            <span>
              <span className="inline-block w-3 h-0.5 bg-accent align-middle" /> MA{maShort}
            </span>
            <span>
              <span className="inline-block w-3 h-0.5 bg-violet-400 align-middle" /> MA{maLong}
            </span>
          </div>
        </div>

        {detail.loading && !detail.data ? (
          <Spinner label="Loading chart…" />
        ) : detail.error ? (
          <ErrorState error={detail.error} onRetry={detail.reload} />
        ) : detail.data && detail.data.candles.length > 0 ? (
          <PriceChart
            candles={detail.data.candles}
            maShort={detail.data.overlays.maShort}
            maLong={detail.data.overlays.maLong}
            mode={mode}
          />
        ) : (
          <div className="text-center text-slate-500 py-10">No candle data for this timeframe.</div>
        )}
      </Card>

      {ind && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile
            label="Change"
            value={fmtPct(ind.changePct)}
            valueClass={(ind.changePct ?? 0) >= 0 ? 'text-bull' : 'text-bear'}
          />
          <StatTile label="RSI" value={fmtNum(ind.rsi, 1)} />
          <StatTile
            label="ATR%"
            value={ind.atrPct === null ? '—' : `${fmtNum(ind.atrPct)}%`}
            sub={`ATR ${fmtNum(ind.atr)}`}
          />
          <StatTile label="Rel volume" value={ind.relVolume === null ? '—' : `${fmtNum(ind.relVolume)}×`} />
          <StatTile label={`Dist MA${maShort}`} value={fmtPct(ind.distShortPct)} />
          <StatTile label={`Dist MA${maLong}`} value={fmtPct(ind.distLongPct)} />
          <StatTile label="Gap" value={fmtPct(ind.gapPct)} />
          <StatTile label="Volume" value={fmtCompact(ind.volume)} sub={`avg ${fmtCompact(ind.avgVolume)}`} />
          <StatTile label={`MA${maShort}`} value={fmtNum(ind.maShort)} />
          <StatTile label={`MA${maLong}`} value={fmtNum(ind.maLong)} />
          {quote?.bid !== undefined && (
            <StatTile label="Bid / Ask" value={`${fmtNum(quote.bid)} / ${fmtNum(quote.ask)}`} />
          )}
          <StatTile label="Day range" value={quote ? `${fmtNum(quote.low)}–${fmtNum(quote.high)}` : '—'} />
        </div>
      )}

      {Object.keys(fundamentals).length > 0 && (
        <Card className="p-4">
          <h3 className="font-medium text-sm mb-2">Fundamentals</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-sm">
            {fundamentalRows(fundamentals).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-ink-700/50 py-1">
                <span className="text-slate-500">{k}</span>
                <span className="tabular-nums">{v}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

const LABELS: Record<string, string> = {
  name: 'Name',
  sector: 'Sector',
  industry: 'Industry',
  marketCap: 'Market cap',
  peRatio: 'P/E',
  eps: 'EPS',
  dividendYield: 'Div yield',
  beta: 'Beta',
  high52: '52w high',
  low52: '52w low',
  averageVolume: 'Avg volume',
};

function fundamentalRows(f: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, label] of Object.entries(LABELS)) {
    const v = f[key];
    if (v === undefined || v === null || v === '') continue;
    let display: string;
    if (key === 'marketCap' || key === 'averageVolume') display = fmtCompact(Number(v));
    else if (key === 'dividendYield') display = fmtPct(Number(v) * 100, 2, false);
    else if (typeof v === 'number') display = fmtNum(v);
    else display = String(v);
    out.push([label, display]);
  }
  return out;
}

import { useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { client } from '../api/client';
import { fmtNum, fmtSignedUsd, fmtUsd, pnlClass } from '../lib/format';
import { Card, CollapsibleCard, ErrorState, Field, NumberInput, StatTile } from './ui';
import { useNavigate } from 'react-router-dom';
import { isPlaceableStructure, strategyToOrder } from '../lib/tradePrefill';
import type { StrategyAnalysis, StrategyLeg } from '../api/types';

type TemplateName =
  'long-call' | 'long-put' | 'bull-call' | 'bear-put' | 'straddle' | 'strangle' | 'iron-condor' | 'custom';

const TEMPLATES: { value: TemplateName; label: string }[] = [
  { value: 'long-call', label: 'Long call' },
  { value: 'long-put', label: 'Long put' },
  { value: 'bull-call', label: 'Bull call spread' },
  { value: 'bear-put', label: 'Bear put spread' },
  { value: 'straddle', label: 'Long straddle' },
  { value: 'strangle', label: 'Long strangle' },
  { value: 'iron-condor', label: 'Iron condor' },
  { value: 'custom', label: 'Custom' },
];

function strikeStep(price: number): number {
  return price < 50 ? 2.5 : price < 200 ? 5 : 10;
}

function buildTemplate(name: TemplateName, price: number): StrategyLeg[] {
  const step = strikeStep(price);
  const atm = Math.round(price / step) * step;
  const prem = Math.max(0.25, Math.round(price * 0.015 * 100) / 100);
  const leg = (type: 'call' | 'put', action: 'buy' | 'sell', strike: number, premium: number): StrategyLeg => ({
    type,
    action,
    strike,
    quantity: 1,
    premium: Math.max(0.05, Math.round(premium * 100) / 100),
  });
  switch (name) {
    case 'long-call':
      return [leg('call', 'buy', atm, prem)];
    case 'long-put':
      return [leg('put', 'buy', atm, prem)];
    case 'bull-call':
      return [leg('call', 'buy', atm, prem), leg('call', 'sell', atm + step, prem * 0.5)];
    case 'bear-put':
      return [leg('put', 'buy', atm, prem), leg('put', 'sell', atm - step, prem * 0.5)];
    case 'straddle':
      return [leg('call', 'buy', atm, prem), leg('put', 'buy', atm, prem)];
    case 'strangle':
      return [leg('call', 'buy', atm + step, prem * 0.7), leg('put', 'buy', atm - step, prem * 0.7)];
    case 'iron-condor':
      return [
        leg('put', 'sell', atm - step, prem * 0.6),
        leg('put', 'buy', atm - 2 * step, prem * 0.3),
        leg('call', 'sell', atm + step, prem * 0.6),
        leg('call', 'buy', atm + 2 * step, prem * 0.3),
      ];
    case 'custom':
      return [leg('call', 'buy', atm, prem)];
  }
}

export function StrategyBuilder() {
  const [underlyingPrice, setUnderlyingPrice] = useState(100);
  const [dte, setDte] = useState(30);
  const [ivForPop, setIvForPop] = useState(30); // percent
  const [legs, setLegs] = useState<StrategyLeg[]>(() => buildTemplate('long-call', 100));
  const [result, setResult] = useState<StrategyAnalysis>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();

  const navigate = useNavigate();

  const applyTemplate = (name: TemplateName) => setLegs(buildTemplate(name, underlyingPrice));
  const updateLeg = (i: number, patch: Partial<StrategyLeg>) =>
    setLegs((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLeg = () =>
    setLegs((ls) => [...ls, { type: 'call', action: 'buy', strike: underlyingPrice, quantity: 1, premium: 1 }]);
  const removeLeg = (i: number) => setLegs((ls) => ls.filter((_, idx) => idx !== i));

  const analyze = async () => {
    if (!legs.length) return;
    setLoading(true);
    setError(undefined);
    try {
      setResult(await client.analyzeStrategy({ underlyingPrice, dte, ivForPop: ivForPop / 100, legs }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <Card className="p-4 lg:w-[420px] shrink-0 space-y-3">
        <div className="grid sm:grid-cols-3 gap-2">
          <Field label="Underlying $">
            <NumberInput value={underlyingPrice} onChange={(v) => setUnderlyingPrice(v ?? 0)} step={0.5} />
          </Field>
          <Field label="DTE">
            <NumberInput value={dte} onChange={(v) => setDte(v ?? 0)} />
          </Field>
          <Field label="IV % (for POP)">
            <NumberInput value={ivForPop} onChange={(v) => setIvForPop(v ?? 0)} />
          </Field>
        </div>

        <Field label="Template">
          <select
            className="input"
            onChange={(e) => applyTemplate(e.target.value as TemplateName)}
            defaultValue="long-call"
          >
            {TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="label !mb-0">Legs</span>
            <button className="text-xs text-accent" onClick={addLeg}>
              + Add leg
            </button>
          </div>
          <div className="space-y-1">
            {legs.map((l, i) => (
              <div key={i} className="grid grid-cols-[auto_auto_1fr_1fr_1fr_auto] gap-1 items-center">
                <select
                  className="input !px-1 text-xs"
                  value={l.action}
                  onChange={(e) => updateLeg(i, { action: e.target.value as 'buy' | 'sell' })}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
                <select
                  className="input !px-1 text-xs"
                  value={l.type}
                  onChange={(e) => updateLeg(i, { type: e.target.value as 'call' | 'put' })}
                >
                  <option value="call">Call</option>
                  <option value="put">Put</option>
                </select>
                <input
                  className="input !px-1 text-xs"
                  type="number"
                  value={l.strike}
                  onChange={(e) => updateLeg(i, { strike: Number(e.target.value) })}
                  title="strike"
                />
                <input
                  className="input !px-1 text-xs"
                  type="number"
                  value={l.quantity}
                  onChange={(e) => updateLeg(i, { quantity: Number(e.target.value) })}
                  title="qty"
                />
                <input
                  className="input !px-1 text-xs"
                  type="number"
                  step={0.01}
                  value={l.premium}
                  onChange={(e) => updateLeg(i, { premium: Number(e.target.value) })}
                  title="premium"
                />
                <button className="text-slate-500 hover:text-bear text-xs px-1" onClick={() => removeLeg(i)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Columns: action · type · strike · qty · premium (per share).
          </div>
        </div>

        <button className="btn-primary w-full" onClick={analyze} disabled={loading || !legs.length}>
          {loading ? 'Analyzing…' : 'Analyze strategy'}
        </button>
        <button
          className="btn-ghost w-full mt-2 disabled:opacity-40"
          disabled={!isPlaceableStructure(legs)}
          title={
            isPlaceableStructure(legs)
              ? 'Prefill the Trade builder with this structure (you set the symbol + expiry)'
              : 'Live placement supports a single leg or a 2-leg vertical (more coming)'
          }
          onClick={() => navigate('/trade', { state: { prefill: strategyToOrder(legs) } })}
        >
          Trade this structure →
        </button>
      </Card>

      <div className="flex-1 min-w-0">
        {error && (
          <Card>
            <ErrorState error={error} onRetry={analyze} />
          </Card>
        )}
        {!result && !error && (
          <Card className="p-8 text-center text-slate-500 text-sm">
            Build a strategy (pick a template, set strikes &amp; premiums) and hit Analyze to see the payoff diagram,
            max profit/loss, breakevens, probability of profit, and combined Greeks.
          </Card>
        )}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <StatTile
                label={result.netPremium < 0 ? 'Net debit' : 'Net credit'}
                value={fmtUsd(Math.abs(result.netPremium))}
                valueClass={result.netPremium < 0 ? 'text-bear' : 'text-bull'}
              />
              <StatTile
                label="Max profit"
                value={result.maxProfit === null ? 'Unlimited' : fmtSignedUsd(result.maxProfit)}
                valueClass="text-bull"
              />
              <StatTile
                label="Max loss"
                value={result.maxLoss === null ? 'Unlimited' : fmtSignedUsd(result.maxLoss)}
                valueClass="text-bear"
              />
              <StatTile
                label="Prob. of profit"
                value={result.probabilityOfProfit === null ? '—' : `${(result.probabilityOfProfit * 100).toFixed(0)}%`}
                sub="lognormal est."
              />
              <StatTile
                label="Expected value"
                value={result.expectedValue === null ? '—' : fmtSignedUsd(result.expectedValue)}
                valueClass={pnlClass(result.expectedValue ?? 0)}
                sub="lognormal est."
              />
            </div>

            <CollapsibleCard
              id="strategyBuilder.payoff"
              title="Payoff at expiration"
              action={
                <span className="text-xs text-slate-400">
                  Breakevens:{' '}
                  {result.breakevens.length ? result.breakevens.map((b) => `$${fmtNum(b)}`).join(', ') : '—'}
                </span>
              }
            >
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={result.payoff} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="price"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    tickFormatter={(v: number) => `$${Math.round(v)}`}
                    axisLine={{ stroke: 'var(--chart-grid)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    tickFormatter={(v: number) => `$${v}`}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--chart-tooltip-bg)',
                      border: '1px solid var(--chart-grid)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(l) => `Underlying $${fmtNum(Number(l))}`}
                    formatter={(v) => [fmtSignedUsd(Number(v)), 'P&L']}
                  />
                  <Area
                    type="monotone"
                    dataKey="pnl"
                    stroke="#38bdf8"
                    fill="#38bdf8"
                    fillOpacity={0.12}
                    isAnimationActive={false}
                  />
                  <ReferenceLine y={0} stroke="#64748b" />
                  <ReferenceLine x={underlyingPrice} stroke="#38bdf8" strokeDasharray="4 4" />
                  {result.breakevens.map((b, i) => (
                    <ReferenceLine key={i} x={b} stroke="#22c55e" strokeDasharray="2 2" />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </CollapsibleCard>

            <CollapsibleCard id="strategyBuilder.greeks" title="Combined Greeks (per the position)">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm tabular-nums">
                <div>
                  <span className="text-slate-500">Δ </span>
                  <span className={pnlClass(result.greeks.delta)}>{fmtNum(result.greeks.delta, 3)}</span>
                </div>
                <div>
                  <span className="text-slate-500">Γ </span>
                  {fmtNum(result.greeks.gamma, 4)}
                </div>
                <div>
                  <span className="text-slate-500">Θ </span>
                  <span className={pnlClass(result.greeks.theta)}>{fmtNum(result.greeks.theta, 3)}</span>
                </div>
                <div>
                  <span className="text-slate-500">ν </span>
                  {fmtNum(result.greeks.vega, 3)}
                </div>
              </div>
            </CollapsibleCard>
          </div>
        )}
      </div>
    </div>
  );
}

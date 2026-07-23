import { useState } from 'react';
import { client } from '../api/client';
import { fmtNum, fmtSignedUsd, fmtUsd, pnlClass } from '../lib/format';
import { Card, ErrorState, Field, NumberInput, StatTile } from './ui';
import type { RollAnalysis, RollLegInput } from '../api/types';

type Side = 'long' | 'short';
type OptionType = 'call' | 'put';

function LegFields({
  title,
  leg,
  onChange,
}: {
  title: string;
  leg: RollLegInput;
  onChange: (patch: Partial<RollLegInput>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-slate-300">{title}</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Type">
          <select
            className="input"
            value={leg.optionType}
            onChange={(e) => onChange({ optionType: e.target.value as OptionType })}
          >
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </Field>
        <Field label="Strike">
          <NumberInput value={leg.strike} onChange={(v) => onChange({ strike: v ?? 0 })} step={0.5} />
        </Field>
        <Field label="DTE">
          <NumberInput value={leg.dte} onChange={(v) => onChange({ dte: v ?? 0 })} />
        </Field>
        <Field label="Premium">
          <NumberInput value={leg.premium} onChange={(v) => onChange({ premium: v ?? 0 })} step={0.05} />
        </Field>
        <Field label="IV % (optional)">
          <NumberInput
            value={leg.iv === undefined ? undefined : leg.iv * 100}
            onChange={(v) => onChange({ iv: v === undefined ? undefined : v / 100 })}
          />
        </Field>
      </div>
    </div>
  );
}

function LegOutlookTiles({ title, outlook }: { title: string; outlook: RollAnalysis['current'] }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-slate-300">{title}</div>
      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label="Breakeven"
          value={outlook.breakevens.length ? outlook.breakevens.map((b) => `$${fmtNum(b)}`).join(', ') : '—'}
        />
        <StatTile
          label="Max profit"
          value={outlook.maxProfit === null ? 'Unlimited' : fmtSignedUsd(outlook.maxProfit)}
          valueClass="text-bull"
        />
        <StatTile
          label="Max loss"
          value={outlook.maxLoss === null ? 'Unlimited' : fmtSignedUsd(outlook.maxLoss)}
          valueClass="text-bear"
        />
        <StatTile
          label="Prob. of profit"
          value={outlook.probabilityOfProfit === null ? '—' : `${(outlook.probabilityOfProfit * 100).toFixed(0)}%`}
        />
      </div>
      <StatTile
        label="Expected value"
        value={outlook.expectedValue === null ? '—' : fmtSignedUsd(outlook.expectedValue)}
        valueClass={pnlClass(outlook.expectedValue ?? 0)}
        sub="lognormal est."
      />
    </div>
  );
}

/**
 * "Should I roll this option, and to what?" — compares the position you hold
 * today against a candidate replacement (same side and quantity; a roll keeps
 * your directional bet, it doesn't flip it). Reuses the same lognormal
 * breakeven/POP/expected-value model as the Strategy Builder above, just
 * applied to each leg standalone and diffed. Decision-support only — it never
 * places the roll.
 */
export function RollAnalyzer() {
  const [side, setSide] = useState<Side>('long');
  const [quantity, setQuantity] = useState(1);
  const [underlyingPrice, setUnderlyingPrice] = useState(100);
  const [current, setCurrent] = useState<RollLegInput>({ optionType: 'call', strike: 100, dte: 10, premium: 3 });
  const [target, setTarget] = useState<RollLegInput>({ optionType: 'call', strike: 105, dte: 40, premium: 4 });
  const [result, setResult] = useState<RollAnalysis>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();

  const analyze = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await client.analyzeRoll({ side, quantity, underlyingPrice, current, target }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <Card className="p-4 lg:w-[420px] shrink-0 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Side">
            <select className="input" value={side} onChange={(e) => setSide(e.target.value as Side)}>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </Field>
          <Field label="Quantity">
            <NumberInput value={quantity} onChange={(v) => setQuantity(v ?? 1)} />
          </Field>
          <Field label="Underlying $">
            <NumberInput value={underlyingPrice} onChange={(v) => setUnderlyingPrice(v ?? 0)} step={0.5} />
          </Field>
        </div>

        <LegFields
          title="Current position"
          leg={current}
          onChange={(patch) => setCurrent((l) => ({ ...l, ...patch }))}
        />
        <LegFields title="Roll to" leg={target} onChange={(patch) => setTarget((l) => ({ ...l, ...patch }))} />

        <button className="btn-primary w-full" onClick={analyze} disabled={loading}>
          {loading ? 'Analyzing…' : 'Analyze roll'}
        </button>
      </Card>

      <div className="flex-1 min-w-0 space-y-3">
        {error && (
          <Card>
            <ErrorState error={error} onRetry={analyze} />
          </Card>
        )}
        {!result && !error && (
          <Card className="p-8 text-center text-slate-500 text-sm">
            Fill in the position you hold and the contract you'd roll to, then hit Analyze to see the net cost to roll
            and how breakeven, probability of profit, and expected value shift.
          </Card>
        )}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatTile
                label={result.netCost < 0 ? 'Net debit to roll' : 'Net credit to roll'}
                value={fmtUsd(Math.abs(result.netCost))}
                valueClass={result.netCost < 0 ? 'text-bear' : 'text-bull'}
              />
              <StatTile
                label="Breakeven shift"
                value={result.breakevenShift === null ? '—' : fmtSignedUsd(result.breakevenShift)}
                sub="whether higher or lower is favorable depends on the type/side — see prob. of profit and EV shift"
              />
              <StatTile
                label="Prob. of profit shift"
                value={
                  result.probabilityOfProfitShift === null
                    ? '—'
                    : `${result.probabilityOfProfitShift >= 0 ? '+' : ''}${(result.probabilityOfProfitShift * 100).toFixed(0)}pp`
                }
                valueClass={result.probabilityOfProfitShift === null ? '' : pnlClass(result.probabilityOfProfitShift)}
              />
              <StatTile
                label="Expected value shift"
                value={result.expectedValueShift === null ? '—' : fmtSignedUsd(result.expectedValueShift)}
                valueClass={result.expectedValueShift === null ? '' : pnlClass(result.expectedValueShift)}
              />
            </div>

            <Card className="p-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <LegOutlookTiles title="Current position" outlook={result.current} />
                <LegOutlookTiles title="After the roll" outlook={result.target} />
              </div>
            </Card>

            <p className="text-[11px] text-slate-500">
              Breakeven, probability of profit, and expected value are the same lognormal model the Strategy Builder
              uses, applied to each leg standalone — an approximation, not a prediction. Decision-support only; this
              never places the roll.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

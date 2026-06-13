import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { cx, fmtNum, fmtPct } from '../lib/format';
import { Field, Modal, NumberInput, StatTile } from './ui';
import type { RuinResult } from '../api/types';

/**
 * Monte-Carlo "will my sizing survive?" tool. Inputs default from your realized
 * edge; it simulates many trade sequences at a fixed risk-% and reports how
 * often you'd breach a drawdown threshold. Survival math — not a prediction.
 */
export function RiskOfRuinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [winRate, setWinRate] = useState<number | undefined>(50);
  const [payoffRatio, setPayoffRatio] = useState<number | undefined>(1.5);
  const [riskPct, setRiskPct] = useState<number | undefined>(1);
  const [ruinThresholdPct, setRuinThresholdPct] = useState<number | undefined>(50);
  const [trades, setTrades] = useState<number | undefined>(100);
  const [result, setResult] = useState<RuinResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!open || seeded) return;
    setSeeded(true);
    client
      .journalStats()
      .then((s) => {
        if (s.winRate) setWinRate(s.winRate);
        if (s.kelly) {
          setPayoffRatio(s.kelly.payoffRatio);
          if (s.kelly.suggestedRiskPct > 0) setRiskPct(s.kelly.suggestedRiskPct);
        }
      })
      .catch(() => {});
  }, [open, seeded]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.riskOfRuin({ winRate, payoffRatio, riskPct, ruinThresholdPct, trades });
      setResult(r.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ror = result?.riskOfRuinPct ?? 0;
  const rorClass = ror >= 25 ? 'text-bear' : ror >= 5 ? 'text-amber-400' : 'text-bull';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Risk-of-ruin simulator"
      wide
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" onClick={run} disabled={busy}>
            {busy ? 'Simulating…' : 'Simulate'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Defaults come from your realized stats. Simulates {fmtNum(5000, 0)} sequences of fixed-fractional bets and
          reports how often equity falls past the drawdown threshold. Assumes the edge holds and trades are independent.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Win rate %">
            <NumberInput value={winRate} onChange={setWinRate} step={1} />
          </Field>
          <Field label="Payoff ratio" hint="avg win ÷ avg loss">
            <NumberInput value={payoffRatio} onChange={setPayoffRatio} step={0.1} />
          </Field>
          <Field label="Risk % / trade">
            <NumberInput value={riskPct} onChange={setRiskPct} step={0.1} />
          </Field>
          <Field label="Ruin = drawdown %">
            <NumberInput value={ruinThresholdPct} onChange={setRuinThresholdPct} step={5} />
          </Field>
          <Field label="Trades">
            <NumberInput value={trades} onChange={setTrades} step={10} />
          </Field>
        </div>

        {error && <div className="text-bear text-sm">{error}</div>}

        {result && (
          <div className="space-y-3">
            <div className="text-center py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                Risk of losing {fmtNum(ruinThresholdPct ?? 50, 0)}% of the account
              </div>
              <div className={cx('text-3xl font-semibold tabular-nums', rorClass)}>{fmtNum(ror, 1)}%</div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <StatTile label={`Median return (${trades} trades)`} value={fmtPct(result.medianReturnPct)} />
              <StatTile
                label="Outcome band (P5–P95)"
                value={`${fmtPct(result.p5ReturnPct)} … ${fmtPct(result.p95ReturnPct)}`}
              />
              <StatTile label="Median max drawdown" value={`${fmtNum(result.medianMaxDrawdownPct, 0)}%`} />
            </div>
            <p className="text-[11px] text-slate-500">
              Rule of thumb: keep risk-of-ruin near zero. If it’s high, cut your risk-% or improve the edge before
              sizing up.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

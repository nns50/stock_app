import { useState } from 'react';
import { client } from '../api/client';
import { useLocalStorage } from '../lib/hooks';
import { fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { Field, Modal, NumberInput, StatTile } from './ui';
import type { RiskSizingResult, SpreadSizingResult } from '../api/types';

type AssetMode = 'stock' | 'option' | 'spread';

export function RiskSizingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Account size + risk% persist locally (per browser) for convenience.
  const [accountSize, setAccountSize] = useLocalStorage<number>('risk.accountSize', 25000);
  const [riskPct, setRiskPct] = useLocalStorage<number>('risk.riskPct', 1);
  const [assetType, setAssetType] = useState<AssetMode>('stock');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [entryPrice, setEntryPrice] = useState<number | undefined>();
  const [stopPrice, setStopPrice] = useState<number | undefined>();
  const [targetR, setTargetR] = useState<number | undefined>(2);
  // Defined-risk spread inputs.
  const [width, setWidth] = useState<number | undefined>();
  const [netPremium, setNetPremium] = useState<number | undefined>();
  const [direction, setDirection] = useState<'debit' | 'credit'>('debit');
  const [result, setResult] = useState<RiskSizingResult>();
  const [spreadResult, setSpreadResult] = useState<SpreadSizingResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const isSpread = assetType === 'spread';

  // The modal stays mounted (hidden via Modal `open`), so without this it
  // reopens still showing the sizing from the last time it was used — numbers
  // computed for a different trade, presented as if they were for this one.
  // Mirrors the re-sync-on-key-change pattern the position modals use.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setResult(undefined);
      setSpreadResult(undefined);
      setError(undefined);
    }
  }

  const calc = async () => {
    setError(undefined);
    if (!accountSize || !riskPct) {
      setError('Fill in account size and risk %.');
      return;
    }
    if (isSpread) {
      if (width === undefined || netPremium === undefined) {
        setError('Fill in the spread width and net premium.');
        return;
      }
    } else if (entryPrice === undefined || stopPrice === undefined) {
      setError('Fill in account size, risk %, entry and stop.');
      return;
    }
    setBusy(true);
    try {
      if (isSpread) {
        setResult(undefined);
        setSpreadResult(
          await client.spreadSize({ accountSize, riskPct, width: width!, netPremium: netPremium!, direction }),
        );
      } else {
        setSpreadResult(undefined);
        setResult(
          await client.positionSize({
            accountSize,
            riskPct,
            entryPrice: entryPrice!,
            stopPrice: stopPrice!,
            assetType,
            side,
            targetRMultiple: targetR,
          }),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Position-size calculator"
      wide
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" onClick={calc} disabled={busy}>
            Calculate
          </button>
        </>
      }
    >
      <div className="grid md:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Account size $">
              <NumberInput value={accountSize} onChange={(v) => setAccountSize(v ?? 0)} />
            </Field>
            <Field label="Risk per trade %">
              <NumberInput value={riskPct} onChange={(v) => setRiskPct(v ?? 0)} step={0.1} />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Asset">
              <select className="input" value={assetType} onChange={(e) => setAssetType(e.target.value as AssetMode)}>
                <option value="stock">Stock</option>
                <option value="option">Option</option>
                <option value="spread">Vertical spread</option>
              </select>
            </Field>
            {isSpread ? (
              <Field label="Direction">
                <select
                  className="input"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as 'debit' | 'credit')}
                >
                  <option value="debit">Debit (you pay)</option>
                  <option value="credit">Credit (you receive)</option>
                </select>
              </Field>
            ) : (
              <Field label="Side">
                <select className="input" value={side} onChange={(e) => setSide(e.target.value as 'long' | 'short')}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </Field>
            )}
          </div>
          {isSpread ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Width (strike gap)">
                <NumberInput value={width} onChange={setWidth} step={0.5} min={0} />
              </Field>
              <Field label={direction === 'credit' ? 'Net credit' : 'Net debit'}>
                <NumberInput value={netPremium} onChange={setNetPremium} step={0.01} min={0} />
              </Field>
            </div>
          ) : (
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label={assetType === 'option' ? 'Entry (premium)' : 'Entry'}>
                <NumberInput value={entryPrice} onChange={setEntryPrice} step={0.01} />
              </Field>
              <Field label="Stop">
                <NumberInput value={stopPrice} onChange={setStopPrice} step={0.01} />
              </Field>
              <Field label="Target (R)">
                <NumberInput value={targetR} onChange={setTargetR} step={0.5} />
              </Field>
            </div>
          )}
          {error && <div className="text-bear text-sm">{error}</div>}
          <p className="text-[11px] text-slate-500">
            {isSpread
              ? 'Sizes a defined-risk vertical by its capped max loss (debit paid, or width − credit) × 100 × contracts.'
              : 'Sizes the position so a full stop-out loses ≈ your risk budget.'}{' '}
            {assetType === 'option' && '100× contract multiplier applied.'} Decision-support only.
          </p>
        </div>

        <div>
          {isSpread && spreadResult ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Suggested"
                  value={spreadResult.suggestedContracts}
                  sub="spreads"
                  valueClass="text-accent"
                />
                <StatTile
                  label="Risk budget"
                  value={fmtUsd(spreadResult.maxRiskDollars)}
                  sub={`max loss ${fmtUsd(spreadResult.totalMaxLoss)}`}
                />
                <StatTile
                  label="Max loss"
                  value={fmtUsd(spreadResult.totalMaxLoss)}
                  sub={`${fmtPct(spreadResult.positionPctOfAccount, 1, false)} of account`}
                  valueClass="text-bear"
                />
                <StatTile
                  label="Max profit"
                  value={fmtSignedUsd(spreadResult.totalMaxProfit)}
                  sub={`per spread ${fmtUsd(spreadResult.maxProfitPerSpread)}`}
                  valueClass="text-bull"
                />
                {spreadResult.rewardRiskRatio !== null && (
                  <StatTile label="Reward : risk" value={`${fmtNum(spreadResult.rewardRiskRatio)} : 1`} />
                )}
                <StatTile label="Max loss / spread" value={fmtUsd(spreadResult.maxLossPerSpread)} />
              </div>
              {spreadResult.warnings.length > 0 && (
                <ul className="text-xs text-amber-400 space-y-1">
                  {spreadResult.warnings.map((w) => (
                    <li key={w}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : !isSpread && result ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Suggested qty"
                  value={result.suggestedQuantity}
                  sub={assetType === 'option' ? 'contracts' : 'shares'}
                  valueClass="text-accent"
                />
                <StatTile
                  label="Risk budget"
                  value={fmtUsd(result.maxRiskDollars)}
                  sub={`actual ${fmtUsd(result.riskOfPosition)}`}
                />
                <StatTile
                  label="Position cost"
                  value={fmtUsd(result.positionCost)}
                  sub={`${fmtPct(result.positionPctOfAccount, 1, false)} of account`}
                />
                <StatTile
                  label="Risk / unit"
                  value={fmtUsd(result.riskPerUnit)}
                  sub={`stop ${fmtNum(result.stopDistance)}`}
                />
                {result.targetPrice !== null && (
                  <StatTile label={`Target (${result.rewardRiskRatio}R)`} value={fmtNum(result.targetPrice)} />
                )}
                {result.targetProfit !== null && (
                  <StatTile label="Target profit" value={fmtSignedUsd(result.targetProfit)} valueClass="text-bull" />
                )}
              </div>
              {result.warnings.length > 0 && (
                <ul className="text-xs text-amber-400 space-y-1">
                  {result.warnings.map((w) => (
                    <li key={w}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm text-center px-4">
              Enter your trade parameters and hit Calculate to size the position.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

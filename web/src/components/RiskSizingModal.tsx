import { useState } from 'react';
import { client } from '../api/client';
import { useLocalStorage } from '../lib/hooks';
import { fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { Field, Modal, NumberInput, StatTile } from './ui';
import type { RiskSizingResult } from '../api/types';

export function RiskSizingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Account size + risk% persist locally (per browser) for convenience.
  const [accountSize, setAccountSize] = useLocalStorage<number>('risk.accountSize', 25000);
  const [riskPct, setRiskPct] = useLocalStorage<number>('risk.riskPct', 1);
  const [assetType, setAssetType] = useState<'stock' | 'option'>('stock');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [entryPrice, setEntryPrice] = useState<number | undefined>();
  const [stopPrice, setStopPrice] = useState<number | undefined>();
  const [targetR, setTargetR] = useState<number | undefined>(2);
  const [result, setResult] = useState<RiskSizingResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const calc = async () => {
    if (!accountSize || !riskPct || entryPrice === undefined || stopPrice === undefined) {
      setError('Fill in account size, risk %, entry and stop.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setResult(await client.positionSize({ accountSize, riskPct, entryPrice, stopPrice, assetType, side, targetRMultiple: targetR }));
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
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={calc} disabled={busy}>Calculate</button>
        </>
      }
    >
      <div className="grid md:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account size $"><NumberInput value={accountSize} onChange={(v) => setAccountSize(v ?? 0)} /></Field>
            <Field label="Risk per trade %"><NumberInput value={riskPct} onChange={(v) => setRiskPct(v ?? 0)} step={0.1} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Asset">
              <select className="input" value={assetType} onChange={(e) => setAssetType(e.target.value as 'stock' | 'option')}>
                <option value="stock">Stock</option>
                <option value="option">Option</option>
              </select>
            </Field>
            <Field label="Side">
              <select className="input" value={side} onChange={(e) => setSide(e.target.value as 'long' | 'short')}>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label={assetType === 'option' ? 'Entry (premium)' : 'Entry'}><NumberInput value={entryPrice} onChange={setEntryPrice} step={0.01} /></Field>
            <Field label="Stop"><NumberInput value={stopPrice} onChange={setStopPrice} step={0.01} /></Field>
            <Field label="Target (R)"><NumberInput value={targetR} onChange={setTargetR} step={0.5} /></Field>
          </div>
          {error && <div className="text-bear text-sm">{error}</div>}
          <p className="text-[11px] text-slate-500">
            Sizes the position so a full stop-out loses ≈ your risk budget. {assetType === 'option' && '100× contract multiplier applied.'} Decision-support only.
          </p>
        </div>

        <div>
          {result ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <StatTile label="Suggested qty" value={result.suggestedQuantity} sub={assetType === 'option' ? 'contracts' : 'shares'} valueClass="text-accent" />
                <StatTile label="Risk budget" value={fmtUsd(result.maxRiskDollars)} sub={`actual ${fmtUsd(result.riskOfPosition)}`} />
                <StatTile label="Position cost" value={fmtUsd(result.positionCost)} sub={`${fmtPct(result.positionPctOfAccount, 1, false)} of account`} />
                <StatTile label="Risk / unit" value={fmtUsd(result.riskPerUnit)} sub={`stop ${fmtNum(result.stopDistance)}`} />
                {result.targetPrice !== null && <StatTile label={`Target (${result.rewardRiskRatio}R)`} value={fmtNum(result.targetPrice)} />}
                {result.targetProfit !== null && <StatTile label="Target profit" value={fmtSignedUsd(result.targetProfit)} valueClass="text-bull" />}
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

import { useState } from 'react';
import { client } from '../api/client';
import { todayISO } from '../lib/format';
import { Field, Modal, NumberInput } from './ui';
import type { Position } from '../api/types';

const GRADES = ['', 'A', 'B', 'C', 'D', 'F'];

export function LogTradeModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [assetType, setAssetType] = useState<'stock' | 'option'>('stock');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [quantity, setQuantity] = useState<number | undefined>(100);
  const [entryPrice, setEntryPrice] = useState<number | undefined>();
  const [entryDate, setEntryDate] = useState(todayISO());
  const [fees, setFees] = useState<number | undefined>(0);
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [strike, setStrike] = useState<number | undefined>();
  const [expiration, setExpiration] = useState('');
  const [tags, setTags] = useState('');
  const [grade, setGrade] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setSymbol('');
    setEntryPrice(undefined);
    setStrike(undefined);
    setExpiration('');
    setTags('');
    setGrade('');
    setNotes('');
    setError(undefined);
  };

  const submit = async () => {
    setError(undefined);
    if (!symbol.trim() || !quantity || entryPrice === undefined)
      return setError('Symbol, quantity and entry price are required.');
    if (assetType === 'option' && (!strike || !expiration)) return setError('Options need strike and expiration.');
    setBusy(true);
    try {
      await client.createPosition({
        assetType,
        symbol: symbol.trim().toUpperCase(),
        side,
        quantity,
        entryPrice,
        entryDate,
        fees: fees ?? 0,
        ...(assetType === 'option' ? { optionType, strike, expiration } : {}),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        grade: grade || null,
        notes: notes || null,
      });
      reset();
      onSaved();
      onClose();
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
      title="Log trade"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex rounded-md overflow-hidden border border-ink-600 text-sm">
          {(['stock', 'option'] as const).map((t) => (
            <button
              key={t}
              className={`flex-1 px-3 py-1.5 ${assetType === t ? 'bg-ink-600 text-white' : 'text-slate-400'}`}
              onClick={() => setAssetType(t)}
            >
              {t === 'stock' ? 'Stock' : 'Option'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol">
            <input
              className="input"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
            />
          </Field>
          <Field label="Side">
            <select className="input" value={side} onChange={(e) => setSide(e.target.value as 'long' | 'short')}>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </Field>
          <Field label={assetType === 'option' ? 'Contracts' : 'Shares'}>
            <NumberInput value={quantity} onChange={setQuantity} min={0} />
          </Field>
          <Field label={assetType === 'option' ? 'Entry premium (/sh)' : 'Entry price'}>
            <NumberInput value={entryPrice} onChange={setEntryPrice} step={0.01} />
          </Field>
          <Field label="Entry date">
            <input type="date" className="input" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <Field label="Fees">
            <NumberInput value={fees} onChange={setFees} step={0.01} />
          </Field>
        </div>
        {assetType === 'option' && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Type">
              <select
                className="input"
                value={optionType}
                onChange={(e) => setOptionType(e.target.value as 'call' | 'put')}
              >
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </Field>
            <Field label="Strike">
              <NumberInput value={strike} onChange={setStrike} step={0.5} />
            </Field>
            <Field label="Expiration">
              <input type="date" className="input" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tags (comma-sep)">
            <input
              className="input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="breakout, earnings"
            />
          </Field>
          <Field label="Grade">
            <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g || '—'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="input h-16" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <div className="text-bear text-sm">{error}</div>}
      </div>
    </Modal>
  );
}

export function ExitModal({
  position,
  onClose,
  onSaved,
}: {
  position: Position | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [quantity, setQuantity] = useState<number | undefined>(position?.remainingQuantity);
  const [exitPrice, setExitPrice] = useState<number | undefined>();
  const [exitDate, setExitDate] = useState(todayISO());
  const [fees, setFees] = useState<number | undefined>(0);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!position) return;
    if (!quantity || exitPrice === undefined) return setError('Quantity and exit price are required.');
    setBusy(true);
    setError(undefined);
    try {
      await client.addExit(position.id, { quantity, exitPrice, exitDate, fees: fees ?? 0, notes: notes || null });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!position}
      onClose={onClose}
      title={position ? `Exit ${position.symbol}` : 'Exit'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            Record exit
          </button>
        </>
      }
    >
      {position && (
        <div className="space-y-3">
          <div className="text-sm text-slate-400">
            Remaining open: <span className="text-slate-200">{position.remainingQuantity}</span>{' '}
            {position.assetType === 'option' ? 'contracts' : 'shares'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity">
              <NumberInput value={quantity} onChange={setQuantity} min={0} max={position.remainingQuantity} />
            </Field>
            <Field label={position.assetType === 'option' ? 'Exit premium (/sh)' : 'Exit price'}>
              <NumberInput value={exitPrice} onChange={setExitPrice} step={0.01} />
            </Field>
            <Field label="Exit date">
              <input type="date" className="input" value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
            </Field>
            <Field label="Fees">
              <NumberInput value={fees} onChange={setFees} step={0.01} />
            </Field>
          </div>
          <Field label="Notes">
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {error && <div className="text-bear text-sm">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

export function JournalEditModal({
  position,
  onClose,
  onSaved,
}: {
  position: Position | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tags, setTags] = useState((position?.tags ?? []).join(', '));
  const [grade, setGrade] = useState(position?.grade ?? '');
  const [notes, setNotes] = useState(position?.notes ?? '');
  const [busy, setBusy] = useState(false);

  // Re-sync when a different position is opened.
  const key = position?.id;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setTags((position?.tags ?? []).join(', '));
    setGrade(position?.grade ?? '');
    setNotes(position?.notes ?? '');
  }

  const submit = async () => {
    if (!position) return;
    setBusy(true);
    try {
      await client.updatePosition(position.id, {
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        grade: grade || null,
        notes: notes || null,
      });
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!position}
      onClose={onClose}
      title={position ? `Journal · ${position.symbol}` : 'Journal'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Tags (comma-sep)">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Grade">
          <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g || '—'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes">
          <textarea className="input h-24" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

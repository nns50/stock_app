import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { fmtNum, fmtUsd, todayISO } from '../lib/format';
import { useLocalStorage } from '../lib/hooks';
import { CHECKLIST_SETTING_KEY, DEFAULT_CHECKLIST_RULES, rulesFromSetting } from '../lib/checklist';
import { Field, Modal, NumberInput, Segmented } from './ui';
import { useToast } from './ToastContext';
import type { Position, RiskSizingResult } from '../api/types';

const GRADES = ['', 'A', 'B', 'C', 'D', 'F'];

export function LogTradeModal({
  open,
  onClose,
  onSaved,
  initialSymbol,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialSymbol?: string;
}) {
  const [assetType, setAssetType] = useState<'stock' | 'option'>('stock');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [quantity, setQuantity] = useState<number | undefined>(100);
  const [entryPrice, setEntryPrice] = useState<number | undefined>();
  const [entryDate, setEntryDate] = useState(todayISO());
  const [entryTime, setEntryTime] = useState('');
  const [fees, setFees] = useState<number | undefined>(0);
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [strike, setStrike] = useState<number | undefined>();
  const [expiration, setExpiration] = useState('');
  const [tags, setTags] = useState('');
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [grade, setGrade] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // Pre-trade discipline checklist: an editable rule list (persisted in settings)
  // the user ticks before logging an entry; the result is saved with the trade.
  const [rules, setRules] = useState<string[]>(DEFAULT_CHECKLIST_RULES);
  const [checked, setChecked] = useState<boolean[]>(() => DEFAULT_CHECKLIST_RULES.map(() => false));
  const [editingRules, setEditingRules] = useState(false);
  const [rulesDraft, setRulesDraft] = useState('');
  const checkedCount = checked.filter(Boolean).length;

  // Load the (possibly customized) rule list whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    const apply = (r: string[]) => {
      if (!active) return;
      setRules(r);
      setChecked(r.map(() => false));
    };
    client
      .settings()
      .then((s) => apply(rulesFromSetting(s[CHECKLIST_SETTING_KEY])))
      .catch(() => apply(DEFAULT_CHECKLIST_RULES));
    client
      .journalTags()
      .then((r) => active && setKnownTags(r.tags))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);

  // Prefill the symbol when opened from a setup row / chart ("log this one").
  useEffect(() => {
    if (open && initialSymbol) setSymbol(initialSymbol.toUpperCase());
  }, [open, initialSymbol]);

  // Risk-based position sizing, folded into the entry flow. Account size + risk%
  // persist per-browser (shared with the standalone Risk sizing tool).
  const [showSizer, setShowSizer] = useState(false);
  // Suggested risk-% from realized edge (undefined = not fetched, null = none).
  const [kellyPct, setKellyPct] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!showSizer || kellyPct !== undefined) return;
    let active = true;
    client
      .journalStats()
      .then((s) => active && setKellyPct(s.kelly?.suggestedRiskPct ?? null))
      .catch(() => active && setKellyPct(null));
    return () => {
      active = false;
    };
  }, [showSizer, kellyPct]);
  const [accountSize, setAccountSize] = useLocalStorage<number>('risk.accountSize', 25000);
  const [riskPct, setRiskPct] = useLocalStorage<number>('risk.riskPct', 1);
  // Planned stop (also drives the risk sizer) and target — saved with the trade
  // and watched by the proactive exit alerts.
  const [stopPrice, setStopPrice] = useState<number | undefined>();
  const [targetPrice, setTargetPrice] = useState<number | undefined>();
  const [sizing, setSizing] = useState<RiskSizingResult>();
  const [sizingErr, setSizingErr] = useState<string>();
  const [sizingBusy, setSizingBusy] = useState(false);

  const calcSize = async () => {
    setSizingErr(undefined);
    setSizing(undefined);
    if (!accountSize || !riskPct || entryPrice === undefined || stopPrice === undefined) {
      setSizingErr('Need account size, risk %, entry price and a stop.');
      return;
    }
    setSizingBusy(true);
    try {
      setSizing(await client.positionSize({ accountSize, riskPct, entryPrice, stopPrice, side, assetType }));
    } catch (e) {
      setSizingErr((e as Error).message);
    } finally {
      setSizingBusy(false);
    }
  };

  const saveRules = async () => {
    const next = rulesDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const finalRules = next.length ? next : DEFAULT_CHECKLIST_RULES;
    setRules(finalRules);
    setChecked(finalRules.map(() => false));
    setEditingRules(false);
    try {
      await client.saveSetting(CHECKLIST_SETTING_KEY, finalRules);
    } catch {
      /* non-fatal — the list still applies for this trade */
    }
  };

  const reset = () => {
    setSymbol('');
    setEntryPrice(undefined);
    setStrike(undefined);
    setExpiration('');
    setTags('');
    setGrade('');
    setNotes('');
    setStopPrice(undefined);
    setTargetPrice(undefined);
    setSizing(undefined);
    setChecked(rules.map(() => false));
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
        entryTime: entryTime || null,
        fees: fees ?? 0,
        ...(assetType === 'option' ? { optionType, strike, expiration } : {}),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        grade: grade || null,
        notes: notes || null,
        checklist: rules.map((rule, i) => ({ rule, checked: !!checked[i] })),
        stopPrice: stopPrice ?? null,
        targetPrice: targetPrice ?? null,
      });
      const sym = symbol.trim().toUpperCase();
      reset();
      onSaved();
      onClose();
      toast(`Logged ${quantity} ${sym}`, { type: 'success' });
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
        <Segmented
          full
          options={[
            { value: 'stock', label: 'Stock' },
            { value: 'option', label: 'Option' },
          ]}
          value={assetType}
          onChange={setAssetType}
        />
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
          <Field label="Entry time" hint="Optional — enables time-of-day stats">
            <input type="time" className="input" value={entryTime} onChange={(e) => setEntryTime(e.target.value)} />
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
          <Field label="Stop (optional)" hint="Watched by exit alerts">
            <NumberInput value={stopPrice} onChange={setStopPrice} step={0.01} />
          </Field>
          <Field label="Target (optional)">
            <NumberInput value={targetPrice} onChange={setTargetPrice} step={0.01} />
          </Field>
        </div>

        <div className="border-t border-ink-700 pt-2">
          <button
            type="button"
            className="text-xs text-accent"
            onClick={() => setShowSizer((v) => !v)}
            aria-expanded={showSizer}
          >
            {showSizer ? '− Hide' : '+ Size by risk'}
          </button>
          {showSizer && (
            <div className="mt-2 space-y-2 rounded-md bg-ink-700/40 p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Account $">
                  <NumberInput value={accountSize} onChange={(v) => setAccountSize(v ?? 0)} />
                </Field>
                <Field label="Risk %">
                  <NumberInput value={riskPct} onChange={(v) => setRiskPct(v ?? 0)} step={0.1} />
                </Field>
              </div>
              {typeof kellyPct === 'number' && kellyPct > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-accent"
                  onClick={() => setRiskPct(kellyPct)}
                  title="Quarter-Kelly from your realized edge"
                >
                  History suggests {kellyPct}% — use
                </button>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-500">Uses entry, side, type &amp; the Stop above.</span>
                <button className="btn-ghost text-xs" type="button" onClick={calcSize} disabled={sizingBusy}>
                  {sizingBusy ? 'Sizing…' : 'Calculate'}
                </button>
              </div>
              {sizingErr && <div className="text-bear text-xs">{sizingErr}</div>}
              {sizing && (
                <div className="text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300">
                      Suggested:{' '}
                      <span className="font-semibold tabular-nums text-slate-100">
                        {sizing.suggestedQuantity} {assetType === 'option' ? 'contracts' : 'shares'}
                      </span>
                    </span>
                    <button
                      className="text-accent disabled:text-slate-600"
                      type="button"
                      disabled={sizing.suggestedQuantity <= 0}
                      onClick={() => setQuantity(sizing.suggestedQuantity)}
                    >
                      Apply
                    </button>
                  </div>
                  <div className="text-slate-500 tabular-nums">
                    risk {fmtUsd(sizing.riskOfPosition)} · cost {fmtUsd(sizing.positionCost)} ·{' '}
                    {fmtNum(sizing.positionPctOfAccount, 0)}% of account
                  </div>
                  {sizing.warnings.map((w, i) => (
                    <div key={i} className="text-amber-400/90">
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

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
          {(() => {
            const current = tags
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean);
            const suggestions = knownTags.filter((t) => !current.includes(t.toLowerCase())).slice(0, 8);
            if (suggestions.length === 0) return null;
            const addTag = (t: string) =>
              setTags((prev) => {
                const trimmed = prev.trim();
                const sep = trimmed === '' ? '' : trimmed.endsWith(',') ? ' ' : ', ';
                return `${trimmed}${sep}${t}`;
              });
            return (
              <div className="col-span-2 flex flex-wrap gap-1 -mt-1.5">
                {suggestions.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="chip bg-ink-600 text-slate-300 hover:text-accent"
                    onClick={() => addTag(t)}
                  >
                    + {t}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
        <Field label="Notes">
          <textarea className="input h-16" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="border-t border-ink-700 pt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="label !mb-0">
              Pre-trade checklist{' '}
              <span className="text-slate-500 tabular-nums">
                ({checkedCount}/{rules.length})
              </span>
            </span>
            <button
              className="text-xs text-accent"
              type="button"
              onClick={() => {
                setRulesDraft(rules.join('\n'));
                setEditingRules((v) => !v);
              }}
            >
              {editingRules ? 'Done' : 'Edit rules'}
            </button>
          </div>
          {editingRules ? (
            <div className="space-y-2">
              <textarea
                className="input h-28 text-sm"
                value={rulesDraft}
                onChange={(e) => setRulesDraft(e.target.value)}
                placeholder="One rule per line"
              />
              <div className="flex justify-end">
                <button className="btn-ghost text-xs" type="button" onClick={saveRules}>
                  Save rules
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {rules.map((rule, i) => (
                <label key={i} className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-accent"
                    checked={!!checked[i]}
                    onChange={(e) => setChecked((c) => c.map((v, idx) => (idx === i ? e.target.checked : v)))}
                  />
                  <span>{rule}</span>
                </label>
              ))}
              {rules.length > 0 && checkedCount < rules.length && (
                <div className="text-[11px] text-amber-400/90 pt-0.5">
                  {rules.length - checkedCount} unchecked — a nudge, not a blocker. You can still save.
                </div>
              )}
            </div>
          )}
        </div>

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
  const { toast } = useToast();

  const submit = async () => {
    if (!position) return;
    if (!quantity || exitPrice === undefined) return setError('Quantity and exit price are required.');
    setBusy(true);
    setError(undefined);
    try {
      await client.addExit(position.id, { quantity, exitPrice, exitDate, fees: fees ?? 0, notes: notes || null });
      const sym = position.symbol;
      onSaved();
      onClose();
      toast(`Exit recorded for ${sym}`, { type: 'success' });
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
  const { toast } = useToast();

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
      toast('Journal updated', { type: 'success' });
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

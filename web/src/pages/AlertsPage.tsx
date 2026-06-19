import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { ago, cx, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  Segmented,
  Spinner,
} from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { useAlerts } from '../components/AlertsContext';
import type { Alert, AlertKind, AlertPreset } from '../api/types';

const KIND_LABEL: Record<AlertKind, string> = {
  price: 'Price',
  change: 'Change %',
  relvol: 'Rel volume',
  rsi: 'RSI',
  macross: 'MA20−MA50 %',
  high52: '% from 52w high',
  low52: '% from 52w low',
  optmark: 'Option mark',
  optbid: 'Option bid',
  optask: 'Option ask',
  optdelta: '|Δ| (abs delta)',
  optiv: 'IV %',
};

// `price` (underlying) is valid for both; the option list adds the contract
// metrics. Mirrors the server's STOCK_KINDS / OPTION_KINDS.
const STOCK_KINDS: AlertKind[] = ['price', 'change', 'relvol', 'rsi', 'macross', 'high52', 'low52'];
const OPTION_KINDS: AlertKind[] = ['price', 'optmark', 'optbid', 'optask', 'optdelta', 'optiv'];

function kindLabel(kind: AlertKind, assetType: 'stock' | 'option'): string {
  if (kind === 'price') return assetType === 'option' ? 'Underlying price' : 'Price';
  return KIND_LABEL[kind];
}

function fmtThreshold(kind: AlertKind, v: number): string {
  if (kind === 'price' || kind === 'optmark' || kind === 'optbid' || kind === 'optask') return fmtUsd(v);
  if (kind === 'change' || kind === 'macross' || kind === 'high52' || kind === 'low52') return fmtPct(v);
  if (kind === 'relvol') return `${fmtNum(v)}×`;
  if (kind === 'optiv') return `${fmtNum(v, 0)}%`;
  if (kind === 'optdelta') return fmtNum(v, 2);
  return fmtNum(v, 1);
}

/** Short contract descriptor, e.g. `150C · 2026-07-17`. */
function contractLabel(a: Alert): string | null {
  if (a.assetType !== 'option' || a.optionType == null || a.strike == null) return null;
  return `${a.strike}${a.optionType === 'call' ? 'C' : 'P'}${a.expiration ? ` · ${a.expiration}` : ''}`;
}

export default function AlertsPage() {
  const data = useAsync(() => client.alerts(), []);
  const { refreshCount } = useAlerts();
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [newly, setNewly] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [assetType, setAssetType] = useState<'stock' | 'option'>('stock');
  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState<AlertKind>('price');
  const [operator, setOperator] = useState<Alert['operator']>('above');
  const [threshold, setThreshold] = useState<number | undefined>();
  const [note, setNote] = useState('');
  // Option-only fields.
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [strike, setStrike] = useState<number | undefined>();
  const [expiration, setExpiration] = useState('');
  const [role, setRole] = useState<'entry' | 'exit'>('entry');
  const [planEntry, setPlanEntry] = useState('');
  const [planExit, setPlanExit] = useState('');
  const [formErr, setFormErr] = useState<string>();
  const symbolRef = useRef<HTMLInputElement>(null);

  // Prefill from the options Entry-scan ("＋ Alert" on a candidate). Applied once.
  const location = useLocation();
  const presetApplied = useRef(false);
  useEffect(() => {
    const preset = (location.state as { presetAlert?: AlertPreset } | null)?.presetAlert;
    if (!preset || presetApplied.current) return;
    presetApplied.current = true;
    setAssetType('option');
    setSymbol(preset.symbol.toUpperCase());
    setOptionType(preset.optionType);
    setStrike(preset.strike);
    setExpiration(preset.expiration);
    setRole(preset.role);
    setKind(preset.kind);
    setOperator(preset.operator);
    if (preset.threshold !== undefined) setThreshold(Math.round(preset.threshold * 100) / 100);
    if (preset.entryPlan) setPlanEntry(preset.entryPlan);
    symbolRef.current?.focus();
    window.history.replaceState({}, ''); // don't re-apply on reload
  }, [location.state]);

  const onAssetType = (t: 'stock' | 'option') => {
    setAssetType(t);
    const kinds = t === 'option' ? OPTION_KINDS : STOCK_KINDS;
    if (!kinds.includes(kind)) setKind(t === 'option' ? 'optmark' : 'price');
  };

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const evaluate = async () => {
    setBusy(true);
    try {
      const r = await client.evaluateAlerts();
      setLastChecked(r.checkedAt);
      setNewly(r.newlyTriggered.map((t) => t.message || `${t.symbol} triggered`));
      data.reload();
      refreshCount();
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!symbol.trim() || threshold === undefined) {
      setFormErr('Symbol and threshold are required.');
      return;
    }
    if (assetType === 'option' && (strike === undefined || !expiration.trim())) {
      setFormErr('Option alerts need a strike and an expiration date.');
      return;
    }
    setFormErr(undefined);
    const plan =
      assetType === 'option' && (planEntry.trim() || planExit.trim())
        ? { entry: planEntry.trim() || undefined, exit: planExit.trim() || undefined }
        : undefined;
    await client.createAlert({
      symbol: symbol.trim().toUpperCase(),
      assetType,
      kind,
      operator,
      threshold,
      note: note || undefined,
      ...(assetType === 'option' ? { optionType, strike, expiration: expiration.trim(), role, plan } : {}),
    });
    setSymbol('');
    setThreshold(undefined);
    setNote('');
    setStrike(undefined);
    setExpiration('');
    setPlanEntry('');
    setPlanExit('');
    data.reload();
    refreshCount();
  };

  const alerts = data.data?.alerts ?? [];
  const triggeredCount = alerts.filter((a) => a.triggered).length;
  const kinds = assetType === 'option' ? OPTION_KINDS : STOCK_KINDS;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Alerts"
        subtitle={
          <>
            Rule-based triggers on a stock&apos;s price/momentum, or on a specific option contract — its mark, bid/ask,
            |Δ| or IV — with an entry/exit role and a trade plan.
            {triggeredCount > 0 && <span className="text-amber-400"> · {triggeredCount} triggered</span>}
          </>
        }
        actions={<RefreshBar onRefresh={evaluate} lastUpdated={lastChecked} loading={busy} />}
      />

      {newly.length > 0 && (
        <Card className="p-3 border-amber-500/40 bg-amber-500/5">
          <div className="text-amber-300 text-sm font-medium mb-1">🔔 Just triggered</div>
          <ul className="text-sm space-y-0.5">
            {newly.map((m, i) => (
              <li key={i}>• {m}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-sm">New alert</h3>
          <Segmented
            options={[
              { value: 'stock', label: 'Stock' },
              { value: 'option', label: 'Option' },
            ]}
            value={assetType}
            onChange={onAssetType}
          />
        </div>

        {assetType === 'option' && (
          <div className="grid sm:grid-cols-5 gap-2 items-end mb-2">
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
              <NumberInput value={strike} onChange={setStrike} step={0.5} min={0} placeholder="150" />
            </Field>
            <Field label="Expiration">
              <input type="date" className="input" value={expiration} onChange={(e) => setExpiration(e.target.value)} />
            </Field>
            <Field
              label="Role"
              hint={
                role === 'entry'
                  ? 'Entry: a good entry, with a suggested exit attached'
                  : 'Exit: on a contract you hold'
              }
            >
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'entry' | 'exit')}>
                <option value="entry">Entry signal</option>
                <option value="exit">Exit signal</option>
              </select>
            </Field>
          </div>
        )}

        <div className="grid sm:grid-cols-6 gap-2 items-end">
          <Field label={assetType === 'option' ? 'Underlying' : 'Symbol'}>
            <input
              ref={symbolRef}
              className="input"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
            />
          </Field>
          <Field label="Metric">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k, assetType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Operator">
            <select
              className="input"
              value={operator}
              onChange={(e) => setOperator(e.target.value as Alert['operator'])}
            >
              <option value="above">above</option>
              <option value="below">below</option>
            </select>
          </Field>
          <Field label="Threshold">
            <NumberInput value={threshold} onChange={setThreshold} step={0.01} />
          </Field>
          <Field label="Note">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button className="btn-primary" onClick={create}>
            Add alert
          </button>
        </div>

        {assetType === 'option' && (
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            <Field label="Entry plan" hint="Why this is a good entry (your own words)">
              <textarea
                className="input"
                rows={2}
                value={planEntry}
                onChange={(e) => setPlanEntry(e.target.value)}
                placeholder="e.g. break & hold over 150 on rising rel-vol"
              />
            </Field>
            <Field
              label="Exit plan"
              hint={
                role === 'entry'
                  ? 'Optional — a default exit is auto-suggested for entry alerts'
                  : 'When/how to close it'
              }
            >
              <textarea
                className="input"
                rows={2}
                value={planExit}
                onChange={(e) => setPlanExit(e.target.value)}
                placeholder="e.g. trim half at +50%, stop under 148"
              />
            </Field>
          </div>
        )}

        {formErr && <div className="text-bear text-sm mt-1">{formErr}</div>}
        {assetType === 'option' && (
          <p className="text-[11px] text-slate-500 mt-2">
            Option mark / bid-ask / |Δ| / IV triggers need an options-capable provider; an underlying-price trigger
            works with any provider. Not a buy signal — a rule you set.
          </p>
        )}
      </Card>

      {data.loading ? (
        <Spinner />
      ) : data.error ? (
        <Card>
          <ErrorState error={data.error} onRetry={data.reload} />
        </Card>
      ) : alerts.length === 0 ? (
        <Card>
          <EmptyState
            title="No alerts yet"
            hint="Create an alert above, then hit Refresh to evaluate it against current data."
            action={
              <button className="btn-primary" onClick={() => symbolRef.current?.focus()}>
                Create your first alert
              </button>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Target</th>
                <th className="th">Condition</th>
                <th className="th text-right">Last value</th>
                <th className="th">Status</th>
                <th className="th">Note</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => {
                const contract = contractLabel(a);
                const hasPlan = !!(a.plan && (a.plan.entry || a.plan.exit || a.plan.suggestedExit));
                const isOpen = expanded.has(a.id);
                return (
                  <Fragment key={a.id}>
                    <tr
                      className={cx(
                        'border-b border-ink-700/50',
                        a.triggered && 'bg-amber-500/5',
                        !a.enabled && 'opacity-50',
                      )}
                    >
                      <td className="td">
                        <div className="flex items-start gap-1.5">
                          {a.assetType === 'option' && hasPlan && (
                            <button
                              className="mt-0.5 text-slate-500 hover:text-accent"
                              onClick={() => toggleExpand(a.id)}
                              aria-label={isOpen ? 'Hide plan' : 'Show plan'}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                          <div>
                            <Link to={`/symbol/${a.symbol}`} className="font-semibold hover:text-accent">
                              {a.symbol}
                            </Link>
                            {contract && (
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-slate-400 tabular-nums">{contract}</span>
                                {a.role && <Badge color={a.role === 'entry' ? 'green' : 'amber'}>{a.role}</Badge>}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        {kindLabel(a.kind, a.assetType)} {a.operator}{' '}
                        <span className="tabular-nums">{fmtThreshold(a.kind, a.threshold)}</span>
                      </td>
                      <td className="td text-right tabular-nums">
                        {a.lastValue === null ? '—' : fmtThreshold(a.kind, a.lastValue)}
                      </td>
                      <td className="td">
                        {a.triggered ? (
                          <span title={a.triggerMessage || ''}>
                            <Badge color="amber">triggered</Badge>{' '}
                            <span className="text-[11px] text-slate-500">{ago(a.lastTriggeredAt)}</span>
                          </span>
                        ) : a.enabled ? (
                          <Badge color="green">armed</Badge>
                        ) : (
                          <Badge>off</Badge>
                        )}
                      </td>
                      <td className="td text-slate-400 text-xs max-w-[180px] truncate" title={a.note || ''}>
                        {a.note || '—'}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        {a.triggered && (
                          <button
                            className="text-xs text-accent mr-2"
                            onClick={async () => {
                              await client.updateAlert(a.id, { triggered: false });
                              data.reload();
                              refreshCount();
                            }}
                          >
                            ack
                          </button>
                        )}
                        <button
                          className="text-xs text-slate-400 mr-2"
                          onClick={async () => {
                            await client.updateAlert(a.id, { enabled: !a.enabled });
                            data.reload();
                          }}
                        >
                          {a.enabled ? 'disable' : 'enable'}
                        </button>
                        <button
                          className="text-xs text-slate-500 hover:text-bear"
                          onClick={async () => {
                            await client.deleteAlert(a.id);
                            data.reload();
                            refreshCount();
                          }}
                        >
                          del
                        </button>
                      </td>
                    </tr>
                    {isOpen && hasPlan && (
                      <tr className="bg-ink-850/40">
                        <td className="td text-xs text-slate-300" colSpan={6}>
                          <div className="grid sm:grid-cols-3 gap-3 py-1">
                            <PlanCell label="Entry plan" text={a.plan?.entry} />
                            <PlanCell label="Exit plan" text={a.plan?.exit} />
                            <PlanCell label="Suggested exit" text={a.plan?.suggestedExit} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-[11px] text-slate-500">
        Alerts are one-shot: once triggered they stay flagged until you “ack” (re-arm). An option <em>entry</em> alert
        carries a suggested exit (take-profit / stop / time) so a signal always comes with a pre-decided exit.
        Evaluation runs when you Refresh (or set an auto-interval). Rule-based heuristics — not advice.
      </p>
    </div>
  );
}

function PlanCell({ label, text }: { label: string; text?: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">{label}</div>
      <div className="text-slate-300">{text || <span className="text-slate-600">—</span>}</div>
    </div>
  );
}

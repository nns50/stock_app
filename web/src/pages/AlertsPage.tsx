import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { ago, cx, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Field, NumberInput, PageHeader, Spinner } from '../components/ui';
import { RefreshBar } from '../components/RefreshBar';
import { useAlerts } from '../components/AlertsContext';
import type { Alert } from '../api/types';

const KIND_LABEL: Record<Alert['kind'], string> = {
  price: 'Price',
  change: 'Change %',
  relvol: 'Rel volume',
  rsi: 'RSI',
  macross: 'MA20−MA50 %',
  high52: '% from 52w high',
  low52: '% from 52w low',
};

function fmtThreshold(kind: Alert['kind'], v: number): string {
  if (kind === 'price') return fmtUsd(v);
  if (kind === 'change' || kind === 'macross' || kind === 'high52' || kind === 'low52') return fmtPct(v);
  if (kind === 'relvol') return `${fmtNum(v)}×`;
  return fmtNum(v, 1);
}

export default function AlertsPage() {
  const data = useAsync(() => client.alerts(), []);
  const { refreshCount } = useAlerts();
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [newly, setNewly] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState<Alert['kind']>('price');
  const [operator, setOperator] = useState<Alert['operator']>('above');
  const [threshold, setThreshold] = useState<number | undefined>();
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState<string>();
  const symbolRef = useRef<HTMLInputElement>(null);

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
    setFormErr(undefined);
    await client.createAlert({
      symbol: symbol.trim().toUpperCase(),
      kind,
      operator,
      threshold,
      note: note || undefined,
    });
    setSymbol('');
    setThreshold(undefined);
    setNote('');
    data.reload();
    refreshCount();
  };

  const alerts = data.data?.alerts ?? [];
  const triggeredCount = alerts.filter((a) => a.triggered).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Alerts"
        subtitle={
          <>
            Rule-based triggers on price, change %, relative volume, RSI, MA20−MA50 spread, and distance from the
            52-week high/low.
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
        <h3 className="font-medium text-sm mb-2">New alert</h3>
        <div className="grid sm:grid-cols-6 gap-2 items-end">
          <Field label="Symbol">
            <input
              ref={symbolRef}
              className="input"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
            />
          </Field>
          <Field label="Metric">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Alert['kind'])}>
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
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
        {formErr && <div className="text-bear text-sm mt-1">{formErr}</div>}
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
                <th className="th">Symbol</th>
                <th className="th">Condition</th>
                <th className="th text-right">Last value</th>
                <th className="th">Status</th>
                <th className="th">Note</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr
                  key={a.id}
                  className={cx(
                    'border-b border-ink-700/50',
                    a.triggered && 'bg-amber-500/5',
                    !a.enabled && 'opacity-50',
                  )}
                >
                  <td className="td">
                    <Link to={`/symbol/${a.symbol}`} className="font-semibold hover:text-accent">
                      {a.symbol}
                    </Link>
                  </td>
                  <td className="td">
                    {KIND_LABEL[a.kind]} {a.operator}{' '}
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
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-[11px] text-slate-500">
        Alerts are one-shot: once triggered they stay flagged until you “ack” (re-arm). Evaluation runs when you Refresh
        (or set an auto-interval). Rule-based heuristics — not advice.
      </p>
    </div>
  );
}

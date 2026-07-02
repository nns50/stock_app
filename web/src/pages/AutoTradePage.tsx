import { ReactNode, useEffect, useState } from 'react';
import { client } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useToast } from '../components/ToastContext';
import { useConfirm } from '../components/ConfirmContext';
import { ago, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { Badge, Card, EmptyState, ErrorState, Field, PageHeader, Spinner } from '../components/ui';
import type { AutotradeRiskProfile, AutotradeScreenResult } from '../api/types';

// Foundations + Research & Screen (Phases 1-2 of docs/AUTOTRADING_SPEC.md).
// Read-only end to end: this page configures and observes the auto-trading
// initiative, it never places an order — Decision, Risk Check, and Execution
// are later phases.

function detailText(detail: string | null): string {
  if (!detail) return '—';
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
    }
    return String(parsed);
  } catch {
    return detail;
  }
}

function ScreenSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

export default function AutoTradePage() {
  const config = useAsync(() => client.autotradeConfig(), []);
  const exclusions = useAsync(() => client.autotradeExclusions(), []);
  const events = useAsync(() => client.autotradeEvents({ limit: 50 }), []);
  const { toast } = useToast();
  const confirm = useConfirm();

  const [enabled, setEnabled] = useState(false);
  const [riskProfile, setRiskProfile] = useState<AutotradeRiskProfile>('MODERATE');
  useEffect(() => {
    if (!config.data) return;
    setEnabled(config.data.enabled);
    setRiskProfile(config.data.riskProfile);
  }, [config.data]);

  const saveConfig = async (patch: { enabled?: boolean; riskProfile?: AutotradeRiskProfile }) => {
    if (patch.riskProfile === 'AGGRESSIVE' && riskProfile !== 'AGGRESSIVE') {
      const ok = await confirm({
        title: 'Switch to AGGRESSIVE?',
        body: 'Aggressive raises per-trade risk, the daily drawdown halt, concurrent positions, max aggregate open risk, correlated-ticker exposure, and the daily trade cap. This should be a deliberate choice, not a default.',
        confirmLabel: 'Switch to Aggressive',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const saved = await client.setAutotradeConfig({
        ...patch,
        confirmAggressive: patch.riskProfile === 'AGGRESSIVE' ? true : undefined,
      });
      setEnabled(saved.enabled);
      setRiskProfile(saved.riskProfile);
      toast('Auto-trading settings saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save settings', { type: 'error' });
    }
  };

  const [newSymbol, setNewSymbol] = useState('');
  const [newReason, setNewReason] = useState('');
  const addExclusion = async () => {
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol) return;
    try {
      await client.addAutotradeExclusion({ symbol, reason: newReason.trim() || undefined });
      setNewSymbol('');
      setNewReason('');
      exclusions.reload();
      toast(`${symbol} added to the exclusion list`, { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not add exclusion', { type: 'error' });
    }
  };
  const removeExclusion = async (symbol: string) => {
    const ok = await confirm({
      title: `Remove ${symbol} from the exclusion list?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await client.removeAutotradeExclusion(symbol);
      exclusions.reload();
      toast(`${symbol} removed`, { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not remove exclusion', { type: 'error' });
    }
  };

  const [screenBusy, setScreenBusy] = useState(false);
  const [screenResult, setScreenResult] = useState<AutotradeScreenResult>();
  const [screenErr, setScreenErr] = useState<string>();
  const runScreen = async () => {
    setScreenBusy(true);
    setScreenErr(undefined);
    try {
      setScreenResult(await client.runAutotradeScreen());
      events.reload();
    } catch (e) {
      setScreenErr((e as Error).message || 'Screen failed');
    } finally {
      setScreenBusy(false);
    }
  };

  const exclusionRows = exclusions.data?.exclusions ?? [];
  const eventRows = events.data?.events ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Auto-Trade"
        subtitle="Foundations for the automated-trading initiative (docs/AUTOTRADING_SPEC.md). Screening + real-estate
          exclusion are wired up; decision, risk checks, and execution are later phases. Nothing here places an order."
      />

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Configuration</h3>
        {config.loading ? (
          <Spinner />
        ) : config.error ? (
          <ErrorState error={config.error} onRetry={config.reload} />
        ) : (
          <div className="grid sm:grid-cols-2 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => saveConfig({ enabled: e.target.checked })} />
              Auto-trading enabled
            </label>
            <Field
              label="Risk profile"
              hint={
                riskProfile === 'AGGRESSIVE'
                  ? 'Higher risk/trade, drawdown halt, position count, aggregate risk, and trade caps.'
                  : 'Default — the conservative caps.'
              }
            >
              <select
                className="input"
                value={riskProfile}
                onChange={(e) => saveConfig({ riskProfile: e.target.value as AutotradeRiskProfile })}
              >
                <option value="MODERATE">Moderate (default)</option>
                <option value="AGGRESSIVE">Aggressive</option>
              </select>
            </Field>
          </div>
        )}
        {enabled && (
          <p className="text-[11px] text-amber-400 mt-3">
            Auto-trading is enabled, but nothing acts on it yet — the execution loop (a later phase) hasn&apos;t been
            built.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Real-estate exclusion list</h3>
        <div className="grid sm:grid-cols-4 gap-2 items-end mb-3">
          <Field label="Symbol">
            <input
              className="input"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="O"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason (optional)">
              <input
                className="input"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="REIT"
              />
            </Field>
          </div>
          <button className="btn-primary" onClick={addExclusion}>
            Add
          </button>
        </div>
        {exclusions.loading ? (
          <Spinner />
        ) : exclusions.error ? (
          <ErrorState error={exclusions.error} onRetry={exclusions.reload} />
        ) : exclusionRows.length === 0 ? (
          <EmptyState
            title="No exclusions"
            hint="Add a symbol above — the sector/industry classification check also catches unlisted REITs."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">Symbol</th>
                <th className="th">Reason</th>
                <th className="th">Source</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {exclusionRows.map((e) => (
                <tr key={e.symbol} className="border-b border-ink-700/50">
                  <td className="td font-semibold">{e.symbol}</td>
                  <td className="td text-slate-400">{e.reason || '—'}</td>
                  <td className="td">
                    <Badge color={e.source === 'default' ? 'slate' : 'blue'}>{e.source}</Badge>
                  </td>
                  <td className="td text-right">
                    <button
                      className="text-xs text-slate-500 hover:text-bear"
                      onClick={() => removeExclusion(e.symbol)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-sm">Research &amp; Screen</h3>
          <button className="btn-primary" onClick={runScreen} disabled={screenBusy}>
            {screenBusy ? 'Scanning…' : 'Run screen'}
          </button>
        </div>
        {screenErr && <div className="text-bear text-sm mb-2">{screenErr}</div>}
        {screenResult ? (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Scanned {screenResult.discovery.scannedCount} symbols ({screenResult.discovery.universeCount} universe
              {screenResult.discovery.moversCount > 0 ? ` + ${screenResult.discovery.moversCount} movers` : ''}) ·
              generated {ago(screenResult.generatedAt)}
            </p>
            <ScreenSection title={`Candidates (${screenResult.candidates.length})`}>
              {screenResult.candidates.length === 0 ? (
                <p className="text-xs text-slate-500">No candidates passed screening this run.</p>
              ) : (
                <table className="w-full">
                  <thead className="border-b border-ink-600/60">
                    <tr>
                      <th className="th">Symbol</th>
                      <th className="th text-right">Price</th>
                      <th className="th text-right">Score</th>
                      <th className="th text-right">Gap</th>
                      <th className="th text-right">Rel Vol</th>
                      <th className="th">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {screenResult.candidates.map((c) => (
                      <tr key={c.symbol} className="border-b border-ink-700/50">
                        <td className="td font-semibold">{c.symbol}</td>
                        <td className="td text-right tabular-nums">{fmtUsd(c.price)}</td>
                        <td className="td text-right tabular-nums">{fmtNum(c.total, 1)}</td>
                        <td className="td text-right tabular-nums">
                          {c.indicators.gapPct === null ? '—' : fmtPct(c.indicators.gapPct)}
                        </td>
                        <td className="td text-right tabular-nums">
                          {c.indicators.relVolume === null ? '—' : `${fmtNum(c.indicators.relVolume)}×`}
                        </td>
                        <td className="td">
                          <Badge color={c.discoverySource === 'movers' ? 'green' : 'slate'}>{c.discoverySource}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ScreenSection>
            {screenResult.excluded.length > 0 && (
              <ScreenSection title={`Excluded — real estate (${screenResult.excluded.length})`}>
                <ul className="text-xs text-slate-400 space-y-0.5">
                  {screenResult.excluded.map((e) => (
                    <li key={e.symbol}>
                      <span className="font-semibold text-slate-300">{e.symbol}</span> — {e.reason}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
            {screenResult.skipped.length > 0 && (
              <ScreenSection title={`Skipped — unverified sector (${screenResult.skipped.length})`}>
                <ul className="text-xs text-slate-500 space-y-0.5">
                  {screenResult.skipped.map((s) => (
                    <li key={s.symbol}>
                      <span className="font-semibold text-slate-300">{s.symbol}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
            {screenResult.errors.length > 0 && (
              <ScreenSection title={`Errors (${screenResult.errors.length})`}>
                <ul className="text-xs text-bear space-y-0.5">
                  {screenResult.errors.map((e) => (
                    <li key={e.symbol}>
                      <span className="font-semibold">{e.symbol}</span> — {e.message}
                    </li>
                  ))}
                </ul>
              </ScreenSection>
            )}
          </div>
        ) : (
          !screenErr && (
            <p className="text-xs text-slate-500">
              Scans the universe (plus Webull&apos;s pre-market movers, if configured) for volume-breakout candidates,
              screening out real estate first. Read-only — nothing here places an order.
            </p>
          )
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium text-sm mb-3">Recent activity</h3>
        {events.loading ? (
          <Spinner />
        ) : events.error ? (
          <ErrorState error={events.error} onRetry={events.reload} />
        ) : eventRows.length === 0 ? (
          <EmptyState
            title="No activity yet"
            hint="Run a screen above, or change a setting, to see journal entries here."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-600/60">
              <tr>
                <th className="th">When</th>
                <th className="th">Stage</th>
                <th className="th">Action</th>
                <th className="th">Symbol</th>
                <th className="th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {eventRows.map((e) => (
                <tr key={e.id} className="border-b border-ink-700/50">
                  <td className="td text-slate-500 text-xs whitespace-nowrap">{ago(e.createdAt)}</td>
                  <td className="td">
                    <Badge>{e.stage}</Badge>
                  </td>
                  <td className="td">{e.action}</td>
                  <td className="td font-semibold">{e.symbol || '—'}</td>
                  <td className="td text-slate-500 text-xs max-w-[280px] truncate" title={detailText(e.detail)}>
                    {detailText(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-[11px] text-slate-500">
        Decision-support and tracking only — this scans and journals but never places an order. See
        docs/AUTOTRADING_SPEC.md for the full plan; the risk engine, execution loop, and live-trading gate are still
        upcoming phases.
      </p>
    </div>
  );
}

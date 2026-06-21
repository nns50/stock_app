import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx } from '../lib/format';
import { CHECKLIST_SETTING_KEY, DEFAULT_CHECKLIST_RULES, rulesFromSetting } from '../lib/checklist';
import { Card, Field, NumberInput, PageHeader, Spinner } from '../components/ui';
import { DataTools } from '../components/DataTools';
import { ProviderStatusModal } from '../components/ProviderStatusModal';
import { useProvider } from '../components/ProviderContext';
import { useAlerts } from '../components/AlertsContext';
import { useAuth } from '../components/AuthGate';
import { useToast } from '../components/ToastContext';
import { NOTIFY_KEY, requestNotificationPermission } from '../lib/notify';

// One home for everything that used to be tucked into modals and dropdowns:
// market-data provider, risk defaults, benchmark, the pre-trade checklist,
// alert polling, and data export/restore. Browser-scoped prefs persist to
// localStorage (instant); the checklist persists server-side.

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="font-medium text-sm">{title}</h2>
      {desc && <p className="text-xs text-slate-500 mt-0.5 mb-3 max-w-2xl">{desc}</p>}
      {!desc && <div className="mb-3" />}
      {children}
    </Card>
  );
}

export default function SettingsPage() {
  const { status } = useProvider();
  const { intervalMs, setIntervalMs } = useAlerts();
  const { required: authRequired, logout } = useAuth();
  const { toast } = useToast();
  const [providerOpen, setProviderOpen] = useState(false);

  // Browser-scoped trading defaults (shared with the risk sizer & benchmark).
  const [accountSize, setAccountSize] = useLocalStorage<number>('risk.accountSize', 25000);
  const [riskPct, setRiskPct] = useLocalStorage<number>('risk.riskPct', 1);
  const [benchSymbol, setBenchSymbol] = useLocalStorage<string>('benchmark.symbol', 'SPY');
  const [dailyLossLimit, setDailyLossLimit] = useLocalStorage<number>('guard.dailyLossLimit', 0);
  const [maxTradesPerDay, setMaxTradesPerDay] = useLocalStorage<number>('guard.maxTradesPerDay', 0);
  const [notifyOn, setNotifyOn] = useLocalStorage<boolean>(NOTIFY_KEY, false);

  // Desktop notifications need an explicit permission grant; only switch on if granted.
  const toggleNotify = async (on: boolean) => {
    if (!on) return setNotifyOn(false);
    const granted = await requestNotificationPermission();
    setNotifyOn(granted);
    if (!granted) toast('Notifications were blocked by the browser.', { type: 'error' });
  };

  // Pre-trade checklist rules — persisted server-side so they follow the data.
  const [rulesDraft, setRulesDraft] = useState<string | null>(null);
  const [savingRules, setSavingRules] = useState(false);
  useEffect(() => {
    let active = true;
    client
      .settings()
      .then((s) => active && setRulesDraft(rulesFromSetting(s[CHECKLIST_SETTING_KEY]).join('\n')))
      .catch(() => active && setRulesDraft(DEFAULT_CHECKLIST_RULES.join('\n')));
    return () => {
      active = false;
    };
  }, []);

  const saveRules = async () => {
    if (rulesDraft === null) return;
    const rules = rulesDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const finalRules = rules.length ? rules : DEFAULT_CHECKLIST_RULES;
    setSavingRules(true);
    try {
      await client.saveSetting(CHECKLIST_SETTING_KEY, finalRules);
      setRulesDraft(finalRules.join('\n'));
      toast('Checklist rules saved', { type: 'success' });
    } catch (e) {
      toast((e as Error).message || 'Could not save rules', { type: 'error' });
    } finally {
      setSavingRules(false);
    }
  };

  const mode = !status
    ? null
    : !status.configured
      ? { label: 'not configured', cls: 'text-bear' }
      : status.synthetic
        ? { label: 'demo (synthetic)', cls: 'text-amber-400' }
        : { label: 'live', cls: 'text-bull' };

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader title="Settings" subtitle="Provider, risk defaults, benchmark, checklist, alerts, and your data." />

      <Section
        title="Market data provider"
        desc="The provider is configured server-side in server/.env (MARKET_DATA_PROVIDER and any API token). This is its current status."
      >
        {!status || !mode ? (
          <Spinner label="Checking provider…" />
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div>
              <div className="label">Provider</div>
              <div className="font-medium">{status.name}</div>
            </div>
            <div>
              <div className="label">Mode</div>
              <div className={cx('font-medium', mode.cls)}>{mode.label}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(status.capabilities).map(([k, v]) => (
                <span key={k} className={cx('chip', v ? 'bg-bull/15 text-bull' : 'bg-ink-600 text-slate-500')}>
                  {v ? '✓' : '✕'} {k}
                </span>
              ))}
            </div>
            <button className="btn-ghost ml-auto" onClick={() => setProviderOpen(true)}>
              Details &amp; test
            </button>
          </div>
        )}
      </Section>

      <Section
        title="Risk &amp; sizing defaults"
        desc="Used by the position sizer and the “you vs benchmark” comparison. Saved in this browser."
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Account size ($)" hint="Turns realized $ into % for the benchmark.">
            <NumberInput value={accountSize} onChange={(v) => setAccountSize(v ?? 0)} min={0} />
          </Field>
          <Field label="Default risk per trade (%)" hint="Pre-fills the risk-based sizer.">
            <NumberInput value={riskPct} onChange={(v) => setRiskPct(v ?? 0)} step={0.1} min={0} />
          </Field>
        </div>
      </Section>

      <Section
        title="Discipline guardrails"
        desc="Opt-in daily circuit breaker. When today's booked loss or new-trade count reaches a limit, the dashboard warns you to step away. 0 = off. It never blocks or places trades."
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Daily loss limit ($)" hint="Warn once today's realized loss reaches this.">
            <NumberInput value={dailyLossLimit} onChange={(v) => setDailyLossLimit(v ?? 0)} min={0} />
          </Field>
          <Field label="Max new trades / day" hint="Warn once you've opened this many today.">
            <NumberInput value={maxTradesPerDay} onChange={(v) => setMaxTradesPerDay(v ?? 0)} min={0} />
          </Field>
        </div>
      </Section>

      <Section
        title="Benchmark"
        desc="The buy-and-hold index your realized trading is measured against in the journal."
      >
        <Field label="Benchmark symbol">
          <input
            className="input max-w-[160px]"
            value={benchSymbol}
            onChange={(e) => setBenchSymbol(e.target.value.toUpperCase())}
            placeholder="SPY"
          />
        </Field>
      </Section>

      <Section
        title="Pre-trade checklist"
        desc="The discipline rules you tick before logging an entry. One rule per line; shared everywhere you log a trade."
      >
        {rulesDraft === null ? (
          <Spinner label="Loading rules…" />
        ) : (
          <div className="space-y-2">
            <textarea
              className="input h-36 text-sm"
              value={rulesDraft}
              onChange={(e) => setRulesDraft(e.target.value)}
              placeholder="One rule per line"
            />
            <div className="flex justify-end">
              <button className="btn-primary" onClick={saveRules} disabled={savingRules}>
                {savingRules ? 'Saving…' : 'Save rules'}
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Alerts" desc="How often the app re-evaluates your alerts in the background.">
        <Field label="Auto-check interval">
          <select
            className="input max-w-[200px]"
            value={intervalMs ?? 'off'}
            onChange={(e) => setIntervalMs(e.target.value === 'off' ? null : Number(e.target.value))}
          >
            <option value="off">Off</option>
            <option value="30000">Every 30s</option>
            <option value="60000">Every 1m</option>
            <option value="300000">Every 5m</option>
          </select>
        </Field>
        <label className="flex items-start gap-2 text-sm text-slate-300 mt-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={notifyOn}
            onChange={(e) => toggleNotify(e.target.checked)}
          />
          <span>
            Desktop notifications when an alert fires
            <span className="block text-[11px] text-slate-500">
              Only while this tab is in the background — needs browser permission.
            </span>
          </span>
        </label>
      </Section>

      <ServerWatchSection />

      <WebullSection />

      <Section title="Data" desc="Export your trades, take a full database backup, or restore from a previous export.">
        <DataTools onImported={() => toast('Import complete', { type: 'success' })} />
      </Section>

      {authRequired && (
        <Section title="Account" desc="This app is password-protected.">
          <div className="space-y-5">
            <div>
              <div className="label mb-1.5">Two-factor authentication</div>
              <TwoFactorSettings />
            </div>
            <div className="pt-1 border-t border-ink-600/50">
              <button className="btn-ghost mt-3" onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
        </Section>
      )}

      <p className="text-xs text-slate-500">
        Looking for how the scores and rules work?{' '}
        <Link to="/about" className="text-accent hover:underline">
          See About →
        </Link>
      </p>

      <ProviderStatusModal open={providerOpen} onClose={() => setProviderOpen(false)} />
    </div>
  );
}

const INTERVALS = [
  { value: 30, label: 'Every 30s' },
  { value: 60, label: 'Every 1m' },
  { value: 300, label: 'Every 5m' },
  { value: 900, label: 'Every 15m' },
];

/**
 * The background poller: evaluates alerts on the server and pushes them to a
 * webhook, so alerts fire even with the browser closed. The webhook URL is
 * configured server-side (env); here you flip the poller on and pick a cadence.
 */
function ServerWatchSection() {
  const { toast } = useToast();
  const status = useAsync(() => client.notifications(), []);
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalSec] = useState(60);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (status.data) {
      setEnabled(status.data.scheduler.enabled);
      setIntervalSec(status.data.scheduler.intervalSeconds);
    }
  }, [status.data]);

  const save = async (next: { enabled?: boolean; intervalSeconds?: number }) => {
    const saved = await client.setAlertScheduler(next);
    setEnabled(saved.enabled);
    setIntervalSec(saved.intervalSeconds);
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await client.testNotification();
      if (!r.results.length) {
        toast('No webhook configured.', { type: 'error' });
      } else {
        const summary = r.results.map((c) => `${c.label} ${c.delivered ? '✓' : `✕ (${c.error})`}`).join(' · ');
        toast(`Test → ${summary}`, { type: r.delivered ? 'success' : 'error' });
      }
    } finally {
      setTesting(false);
    }
  };

  const channels = status.data?.channels ?? [];
  const configured = !!status.data?.configured;

  return (
    <Section
      title="Server-side watching"
      desc="Let the server evaluate your alerts on a schedule and push them to a webhook — so alerts fire even when the app/browser is closed. The server process must stay running."
    >
      {status.loading ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent"
              checked={enabled}
              onChange={(e) => save({ enabled: e.target.checked })}
            />
            <span>
              Enable the background alert poller
              <span className="block text-[11px] text-slate-500">Runs on the server, independent of any open tab.</span>
            </span>
          </label>

          <Field label="Poll interval">
            <select
              className="input max-w-[200px]"
              value={interval}
              disabled={!enabled}
              onChange={(e) => save({ intervalSeconds: Number(e.target.value) })}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="text-xs text-slate-400">
            {configured ? (
              <>
                Pushing to:{' '}
                {channels.map((c, i) => (
                  <span key={c.label}>
                    {i > 0 && ' · '}
                    <span className="text-bull capitalize">{c.label}</span>
                  </span>
                ))}
                . Set in <code className="text-slate-300">server/.env</code>.
              </>
            ) : (
              <>
                No webhook configured — set <code className="text-slate-300">SLACK_WEBHOOK_URL</code> and/or{' '}
                <code className="text-slate-300">DISCORD_WEBHOOK_URL</code> in{' '}
                <code className="text-slate-300">server/.env</code> to receive pushes.
              </>
            )}
          </div>

          <button className="btn-ghost text-sm" onClick={sendTest} disabled={testing || !configured}>
            {testing ? 'Sending…' : 'Send test notification'}
          </button>
        </div>
      )}
    </Section>
  );
}

/**
 * Webull integration connectivity. Shows whether server-side credentials are
 * configured and runs a read-only probe to validate the keys live and reveal the
 * raw response shape (used while the data mappers are being built).
 */
function WebullSection() {
  const status = useAsync(() => client.webullStatus(), []);
  const [kind, setKind] = useState<'account-list' | 'snapshot' | 'bars' | 'positions' | 'balance' | 'subscriptions'>(
    'account-list',
  );
  const [symbol, setSymbol] = useState('AAPL');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    error?: string;
    status?: number;
    url?: string;
    data?: unknown;
  } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await client.webullProbe(kind, { symbol, accountId }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Webull (beta)"
      desc="Connect Webull's OpenAPI (v2) for stock & option market data and your account. Credentials are server-side (WEBULL_APP_KEY / WEBULL_APP_SECRET). Market data needs an active OpenAPI subscription on your Webull account."
    >
      {status.loading ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <div className="text-sm">
            {status.data?.configured ? (
              <span className="text-bull">Credentials configured</span>
            ) : (
              <span className="text-slate-400">
                Not configured — set <code className="text-slate-300">WEBULL_APP_KEY</code> /{' '}
                <code className="text-slate-300">WEBULL_APP_SECRET</code> server-side.
              </span>
            )}
            <span className="text-slate-500"> · region {status.data?.region ?? '—'}</span>
            <span className="text-slate-500"> · 2FA token {status.data?.hasAccessToken ? 'set' : 'not set'}</span>
          </div>
          <p className="text-[11px] text-slate-500">
            A token is only needed if 2FA is enabled on your Webull account. If you get{' '}
            <code className="text-slate-400">INVALID_TOKEN</code>, either disable API 2FA on the Webull portal, or set a
            verified <code className="text-slate-400">WEBULL_ACCESS_TOKEN</code>.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <Field label="Test call">
              <select className="input max-w-[200px]" value={kind} onChange={(e) => setKind(e.target.value as never)}>
                <option value="account-list">Account list</option>
                <option value="snapshot">Stock snapshot</option>
                <option value="bars">Stock candles</option>
                <option value="positions">Positions</option>
                <option value="balance">Balance</option>
                <option value="subscriptions">Quote subscriptions</option>
              </select>
            </Field>
            {(kind === 'snapshot' || kind === 'bars') && (
              <Field label="Symbol">
                <input
                  className="input max-w-[120px]"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              </Field>
            )}
            {(kind === 'positions' || kind === 'balance') && (
              <Field label="Account ID" hint="Copy an account_id from Account list">
                <input
                  className="input max-w-[260px] font-mono text-xs"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value.trim())}
                  placeholder="account_id"
                />
              </Field>
            )}
            <button className="btn-primary" onClick={run} disabled={busy || !status.data?.configured}>
              {busy ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {kind === 'subscriptions' && (
            <p className="text-[11px] text-slate-500">
              Lists the market-data subscriptions Webull's OpenAPI sees for this app. If a stock snapshot returns{' '}
              <em>“Insufficient permission, please subscribe to stock quotes”</em> but this list is empty, the plan you
              bought isn't an OpenAPI quote subscription (mobile-app / desktop QT plans don't count) or hasn't activated
              yet.
            </p>
          )}

          {result && (
            <div className="text-sm">
              {result.ok ? (
                <span className="text-bull">✓ Connected — response below.</span>
              ) : (
                <span className="text-bear">
                  ✕ {result.error ?? 'failed'}
                  {result.status ? ` (HTTP ${result.status})` : ''}
                </span>
              )}
              {result.url && (
                <div className="mt-1 text-[11px] text-slate-500 break-all">
                  called <code className="text-slate-400">{result.url}</code>
                </div>
              )}
              {result.data !== undefined && (
                <pre className="mt-2 max-h-64 overflow-auto rounded border border-ink-600 bg-ink-900 p-2 text-[11px] text-slate-300">
                  {JSON.stringify(result.data, null, 2)}
                </pre>
              )}
            </div>
          )}

          <WebullPositionsSync configured={!!status.data?.configured} />
        </div>
      )}
    </Section>
  );
}

/** Preview-and-confirm sync of open Webull positions into the journal. */
function WebullPositionsSync({ configured }: { configured: boolean }) {
  const { toast } = useToast();
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof client.webullPositionsPreview>> | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const runPreview = async () => {
    if (!accountId) return;
    setBusy('preview');
    setPreview(null);
    try {
      setPreview(await client.webullPositionsPreview(accountId));
    } catch (e) {
      setPreview({ ok: false, accountId, positions: [], unmapped: 0, error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!accountId) return;
    setBusy('import');
    try {
      const r = await client.webullPositionsImport(accountId);
      if (r.ok) {
        toast(`Imported ${r.imported} position${r.imported === 1 ? '' : 's'} · ${r.skipped} already in journal`, {
          type: 'success',
        });
        setPreview(null);
      } else {
        toast(r.error || 'Import failed', { type: 'error' });
      }
    } catch (e) {
      toast((e as Error).message || 'Import failed', { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-ink-700 pt-3 space-y-2">
      <div className="text-sm font-medium">Sync positions → journal</div>
      <p className="text-[11px] text-slate-500">
        Preview your open Webull positions, then import the ones not already in the journal. Import only <em>adds</em>{' '}
        open positions — it never edits or deletes existing entries. Imported positions are tagged{' '}
        <code className="text-slate-400">webull</code>.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Account ID" hint="Copy an account_id from Account list">
          <input
            className="input max-w-[260px] font-mono text-xs"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value.trim())}
            placeholder="account_id"
          />
        </Field>
        <button className="btn-ghost" onClick={runPreview} disabled={!configured || !accountId || busy !== null}>
          {busy === 'preview' ? 'Loading…' : 'Preview'}
        </button>
        {preview?.ok && preview.positions.length > 0 && (
          <button className="btn-primary" onClick={runImport} disabled={busy !== null}>
            {busy === 'import' ? 'Importing…' : `Import ${preview.positions.length}`}
          </button>
        )}
      </div>

      {preview && !preview.ok && <div className="text-sm text-bear">✕ {preview.error ?? 'failed'}</div>}
      {preview?.ok && (
        <div className="text-sm space-y-2">
          {preview.positions.length === 0 ? (
            <span className="text-slate-400">
              No open positions to import
              {preview.unmapped ? ` (${preview.unmapped} row(s) couldn't be parsed)` : ''}.
            </span>
          ) : (
            <>
              <table className="w-full text-[11px]">
                <thead className="text-slate-500">
                  <tr className="text-left">
                    <th className="pr-2">Symbol</th>
                    <th className="pr-2">Type</th>
                    <th className="pr-2">Side</th>
                    <th className="pr-2">Qty</th>
                    <th className="pr-2">Entry</th>
                    <th>Contract</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.positions.map((p, i) => (
                    <tr key={i} className="border-t border-ink-800">
                      <td className="pr-2 font-medium">{p.symbol}</td>
                      <td className="pr-2">{p.assetType}</td>
                      <td className="pr-2">{p.side}</td>
                      <td className="pr-2">{p.quantity}</td>
                      <td className="pr-2">{p.entryPrice}</td>
                      <td className="text-slate-400">
                        {p.assetType === 'option' ? `${p.optionType} ${p.strike} ${p.expiration}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.unmapped > 0 && (
                <div className="text-[11px] text-amber-400">
                  {preview.unmapped} row(s) couldn't be parsed — check the raw payload.
                </div>
              )}
            </>
          )}
          <button className="text-[11px] text-slate-500 underline" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Hide' : 'Show'} raw payload
          </button>
          {showRaw && (
            <pre className="max-h-64 overflow-auto rounded border border-ink-600 bg-ink-900 p-2 text-[11px] text-slate-300">
              {JSON.stringify(preview.raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Group a base32 secret into 4-char blocks for readable manual entry. */
const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/**
 * Enroll / remove a TOTP second factor. Enabling shows the otpauth link + setup
 * key, then verifies a code; disabling requires a current code.
 */
function TwoFactorSettings() {
  const { toast } = useToast();
  const status = useAsync(() => client.mfaStatus(), []);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const codeError = (e: unknown, fallback: string) =>
    e instanceof ApiError && e.code === 'invalid_code'
      ? 'That code did not match — try again.'
      : (e as Error).message || fallback;
  const reset = () => {
    setSetup(null);
    setCode('');
    setError(undefined);
  };

  const begin = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setSetup(await client.mfaSetup());
      setCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.mfaEnable(code);
      reset();
      status.reload();
      toast('Two-factor enabled', { type: 'success' });
    } catch (e) {
      setError(codeError(e, 'Could not enable'));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.mfaDisable(code);
      reset();
      status.reload();
      toast('Two-factor disabled', { type: 'success' });
    } catch (e) {
      setError(codeError(e, 'Could not disable'));
    } finally {
      setBusy(false);
    }
  };

  if (status.loading) return <Spinner />;
  const s = status.data;
  if (!s?.available)
    return <p className="text-sm text-slate-500">Set a server password (APP_PASSWORD) first to use two-factor.</p>;

  const codeInput = (
    <input
      className="input max-w-[150px] tabular-nums"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      value={code}
      onChange={(e) => setCode(e.target.value)}
    />
  );

  if (s.enabled) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-bull">
          Two-factor is on.
          {!s.enforced && <span className="text-amber-400"> (bypassed by DISABLE_MFA on the server)</span>}
        </div>
        <p className="text-xs text-slate-500">Enter a current authenticator code to turn it off.</p>
        <div className="flex flex-wrap items-center gap-2">
          {codeInput}
          <button className="btn-ghost" onClick={disable} disabled={busy || code.length < 6}>
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        </div>
        {error && <div className="text-bear text-sm">{error}</div>}
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-slate-400">
          Add an authenticator app (Google Authenticator, Authy, 1Password…) for a one-time code at login.
        </p>
        <button className="btn-primary" onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Enable two-factor'}
        </button>
        {error && <div className="text-bear text-sm">{error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        1. In your authenticator app, add an account — open this link, or enter the setup key by hand:
      </p>
      <a
        href={setup.otpauthUri}
        className="block text-xs text-accent break-all rounded border border-ink-600 bg-ink-900 p-2"
      >
        {setup.otpauthUri}
      </a>
      <div className="text-sm text-slate-300">
        Setup key: <code className="tabular-nums text-slate-100">{groupSecret(setup.secret)}</code>
      </div>
      <p className="text-sm text-slate-400">2. Enter the 6-digit code it shows:</p>
      <div className="flex flex-wrap items-center gap-2">
        {codeInput}
        <button className="btn-primary" onClick={confirm} disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify & enable'}
        </button>
        <button className="btn-ghost" onClick={reset} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <div className="text-bear text-sm">{error}</div>}
    </div>
  );
}

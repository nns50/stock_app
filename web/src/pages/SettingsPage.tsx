import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx } from '../lib/format';
import { CHECKLIST_SETTING_KEY, DEFAULT_CHECKLIST_RULES, rulesFromSetting } from '../lib/checklist';
import { Card, Field, NumberInput, PageHeader, Spinner } from '../components/ui';
import { DataTools } from '../components/DataTools';
import { ProviderStatusModal } from '../components/ProviderStatusModal';
import { useProvider } from '../components/ProviderContext';
import { useAlerts } from '../components/AlertsContext';
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

      <Section title="Data" desc="Export your trades, take a full database backup, or restore from a previous export.">
        <DataTools onImported={() => toast('Import complete', { type: 'success' })} />
      </Section>

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

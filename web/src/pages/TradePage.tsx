import { useState } from 'react';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx, fmtUsd } from '../lib/format';
import { Badge, Card, Field, NumberInput, PageHeader, Segmented, Spinner } from '../components/ui';
import type { AccountStateInput, DryRunResult, GuardrailCheck, OrderIntentInput, TradingConfig } from '../api/types';

const DEFAULT_ACCOUNT: AccountStateInput = {
  buyingPowerUsd: 25000,
  exposureUsd: 0,
  realizedPnlTodayUsd: 0,
  ordersToday: 0,
  currentPositionQty: 0,
};

const DEFAULT_ORDER: OrderIntentInput = {
  symbol: 'AAPL',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 10,
  orderType: 'limit',
  limitPrice: 100,
  referencePrice: 100,
};

export default function TradePage() {
  const cfg = useAsync(() => client.tradeConfig(), []);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Trade (dry-run)"
        subtitle="Compose an order and see exactly what your guardrails would do. Nothing here is ever sent to a broker."
      />
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <b>Dry-run sandbox.</b> Every order here is validated against your guardrails and written to the audit trail,
        then it stops — no order is placed, and the live submit path isn't built yet. Account values below are entered
        by hand to test the rules.
      </div>
      {cfg.loading ? (
        <Spinner label="Loading trading config…" />
      ) : cfg.data ? (
        <Workspace config={cfg.data} reloadConfig={cfg.reload} />
      ) : null}
    </div>
  );
}

function Workspace({ config, reloadConfig }: { config: TradingConfig; reloadConfig: () => void }) {
  const [order, setOrder] = useState<OrderIntentInput>(DEFAULT_ORDER);
  const [account, setAccount] = useState<AccountStateInput>(DEFAULT_ACCOUNT);
  const [result, setResult] = useState<DryRunResult>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [accountId, setAccountId] = useLocalStorage('trade.accountId', '');
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string>();

  const setO = <K extends keyof OrderIntentInput>(k: K, v: OrderIntentInput[K]) => setOrder((o) => ({ ...o, [k]: v }));
  const setA = <K extends keyof AccountStateInput>(k: K, v: AccountStateInput[K]) =>
    setAccount((a) => ({ ...a, [k]: v }));

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setResult(await client.dryRunOrder(order, account));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // Read-only: pull live buying power / exposure / day P&L (+ this symbol's
  // position) from the broker into the account-state form. Places nothing.
  const pull = async () => {
    if (!accountId.trim()) return setPullMsg('Enter your cash account_id first (Settings → Webull → Account list).');
    setPulling(true);
    setPullMsg(undefined);
    try {
      const r = await client.tradeAccountState(accountId.trim(), order.symbol);
      if (r.ok && r.state) {
        setAccount(r.state);
        setPullMsg(
          `Pulled — buying power $${r.state.buyingPowerUsd.toLocaleString('en-US')}` +
            (r.netLiquidationUsd !== undefined ? ` · net liq $${r.netLiquidationUsd.toLocaleString('en-US')}` : ''),
        );
      } else {
        setPullMsg(r.error ?? 'Could not pull account state.');
      }
    } catch (e) {
      setPullMsg((e as Error).message);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card className="p-4 space-y-3">
          <h3 className="font-medium">Order</h3>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Symbol">
              <input
                className="input !w-28"
                value={order.symbol}
                onChange={(e) => setO('symbol', e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Asset">
              <Segmented
                value={order.assetKind}
                onChange={(v) => setO('assetKind', v)}
                options={[
                  { value: 'stock', label: 'Stock' },
                  { value: 'option', label: 'Option' },
                ]}
              />
            </Field>
            <Field label="Side">
              <Segmented
                value={order.side}
                onChange={(v) => setO('side', v)}
                options={[
                  { value: 'buy', label: 'Buy' },
                  { value: 'sell', label: 'Sell' },
                ]}
              />
            </Field>
            <Field label="Open / close">
              <Segmented
                value={order.openClose}
                onChange={(v) => setO('openClose', v)}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'close', label: 'Close' },
                ]}
              />
            </Field>
            <Field label="Type">
              <Segmented
                value={order.orderType}
                onChange={(v) => setO('orderType', v)}
                options={[
                  { value: 'limit', label: 'Limit' },
                  { value: 'market', label: 'Market' },
                ]}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Quantity">
              <NumberInput value={order.quantity} onChange={(v) => setO('quantity', v ?? 0)} min={0} />
            </Field>
            {order.orderType === 'limit' && (
              <Field label="Limit price">
                <NumberInput value={order.limitPrice} onChange={(v) => setO('limitPrice', v)} min={0} step={0.01} />
              </Field>
            )}
            <Field label="Reference price" hint="last/mark — used for notional + fat-finger">
              <NumberInput
                value={order.referencePrice}
                onChange={(v) => setO('referencePrice', v)}
                min={0}
                step={0.01}
              />
            </Field>
          </div>
          {order.assetKind === 'option' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Call / put">
                <Segmented
                  value={order.optionType ?? 'call'}
                  onChange={(v) => setO('optionType', v)}
                  options={[
                    { value: 'call', label: 'Call' },
                    { value: 'put', label: 'Put' },
                  ]}
                />
              </Field>
              <Field label="Strike">
                <NumberInput value={order.strike} onChange={(v) => setO('strike', v)} min={0} />
              </Field>
              <Field label="Expiration">
                <input
                  className="input"
                  placeholder="YYYY-MM-DD"
                  value={order.expiration ?? ''}
                  onChange={(e) => setO('expiration', e.target.value)}
                />
              </Field>
            </div>
          )}
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? 'Checking…' : 'Dry-run order'}
          </button>
          {error && <p className="text-sm text-bear">{error}</p>}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h3 className="font-medium">Account state</h3>
            <div className="flex items-end gap-2">
              <Field label="Cash account_id" hint="Settings → Webull → Account list">
                <input
                  className="input max-w-[220px] font-mono text-xs"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value.trim())}
                  placeholder="account_id"
                />
              </Field>
              <button className="btn-ghost" onClick={pull} disabled={pulling}>
                {pulling ? 'Pulling…' : 'Pull from Webull'}
              </button>
            </div>
          </div>
          {pullMsg && <p className="text-xs text-slate-400">{pullMsg}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Buying power $">
              <NumberInput value={account.buyingPowerUsd} onChange={(v) => setA('buyingPowerUsd', v ?? 0)} min={0} />
            </Field>
            <Field label="Exposure $">
              <NumberInput value={account.exposureUsd} onChange={(v) => setA('exposureUsd', v ?? 0)} min={0} />
            </Field>
            <Field label="Today's P&L $">
              <NumberInput value={account.realizedPnlTodayUsd} onChange={(v) => setA('realizedPnlTodayUsd', v ?? 0)} />
            </Field>
            <Field label="Orders today">
              <NumberInput value={account.ordersToday} onChange={(v) => setA('ordersToday', v ?? 0)} min={0} />
            </Field>
            <Field label="Current position">
              <NumberInput value={account.currentPositionQty} onChange={(v) => setA('currentPositionQty', v ?? 0)} />
            </Field>
          </div>
        </Card>

        {result && <ResultPanel result={result} />}
      </div>

      <ConfigPanel config={config} reload={reloadConfig} />
    </div>
  );
}

function ResultPanel({ result }: { result: DryRunResult }) {
  const blocks = result.guardrails.checks.filter((c) => c.severity === 'block');
  const warns = result.guardrails.checks.filter((c) => c.severity === 'warn');
  return (
    <Card className="overflow-hidden">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-2 p-3 border-b border-ink-600/60',
          result.wouldSubmit ? 'bg-bull/10' : 'bg-bear/10',
        )}
      >
        <div className="flex items-center gap-2">
          <Badge color={result.wouldSubmit ? 'green' : 'red'}>{result.wouldSubmit ? 'would submit' : 'blocked'}</Badge>
          <span className="text-sm text-slate-200">{result.summary}</span>
        </div>
        <div className="text-xs text-slate-400">
          intent #{result.intent.id} · <span className="text-slate-200">{result.intent.state}</span>
          {result.notional !== null && <> · notional {fmtUsd(result.notional)}</>}
        </div>
      </div>
      <div className="p-3">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">Guardrails</div>
        <div className="flex flex-wrap gap-1.5">
          {blocks.map((c) => (
            <RuleChip key={c.rule} check={c} />
          ))}
          {warns.map((c) => (
            <RuleChip key={c.rule} check={c} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function RuleChip({ check }: { check: GuardrailCheck }) {
  const tone = check.passed
    ? 'bg-bull/15 text-bull'
    : check.severity === 'warn'
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-bear/15 text-bear';
  const mark = check.passed ? '✓' : check.severity === 'warn' ? '⚠' : '✕';
  return (
    <span className={cx('chip', tone)} title={check.detail}>
      {mark} {check.rule}
    </span>
  );
}

function ConfigPanel({ config, reload }: { config: TradingConfig; reload: () => void }) {
  const [draft, setDraft] = useState<TradingConfig>(config);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof TradingConfig>(k: K, v: TradingConfig[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const toggleKill = async () => {
    const next = await client.setKillSwitch(!config.killSwitch);
    setDraft(next);
    reload();
  };
  const save = async () => {
    setSaving(true);
    try {
      const next = await client.setTradeConfig(draft);
      setDraft(next);
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 space-y-3 self-start">
      <h3 className="font-medium">Guardrail config</h3>

      <button
        onClick={toggleKill}
        className={cx(
          'w-full rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
          config.killSwitch
            ? 'border-bear bg-bear/20 text-bear'
            : 'border-ink-600 bg-ink-700/40 text-slate-300 hover:border-bear/60',
        )}
      >
        {config.killSwitch ? '■ Kill switch ENGAGED — release' : 'Kill switch — engage halt'}
      </button>

      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-300">Trading enabled</span>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
      </label>
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-300">Allow naked short</span>
        <input
          type="checkbox"
          checked={draft.allowNakedShort}
          onChange={(e) => set('allowNakedShort', e.target.checked)}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Max order $">
          <NumberInput value={draft.maxOrderUsd} onChange={(v) => set('maxOrderUsd', v ?? 0)} min={0} />
        </Field>
        <Field label="Max symbol qty">
          <NumberInput
            value={draft.maxSymbolPositionQty}
            onChange={(v) => set('maxSymbolPositionQty', v ?? 0)}
            min={0}
          />
        </Field>
        <Field label="Max exposure $">
          <NumberInput value={draft.maxExposureUsd} onChange={(v) => set('maxExposureUsd', v ?? 0)} min={0} />
        </Field>
        <Field label="Max orders/day">
          <NumberInput value={draft.maxOrdersPerDay} onChange={(v) => set('maxOrdersPerDay', v ?? 0)} min={0} />
        </Field>
        <Field label="Max daily loss $">
          <NumberInput value={draft.maxDailyLossUsd} onChange={(v) => set('maxDailyLossUsd', v ?? 0)} min={0} />
        </Field>
        <Field label="Fat-finger %">
          <NumberInput value={draft.fatFingerPct} onChange={(v) => set('fatFingerPct', v ?? 0)} min={0} max={100} />
        </Field>
      </div>

      <button className="btn-primary w-full" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save config'}
      </button>
      <p className="text-[11px] text-slate-500">
        Caps and the kill switch persist server-side. Defaults are intentionally tiny and trading ships <b>off</b>.
      </p>
    </Card>
  );
}

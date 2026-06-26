import { useState } from 'react';
import { client } from '../api/client';
import { useAsync, useLocalStorage } from '../lib/hooks';
import { cx, fmtUsd } from '../lib/format';
import { Badge, Card, Field, NumberInput, PageHeader, Segmented, Spinner } from '../components/ui';
import { ExpirySelect, StrikeSelect, chainStrikes } from '../components/OptionPicker';
import type {
  AccountStateInput,
  DryRunResult,
  GuardrailCheck,
  LivePreviewResult,
  OrderIntentInput,
  PlaceResult,
  TradingConfig,
} from '../api/types';

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

type OptionLeg = NonNullable<OrderIntentInput['optionLegs']>[number];
const DEFAULT_LEGS: OptionLeg[] = [
  { side: 'buy', optionType: 'call', strike: 0, expiration: '' },
  { side: 'sell', optionType: 'call', strike: 0, expiration: '' },
];

export default function TradePage() {
  const cfg = useAsync(() => client.tradeConfig(), []);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Trade"
        subtitle="Check an order against your guardrails (dry-run or live preview), then place it — behind the full safety gate."
      />
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <b>Dry-run</b> and <b>Preview (live)</b> place nothing. <b>Place order</b> submits a <b>real</b> order to your
        cash account — and only when you type-to-confirm, every guardrail passes, the kill switch is off, and{' '}
        <code>TRADING_ENABLED</code> is set on the server. Caps stay tiny by default; the kill switch is one tap away.
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
  const [livePrev, setLivePrev] = useState<LivePreviewResult>();
  const [previewing, setPreviewing] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placeResult, setPlaceResult] = useState<PlaceResult>();

  const placePhrase = `${order.side.toUpperCase()} ${order.quantity} ${order.symbol.toUpperCase()}`;

  const setO = <K extends keyof OrderIntentInput>(k: K, v: OrderIntentInput[K]) => setOrder((o) => ({ ...o, [k]: v }));
  const setA = <K extends keyof AccountStateInput>(k: K, v: AccountStateInput[K]) =>
    setAccount((a) => ({ ...a, [k]: v }));

  // Edit one leg of a vertical spread (seeds two default legs the first time).
  const setLeg = (i: number, patch: Partial<OptionLeg>) =>
    setOrder((o) => {
      const base = o.optionLegs && o.optionLegs.length >= 2 ? o.optionLegs : DEFAULT_LEGS;
      const optionLegs = base.map((leg, idx) => (idx === i ? { ...leg, ...patch } : leg));
      return { ...o, optionLegs };
    });

  const isVertical = order.assetKind === 'option' && (order.optionStrategy ?? 'SINGLE') === 'VERTICAL';

  // Switching strategy: a vertical is one Spreads count + one Net limit (always a
  // limit order), so reset the single-order scaling AND clear the single-leg
  // contract fields — otherwise a leftover strike/expiry could be (mis)used if the
  // order were ever treated as single-leg. Switching back to Single drops the legs.
  const setStrategy = (s: NonNullable<OrderIntentInput['optionStrategy']>) =>
    setOrder((o) =>
      s === 'VERTICAL'
        ? {
            ...o,
            optionStrategy: s,
            orderType: 'limit',
            quantity: 1,
            limitPrice: undefined,
            referencePrice: undefined,
            strike: undefined,
            optionType: undefined,
            expiration: undefined,
          }
        : { ...o, optionStrategy: s, optionLegs: undefined },
    );

  // Option-chain pickers: pull expirations for the symbol, and the chain for the
  // active expiry, so strikes/expiries are chosen from real, tradeable contracts
  // (no more free-text "invalid market / strike" rejections). Options only.
  const optSymbol = order.assetKind === 'option' ? order.symbol.trim().toUpperCase() : '';
  const expirations = useAsync(
    () => (optSymbol ? client.expirations(optSymbol) : Promise.resolve({ expirations: [] as string[] })),
    [optSymbol],
  );
  const expiryOpts = expirations.data?.expirations ?? [];
  const activeExpiry = isVertical ? (order.optionLegs?.[0]?.expiration ?? '') : (order.expiration ?? '');
  const chain = useAsync(
    () => (optSymbol && activeExpiry ? client.chain(optSymbol, activeExpiry) : Promise.resolve(null)),
    [optSymbol, activeExpiry],
  );

  // A vertical's two legs share one expiry — set both at once.
  const setLegsExpiry = (expiration: string) =>
    setOrder((o) => {
      const base = o.optionLegs && o.optionLegs.length >= 2 ? o.optionLegs : DEFAULT_LEGS;
      return { ...o, optionLegs: base.map((leg) => ({ ...leg, expiration })) };
    });

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

  // Live pre-submit check against the REAL account: pull account state → run
  // guardrails → (if they pass) fetch the broker's cost estimate. Places nothing.
  const preview = async () => {
    if (!accountId.trim()) return setLivePrev({ ok: false, accountId: '', error: 'Enter your cash account_id first.' });
    setPreviewing(true);
    setLivePrev(undefined);
    try {
      setLivePrev(await client.tradePreview(order, accountId.trim()));
    } catch (e) {
      setLivePrev({ ok: false, accountId, error: (e as Error).message });
    } finally {
      setPreviewing(false);
    }
  };

  // Submit a REAL order. The server re-runs every gate (env + confirm +
  // guardrails + kill switch); this just carries the type-to-confirm phrase.
  const place = async () => {
    setPlacing(true);
    setPlaceResult(undefined);
    try {
      setPlaceResult(await client.tradePlace(order, accountId.trim(), confirmText.trim()));
    } catch (e) {
      setPlaceResult({ ok: false, placed: false, reason: 'account_error', error: (e as Error).message });
    } finally {
      setPlacing(false);
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
            {!isVertical && (
              <Field label="Type">
                <Segmented
                  value={order.orderType}
                  onChange={(v) => setO('orderType', v)}
                  options={[
                    { value: 'limit', label: 'Limit' },
                    { value: 'market', label: 'Market' },
                    { value: 'stop_loss', label: 'Stop' },
                    { value: 'stop_loss_limit', label: 'Stop-lim' },
                  ]}
                />
              </Field>
            )}
            <Field label="Session">
              <Segmented
                value={order.session ?? 'core'}
                onChange={(v) => setO('session', v)}
                options={[
                  { value: 'core', label: 'Regular' },
                  { value: 'extended', label: 'Extended' },
                  { value: 'overnight', label: 'Overnight' },
                ]}
              />
            </Field>
          </div>
          {(order.session ?? 'core') !== 'core' && (
            <p className="text-[11px] text-amber-400/90">
              {order.session === 'overnight' ? 'Overnight' : 'Extended-hours'} orders must be <b>limit</b> orders, and
              the symbol has to be eligible for that session on Webull — otherwise the broker rejects the order.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={isVertical ? 'Spreads' : 'Quantity'}>
              <NumberInput value={order.quantity} onChange={(v) => setO('quantity', v ?? 0)} min={0} />
            </Field>
            {(order.orderType === 'stop_loss' || order.orderType === 'stop_loss_limit') && !isVertical && (
              <Field label="Stop (trigger) price">
                <NumberInput value={order.stopPrice} onChange={(v) => setO('stopPrice', v)} min={0} step={0.01} />
              </Field>
            )}
            {(order.orderType === 'limit' || order.orderType === 'stop_loss_limit' || isVertical) && (
              <Field label={isVertical ? 'Net limit (debit/credit)' : 'Limit price'}>
                <NumberInput value={order.limitPrice} onChange={(v) => setO('limitPrice', v)} min={0} step={0.01} />
              </Field>
            )}
            {!isVertical && (
              <Field label="Reference price" hint="last/mark — used for notional + fat-finger">
                <NumberInput
                  value={order.referencePrice}
                  onChange={(v) => setO('referencePrice', v)}
                  min={0}
                  step={0.01}
                />
              </Field>
            )}
          </div>
          {order.assetKind === 'option' && (
            <div className="space-y-3">
              <Field label="Strategy">
                <Segmented
                  value={order.optionStrategy ?? 'SINGLE'}
                  onChange={setStrategy}
                  options={[
                    { value: 'SINGLE', label: 'Single' },
                    { value: 'VERTICAL', label: 'Vertical' },
                  ]}
                />
              </Field>
              {(order.optionStrategy ?? 'SINGLE') === 'SINGLE' ? (
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
                  <Field label="Expiration">
                    <ExpirySelect
                      value={order.expiration ?? ''}
                      options={expiryOpts}
                      loading={expirations.loading}
                      onChange={(v) => setO('expiration', v)}
                    />
                  </Field>
                  <Field label="Strike">
                    <StrikeSelect
                      value={order.strike}
                      options={chainStrikes(chain.data, order.optionType ?? 'call')}
                      loading={chain.loading}
                      onChange={(v) => setO('strike', v)}
                    />
                  </Field>
                  <p className="col-span-2 text-[11px] text-slate-500 sm:col-span-4">
                    Single-leg options — <b>limit or stop</b> (no market). Prices are the per-contract premium.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                    <b>Requires a margin account.</b> Webull only allows debit/credit spreads on an approved{' '}
                    <b>margin</b> account — <b>cash</b> and <b>IRA</b> accounts are rejected at placement (you can still
                    dry-run and preview).
                  </div>
                  <Field label="Expiry (both legs)">
                    <ExpirySelect
                      value={order.optionLegs?.[0]?.expiration ?? ''}
                      options={expiryOpts}
                      loading={expirations.loading}
                      onChange={setLegsExpiry}
                    />
                  </Field>
                  {[0, 1].map((i) => (
                    <div key={i} className="flex flex-wrap items-end gap-2">
                      <Field label={`Leg ${i + 1}`}>
                        <Segmented
                          value={order.optionLegs?.[i]?.side ?? (i === 0 ? 'buy' : 'sell')}
                          onChange={(v) => setLeg(i, { side: v })}
                          options={[
                            { value: 'buy', label: 'Buy' },
                            { value: 'sell', label: 'Sell' },
                          ]}
                        />
                      </Field>
                      <Field label="C / P">
                        <Segmented
                          value={order.optionLegs?.[i]?.optionType ?? 'call'}
                          onChange={(v) => setLeg(i, { optionType: v })}
                          options={[
                            { value: 'call', label: 'Call' },
                            { value: 'put', label: 'Put' },
                          ]}
                        />
                      </Field>
                      <Field label="Strike">
                        <StrikeSelect
                          value={order.optionLegs?.[i]?.strike}
                          options={chainStrikes(chain.data, order.optionLegs?.[i]?.optionType ?? 'call')}
                          loading={chain.loading}
                          onChange={(v) => setLeg(i, { strike: v ?? 0 })}
                        />
                      </Field>
                    </div>
                  ))}
                  <p className="text-[11px] text-amber-400/90">
                    Use distinct strikes, one Buy + one Sell. <b>Spreads</b> (above) is the contract count,{' '}
                    <b>Net limit</b> is the net debit/credit, and order <b>Side</b> is the net direction (debit = Buy).{' '}
                    <b>Preview (live)</b> validates the spread with the broker first.
                  </p>
                </div>
              )}
            </div>
          )}
          {order.assetKind === 'stock' && order.orderType === 'limit' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Take-profit" hint="optional bracket leg">
                <NumberInput
                  value={order.bracket?.takeProfitPrice}
                  onChange={(v) => setO('bracket', { ...order.bracket, takeProfitPrice: v })}
                  min={0}
                  step={0.01}
                />
              </Field>
              <Field label="Stop-loss" hint="optional bracket leg">
                <NumberInput
                  value={order.bracket?.stopLossPrice}
                  onChange={(v) => setO('bracket', { ...order.bracket, stopLossPrice: v })}
                  min={0}
                  step={0.01}
                />
              </Field>
              <p className="col-span-2 text-[11px] text-slate-500 sm:col-span-4">
                Optional <b>bracket</b> — attaches a take-profit and/or stop-loss that fire as the entry fills (Webull
                MASTER + STOP_PROFIT/STOP_LOSS). Take-profit above / stop-loss below the entry for a buy. Stocks only.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost" onClick={run} disabled={running}>
              {running ? 'Checking…' : 'Dry-run (manual state)'}
            </button>
            <button className="btn-primary" onClick={preview} disabled={previewing}>
              {previewing ? 'Previewing…' : 'Preview (live)'}
            </button>
            <span className="text-[11px] text-slate-500">
              Preview pulls your real account + a broker estimate. Places nothing.
            </span>
          </div>
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

        {livePrev && <LivePreviewPanel result={livePrev} />}

        {livePrev?.wouldSubmit && (
          <Card className="p-4 space-y-2 border border-bear/50">
            <h3 className="font-medium text-bear">⚠ Place live order — real money</h3>
            <p className="text-xs text-slate-400">
              This submits a <b>real</b> order to your cash account. Type{' '}
              <code className="text-slate-200">{placePhrase}</code> to arm. The server re-checks every guardrail, the
              kill switch, and <code>TRADING_ENABLED</code> before it fires.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input max-w-[220px] font-mono"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                placeholder={placePhrase}
                aria-label="type to confirm"
              />
              <button
                className="btn-primary !bg-bear !border-bear disabled:opacity-40"
                disabled={placing || confirmText.trim().toUpperCase() !== placePhrase}
                onClick={place}
              >
                {placing ? 'Placing…' : 'Place order'}
              </button>
            </div>
            {placeResult && <PlaceResultPanel result={placeResult} />}
          </Card>
        )}

        {result && <ResultPanel result={result} />}

        <OrdersPanel accountId={accountId} refreshKey={placeResult?.intent?.id ?? 0} />
      </div>

      <ConfigPanel config={config} reload={reloadConfig} />
    </div>
  );
}

function stateTone(state: string): string {
  if (state === 'filled') return 'text-bull';
  if (state === 'partially_filled') return 'text-amber-400';
  if (state === 'cancelled' || state === 'rejected' || state === 'expired') return 'text-bear';
  return 'text-slate-300';
}

// Recent order intents (placed + dry-run). For orders that reached the broker,
// "Refresh status" reconciles our lifecycle with the live broker status.
function OrdersPanel({ accountId, refreshKey }: { accountId: string; refreshKey: number }) {
  const intents = useAsync(() => client.tradeIntents(), [refreshKey]);
  const [busyId, setBusyId] = useState<number>();
  const [msg, setMsg] = useState<Record<number, string>>({});
  const rows = intents.data?.intents ?? [];

  const refresh = async (id: number) => {
    if (!accountId.trim()) {
      setMsg((m) => ({ ...m, [id]: 'Enter your cash account_id above first.' }));
      return;
    }
    setBusyId(id);
    try {
      const r = await client.tradeReconcile(id, accountId.trim());
      let line: string;
      if (!r.ok) line = r.error ?? 'reconcile failed';
      else if (!r.broker?.found) line = 'no matching order at the broker yet';
      else {
        const b = r.broker;
        const fill = b.filledQty !== undefined ? ` · ${b.filledQty}/${b.totalQty ?? '?'}` : '';
        const at = b.filledPrice !== undefined ? ` @ ${fmtUsd(b.filledPrice)}` : '';
        line = `${(b.status ?? 'unknown').toLowerCase()}${fill}${at}${r.changed ? '' : ' · no change'}`;
      }
      setMsg((m) => ({ ...m, [id]: line }));
      intents.reload();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setBusyId(undefined);
    }
  };

  const cancel = async (id: number) => {
    if (!accountId.trim()) {
      setMsg((m) => ({ ...m, [id]: 'Enter your cash account_id above first.' }));
      return;
    }
    setBusyId(id);
    try {
      const r = await client.tradeCancel(id, accountId.trim());
      let line: string;
      if (!r.ok || !r.requested) line = r.error ?? `not cancellable (${r.reason})`;
      else line = `cancel requested → ${r.intent?.state ?? 'pending'}`;
      setMsg((m) => ({ ...m, [id]: line }));
      intents.reload();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setBusyId(undefined);
    }
  };

  const [editId, setEditId] = useState<number>();
  const [editQty, setEditQty] = useState<number>();
  const [editLimit, setEditLimit] = useState<number>();

  const openEdit = (it: { id: number; quantity: number; limitPrice: number | null }) => {
    setEditId(it.id);
    setEditQty(it.quantity);
    setEditLimit(it.limitPrice ?? undefined);
  };

  const replace = async (id: number) => {
    if (!accountId.trim()) {
      setMsg((m) => ({ ...m, [id]: 'Enter your cash account_id above first.' }));
      return;
    }
    setBusyId(id);
    try {
      const r = await client.tradeReplace(id, accountId.trim(), { quantity: editQty, limitPrice: editLimit });
      let line: string;
      if (!r.ok || !r.replaced) line = r.error ?? `not modified (${r.reason})`;
      else line = `modified → ${r.intent?.state ?? 'pending'}`;
      setMsg((m) => ({ ...m, [id]: line }));
      setEditId(undefined);
      intents.reload();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setBusyId(undefined);
    }
  };

  // Only orders still live at the broker can be cancelled or modified.
  const cancellable = (state: string) => state === 'acknowledged' || state === 'partially_filled';

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Orders</h3>
        <button className="btn-ghost text-xs" onClick={intents.reload} disabled={intents.loading}>
          {intents.loading ? 'Loading…' : 'Reload'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No orders yet — placed and dry-run orders show here.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((it) => (
            <li key={it.id} className="rounded-md border border-ink-600 bg-ink-700/40 p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-500">#{it.id}</span>
                <span className="flex-1 truncate">
                  {it.side.toUpperCase()} {it.quantity} {it.symbol}{' '}
                  <span className="text-slate-500">
                    {it.orderType}
                    {it.limitPrice !== null ? ` @ ${fmtUsd(it.limitPrice)}` : ''}
                  </span>
                </span>
                <span className={cx('text-xs font-medium', stateTone(it.state))}>{it.state}</span>
                {it.brokerOrderId && (
                  <button className="btn-ghost text-xs" onClick={() => refresh(it.id)} disabled={busyId === it.id}>
                    {busyId === it.id ? '…' : 'Refresh status'}
                  </button>
                )}
                {it.brokerOrderId && cancellable(it.state) && (
                  <>
                    <button className="btn-ghost text-xs" onClick={() => openEdit(it)} disabled={busyId === it.id}>
                      Modify
                    </button>
                    <button
                      className="btn-ghost text-xs !text-bear"
                      onClick={() => cancel(it.id)}
                      disabled={busyId === it.id}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
              {editId === it.id && (
                <div className="mt-1.5 flex flex-wrap items-end gap-2 border-t border-ink-600/60 pt-1.5">
                  <Field label="New qty">
                    <NumberInput value={editQty} onChange={setEditQty} min={1} />
                  </Field>
                  <Field label="New limit">
                    <NumberInput value={editLimit} onChange={setEditLimit} min={0} step={0.01} />
                  </Field>
                  <button className="btn-primary text-xs" onClick={() => replace(it.id)} disabled={busyId === it.id}>
                    {busyId === it.id ? '…' : 'Replace'}
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => setEditId(undefined)}>
                    Cancel edit
                  </button>
                </div>
              )}
              {it.brokerOrderId && (
                <div className="truncate font-mono text-[10px] text-slate-500">broker {it.brokerOrderId}</div>
              )}
              {msg[it.id] && <div className="text-[11px] text-slate-400">{msg[it.id]}</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-slate-500">
        <b>Refresh status</b> pulls the live broker status (read-only). <b>Modify</b> changes a working order's
        qty/limit (re-checked against the guardrails); <b>Cancel</b> pulls it.
      </p>
    </Card>
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

function LivePreviewPanel({ result }: { result: LivePreviewResult }) {
  if (!result.ok) {
    return (
      <Card className="p-3">
        <div className="flex items-center gap-2">
          <Badge color="amber">live preview</Badge>
          <span className="text-sm text-bear">{result.error}</span>
        </div>
      </Card>
    );
  }
  const blocks = result.guardrails?.checks.filter((c) => c.severity === 'block') ?? [];
  const warns = result.guardrails?.checks.filter((c) => c.severity === 'warn') ?? [];
  const est = result.preview?.estimate;
  return (
    <Card className="overflow-hidden">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-2 p-3 border-b border-ink-600/60',
          result.wouldSubmit ? 'bg-bull/10' : 'bg-bear/10',
        )}
      >
        <div className="flex items-center gap-2">
          <Badge color="green">live preview</Badge>
          <Badge color={result.wouldSubmit ? 'green' : 'red'}>{result.wouldSubmit ? 'would submit' : 'blocked'}</Badge>
          <span className="text-xs text-slate-400">places nothing</span>
        </div>
        {result.accountState && (
          <div className="text-xs text-slate-400">
            buying power <span className="text-slate-200">{fmtUsd(result.accountState.buyingPowerUsd)}</span>
            {result.notional != null && <> · notional {fmtUsd(result.notional)}</>}
          </div>
        )}
      </div>
      <div className="p-3 space-y-2">
        {result.preview && (
          <div className="text-sm">
            {result.preview.ok ? (
              <span className="text-slate-300">
                Broker estimate:{' '}
                {est?.costUsd != null ? (
                  <b className="text-slate-100">{fmtUsd(est.costUsd)}</b>
                ) : (
                  <span className="text-slate-500">see raw</span>
                )}
                {est?.commissionUsd != null && <> · commission {fmtUsd(est.commissionUsd)}</>}
              </span>
            ) : (
              <span className="text-bear">Broker preview error: {result.preview.error}</span>
            )}
          </div>
        )}
        {warns.some((c) => c.rule === 'market_hours') && (
          <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            ⚠ US regular hours are <b>9:30 a.m.–4:00 p.m. ET</b>. Options only trade then; a regular-session stock order
            placed now likely won't fill until the open.
          </div>
        )}
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">Guardrails (vs live account)</div>
          <div className="flex flex-wrap gap-1.5">
            {[...blocks, ...warns].map((c) => (
              <RuleChip key={c.rule} check={c} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function PlaceResultPanel({ result }: { result: PlaceResult }) {
  if (result.placed) {
    return (
      <div className="rounded-md bg-bull/15 text-bull text-sm p-2">
        ✓ Order placed{result.broker?.orderId ? ` · broker order ${result.broker.orderId}` : ''}
        {result.intent && (
          <>
            {' '}
            · intent #{result.intent.id} ({result.intent.state})
          </>
        )}
      </div>
    );
  }
  const msg = result.error || result.broker?.error || `not placed (${result.reason})`;
  return <div className="rounded-md bg-bear/15 text-bear text-sm p-2">✕ Not placed — {msg}</div>;
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
      <p className="text-[11px] text-slate-500 -mt-2">
        Arms the <code>trading_enabled</code> guardrail. Separate from the server <code>TRADING_ENABLED</code> env —
        both must be on to place. Remember to <b>Save</b>.
      </p>
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

import { Alert, applyEvaluation, listAlerts } from '../db/alerts';
import { AlertMetrics, evaluateAlert } from './alertEngine';
import { evaluateOpenPositionExits, PositionExitAlert } from './positionExits';
import { getProvider } from '../providers';
import { computeCandleMetrics, CandleMetrics, OptionContractMetrics, optionContractMetrics } from './alertMetrics';

// ---------------------------------------------------------------------------
// The shared alert-evaluation pass: gather current data for every enabled
// alert, flip one-shot triggers, and report what newly fired. Called both by
// the on-demand `/api/alerts/evaluate` route and by the background scheduler so
// they behave identically. I/O lives here; the per-alert decision stays pure in
// alertEngine.
// ---------------------------------------------------------------------------

export interface TriggeredAlert {
  id: number;
  symbol: string;
  message: string | null;
}

export interface AlertEvaluationResult {
  alerts: Alert[];
  newlyTriggered: TriggeredAlert[];
  positionAlerts: PositionExitAlert[];
  checkedAt: number;
}

const CANDLE_KINDS = ['rsi', 'macross', 'high52', 'low52'];

/** Human descriptor for an alert's message — bare symbol, or a contract. */
export function alertSubject(a: Alert): string {
  if (a.assetType === 'option' && a.optionType && a.strike != null) {
    const cp = a.optionType === 'call' ? 'C' : 'P';
    return `${a.symbol.toUpperCase()} ${a.strike}${cp}${a.expiration ? ' ' + a.expiration : ''}`;
  }
  return a.symbol.toUpperCase();
}

export async function runAlertEvaluation(): Promise<AlertEvaluationResult> {
  const alerts = listAlerts(true);
  const symbols = Array.from(new Set(alerts.map((a) => a.symbol.toUpperCase())));
  const provider = getProvider();

  const quotes = new Map<string, any>();
  try {
    const fetched = provider.getQuotes
      ? await provider.getQuotes(symbols)
      : await Promise.all(symbols.map((s) => provider.getQuote(s)));
    for (const q of fetched) quotes.set(q.symbol.toUpperCase(), q);
  } catch {
    // leave quotes empty; alerts simply won't trigger this round
  }

  // RSI, MA-cross and 52-week-distance all need candle history; fetch once per
  // symbol that has any such alert and derive them together.
  const EMPTY_CANDLE: CandleMetrics = { rsi: null, maSpreadPct: null, pctFromHigh52: null, pctFromLow52: null };
  const candleSymbols = Array.from(
    new Set(
      alerts.filter((a) => a.assetType === 'stock' && CANDLE_KINDS.includes(a.kind)).map((a) => a.symbol.toUpperCase()),
    ),
  );
  const candleMetrics = new Map<string, CandleMetrics>();
  await Promise.all(
    candleSymbols.map(async (s) => {
      try {
        const candles = await provider.getCandles(s, 'daily', { limit: 260 });
        candleMetrics.set(s, computeCandleMetrics(candles, quotes.get(s)?.last ?? null));
      } catch {
        // leave unset → metrics stay null and the alert just won't trigger
      }
    }),
  );

  // Option-contract alerts: fetch each needed (symbol, expiration) chain once
  // and read the targeted contract's mark/bid/ask/delta/IV. Skipped silently
  // when the provider has no options data (metrics stay null → no trigger).
  const optionAlerts = alerts.filter(
    (a) => a.assetType === 'option' && a.optionType && a.strike != null && a.expiration,
  );
  const optionMetrics = new Map<number, OptionContractMetrics>();
  if (optionAlerts.length && provider.capabilities.options) {
    const groups = new Map<string, Alert[]>();
    for (const a of optionAlerts) {
      const key = `${a.symbol.toUpperCase()}|${a.expiration}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
    }
    await Promise.all(
      Array.from(groups.entries()).map(async ([key, members]) => {
        const [sym, exp] = key.split('|');
        try {
          const chain = await provider.getOptionsChain(sym, exp);
          for (const a of members) optionMetrics.set(a.id, optionContractMetrics(chain, a.optionType!, a.strike!));
        } catch {
          // leave unset → metrics null → alert won't trigger this round
        }
      }),
    );
  }

  const newlyTriggered: TriggeredAlert[] = [];
  for (const a of alerts) {
    const sym = a.symbol.toUpperCase();
    const q = quotes.get(sym);
    const cm = candleMetrics.get(sym) ?? EMPTY_CANDLE;
    const om = optionMetrics.get(a.id);
    const metrics: AlertMetrics = {
      price: a.assetType === 'option' ? (om?.underlyingPrice ?? q?.last ?? null) : (q?.last ?? null),
      changePct: q?.changePct ?? null,
      relVol: q && q.avgVolume ? q.volume / q.avgVolume : null,
      rsi: cm.rsi,
      maSpreadPct: cm.maSpreadPct,
      pctFromHigh52: cm.pctFromHigh52,
      pctFromLow52: cm.pctFromLow52,
      optMark: om?.mark ?? null,
      optBid: om?.bid ?? null,
      optAsk: om?.ask ?? null,
      optDelta: om?.delta ?? null,
      optIv: om?.iv ?? null,
    };
    const ev = evaluateAlert(a.symbol, a, metrics, alertSubject(a));
    // An entry alert is "a good entry point with the suggestion of when to
    // exit" — fold its planned exit into the fired message.
    let message = ev.message;
    if (ev.triggered && a.role === 'entry' && a.plan?.suggestedExit) {
      message = `${message} — plan exit: ${a.plan.suggestedExit}`;
    }
    const wasTriggered = a.triggered;
    applyEvaluation(a.id, ev.value, ev.triggered, message);
    if (ev.triggered && !wasTriggered) newlyTriggered.push({ id: a.id, symbol: a.symbol, message });
  }

  // Also surface open option positions that have hit an exit rule.
  const positionAlerts = await evaluateOpenPositionExits().catch(() => []);

  return { alerts: listAlerts(), newlyTriggered, positionAlerts, checkedAt: Date.now() };
}

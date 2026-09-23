import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { getDailyResult } from '../../db/dailyResults';
import { getIntent, intentExistsForKey } from '../../db/orders';
import { correctExitPrice, getPosition, listSyncEstimatedExits, SyncEstimatedExit } from '../../db/positions';
import {
  BrokerEquityFill,
  isExitLeg,
  listBrokerEquityFills,
  webullOrderStatusBatch,
  WebullOrderLeg,
  WebullOrderStatus,
} from '../../providers/webull/orders';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import {
  confirmationNote,
  correctionNote,
  decideExitCorrection,
  ExitCorrectionSkipCode,
  legExitReason,
  PRICE_EPS,
} from '../exitPriceBackfill';
import { realizedPnlOf } from '../pnl';
import { recordDailyResult } from './dailyResults';
import { entryIntentIdForPosition } from '../../db/autotradeLiveOrders';

// ---------------------------------------------------------------------------
// A STOCK EXIT THE SYNC PRICED ITSELF IS CORRECTED TO ITS LEG'S FILL (2026-09-23).
//
// When a bracket leg fills, two things race to book it. The entry order's
// reconcile reads the leg from the order lists, which show a filled leg about
// two minutes late. The position sync sees the shares gone from the broker and,
// once its grace runs out, books the exit itself at a live QUOTE, with a reason
// inferred from the price, or 'manual' when the price sits between the levels.
// Whichever writes first is the record. The sync's close takes the entry order
// out of the pending list, so its reconcile never looks at the leg again.
//
// The sync won on 2026-09-21. COIN's breakeven stop filled at 204.37 (a $3.22
// loss); the sync booked the $205.05 quote as a 'manual' +$105 win. The step-down
// counts consecutive losses off exactly these rows, and HPE went in four seconds
// later at full size after two real losses. It lost $429.
//
// The broker's order history keeps the leg's real fill for seven days, and
// exitPriceBackfill.ts already decides a correction from it. That decision had
// only ever run as a one-shot CLI (scripts/backfillExitPrices.ts), written for
// a parser bug that was supposed to be the last source of these rows. It was
// not, and nothing re-ran it. This is the same decision, run by the loop.
// The grace in providers/webull/positions.ts (BRACKET_RECONCILE_GRACE_MS) makes
// the race rare; this repairs the cases that still happen, and what is already
// on the record.
//
// A close the operator made by hand in Webull has no filled leg to read, and
// since the grace above it is priced from a quote up to four minutes after the
// sale. The history holds that sale too, so it is matched there, the stock twin
// of the options hand-close match (liveOptionsExecute.ts, matchHandCloseFill).
//
// A SKIP IS STATED, AND A LEG OUTSIDE THE BRACKET IS READ (2026-09-23, later).
// The first deploy that could see adopted positions corrected five of eight
// estimates and said nothing about the other three. LITE's (09-21) shows why a
// silent skip is not good enough: its bracket's legs never rested, the re-arm
// failed, and the stop that filled at 10:38 was in a bracket the operator placed
// by hand. The entry's combo had no filled leg, so it went to the hand-sale
// match, which read only NORMAL orders and so could not see a stop leg. It was
// left an estimate for good, with no row anywhere saying so. Now:
// - the match reads any closing fill that is not an opening order (MASTER): a
//   hand sale, and equally a stop or target the operator placed by hand or a
//   re-arm placed, bounded to fills on or before the day the sync booked;
// - an estimate the fill confirms to the cent gets a confirmed note;
// - every estimate left alone for good journals `live_exit_correction_skipped`
//   once, with its cause and the broker's evidence (a working leg, once a day
//   from the day after the close).
//
// Read-only toward the broker: paged order-list reads (the combos from the open
// and history lists, and the history's stock fills only when a hand sale is
// being matched), never a place, cancel or modify.
// ---------------------------------------------------------------------------

/** The broker's order history covers the past seven days: a row older than that
 *  can never be corrected, so it is not asked about. */
export const STOCK_EXIT_CORRECTION_LOOKBACK_DAYS = 7;
/** A pass is two paged list reads at 2 requests / 2 s. A new estimate is asked
 *  about on the next tick; the rest are re-asked at most this often, because a
 *  leg the lists have not shown yet usually needs minutes, not seconds. */
export const STOCK_EXIT_CORRECTION_INTERVAL_MS = 15 * 60 * 1000;

const LEG_TERMINAL = new Set(['FILLED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'FAILED']);

let lastPassAt = 0;
/** Estimates already asked about since the process started. */
const seenExitIds = new Set<number>();
/** Estimates the broker has FINISHED with and that still do not correct: the
 *  combo is gone from history, or every leg is terminal and none filled (a
 *  hand close). No later read can change the answer, so they are not re-read.
 *  Process state: a restart asks about each of them once more. */
const finalExitIds = new Set<number>();

export function resetStockExitCorrectionState(): void {
  lastPassAt = 0;
  seenExitIds.clear();
  finalExitIds.clear();
}

/** Whether a skipped estimate can ever change: false once the broker is done
 *  with the combo (or has aged it out), true while it is still unreadable. */
function stillOpen(broker: WebullOrderStatus | undefined): boolean {
  if (!broker || !broker.ok) return true; // a failed read says nothing
  if (!broker.found) return false; // aged out of the seven-day history for good
  return (broker.legs ?? []).some((l) => !LEG_TERMINAL.has((l.status ?? '').toUpperCase()));
}

/** A combo the broker has finished with in which no exit leg filled: the
 *  shares left some other way. On a position the app bracketed, that is a
 *  sale by hand in Webull (the operator cancels the bracket and sells). */
function closedOutsideTheBracket(broker: WebullOrderStatus | undefined): boolean {
  if (!broker || !broker.ok || !broker.found || stillOpen(broker)) return false;
  return !(broker.legs ?? []).some((l) => isExitLeg(l) && (l.status ?? '').toUpperCase() === 'FILLED');
}

/** What closed a stock position outside its entry's own bracket, as the order
 *  history shows it. */
export interface SaleOutsideBracket {
  /** Quantity-weighted over the matched fills. */
  price: number;
  qty: number;
  filledAt: number;
  clientOrderIds: string[];
  /** `stop` or `target` when every matched fill is that kind of protective
   *  order (legExitReason: the combo label, or a stop order type), else
   *  `manual`: an order the operator placed by hand, or a mix. */
  reason: 'stop' | 'target' | 'manual';
  /** `outside_bracket` when every matched fill is a protective order (a stop
   *  or target leg) rather than a plain sale. This path runs only when no leg
   *  of the entry's own bracket reads FILLED, so in practice that is a stop or
   *  target placed again outside it, by a re-arm or by hand. `broker_history`
   *  when any of it was a plain sale. */
  source: 'outside_bracket' | 'broker_history';
}

/**
 * The fills that closed a stock exit the sync priced at a quote, from the
 * broker's order history, or null when the history cannot say. PURE. The stock
 * twin of liveOptionsExecute.ts's matchHandCloseFill.
 *
 * Only reached when the entry's own bracket finished with no leg filled, so
 * whatever sold the shares was some other order. A candidate is a SELL of this
 * symbol that is not an opening order (combo MASTER), filled at or after the
 * entry and on or before the day the sync booked the close (the shares were
 * gone by then, so a later fill belongs to a later position), and is not one of
 * the app's own orders (an order with an intent: its own reconcile books it).
 * A leg of a bracket placed outside the entry's (a re-arm, or one the operator
 * placed by hand) is a candidate; until 2026-09-23 only NORMAL orders were,
 * which is how LITE's stop fill on 09-21 went unread. Taken oldest first until
 * they add up to exactly the booked quantity, they book at their
 * quantity-weighted price. Sales that overshoot (the operator traded the symbol
 * again) or fall short (part went some other way) leave the estimate alone.
 */
export function matchSaleOutsideBracket(
  exit: { symbol: string; quantity: number; exitDate: string },
  enteredAt: number,
  fills: BrokerEquityFill[],
  isAppOrder: (clientOrderId: string) => boolean,
): SaleOutsideBracket | null {
  const mine = closingFills(exit, enteredAt, fills).filter((f) => !isAppOrder(f.clientOrderId));
  let qty = 0;
  let notional = 0;
  const used: BrokerEquityFill[] = [];
  for (const f of mine) {
    if (qty + f.filledQty > exit.quantity + 1e-9) return null;
    qty += f.filledQty;
    notional += f.filledQty * f.filledPrice;
    used.push(f);
    if (Math.abs(qty - exit.quantity) < 1e-9) {
      const kinds = used.map((u) =>
        legExitReason({ comboType: u.comboType ?? undefined, orderType: u.orderType ?? undefined }),
      );
      const reason = kinds.every((k) => k === 'stop')
        ? 'stop'
        : kinds.every((k) => k === 'target')
          ? 'target'
          : 'manual';
      return {
        price: Math.round((notional / qty) * 10_000) / 10_000,
        qty,
        filledAt: f.filledAt,
        clientOrderIds: used.map((u) => u.clientOrderId),
        reason,
        source: kinds.every((k) => k !== null) ? 'outside_bracket' : 'broker_history',
      };
    }
  }
  return null;
}

/** Every SELL of the symbol that could have closed the exit, oldest first, the
 *  app's own orders included (the matcher drops those; a skip row lists them). */
function closingFills(
  exit: { symbol: string; exitDate: string },
  enteredAt: number,
  fills: BrokerEquityFill[],
): BrokerEquityFill[] {
  const symbol = exit.symbol.toUpperCase();
  return fills
    .filter(
      (f) =>
        f.side === 'SELL' &&
        f.symbol === symbol &&
        f.comboType !== 'MASTER' &&
        f.filledAt >= enteredAt &&
        etToday(f.filledAt) <= exit.exitDate,
    )
    .sort((a, b) => a.filledAt - b.filledAt);
}

/** The note on an exit corrected from the order history. Like the bracket
 *  note, it replaces the estimate note, so the row leaves the candidate set. */
export function saleCorrectionNote(previousPrice: number, source: SaleOutsideBracket['source']): string {
  const what =
    source === 'outside_bracket'
      ? 'the fill of a stop or target placed outside the entry bracket (a re-arm, or one placed by hand)'
      : 'your own sale';
  return (
    `Exit price corrected to ${what} in Webull's order history ` +
    `(was ${previousPrice}, an estimate recorded by the Webull position sync).`
  );
}

/** Why an estimate is left alone: the decision's own codes, plus the pass's. */
type SkipCause = ExitCorrectionSkipCode | 'entry_order_missing' | 'no_matching_sale' | 'combo_working';

/** The broker's legs as a skip row states them. */
function legEvidence(legs: WebullOrderLeg[]) {
  return legs.map((l) => ({
    comboType: l.comboType ?? null,
    orderType: l.orderType ?? null,
    status: l.status ?? null,
    filledQty: l.filledQty ?? null,
    filledPrice: l.filledPrice ?? null,
  }));
}

/**
 * Journal that an estimate is being left alone, and why: once per estimate and
 * cause, or once per day for a leg still working (which can still resolve).
 * Durable across restarts: it reads its own earlier rows rather than process
 * state, because a restart asks about every unresolved estimate once more.
 */
function journalSkip(
  row: SyncEstimatedExit,
  cause: SkipCause,
  why: string,
  evidence: Record<string, unknown>,
  now: number,
): void {
  const perDay = cause === 'combo_working';
  const today = etToday(now);
  const prior = listAutotradeEvents({
    stage: 'execution',
    symbol: row.symbol,
    actions: ['live_exit_correction_skipped'],
    limit: 200,
  });
  const already = prior.some((e) => {
    if (perDay && etToday(e.createdAt) !== today) return false;
    try {
      const d = JSON.parse(e.detail ?? 'null') as { exitId?: unknown; cause?: unknown } | null;
      return d !== null && d.exitId === row.exitId && d.cause === cause;
    } catch {
      return false;
    }
  });
  if (already) return;
  logAutotradeEvent({
    symbol: row.symbol,
    stage: 'execution',
    action: 'live_exit_correction_skipped',
    detail: {
      positionId: row.positionId,
      exitId: row.exitId,
      exitDate: row.exitDate,
      quantity: row.quantity,
      exitPrice: row.exitPrice,
      exitReason: row.exitReason,
      cause,
      why,
      ...evidence,
    },
  });
}

/**
 * Correct the stock exits the Webull position sync booked at an estimated price
 * in the last seven days to what the broker says they filled at. Two sources:
 * - the bracket leg that closed the position, price and reason, when the
 *   order lists show exactly one filled exit leg covering the booked quantity;
 * - the fills that closed it outside that bracket (a hand sale, or a stop or
 *   target placed by a re-arm or by hand), when the bracket finished without a
 *   leg filling and the history holds fills that add up exactly.
 * An estimate the fill matches to the cent is confirmed in place. One left alone
 * for good journals `live_exit_correction_skipped` with its cause.
 * Returns how many exits were corrected.
 *
 * Journals `live_exit_corrected` for each correction and re-records the daily
 * result of any past day whose total it moved. Never throws toward the broker;
 * a failed read is simply retried on a later pass.
 */
export async function correctEstimatedStockExits(accountId: string, now: number = Date.now()): Promise<number> {
  const since = etToday(now - STOCK_EXIT_CORRECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const today = etToday(now);
  const rows = listSyncEstimatedExits({ since, accountId }).filter((r) => !finalExitIds.has(r.exitId));
  if (rows.length === 0) return 0;
  const fresh = rows.some((r) => !seenExitIds.has(r.exitId));
  if (!fresh && now - lastPassAt < STOCK_EXIT_CORRECTION_INTERVAL_MS) return 0;
  lastPassAt = now;
  for (const r of rows) seenExitIds.add(r.exitId);

  // Every estimate's ENTRY order: its client_order_id is what reaches the
  // broker's combo, and so the exit leg that filled. Resolved the way every
  // other live path resolves it (entryIntentIdForPosition), because an ADOPTED
  // position has no source_intent_id, and in production almost all are adopted.
  // Reading only that column is how this pass found nothing on its first deploy.
  const byKey = new Map<string, SyncEstimatedExit[]>();
  for (const row of rows) {
    const intentId = entryIntentIdForPosition({ id: row.positionId, sourceIntentId: row.sourceIntentId });
    const intent = intentId === null ? undefined : getIntent(intentId);
    if (!intent) {
      finalExitIds.add(row.exitId);
      journalSkip(row, 'entry_order_missing', "the entry order is gone from the app's own record", {}, now);
      continue;
    }
    const list = byKey.get(intent.idempotencyKey) ?? [];
    list.push(row);
    byKey.set(intent.idempotencyKey, list);
  }
  if (byKey.size === 0) return 0;
  const statuses = await webullOrderStatusBatch(accountId, [...byKey.keys()]);

  let corrected = 0;
  const pastDays = new Set<string>();
  const soldOutside: { row: SyncEstimatedExit; legs: WebullOrderLeg[] }[] = [];
  for (const [key, list] of byKey) {
    const broker = statuses.get(key);
    for (const row of list) {
      // A failed read says nothing: asked again on a later pass.
      if (!broker || !broker.ok) continue;
      if (!broker.found) {
        finalExitIds.add(row.exitId);
        journalSkip(row, 'aged_out', "the entry's orders are no longer in the broker's order lists", {}, now);
        continue;
      }
      const legs = broker.legs ?? [];
      const decision = decideExitCorrection(row, legs);
      if (decision.action === 'skip') {
        if (decision.code === 'already_matches') {
          finalExitIds.add(row.exitId);
          correctExitPrice(row.exitId, row.exitPrice, confirmationNote(row.exitPrice, "the bracket's exit leg"));
        } else if (closedOutsideTheBracket(broker)) {
          soldOutside.push({ row, legs });
        } else if (stillOpen(broker)) {
          // The lists show a filled leg minutes late, so a working leg on the
          // day of the close is expected. From the next day it is not: the
          // shares are gone and the broker still shows an order working.
          if (row.exitDate < today) {
            journalSkip(
              row,
              'combo_working',
              "the entry's bracket still shows a working leg although the shares are gone",
              { legs: legEvidence(legs) },
              now,
            );
          }
        } else {
          finalExitIds.add(row.exitId);
          journalSkip(row, decision.code, decision.reason, { legs: legEvidence(legs) }, now);
        }
        continue;
      }
      const before = getPosition(row.positionId);
      const after = correctExitPrice(
        row.exitId,
        decision.realPrice,
        correctionNote(row.exitPrice),
        decision.reason ?? undefined,
      );
      if (!after) continue;
      corrected += 1;
      finalExitIds.add(row.exitId);
      logAutotradeEvent({
        symbol: row.symbol,
        stage: 'execution',
        action: 'live_exit_corrected',
        detail: {
          positionId: row.positionId,
          exitId: row.exitId,
          // The fill of the bracket leg the entry's combo reports as filled.
          source: 'bracket_leg',
          exitDate: row.exitDate,
          quantity: row.quantity,
          fromPrice: row.exitPrice,
          toPrice: decision.realPrice,
          fromReason: row.exitReason,
          toReason: decision.reason ?? row.exitReason,
          pnlDelta: Math.round(decision.pnlDelta * 100) / 100,
          pnlBefore: before ? Math.round(realizedPnlOf(before) * 100) / 100 : null,
          pnlAfter: Math.round(realizedPnlOf(after) * 100) / 100,
        },
      });
      if (row.exitDate !== today) pastDays.add(row.exitDate);
    }
  }

  // CLOSED OUTSIDE THE BRACKET. No leg of the entry's bracket filled, so it
  // cannot say what the shares went for, but the broker's history holds what
  // did: the operator's own sale, or a stop or target placed outside it. One
  // read, and only when such a close exists.
  if (soldOutside.length > 0) {
    const history = await listBrokerEquityFills(accountId);
    for (const { row, legs } of soldOutside) {
      const pos = getPosition(row.positionId);
      const enteredAt = pos?.entryDate != null ? etDateTimeToMs(pos.entryDate, pos.entryTime ?? '00:00') : null;
      const sale =
        history.ok && pos && enteredAt !== null
          ? matchSaleOutsideBracket(row, enteredAt, history.fills, intentExistsForKey)
          : null;
      if (!sale) {
        // The history can lag a sale by minutes. Keep asking through the day of
        // the close; after that, an unmatched close stays an estimate for good.
        if (history.ok && row.exitDate < today) {
          finalExitIds.add(row.exitId);
          const candidates = enteredAt === null ? [] : closingFills(row, enteredAt, history.fills);
          journalSkip(
            row,
            'no_matching_sale',
            'no set of closing fills in the order history adds up to the quantity booked',
            {
              legs: legEvidence(legs),
              sells: candidates.slice(0, 10).map((f) => ({
                clientOrderId: f.clientOrderId,
                comboType: f.comboType,
                orderType: f.orderType,
                qty: f.filledQty,
                price: f.filledPrice,
                filledAt: f.filledAt,
                appOrder: intentExistsForKey(f.clientOrderId),
              })),
            },
            now,
          );
        }
        continue;
      }
      finalExitIds.add(row.exitId);
      if (Math.abs(sale.price - row.exitPrice) < PRICE_EPS && sale.reason === row.exitReason) {
        correctExitPrice(row.exitId, row.exitPrice, confirmationNote(row.exitPrice, "Webull's order history"));
        continue;
      }
      const after = correctExitPrice(
        row.exitId,
        sale.price,
        saleCorrectionNote(row.exitPrice, sale.source),
        sale.reason,
      );
      if (!after) continue;
      corrected += 1;
      const pnlDelta = (sale.price - row.exitPrice) * row.quantity * (pos!.side === 'short' ? -1 : 1);
      logAutotradeEvent({
        symbol: row.symbol,
        stage: 'execution',
        action: 'live_exit_corrected',
        detail: {
          positionId: row.positionId,
          exitId: row.exitId,
          // From the order history: the operator's own sale (`broker_history`,
          // the options twin's name), or a stop or target placed outside the
          // entry's bracket (`outside_bracket`).
          source: sale.source,
          exitDate: row.exitDate,
          quantity: row.quantity,
          fromPrice: row.exitPrice,
          toPrice: sale.price,
          fromReason: row.exitReason,
          toReason: sale.reason,
          fillClientOrderIds: sale.clientOrderIds,
          pnlDelta: Math.round(pnlDelta * 100) / 100,
          pnlBefore: Math.round(realizedPnlOf(pos!) * 100) / 100,
          pnlAfter: Math.round(realizedPnlOf(after) * 100) / 100,
        },
      });
      if (row.exitDate !== today) pastDays.add(row.exitDate);
    }
  }

  // A past day's recorded result read the estimate. Re-record it, keeping its
  // account half, only where a row exists (the recorder writes a day once).
  for (const day of pastDays) {
    if (getDailyResult(day)) recordDailyResult(day, now);
  }
  return corrected;
}

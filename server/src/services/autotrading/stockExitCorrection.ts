import { logAutotradeEvent } from '../../db/autotradeEvents';
import { getDailyResult } from '../../db/dailyResults';
import { getIntent, intentExistsForKey } from '../../db/orders';
import { correctExitPrice, getPosition, listSyncEstimatedExits, SyncEstimatedExit } from '../../db/positions';
import {
  BrokerEquityFill,
  isExitLeg,
  listBrokerEquityFills,
  webullOrderStatusBatch,
  WebullOrderStatus,
} from '../../providers/webull/orders';
import { etDateTimeToMs, etToday } from '../../util/marketDate';
import { correctionNote, decideExitCorrection } from '../exitPriceBackfill';
import { realizedPnlOf } from '../pnl';
import { recordDailyResult } from './dailyResults';

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

/**
 * The operator's own sale for a stock exit the sync priced at a quote, from the
 * broker's order history, or null when the history cannot say. PURE. The stock
 * twin of liveOptionsExecute.ts's matchHandCloseFill.
 *
 * A candidate fill is a SELL of this symbol, filled at or after the position
 * was entered, that is a plain order (combo NORMAL: a bracket leg is the other
 * path's to read) and not one of the app's own orders. Taken oldest first until
 * they add up to exactly the booked quantity, they book at their
 * quantity-weighted price. Sales that overshoot (the operator traded the symbol
 * again) or fall short (part went some other way) leave the estimate alone.
 */
export function matchStockHandSale(
  exit: { symbol: string; quantity: number },
  enteredAt: number,
  fills: BrokerEquityFill[],
  isAppOrder: (clientOrderId: string) => boolean,
): { price: number; qty: number; filledAt: number; clientOrderIds: string[] } | null {
  const symbol = exit.symbol.toUpperCase();
  const mine = fills
    .filter(
      (f) =>
        f.side === 'SELL' &&
        f.symbol === symbol &&
        (f.comboType === null || f.comboType === 'NORMAL') &&
        f.filledAt >= enteredAt &&
        !isAppOrder(f.clientOrderId),
    )
    .sort((a, b) => a.filledAt - b.filledAt);
  let qty = 0;
  let notional = 0;
  const clientOrderIds: string[] = [];
  for (const f of mine) {
    if (qty + f.filledQty > exit.quantity + 1e-9) return null;
    qty += f.filledQty;
    notional += f.filledQty * f.filledPrice;
    clientOrderIds.push(f.clientOrderId);
    if (Math.abs(qty - exit.quantity) < 1e-9) {
      return { price: Math.round((notional / qty) * 10_000) / 10_000, qty, filledAt: f.filledAt, clientOrderIds };
    }
  }
  return null;
}

/** The note on an exit corrected to the operator's own sale. Like the bracket
 *  note, it replaces the estimate note, so the row leaves the candidate set. */
export function handSaleCorrectionNote(previousPrice: number): string {
  return (
    `Exit price corrected to your own sale in Webull's order history ` +
    `(was ${previousPrice}, an estimate recorded by the Webull position sync).`
  );
}

/**
 * Correct the stock exits the Webull position sync booked at an estimated price
 * in the last seven days to what the broker says they filled at. Two sources:
 * - the bracket leg that closed the position, price and reason, when the
 *   order lists show exactly one filled exit leg covering the booked quantity;
 * - the operator's own sale (reason kept `manual`), when the bracket finished
 *   without a leg filling and the history holds sales that add up exactly.
 * Returns how many exits were corrected.
 *
 * Journals `live_exit_corrected` for each one and re-records the daily result
 * of any past day whose total it moved. Never throws toward the broker; a
 * failed read is simply retried on a later pass.
 */
export async function correctEstimatedStockExits(accountId: string, now: number = Date.now()): Promise<number> {
  const since = etToday(now - STOCK_EXIT_CORRECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = listSyncEstimatedExits({ since, accountId }).filter((r) => !finalExitIds.has(r.exitId));
  if (rows.length === 0) return 0;
  const fresh = rows.some((r) => !seenExitIds.has(r.exitId));
  if (!fresh && now - lastPassAt < STOCK_EXIT_CORRECTION_INTERVAL_MS) return 0;
  lastPassAt = now;
  for (const r of rows) seenExitIds.add(r.exitId);

  // Every estimate's ENTRY order: its client_order_id is what reaches the
  // broker's combo, and so the exit leg that filled.
  const byKey = new Map<string, SyncEstimatedExit[]>();
  for (const row of rows) {
    const intent = getIntent(row.sourceIntentId);
    if (!intent) {
      finalExitIds.add(row.exitId); // the entry order is gone from our own record
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
  const soldByHand: SyncEstimatedExit[] = [];
  for (const [key, list] of byKey) {
    const broker = statuses.get(key);
    for (const row of list) {
      const decision =
        broker && broker.ok && broker.found
          ? decideExitCorrection(row, broker.legs ?? [])
          : ({ action: 'skip', reason: 'unreadable' } as const);
      if (decision.action === 'skip') {
        if (closedOutsideTheBracket(broker)) soldByHand.push(row);
        else if (!stillOpen(broker)) finalExitIds.add(row.exitId);
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
      if (row.exitDate !== etToday(now)) pastDays.add(row.exitDate);
    }
  }

  // SOLD BY HAND. No leg filled, so the bracket cannot say what the shares went
  // for, but the broker's history holds the operator's own sale. One read, and
  // only when such a close exists.
  if (soldByHand.length > 0) {
    const history = await listBrokerEquityFills(accountId);
    for (const row of soldByHand) {
      const pos = getPosition(row.positionId);
      const enteredAt = pos?.entryDate != null ? etDateTimeToMs(pos.entryDate, pos.entryTime ?? '00:00') : null;
      const sale =
        history.ok && pos && enteredAt !== null
          ? matchStockHandSale(row, enteredAt, history.fills, intentExistsForKey)
          : null;
      if (!sale) {
        // The history can lag a sale by minutes. Keep asking through the day of
        // the close; after that, an unmatched sale stays an estimate for good.
        if (history.ok && row.exitDate < etToday(now)) finalExitIds.add(row.exitId);
        continue;
      }
      finalExitIds.add(row.exitId);
      if (Math.abs(sale.price - row.exitPrice) < 0.005) continue;
      const after = correctExitPrice(row.exitId, sale.price, handSaleCorrectionNote(row.exitPrice));
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
          // The operator's own sale, from the order history: context, not a
          // defect (the options twin's `broker_history`).
          source: 'broker_history',
          exitDate: row.exitDate,
          quantity: row.quantity,
          fromPrice: row.exitPrice,
          toPrice: sale.price,
          fromReason: row.exitReason,
          toReason: row.exitReason,
          fillClientOrderIds: sale.clientOrderIds,
          pnlDelta: Math.round(pnlDelta * 100) / 100,
          pnlBefore: Math.round(realizedPnlOf(pos!) * 100) / 100,
          pnlAfter: Math.round(realizedPnlOf(after) * 100) / 100,
        },
      });
      if (row.exitDate !== etToday(now)) pastDays.add(row.exitDate);
    }
  }

  // A past day's recorded result read the estimate. Re-record it, keeping its
  // account half, only where a row exists (the recorder writes a day once).
  for (const day of pastDays) {
    if (getDailyResult(day)) recordDailyResult(day, now);
  }
  return corrected;
}

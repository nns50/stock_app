import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { intentExistsForKey } from '../../db/orders';
import { correctExitPrice, getPosition, HandEstimatedExit, listSyncEstimatedHandExits } from '../../db/positions';
import { BrokerOptionFill, FILL_CLOCK_SLACK_MS, listBrokerFills } from '../../providers/webull/orders';
import { etToday } from '../../util/marketDate';
import { confirmationNote, PRICE_EPS } from '../exitPriceBackfill';
import { realizedPnlOf } from '../pnl';
import {
  fillsClaimedByCorrections,
  matchSaleOutsideBracket,
  previousExitBookedAt,
  STOCK_EXIT_CORRECTION_INTERVAL_MS,
  STOCK_EXIT_CORRECTION_LOOKBACK_DAYS,
} from './stockExitCorrection';

// ---------------------------------------------------------------------------
// A POSITION THE APP DID NOT OPEN IS BOOKED AT ITS FILL TOO (2026-09-24).
//
// The Webull position sync imports every holding the journal does not already
// have, and when the holding goes, closes the row at a live QUOTE, noted as an
// estimate. stockExitCorrection.ts rewrites those estimates to the broker's
// fill, but only for positions the app opened: it starts from the entry order,
// and an imported row has none. So the operator's own trades kept the quote for
// good. The 1-share AMC test short showed it: covered at $2.82 at 09:52:53 ET,
// booked 21 seconds later at a $2.805 quote.
//
// The options side is worse. The live options sleeve keeps its positions in its
// own table, so the sync imports each of its contracts into the journal as well,
// and closes that copy at a quote too. On 2026-09-23 the sleeve's DELL call
// stopped out at $4.95; the journal's copy read $9.90, a $330 win where $165
// was lost. The journal (the Journal page, the equity curve, the tax export)
// read these rows; the loop does not, it reads its own tables. On the
// 2026-09-23 copy: 78 option rows and 22 stock rows still on their estimates.
//
// The fill is in the broker's order history, which keeps seven days:
// - A STOCK row is matched the way stockExitCorrection matches a sale outside
//   a bracket (matchSaleOutsideBracket, the same function): a fill on the
//   closing side, oldest first, to exactly the booked quantity, never one of
//   the app's own orders (the app's positions share this table and book those).
// - An OPTIONS row is matched by its exact contract, and the app's own orders
//   count: the journal's copy of a sleeve contract is closed by the sleeve's
//   order, and that fill is what the copy should say.
// - The window: after the import (an imported row has no entry date; it was
//   held when the sync saw it, so whatever closed it filled later) and after
//   the position's previous exit, up to when the sync booked this one.
//
// A match books the fill's price, noted as corrected from the history, and
// writes `hand_exit_corrected` with the fills, which then count as claimed in
// both passes. No match by the end of the close's day stays an estimate, said
// once in `hand_exit_correction_skipped`. Read-only toward the broker: one paged
// history read per pass, only while such an estimate exists.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** A corrected row. Its `fillClientOrderIds` count as claimed in both this
 *  pass and the stock pass (stockExitCorrection.ts, fillsClaimedByCorrections). */
export const HAND_EXIT_CORRECTED = 'hand_exit_corrected';
export const HAND_EXIT_CORRECTION_SKIPPED = 'hand_exit_correction_skipped';

let lastPassAt = 0;
const seenExitIds = new Set<number>();
/** Estimates settled (corrected, confirmed, or left for good): not re-read.
 *  Process state; a restart reads each once more, and the journal keeps the
 *  statements from repeating. */
const finalExitIds = new Set<number>();

export function resetHandExitCorrectionState(): void {
  lastPassAt = 0;
  seenExitIds.clear();
  finalExitIds.clear();
}

/** What an imported options row's close has to match. */
export interface HandOptionWindow {
  symbol: string;
  optionType: 'call' | 'put' | null;
  strike: number | null;
  expiration: string | null;
  positionSide: 'long' | 'short';
  quantity: number;
  /** Fills at or after this (the import, less the clock slack). */
  enteredAt: number;
  /** Fills after this: the position's previous exit, when it had one. */
  after: number | null;
  /** When the sync booked the exit: the contract was gone by then. */
  createdAt: number;
}

/** Every fill that could have closed an imported options row, oldest first:
 *  its exact contract, on the closing side (a SELL for a long, a BUY for a
 *  short, never an order the broker marks as opening), inside its window. */
export function optionClosingFills(row: HandOptionWindow, fills: BrokerOptionFill[]): BrokerOptionFill[] {
  if (row.optionType === null || row.strike === null || row.expiration === null) return [];
  const closingSide = row.positionSide === 'short' ? 'BUY' : 'SELL';
  const symbol = row.symbol.toUpperCase();
  return fills
    .filter(
      (f) =>
        f.side === closingSide &&
        !(f.positionIntent ?? '').toUpperCase().endsWith('_TO_OPEN') &&
        f.underlying === symbol &&
        f.optionType === row.optionType &&
        Math.abs(f.strike - (row.strike as number)) < 1e-6 &&
        f.expiration === row.expiration &&
        f.filledAt >= row.enteredAt &&
        f.filledAt <= row.createdAt + FILL_CLOCK_SLACK_MS &&
        (row.after === null || f.filledAt > row.after),
    )
    .sort((a, b) => a.filledAt - b.filledAt);
}

/**
 * The fills that closed an imported options row, or null when the history
 * cannot say. PURE. Oldest first until they add up to exactly the booked
 * quantity; a fill another exit already booked is never booked twice. An
 * overshoot (the contract traded again) or a shortfall leaves the estimate.
 */
export function matchHandOptionClose(
  row: HandOptionWindow,
  fills: BrokerOptionFill[],
  claimed: ReadonlySet<string> = new Set(),
): { price: number; qty: number; filledAt: number; clientOrderIds: string[] } | null {
  let qty = 0;
  let notional = 0;
  const ids: string[] = [];
  for (const f of optionClosingFills(row, fills)) {
    if (claimed.has(f.clientOrderId)) continue;
    if (qty + f.filledQty > row.quantity + 1e-9) return null;
    qty += f.filledQty;
    notional += f.filledQty * f.filledPrice;
    ids.push(f.clientOrderId);
    if (Math.abs(qty - row.quantity) < 1e-9) {
      return { price: Math.round((notional / qty) * 10_000) / 10_000, qty, filledAt: f.filledAt, clientOrderIds: ids };
    }
  }
  return null;
}

/** The note on a corrected row. Like the other corrections' notes, it replaces
 *  the estimate note, so the row leaves the candidate set. */
export function handCorrectionNote(
  previousPrice: number,
  row: Pick<HandEstimatedExit, 'assetType' | 'positionSide'>,
): string {
  const what =
    row.assetType === 'option'
      ? "the fill that closed the contract in Webull's order history"
      : row.positionSide === 'short'
        ? "your buy to cover in Webull's order history"
        : "your sale in Webull's order history";
  return `Exit price corrected to ${what} (was ${previousPrice}, an estimate recorded by the Webull position sync).`;
}

/** Say once that an estimate stays one, with the fills the history held. */
function journalHandSkip(row: HandEstimatedExit, candidates: Record<string, unknown>[]): void {
  const already = listAutotradeEvents({
    stage: 'execution',
    symbol: row.symbol,
    actions: [HAND_EXIT_CORRECTION_SKIPPED],
    limit: 200,
  }).some((e) => {
    try {
      return (JSON.parse(e.detail ?? 'null') as { exitId?: unknown } | null)?.exitId === row.exitId;
    } catch {
      return false;
    }
  });
  if (already) return;
  logAutotradeEvent({
    symbol: row.symbol,
    stage: 'execution',
    action: HAND_EXIT_CORRECTION_SKIPPED,
    detail: {
      positionId: row.positionId,
      exitId: row.exitId,
      assetType: row.assetType,
      exitDate: row.exitDate,
      quantity: row.quantity,
      exitPrice: row.exitPrice,
      cause: 'no_matching_fill',
      why: 'no set of closing fills in the order history adds up to the quantity booked',
      fills: candidates.slice(0, 10),
    },
  });
}

/**
 * Correct the sync's estimated exits on positions the app did not open, over
 * the last seven days, to the fills the broker's history holds. Returns how
 * many were corrected. A new estimate is read on the next pass, the rest at
 * most every STOCK_EXIT_CORRECTION_INTERVAL_MS, and only while one exists.
 * Never throws toward the broker: a failed read is retried on a later pass.
 */
export async function correctEstimatedHandExits(accountId: string, now: number = Date.now()): Promise<number> {
  const since = etToday(now - STOCK_EXIT_CORRECTION_LOOKBACK_DAYS * DAY_MS);
  const today = etToday(now);
  const rows = listSyncEstimatedHandExits({ since, accountId }).filter((r) => !finalExitIds.has(r.exitId));
  if (rows.length === 0) return 0;
  const fresh = rows.some((r) => !seenExitIds.has(r.exitId));
  if (!fresh && now - lastPassAt < STOCK_EXIT_CORRECTION_INTERVAL_MS) return 0;
  lastPassAt = now;
  for (const r of rows) seenExitIds.add(r.exitId);

  const history = await listBrokerFills(accountId);
  if (!history.ok) return 0;
  const claimed = fillsClaimedByCorrections(now);
  let corrected = 0;
  // Oldest estimate first (the query's order), so a position closed in pieces
  // books each piece in turn and no fill is booked twice.
  for (const row of rows) {
    const enteredAt = row.positionCreatedAt - FILL_CLOCK_SLACK_MS;
    const after = previousExitBookedAt(row);
    const isOption = row.assetType === 'option';
    const optionWindow: HandOptionWindow = { ...row, enteredAt, after };
    // A stock close says what kind of order filled (a stop, a target, or a
    // plain order); an options fill does not, so its row keeps its reason.
    const stockSale = isOption
      ? null
      : matchSaleOutsideBracket({ ...row, after }, enteredAt, history.equity, intentExistsForKey, claimed);
    const match = isOption ? matchHandOptionClose(optionWindow, history.option, claimed) : stockSale;

    if (!match) {
      // The history lags a fill by minutes: asked again through the day of
      // the close, then left an estimate for good, and said so once.
      if (row.exitDate < today) {
        finalExitIds.add(row.exitId);
        const candidates = isOption
          ? optionClosingFills(optionWindow, history.option).map((f) => ({
              clientOrderId: f.clientOrderId,
              qty: f.filledQty,
              price: f.filledPrice,
              filledAt: f.filledAt,
            }))
          : history.equity
              .filter((f) => f.symbol === row.symbol.toUpperCase() && f.filledAt >= enteredAt)
              .map((f) => ({
                clientOrderId: f.clientOrderId,
                side: f.side,
                qty: f.filledQty,
                price: f.filledPrice,
                filledAt: f.filledAt,
                appOrder: intentExistsForKey(f.clientOrderId),
              }));
        journalHandSkip(row, candidates);
      }
      continue;
    }

    finalExitIds.add(row.exitId);
    for (const id of match.clientOrderIds) claimed.add(id);
    if (Math.abs(match.price - row.exitPrice) < PRICE_EPS) {
      correctExitPrice(row.exitId, row.exitPrice, confirmationNote(row.exitPrice, "Webull's order history"));
      continue;
    }
    const before = getPosition(row.positionId);
    const updated = correctExitPrice(
      row.exitId,
      match.price,
      handCorrectionNote(row.exitPrice, row),
      stockSale?.reason,
    );
    if (!updated) continue;
    corrected += 1;
    const multiplier = updated.multiplier ?? 1;
    const pnlDelta =
      (match.price - row.exitPrice) * row.quantity * multiplier * (row.positionSide === 'short' ? -1 : 1);
    logAutotradeEvent({
      symbol: row.symbol,
      stage: 'execution',
      action: HAND_EXIT_CORRECTED,
      detail: {
        positionId: row.positionId,
        exitId: row.exitId,
        assetType: row.assetType,
        exitDate: row.exitDate,
        quantity: row.quantity,
        fromPrice: row.exitPrice,
        toPrice: match.price,
        fillClientOrderIds: match.clientOrderIds,
        pnlDelta: Math.round(pnlDelta * 100) / 100,
        pnlBefore: before ? Math.round(realizedPnlOf(before) * 100) / 100 : null,
        pnlAfter: Math.round(realizedPnlOf(updated) * 100) / 100,
      },
    });
  }
  return corrected;
}

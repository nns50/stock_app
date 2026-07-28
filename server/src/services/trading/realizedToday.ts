import { db } from '../../db';
import { listKnownAccountIds } from '../../db/positions';
import { etToday } from '../../util/marketDate';

// ---------------------------------------------------------------------------
// Realized P&L booked TODAY, from our own records — the daily-loss halt's
// second opinion.
//
// Why this exists: the halt used to read the broker's `total_day_profit_loss`
// as if it were realized-only. A live capture (2026-07-28) settled that it is
// not — it moved 1:1 with open-position marks while no orders were placed. Fed
// straight into `daily_loss_halt`, that fails in BOTH directions: open
// drawdown that was never actually lost can trip the halt, and — worse — an
// open GAIN can mask a real realized loss, so the halt silently fails open on
// the day it was bought for.
//
// Neither available source is sufficient alone:
//
//   broker `day − unrealized`  account-wide (sees trades placed in the Webull
//                              app that we never journaled), but mis-decomposes
//                              for positions held overnight: `unrealized` is
//                              since ENTRY while `day` is since the OPEN, so
//                              prior days' unrealized P&L leaks into the
//                              difference.
//   this file (own book)       exact for every exit we recorded (real fills
//                              since #340), but blind to anything traded
//                              outside the app.
//
// So the halt takes the WORSE of the two (see webullAccountState). Each
// covers the other's blind spot; a disagreement halts rather than trades on.
//
// Scope: the account being traded. Rows with NO account recorded count only
// while no OTHER account is known — same single-account rule as
// closePositionsFromPreview and checkLiveBracketProtection (task #120): once a
// second account exists we cannot say which one an unassigned row belongs to.
// ---------------------------------------------------------------------------

export interface RealizedTodayBreakdown {
  /** Sum of both books, deduped. What the halt consumes. */
  totalUsd: number;
  /** From position_exits (journal: equities + imported/hand-logged options). */
  journalUsd: number;
  /** From autotrade_live_options_positions closes not already journaled. */
  liveOptionsUsd: number;
  journalExitCount: number;
  liveOptionsCloseCount: number;
}

interface JournalExitRow {
  exitPrice: number;
  exitFees: number;
  quantity: number;
  entryPrice: number;
  multiplier: number;
  side: string;
  assetType: string;
  symbol: string;
  strike: number | null;
  expiration: string | null;
  optionType: string | null;
}

interface LiveOptionRow {
  symbol: string;
  side: string;
  kind: string;
  strike: number;
  shortStrike: number | null;
  expiration: string;
  quantity: number;
  entryPrice: number;
  shortEntryPrice: number | null;
  exitPrice: number | null;
  shortExitPrice: number | null;
  exitAt: number | null;
}

/** Options contract identity, for deduping the same close recorded in both
 *  books (the positions sync imports broker option holdings into the journal,
 *  so a contract autotrade also tracks can be closed twice on paper). */
function contractKeyOf(symbol: string, optionType: string, strike: number, expiration: string): string {
  return `${symbol.toUpperCase()}|${optionType.toLowerCase()}|${strike}|${expiration}`;
}

const OPTION_MULTIPLIER = 100;

/**
 * Realized P&L from exits dated today (US market calendar), scoped to
 * `accountId`. Fees on the exits are netted; entry fees are not allocated
 * per-day (whole-position math lives in pnl.ts — this is a guardrail input,
 * not the journal's P&L).
 */
export function realizedTodayFromBook(accountId: string, now: number = Date.now()): RealizedTodayBreakdown {
  const today = etToday(now);
  const otherAccountKnown = listKnownAccountIds().some((a) => a !== accountId);
  const accountFilter = otherAccountKnown
    ? 'p.account_id = ?'
    : "(p.account_id = ? OR p.account_id IS NULL OR p.account_id = '')";

  // --- live options book first: its closes carry real fills and win dedup ---
  const optRows = db
    .prepare(
      `SELECT symbol, side, kind, strike, short_strike AS shortStrike, expiration, quantity,
              entry_price AS entryPrice, short_entry_price AS shortEntryPrice,
              exit_price AS exitPrice, short_exit_price AS shortExitPrice, exit_at AS exitAt
         FROM autotrade_live_options_positions p
        WHERE status = 'closed' AND exit_at IS NOT NULL AND ${accountFilter}`,
    )
    .all(accountId) as LiveOptionRow[];

  const closedContractKeys = new Set<string>();
  let liveOptionsUsd = 0;
  let liveOptionsCloseCount = 0;
  for (const r of optRows) {
    if (r.exitAt === null || etToday(r.exitAt) !== today) continue;
    if (r.exitPrice === null) continue; // closed without a usable price — nothing to book
    const perShare =
      r.kind === 'debit_spread'
        ? r.exitPrice - (r.shortExitPrice ?? 0) - (r.entryPrice - (r.shortEntryPrice ?? 0))
        : r.exitPrice - r.entryPrice;
    liveOptionsUsd += perShare * r.quantity * OPTION_MULTIPLIER;
    liveOptionsCloseCount++;
    closedContractKeys.add(contractKeyOf(r.symbol, r.side, r.strike, r.expiration));
    if (r.kind === 'debit_spread' && r.shortStrike !== null) {
      closedContractKeys.add(contractKeyOf(r.symbol, r.side, r.shortStrike, r.expiration));
    }
  }

  // --- journal exits dated today ------------------------------------------
  const journalRows = db
    .prepare(
      `SELECT e.exit_price AS exitPrice, e.fees AS exitFees, e.quantity,
              p.entry_price AS entryPrice, p.multiplier, p.side, p.asset_type AS assetType,
              p.symbol, p.strike, p.expiration, p.option_type AS optionType
         FROM position_exits e
         JOIN positions p ON p.id = e.position_id
        WHERE e.exit_date = ? AND ${accountFilter}`,
    )
    .all(today, accountId) as JournalExitRow[];

  let journalUsd = 0;
  let journalExitCount = 0;
  for (const r of journalRows) {
    // The same contract closed in the live options book today: one real-world
    // event recorded twice (the positions sync imports broker option holdings
    // into the journal). The live row carries the actual fills, so it wins.
    if (
      r.assetType === 'option' &&
      r.optionType !== null &&
      r.strike !== null &&
      r.expiration !== null &&
      closedContractKeys.has(contractKeyOf(r.symbol, r.optionType, r.strike, r.expiration))
    ) {
      continue;
    }
    const sign = r.side === 'short' ? -1 : 1;
    journalUsd += (r.exitPrice - r.entryPrice) * r.quantity * r.multiplier * sign - r.exitFees;
    journalExitCount++;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    totalUsd: round2(journalUsd + liveOptionsUsd),
    journalUsd: round2(journalUsd),
    liveOptionsUsd: round2(liveOptionsUsd),
    journalExitCount,
    liveOptionsCloseCount,
  };
}

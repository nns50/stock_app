import { Position } from '../db/positions';
import { realizedPnlOf } from './pnl';

// ---------------------------------------------------------------------------
// Wash-sale awareness for the Journal — flags a closed LOSS position where the
// same underlying (positions.symbol is always the underlying, even for
// options — option_type/strike/expiration are separate columns, see
// db/index.ts) was also entered within the 61-day wash-sale window (30 days
// before the loss's closing date, the closing day itself, and 30 days after —
// IRS Pub. 550, "substantially identical security"). Purely informational:
// this app never gates a trade on tax considerations, and doesn't attempt any
// cost-basis adjustment or Form 8949 math — just a pointer to go check with a
// tax professional. Deliberately does NOT try to match option-vs-option
// strike/expiration identity ("substantially identical" for two DIFFERENT
// option contracts is genuinely gray-area even under IRS guidance, unlike
// same-symbol matching, which the statute confirms unambiguously counts) —
// and doesn't know about positions in other brokers/accounts or IRAs, where
// the rule's consequences differ. This app only sees what's logged in it.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const WASH_SALE_WINDOW_DAYS = 30;

function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/** The date this position fully closed — its last exit, same "last exit"
 *  convention JournalPage.tsx already uses for display. Undefined for a
 *  still-open position (nothing to check yet). */
function closingDateOf(position: Position): string | undefined {
  if (position.exits.length === 0) return undefined;
  return position.exits[position.exits.length - 1].exitDate;
}

export interface WashSaleWarning {
  /** The other same-symbol position whose entry falls in the window. */
  triggerPositionId: number;
  triggerEntryDate: string;
  /** Signed days from this loss's closing date to the trigger's entry date —
   *  negative means the trigger was already open before the loss closed,
   *  positive means the symbol was reopened after. */
  daysApart: number;
}

/**
 * Whether `position` (a closed lot) may be wash-sale disallowed: it realized
 * a LOSS, and the SAME underlying symbol was also entered within 30 days
 * either side of when this loss closed. `sameSymbolPositions` is every OTHER
 * position (any status) sharing `position.symbol` — the caller's job to
 * fetch (e.g. grouping a full listPositions() by symbol), so this stays a
 * pure function over already-loaded data, same convention as dayGuard.ts.
 * Returns the FIRST match found, not every one — enough to flag the risk,
 * not to enumerate every possible trigger.
 */
export function detectWashSale(position: Position, sameSymbolPositions: Position[]): WashSaleWarning | null {
  if (position.status !== 'closed') return null;
  if (realizedPnlOf(position) >= 0) return null;
  const closingDate = closingDateOf(position);
  if (!closingDate) return null;

  for (const other of sameSymbolPositions) {
    if (other.id === position.id) continue;
    // A position with no known entry date cannot anchor a 61-day window, so it
    // can never be the trigger. daysBetween(date, null) is NaN and every
    // comparison against it is false, which would have reached the same
    // outcome by accident — stated explicitly so it stays deliberate.
    if (other.entryDate === null) continue;
    const daysApart = daysBetween(closingDate, other.entryDate);
    if (Math.abs(daysApart) <= WASH_SALE_WINDOW_DAYS) {
      return { triggerPositionId: other.id, triggerEntryDate: other.entryDate, daysApart };
    }
  }
  return null;
}

import { TriangleAlert } from 'lucide-react';
import { cx } from '../lib/format';
import type { AutotradeOptionsSignalSide, SymbolEvents } from '../api/types';

/** How close to $0/share a short leg's extrinsic (time) value has to be
 *  before assignment becomes a live risk rather than a theoretical one —
 *  once there's essentially no time value left, the holder loses nothing by
 *  exercising early, so whoever is short that contract can be assigned at
 *  any moment. $0.05/share is the common broker/analyst rule of thumb for
 *  "close enough to zero to matter." */
export const LOW_EXTRINSIC_THRESHOLD = 0.05;

/** Days-until-ex-dividend inside which a deep-ITM short call's early
 *  exercise becomes a real (not just textbook) risk. The classic
 *  dividend-capture trade is only rational the night before ex-div, but
 *  holders often act a few days early, so this stays a little wider than a
 *  single day. */
export const DIVIDEND_RISK_WINDOW_DAYS = 5;

/** Intrinsic value of a leg — the floor its mark can't fall below without
 *  being free money for whoever buys it. Null propagates when the
 *  underlying price isn't available, rather than fabricating a 0. */
export function intrinsicValue(
  side: AutotradeOptionsSignalSide,
  strike: number,
  underlyingPrice: number | null,
): number | null {
  if (underlyingPrice === null) return null;
  return side === 'call' ? Math.max(0, underlyingPrice - strike) : Math.max(0, strike - underlyingPrice);
}

/** Extrinsic (time) value remaining on a leg — mark minus intrinsic, floored
 *  at 0 for display (a mark can print fractionally below intrinsic on a
 *  wide/stale bid-ask without meaning anything). Null when the mark or the
 *  underlying price isn't available. */
export function extrinsicValue(
  side: AutotradeOptionsSignalSide,
  strike: number,
  mark: number | null,
  underlyingPrice: number | null,
): number | null {
  const intrinsic = intrinsicValue(side, strike, underlyingPrice);
  if (mark === null || intrinsic === null) return null;
  return Math.max(0, mark - intrinsic);
}

function daysUntil(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export interface AssignmentRiskBadgeProps {
  /** The SHORT leg's own side/strike/mark — this app never writes a naked
   *  call/put, so the only leg that can ever be assigned is a debit
   *  spread's short leg (see services/portfolioGreeks.ts's own doc
   *  comment). */
  side: AutotradeOptionsSignalSide;
  strike: number;
  mark: number | null;
  underlyingPrice: number | null;
  events?: SymbolEvents;
}

/** Passive, display-only warning on a short option leg — mirrors
 *  EarningsBadge's shape. Two distinct risks share the same low-extrinsic
 *  gate:
 *  - General assignment risk (either side): ITM with near-zero time value —
 *    the holder loses nothing by exercising early.
 *  - Dividend risk (short CALL only): the above, plus an imminent
 *    ex-dividend date — the classic dividend-capture early-exercise case.
 *    (A put's early-exercise driver is interest rates, a different
 *    mechanism not modeled here.)
 *  Renders nothing when the leg is out-of-the-money, still has real time
 *  value, or a needed price isn't available yet — this never warns on a
 *  guess. Not a precise dividend-vs-extrinsic-value comparison (the
 *  dividend's dollar amount isn't fetched) — informational only, confirm
 *  before acting. */
export function AssignmentRiskBadge({ side, strike, mark, underlyingPrice, events }: AssignmentRiskBadgeProps) {
  const intrinsic = intrinsicValue(side, strike, underlyingPrice);
  const extrinsic = extrinsicValue(side, strike, mark, underlyingPrice);
  if (intrinsic === null || extrinsic === null || intrinsic <= 0 || extrinsic > LOW_EXTRINSIC_THRESHOLD) return null;

  const exDte = daysUntil(events?.exDividendDate);
  const dividendRisk = side === 'call' && exDte !== null && exDte >= 0 && exDte <= DIVIDEND_RISK_WINDOW_DAYS;

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        dividendRisk ? 'bg-amber-500/15 text-amber-400' : 'bg-ink-600 text-slate-400',
      )}
      title={
        dividendRisk
          ? `Short leg is deep ITM with only ~$${extrinsic.toFixed(2)} extrinsic value left, and this symbol goes ex-dividend ${events?.exDividendDate} — the holder may exercise early to capture the dividend. Not a precise dividend-vs-extrinsic comparison; confirm the payout yourself.`
          : `Short leg is deep ITM with only ~$${extrinsic.toFixed(2)} extrinsic value left — little reason for the holder not to exercise early. General assignment risk, not tied to any specific event.`
      }
    >
      <TriangleAlert className="h-3 w-3" />
      {dividendRisk ? 'Div. assignment risk' : 'Assignment risk'}
    </span>
  );
}

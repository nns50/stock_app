import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { getAutotradeConfig } from '../../db/autotradeConfig';
import {
  LiveOptionsPosition,
  closeLiveOptionsPosition,
  listOpenLiveOptionsPositions,
} from '../../db/autotradeLiveOptionsPositions';
import { ExpiredOptionDisposition, ExpiringOption, classifyExpiredOptions, optionLabel } from '../expiredOptions';
import { etToday, resolveExpiryCloses } from '../expiredOptionsSweep';
import { dispatchNotifications } from '../notifier';

// ---------------------------------------------------------------------------
// Expired-but-still-open positions in autotrade's LIVE OPTIONS book.
//
// An option held THROUGH expiry never produces a closing order — nobody sells a
// contract that has ceased to exist — so nothing in the normal machinery ever
// closes the row. For the generic Positions ledger that is already handled by
// services/expiredOptionsSweep.ts. This book was not: it lives in its own table
// (autotrade_live_options_positions, structurally different because a debit
// spread needs a second leg's columns), and the sweep only ever read
// listPositions().
//
// All three mechanisms that should have caught it miss, each for its own
// reason:
//
//   1. The order-based reconcile has no order to poll — a closing order only
//      exists if checkLiveOptionsExits() actually managed to place one.
//   2. The broker-truth sync (syncLiveOptionsPositionsFromBroker) confirms the
//      contract is GONE, then needs a price to book the exit at. For a
//      past-expiration contract the chain no longer exists, so that price is
//      permanently unavailable and its `continue // retry next sync` never
//      terminates. Two facts arrive together — "positively gone" and "cannot
//      be priced" — and the second silently discards the first.
//   3. This sweep did not cover the table at all.
//
// A stuck row is not merely cosmetic. It counts toward combinedLiveOpenRisk()
// (liveExecute.ts), which BOTH books seed their budget from — so one expired
// options position permanently consumes shared aggregate-risk headroom and a
// concurrent-position slot from the EQUITY book too — and
// hasOpenLiveOptionsPosition() blocks any new options entry on that underlying
// for good.
//
// The disposition split is the pure classifier the Positions sweep already
// uses (services/expiredOptions.ts), deliberately reused rather than
// reimplemented: worthless is booked at $0 because that is a statement of fact,
// while in-the-money and undeterminable are flagged for a human and never
// auto-closed, since an exercised or assigned contract becomes a STOCK position
// this app does not model and inventing a cash exit would misstate both the P&L
// and the resulting holding.
// ---------------------------------------------------------------------------

/** One leg of a live options position, adapted onto the shared classifier's
 *  shape. `side` there means LONG/SHORT; this table's own `side` column means
 *  call/put, so it must not be passed straight through. Every autotrade options
 *  position is opened long the contract (a put for a bearish read rather than a
 *  short call), so the long leg is 'long' and a spread's written leg is
 *  'short'. */
interface LegRef extends ExpiringOption {
  position: LiveOptionsPosition;
  leg: 'long' | 'short';
}

function legsOf(pos: LiveOptionsPosition): LegRef[] {
  const base = {
    symbol: pos.symbol,
    expiration: pos.expiration,
    remainingQuantity: pos.quantity,
    optionType: pos.side,
    position: pos,
  };
  const legs: LegRef[] = [{ ...base, id: pos.id, side: 'long', strike: pos.strike, leg: 'long' }];
  // A debit spread's written leg expires too, and it is the one that turns a
  // clean expiry into an assignment. Classified on its own terms so the shared
  // pin-risk band applies to it as well.
  if (pos.kind === 'debit_spread' && pos.shortStrike !== null) {
    legs.push({ ...base, id: pos.id, side: 'short', strike: pos.shortStrike, leg: 'short' });
  }
  return legs;
}

export interface LiveOptionsExpiryOutcome {
  positionId: number;
  symbol: string;
  label: string;
  disposition: ExpiredOptionDisposition;
  reason: string;
  /** True when this call actually booked the $0 exit. */
  closed: boolean;
}

export interface LiveOptionsExpirySweepResult {
  examined: number;
  closed: LiveOptionsExpiryOutcome[];
  needsReview: LiveOptionsExpiryOutcome[];
}

/**
 * Sweep expired-but-open live options positions.
 *
 * Read-only toward the broker — it places and cancels nothing, and books a $0
 * exit only where the contract's value is unambiguously zero. Deliberately NOT
 * gated on TRADING_ENABLED or either kill switch, for the same reason the
 * reconcilers aren't: this records what already happened at expiry rather than
 * acting on the market, and a halted account still needs its books straight.
 *
 * Safe to run every tick: a closed position stops appearing as open, so a
 * later run simply finds fewer. A position needing review is re-examined each
 * time but only journaled once per (position, ET day) — enough for the
 * unresolved-order alert to keep surfacing it daily while it is still open,
 * without a journal entry every 60 seconds.
 */
export async function sweepExpiredLiveOptions(opts: { now?: number } = {}): Promise<LiveOptionsExpirySweepResult> {
  const today = etToday(opts.now);
  // Strictly BEFORE today, matching findExpiredOpenOptions: a contract is
  // tradeable all through its own expiration day, and checkLiveOptionsExits may
  // still place a real close for it.
  const expired = listOpenLiveOptionsPositions().filter((p) => p.expiration < today);
  if (expired.length === 0) return { examined: 0, closed: [], needsReview: [] };

  const legs = expired.flatMap(legsOf);
  const findings = classifyExpiredOptions(legs, await resolveExpiryCloses(legs));

  // Re-associate each leg's finding with its position. A position is only
  // worthless when EVERY leg is: for a debit spread, one leg finishing in the
  // money means exercise or assignment, which produces a stock position and
  // needs a human regardless of what the other leg did.
  const byPosition = new Map<number, { pos: LiveOptionsPosition; findings: typeof findings }>();
  findings.forEach((f, i) => {
    const pos = legs[i].position;
    const entry = byPosition.get(pos.id) ?? { pos, findings: [] };
    entry.findings.push(f);
    byPosition.set(pos.id, entry);
  });

  const closed: LiveOptionsExpiryOutcome[] = [];
  const needsReview: LiveOptionsExpiryOutcome[] = [];
  // Only the ones flagged for the FIRST time today get pushed — see the
  // dispatch below. A needs-review row is never auto-closed, so it is still
  // here on every subsequent tick.
  const newlyFlagged: LiveOptionsExpiryOutcome[] = [];

  for (const { pos, findings: legFindings } of byPosition.values()) {
    const label = optionLabel({
      symbol: pos.symbol,
      strike: pos.strike,
      optionType: pos.side,
      expiration: pos.expiration,
    });
    // Report the most serious leg — an ITM leg is what a human needs to act on,
    // and an unknown one is what stops us acting at all.
    const blocking =
      legFindings.find((f) => f.disposition === 'in_the_money') ?? legFindings.find((f) => f.disposition === 'unknown');

    if (blocking) {
      const outcome: LiveOptionsExpiryOutcome = {
        positionId: pos.id,
        symbol: pos.symbol,
        label,
        disposition: blocking.disposition,
        reason: blocking.reason,
        closed: false,
      };
      if (!alreadyFlaggedToday(pos.id)) {
        logAutotradeEvent({
          symbol: pos.symbol,
          stage: 'execution',
          action: 'live_options_expired_needs_review',
          detail: {
            positionId: pos.id,
            label,
            kind: pos.kind,
            disposition: blocking.disposition,
            reason: blocking.reason,
          },
          riskProfile: pos.riskProfile,
        });
        newlyFlagged.push(outcome);
      }
      needsReview.push(outcome);
      continue;
    }

    // Every leg finished clearly out of the money: the position is worth zero,
    // and for a spread that is true of the net as well (both legs expire with
    // no intrinsic value, so there is nothing to exercise on either side).
    const done = closeLiveOptionsPosition(pos.id, {
      exitPrice: 0,
      shortExitPrice: pos.kind === 'debit_spread' ? 0 : undefined,
      // Reusing 'manual' rather than adding an 'expired' reason: the column's
      // CHECK constraint only permits time_exit/manual, and widening it would
      // need a full table rebuild on every existing database for a value whose
      // detail is already carried in the journal entry below. Same choice the
      // broker-sync close (liveOptionsExecute.ts) already makes.
      exitReason: 'manual',
    });
    if (!done) {
      // Already closed between the read and the write — not an error.
      continue;
    }
    logAutotradeEvent({
      symbol: pos.symbol,
      stage: 'execution',
      action: 'live_options_expired_worthless',
      detail: {
        positionId: pos.id,
        label,
        kind: pos.kind,
        reason: legFindings.map((f) => f.reason).join('; '),
        note: 'Closed at $0 by the expired-options sweep — the contract expired out of the money and no longer exists.',
      },
      riskProfile: pos.riskProfile,
    });
    closed.push({
      positionId: pos.id,
      symbol: pos.symbol,
      label,
      disposition: 'worthless',
      reason: legFindings.map((f) => f.reason).join('; '),
      closed: true,
    });
  }

  // PUSH the ones that need a human. This is the sweep's only outcome that
  // someone has to act on, and until 2026-09-05 it was the one thing here that
  // never left the journal: an expired IN-THE-MONEY contract has been exercised
  // or assigned, so the account now holds a STOCK position this app does not
  // model, while a far smaller event — an auto-tuned risk-% nudge — already
  // pushes on the stated grounds that it is "consequential enough to surface
  // immediately, not just discoverable later on Recent Activity".
  //
  // It also tends to happen at the worst time to be reading a journal: expiry
  // is Friday's close, and a 0DTE contract only reaches it because the hard
  // time exit failed to place.
  //
  // Gated on newlyFlagged, which the once-per-day journal guard above already
  // computes — a needs-review row is never auto-closed, so notifying off
  // `needsReview` itself would re-push on every tick for as long as it sits
  // there. One message for all of them, not one each.
  if (newlyFlagged.length > 0) {
    const lines = newlyFlagged.map(
      (o) =>
        `${o.label} — ${o.disposition === 'in_the_money' ? 'expired IN THE MONEY' : 'disposition unknown'} (${o.reason})`,
    );
    await dispatchNotifications([
      {
        title: `Autotrade: ${newlyFlagged.length} expired option position${newlyFlagged.length === 1 ? '' : 's'} need review`,
        message:
          `${lines.join('; ')}. An in-the-money expiry is exercised or assigned, so the account may now hold ` +
          `stock this app does not track — check the broker and close the position by hand.`,
      },
    ]);
  }

  return { examined: expired.length, closed, needsReview };
}

/**
 * Has this position already been flagged for review today?
 *
 * A position a human hasn't dealt with yet stays expired-and-open indefinitely,
 * and the sweep re-examines it every tick. Journaling each time would write an
 * entry a minute and drown the very alert it is meant to raise; journaling only
 * once ever would let a genuinely stuck position go quiet after one mention.
 * Once per ET day is the middle: the unresolved-order alert re-raises it daily
 * while it is still open, and stops on its own once it is resolved.
 *
 * Deliberately uses the REAL clock rather than the sweep's injectable `now`.
 * The two answer different questions: `now` decides which contracts have
 * expired (so a test — or a backfill — can reason about a date in the past),
 * while this is about how recently we last wrote to the journal, and journal
 * entries are always stamped with the real time. Comparing a real-time stamp
 * against a simulated day would never match, and the throttle would silently
 * do nothing.
 */
function alreadyFlaggedToday(positionId: number): boolean {
  const today = etToday();
  return listAutotradeEvents({
    stage: 'execution',
    actions: ['live_options_expired_needs_review'],
    limit: 200,
  }).some((e) => {
    if (etToday(e.createdAt) !== today) return false;
    try {
      return (JSON.parse(e.detail ?? '{}') as { positionId?: unknown }).positionId === positionId;
    } catch {
      return false;
    }
  });
}

/** Whether the sweep has anything to do at all — lets the loop skip the candle
 *  fetch entirely on the overwhelmingly common tick where nothing has expired. */
export function hasExpiredLiveOptions(now: number = Date.now()): boolean {
  if (!getAutotradeConfig().liveAccountId) return false;
  const today = etToday(now);
  return listOpenLiveOptionsPositions().some((p) => p.expiration < today);
}

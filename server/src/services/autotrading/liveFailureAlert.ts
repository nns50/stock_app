import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';

// ---------------------------------------------------------------------------
// Live-order anomaly alerting — two independent alerts over the same journal:
//
//   maybeAlertLiveOrderFailures  a RUN of broker rejections (nothing is
//                                getting through right now)
//   maybeAlertLiveAmbiguity      a single UNRESOLVED order state (our records
//                                and the broker may already disagree)
//
// Both are throttled and derived entirely from the append-only journal. See
// the AMBIGUITY_ACTIONS block below for why the second one is separate rather
// than more actions added to the first.
//
// The sub-penny bracket bug rejected 2000+ live entries before anyone noticed,
// because nothing surfaced a SYSTEMIC run of live-order rejections — only a
// successful placement (and a kill-switch engage) ever pushed a notification.
// This closes that gap: when live orders keep getting rejected in a row, one
// throttled alert fires through the SAME Slack/Discord/webhook infra the rest
// of the app already uses.
//
// Scope is deliberately the BROKER/QUOTE REJECTION class (`*_failed`) — an
// order we actually tried to place and the broker (or a missing quote) refused
// — NOT guardrail BLOCKS (`*_blocked`), which are the system correctly
// refusing (a kill switch, a daily cap): those are expected, and the kill
// switch already alerts on its own engage. A one-off rejection is normal market
// friction; a RUN of them means something is systemically wrong (a bad price, a
// broker/account problem, a config error) and no live trades are getting
// through.
//
// Derived entirely from the append-only journal (restart-safe; no separate
// counter that could drift from what actually happened): count consecutive
// rejections since the last successful placement, alert once at the threshold,
// then re-remind at most hourly until a success resets the streak.
// ---------------------------------------------------------------------------

/** A real live order the broker REJECTED (webullPlaceOrder returned !ok), or a
 *  close we couldn't even price — the anomaly class this alert exists for. */
export const FAILURE_ACTIONS = [
  'live_entry_failed',
  'live_options_entry_failed',
  'live_options_exit_failed',
  // Equity time-exits were missing here. A blocked or failed CLOSE is strictly
  // worse than a blocked entry — an entry that doesn't happen costs nothing,
  // while a close that doesn't happen leaves a real position open past the hold
  // limit, and (before the cancel/place reorder) could leave one with no stop at
  // all. It repeats every tick, so without these it repeated silently.
  'live_time_exit_blocked',
  'live_time_exit_failed',
  'live_time_exit_cancel_failed',
];
/** A real live order that reached the broker — resets the failure streak. */
const SUCCESS_ACTIONS = ['live_order_placed', 'live_options_order_placed', 'live_time_exit_placed'];
/** Our own "we alerted" marker, journaled so the throttle survives a restart. */
const ALERT_ACTION = 'live_failure_alerted';

// ---------------------------------------------------------------------------
// The AMBIGUITY class — a separate alert with separate semantics.
//
// Every one of these is journaled by a branch that resolved an UNKNOWN by
// deferring: a placement whose outcome we never learned, an order retired
// because the broker denied knowing it, a fill the shared guards refused to
// book, a bracket whose exit legs both claimed FILLED, a fill recorded at the
// broker that then failed to reach our ledger. Each of those code paths
// justifies its conservative choice with some variant of "recoverable, and
// loudly journaled for a human to notice" — but until now nothing turned the
// journal entry into anything a human would actually see, so the premise was
// false and the recovery never started.
//
// Deliberately NOT folded into the rejection streak above, because the two
// have opposite reset semantics. A rejection streak is about a CURRENT
// condition (nothing is getting through right now), so a later success
// genuinely clears it. An ambiguity is about a PAST fact that a later success
// does nothing to resolve: shares the broker filled and our ledger never
// booked stay unbooked no matter how many orders work afterwards. So this
// alerts on the FIRST occurrence rather than at a threshold, counts only what
// arrived since the last ambiguity alert (never re-counting what a previous
// alert already reported), and is never reset by anything but being reported.
// ---------------------------------------------------------------------------

/** A branch that resolved an unknown by deferring — see the block comment. */
export const AMBIGUITY_ACTIONS = [
  // We never heard back from the broker on a real placement. The order may be
  // working, filled, or never have landed; the intent is deliberately left
  // non-terminal so reconcile can settle it by client order id.
  'live_order_outcome_unknown',
  'live_options_order_outcome_unknown',
  // ...and the resolution of the above: the broker positively denied knowing
  // the order, so it was retired. Worth surfacing because it is inferred from
  // absence (an unindexed or paged-out order looks identical), not observed.
  'live_order_never_placed',
  'live_options_order_never_placed',
  // A broker fill our own guards refused to book in full (fillDelta.ts). Real
  // shares exist that the ledger, the risk caps and P&L cannot see.
  'live_fill_not_fully_materialized',
  'live_options_fill_not_fully_materialized',
  // The broker reported a fill and writing it to our ledger then threw. The
  // intent already moved on, so nothing retries an entry — permanent drift.
  'live_entry_materialization_failed',
  'live_exit_materialization_failed',
  'live_time_exit_materialization_failed',
  'live_options_materialization_failed',
  // Two bracket exit legs both reported FILLED. The position was left open
  // rather than guessed closed, so our ledger and the account may disagree
  // about whether it is still on.
  'live_exit_ambiguous',
  // The broker used an order status the mapper has never seen. Any fill it
  // reported is still booked, but the order's lifecycle state is now whatever
  // it was before — so what the broker thinks this order is doing and what we
  // think are not the same thing. Journaled once per intent+status, not once
  // per 60s tick, so a persistently stuck order can't flood this.
  'live_broker_status_unrecognized',
  'live_options_broker_status_unrecognized',
  // A real closing order was priced off a contract's LAST TRADE because no
  // two-sided quote existed. It was still placed (refusing would guarantee the
  // drift-to-expiration this exit exists to prevent), but a stale-high print
  // puts the sell limit above where the contract can actually be sold, so the
  // close can rest unfilled while looking, from outside, like nothing happened.
  'live_options_exit_stale_quote',
  // An options position expired while still open and could NOT be booked at $0:
  // it finished in the money (so it was exercised or assigned, creating a stock
  // position this app doesn't model) or its outcome couldn't be determined.
  // Left open deliberately rather than closed at a guessed price — which means
  // the ledger is knowingly carrying a position that no longer exists in the
  // form it records, so it needs a human. Journaled once per position per ET
  // day, so this re-raises daily while it stays unresolved.
  'live_options_expired_needs_review',
  // A live position opened WITH a bracket has no resting exit-side order at the
  // broker. Its stop may never have been accepted (the place response can't
  // tell us) or was cancelled since. The ledger still shows a stop price, so
  // nothing else in the app would ever reveal this. Journaled once per position
  // per ET day, so it re-raises daily while the position is still naked.
  'live_position_unprotected',
];
/** Our own "we alerted about ambiguity" marker — same restart-safe throttle. */
const AMBIGUITY_ALERT_ACTION = 'live_ambiguity_alerted';
/** An unresolved ambiguity is reported on its FIRST occurrence: unlike a
 *  rejection (normal market friction until it repeats), one of these already
 *  means real exposure the ledger can't account for. */
export const LIVE_AMBIGUITY_ALERT_THRESHOLD = 1;
/** While ambiguities keep arriving, re-remind at most this often. */
export const LIVE_AMBIGUITY_REALERT_COOLDOWN_MS = 60 * 60_000;

/** Fire once this many live orders are rejected in a row. A single rejection is
 *  normal; a run of them is systemic. */
export const LIVE_FAILURE_ALERT_THRESHOLD = 3;
/** While a failing streak persists, re-remind at most this often — so a
 *  multi-hour outage pages again, but the same streak never spams. */
export const LIVE_FAILURE_REALERT_COOLDOWN_MS = 60 * 60_000;

function reasonOf(detail: string | null): string {
  if (!detail) return 'no reason reported';
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    if (typeof parsed.reason === 'string' && parsed.reason) return parsed.reason;
  } catch {
    // detail wasn't JSON — use it verbatim.
  }
  return detail;
}

/**
 * Surface a systemic run of live-order rejections through the notifier. Reads
 * the journal (newest-first), counts consecutive rejections since the last
 * successful placement, and — if that count is at/above the threshold and we
 * haven't already alerted for this same streak within the cooldown — dispatches
 * one alert and journals a marker. A success between rejections resets
 * everything. Best-effort and never throws (dispatchNotifications() is itself a
 * no-op with zero channels configured). Returns true iff it dispatched.
 *
 * `now` is injectable for tests.
 */
export async function maybeAlertLiveOrderFailures(now: number = Date.now()): Promise<boolean> {
  // Only the live-order OUTCOME + our own alert-marker events, newest-first —
  // filtering by action (not just stage) so the window reliably reaches back
  // past the last alert marker even during heavy execution-event activity.
  const events = listAutotradeEvents({
    stage: 'execution',
    actions: [...FAILURE_ACTIONS, ...SUCCESS_ACTIONS, ALERT_ACTION],
    limit: 100,
  });

  let consecutiveFailures = 0;
  let latest: { symbol: string | null; reason: string } | null = null;
  let lastAlertAt: number | null = null;
  for (const e of events) {
    if (SUCCESS_ACTIONS.includes(e.action)) break; // the streak ends at the most recent real placement
    if (e.action === ALERT_ACTION) {
      if (lastAlertAt === null) lastAlertAt = e.createdAt; // most recent alert in THIS streak
      continue;
    }
    // A failure action.
    consecutiveFailures++;
    if (!latest) latest = { symbol: e.symbol, reason: reasonOf(e.detail) };
  }

  if (consecutiveFailures < LIVE_FAILURE_ALERT_THRESHOLD) return false;
  // Already alerted for this (post-success) streak and still within the cooldown.
  if (lastAlertAt !== null && now - lastAlertAt < LIVE_FAILURE_REALERT_COOLDOWN_MS) return false;

  const symbol = latest?.symbol ?? 'unknown';
  const reason = latest?.reason ?? 'no reason reported';
  // Journal the marker BEFORE dispatching so the throttle holds even if the
  // dispatch is slow and another tick runs (the journal is the source of truth).
  logAutotradeEvent({
    stage: 'execution',
    action: ALERT_ACTION,
    detail: { consecutiveFailures, latestSymbol: symbol, latestReason: reason },
  });
  await dispatchNotifications([
    {
      title: 'Autotrade live orders failing',
      message:
        `⚠️ ${consecutiveFailures} live order attempts REJECTED in a row — no live trades are ` +
        `getting through. Latest: ${symbol} — ${reason}. Check the Auto-Trade page.`,
    },
  ]);
  return true;
}

/** A one-line "what actually happened" per ambiguity action, so the alert says
 *  what to go and check rather than just naming an event. */
const AMBIGUITY_SUMMARY: Record<string, string> = {
  live_order_outcome_unknown: 'a live order was sent but the broker never answered',
  live_options_order_outcome_unknown: 'a live options order was sent but the broker never answered',
  live_order_never_placed: 'an unknown-outcome order was retired — the broker denies knowing it',
  live_options_order_never_placed: 'an unknown-outcome options order was retired — the broker denies knowing it',
  live_fill_not_fully_materialized: 'a broker fill could not be fully booked into the ledger',
  live_options_fill_not_fully_materialized: 'a broker options fill could not be fully booked into the ledger',
  live_entry_materialization_failed: 'an entry filled at the broker but writing the position failed',
  live_exit_materialization_failed: 'an exit filled at the broker but recording the close failed',
  live_time_exit_materialization_failed: 'a time-exit filled at the broker but recording the close failed',
  live_options_materialization_failed: 'an options fill was recorded at the broker but not in the ledger',
  live_exit_ambiguous: 'two bracket exit legs both reported FILLED — the position was left open',
  live_broker_status_unrecognized: 'the broker reported an order status this app does not recognize',
  live_options_broker_status_unrecognized: 'the broker reported an options order status this app does not recognize',
  live_options_exit_stale_quote: 'a closing order was priced off a stale last trade and may rest unfilled',
  live_options_expired_needs_review:
    'an options position expired in the money or undeterminable — it needs your broker statement',
  live_position_unprotected: 'a live position has NO resting stop at the broker despite being opened with one',
};

/**
 * Surface UNRESOLVED AMBIGUITIES through the notifier — the branches that
 * deferred an unknown rather than guessing at it (see AMBIGUITY_ACTIONS).
 *
 * Reads the journal newest-first, counts the ambiguity events that arrived
 * SINCE the last ambiguity alert (so an alert never re-reports what an earlier
 * one already covered, and the alerting naturally stops once they stop
 * arriving), and dispatches if the cooldown has elapsed. Unlike the rejection
 * streak above, a successful placement does NOT reset this: a fill the ledger
 * never booked stays unbooked regardless of what happens afterwards.
 *
 * Best-effort and never throws. Returns true iff it dispatched. `now` is
 * injectable for tests.
 */
export async function maybeAlertLiveAmbiguity(now: number = Date.now()): Promise<boolean> {
  const events = listAutotradeEvents({
    stage: 'execution',
    actions: [...AMBIGUITY_ACTIONS, AMBIGUITY_ALERT_ACTION],
    limit: 100,
  });

  let unreported = 0;
  let latest: { symbol: string | null; action: string; reason: string } | null = null;
  let lastAlertAt: number | null = null;
  for (const e of events) {
    // The most recent marker ends the window — everything older was already
    // reported by that alert.
    if (e.action === AMBIGUITY_ALERT_ACTION) {
      lastAlertAt = e.createdAt;
      break;
    }
    unreported++;
    if (!latest) latest = { symbol: e.symbol, action: e.action, reason: reasonOf(e.detail) };
  }

  if (unreported < LIVE_AMBIGUITY_ALERT_THRESHOLD) return false;
  if (lastAlertAt !== null && now - lastAlertAt < LIVE_AMBIGUITY_REALERT_COOLDOWN_MS) return false;

  const symbol = latest?.symbol ?? 'unknown';
  const action = latest?.action ?? 'unknown';
  const what = AMBIGUITY_SUMMARY[action] ?? 'a live order outcome could not be resolved';
  // Journal the marker BEFORE dispatching, same reasoning as the rejection
  // alert: the journal is the throttle's source of truth.
  logAutotradeEvent({
    stage: 'execution',
    action: AMBIGUITY_ALERT_ACTION,
    detail: { unreported, latestSymbol: symbol, latestAction: action, latestReason: latest?.reason ?? null },
  });
  await dispatchNotifications([
    {
      title: 'Autotrade: unresolved live order state',
      message:
        `⚠️ ${unreported} live order${unreported === 1 ? '' : 's'} in an UNRESOLVED state — the app's ` +
        `records may not match the broker. Latest: ${symbol} — ${what}. ` +
        `Reconcile against your broker and check the Auto-Trade page's journal.`,
    },
  ]);
  return true;
}

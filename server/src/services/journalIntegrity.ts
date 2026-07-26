import { Position } from '../db/positions';
import { etToday } from '../util/marketDate';

// ---------------------------------------------------------------------------
// Read-only audit of the trade journal.
//
// Every check here corresponds to a way a row could already be wrong — a bug
// that has since been fixed writes nothing new, but repairs nothing it wrote
// either. The numbers on the Positions page, the Journal's expectancy, and the
// CSV/tax export are all computed from these rows, so a bad one is not cosmetic:
// it is a wrong input to a decision.
//
// The failure mode this exists for is SILENCE. Nothing in the UI can show you
// that an exit is dated a day late, that a position's exits overrun its own
// size, or that a lot lost the account it belongs to — each of those renders as
// a perfectly ordinary row. This module's whole job is to make them say so.
//
// PURE AND READ-ONLY, deliberately and permanently. It imports no write
// function, holds no db handle, and has no --apply counterpart: deciding what a
// row SHOULD say is a judgement call about someone's real trading record, and
// several of these have more than one defensible repair (is a future-dated exit
// a typo, or a genuinely mis-recorded date?). It reports, names the row, and
// stops. Repair is a separate, deliberate act.
// ---------------------------------------------------------------------------

export type IntegrityCheckId =
  | 'non_iso_date'
  | 'utc_dated_by_background_writer'
  | 'exit_before_entry'
  | 'future_dated'
  | 'exits_exceed_quantity'
  | 'status_disagrees_with_remaining'
  | 'nonpositive_entry_price'
  | 'nonpositive_exit_quantity'
  | 'broker_tracked_without_account';

export type IntegritySeverity = 'high' | 'medium';

export interface IntegrityFinding {
  check: IntegrityCheckId;
  severity: IntegritySeverity;
  positionId: number;
  symbol: string;
  /** What is wrong with THIS row, with its own values named. */
  detail: string;
  /** The correct value, only where the check can derive it with certainty
   *  (today: just the UTC-dating one, whose fingerprint carries the answer).
   *  Never applied by anything — this module writes nothing. */
  suggested?: string;
}

export interface IntegrityCheck {
  id: IntegrityCheckId;
  severity: IntegritySeverity;
  title: string;
  /** Why a row failing this matters — printed above its rows in the report. */
  why: string;
  count: number;
}

export interface IntegrityReport {
  generatedAt: number;
  /** The market date the report was run against (ET, see util/marketDate.ts). */
  marketDate: string;
  positionsExamined: number;
  exitsExamined: number;
  checks: IntegrityCheck[];
  findings: IntegrityFinding[];
  /** True when nothing was found. */
  clean: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar date at an instant — what the pre-2026-07-26 background
 *  writers used as "today". Only ever used to RECOGNISE their output. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Mirrors providers/webull/positions.ts's isWebullTracked(). Inlined rather
 * than imported to keep this module free of the provider/broker-client graph —
 * same mirroring the Positions page already does, for the same reason.
 */
function isBrokerTracked(p: Position): boolean {
  return p.tags.includes('webull') || p.tags.includes('live') || p.sourceIntentId !== null;
}

/**
 * Notes written by the two background writers that used to date rows in UTC:
 * the Webull position sync and the live-order reconciler. The expiry sweep is
 * absent on purpose — it dates its exits on the EXPIRATION, not on "today", so
 * it was never affected.
 *
 * Prefix-matched because both append per-row detail (a broker order id, the
 * reason a contract was called worthless).
 */
const BACKGROUND_EXIT_NOTES = ['Auto-closed via Webull sync', 'Auto-recorded from live close order'];
const BACKGROUND_ENTRY_NOTE = 'Auto-recorded from live order';

function writtenByBackgroundJob(notes: string | null, prefixes: string[]): boolean {
  return notes !== null && prefixes.some((prefix) => notes.startsWith(prefix));
}

const CHECK_META: Record<IntegrityCheckId, { severity: IntegritySeverity; title: string; why: string }> = {
  non_iso_date: {
    severity: 'high',
    title: 'Date is not YYYY-MM-DD',
    why:
      'Journal dates are compared as plain strings — hold-time buckets, the wash-sale window, the ' +
      'equity curve’s ordering and the tax export all sort and subtract them directly. A non-ISO ' +
      'date does not merely display wrong; every statistic derived from it is wrong too.',
  },
  utc_dated_by_background_writer: {
    severity: 'high',
    title: 'Dated a day late by a background job (UTC vs ET)',
    why:
      'Until 2026-07-26 the Webull sync and the order reconciler dated rows off the server’s UTC ' +
      'clock. On a UTC-deployed box that is already tomorrow from 20:00 ET onward, so any run in ' +
      'that window recorded the trade on the following day: wrong bucket in the weekday and daily ' +
      'stats, an extra day of hold time, and a row sorted past its own session in the equity curve. ' +
      'Detection is exact rather than heuristic — a row is flagged only when its date equals the ' +
      'UTC date at the moment it was written AND that differs from the market date, which is true ' +
      'of every affected row and of no correctly-dated one.',
  },
  exit_before_entry: {
    severity: 'high',
    title: 'Exit dated before its own entry',
    why: 'Produces negative hold time and a negative wash-sale window, poisoning both breakdowns.',
  },
  future_dated: {
    severity: 'medium',
    title: 'Dated in the future',
    why:
      'A trade cannot have happened after today. It sorts past every real row at the end of the ' +
      'equity curve and lands in a period that has not occurred.',
  },
  exits_exceed_quantity: {
    severity: 'high',
    title: 'Exits close more than the position ever held',
    why:
      'remainingQuantity clamps at zero, so this is invisible on screen — the position simply reads ' +
      'as closed. Realized P&L is booked against the full overrun, so the reported profit or loss ' +
      'is for a larger trade than was ever taken.',
  },
  status_disagrees_with_remaining: {
    severity: 'high',
    title: 'Status contradicts the remaining quantity',
    why:
      'Open/closed drives which tab a row appears on, whether it counts toward open exposure and ' +
      'the risk caps, and whether the Journal treats it as a completed trade. A disagreement means ' +
      'one of those is counting it wrongly.',
  },
  nonpositive_entry_price: {
    severity: 'high',
    title: 'Entry price is zero or negative',
    why:
      'Cost basis becomes zero, so the entire market value books as unrealized “gain” and return % ' +
      'and R-multiple go null. The create route refuses these now; older rows and rows restored ' +
      'through the pre-2026-07-26 import were never checked.',
  },
  nonpositive_exit_quantity: {
    severity: 'high',
    title: 'Exit closes zero or negative quantity',
    why: 'Contributes nothing to the position’s remaining size while still carrying fees and P&L.',
  },
  broker_tracked_without_account: {
    severity: 'medium',
    title: 'Broker-tracked position with no account recorded',
    why:
      'With more than one account known, the position sync deliberately refuses to act on a lot it ' +
      'cannot attribute — so this row is never auto-closed when it sells at the broker, and drifts ' +
      'until reconciled by hand. A common cause is a restore or a delete-Undo taken before ' +
      '2026-07-26, when the import route silently dropped accountId.',
  },
};

/** Every date on a position and its exits, labelled for the report. */
function datesOf(p: Position): { label: string; value: string }[] {
  const out = [{ label: 'entry date', value: p.entryDate }];
  if (p.expiration) out.push({ label: 'expiration', value: p.expiration });
  for (const e of p.exits) out.push({ label: `exit #${e.id} date`, value: e.exitDate });
  return out;
}

/**
 * Audit `positions` (pass the WHOLE book — the account checks reason about
 * which accounts exist across all of it) and return everything wrong with it.
 *
 * `now` is injectable so the date checks are testable at a fixed instant.
 */
export function analyzeJournal(positions: Position[], now: number = Date.now()): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const marketDate = etToday(now);
  const add = (check: IntegrityCheckId, p: Position, detail: string, suggested?: string) =>
    findings.push({
      check,
      severity: CHECK_META[check].severity,
      positionId: p.id,
      symbol: p.symbol,
      detail,
      suggested,
    });

  // Known accounts across the whole book — a single-account setup is not a
  // problem (an unassigned lot can only belong to the one account), so the
  // account check below only fires once a second one exists.
  const knownAccounts = new Set(positions.map((p) => p.accountId).filter((a): a is string => !!a));

  for (const p of positions) {
    // The UTC-dating checks run FIRST so the generic date scan below can defer
    // to them. A row a background job dated tomorrow is also, trivially,
    // "dated in the future" — but that is the same defect seen twice, and
    // listing it under both headings inflates the count and splits one fix
    // across two entries. The specific finding wins; it also names the
    // correct value, which the generic one can't.
    const explained = new Set<string>();

    // The entry side of the UTC-dating bug: a position the reconciler created
    // from a live fill.
    if (writtenByBackgroundJob(p.notes, [BACKGROUND_ENTRY_NOTE])) {
      const shouldBe = etToday(p.createdAt);
      if (p.entryDate === utcDate(p.createdAt) && p.entryDate !== shouldBe) {
        add('utc_dated_by_background_writer', p, `entry dated ${p.entryDate}, recorded on ${shouldBe} (ET)`, shouldBe);
        explained.add('entry date');
      }
    }
    for (const e of p.exits) {
      if (!writtenByBackgroundJob(e.notes, BACKGROUND_EXIT_NOTES)) continue;
      const shouldBe = etToday(e.createdAt);
      if (e.exitDate === utcDate(e.createdAt) && e.exitDate !== shouldBe) {
        add(
          'utc_dated_by_background_writer',
          p,
          `exit #${e.id} dated ${e.exitDate}, recorded on ${shouldBe} (ET)`,
          shouldBe,
        );
        explained.add(`exit #${e.id} date`);
      }
    }

    for (const { label, value } of datesOf(p)) {
      if (!ISO_DATE.test(value)) add('non_iso_date', p, `${label} is "${value}"`);
      else if (value > marketDate && !explained.has(label)) {
        add('future_dated', p, `${label} is ${value}, after today (${marketDate})`);
      }
    }

    if (p.entryPrice <= 0) add('nonpositive_entry_price', p, `entry price is ${p.entryPrice}`);

    let exited = 0;
    for (const e of p.exits) {
      exited += e.quantity;
      if (e.quantity <= 0) add('nonpositive_exit_quantity', p, `exit #${e.id} closes ${e.quantity}`);
      if (ISO_DATE.test(e.exitDate) && ISO_DATE.test(p.entryDate) && e.exitDate < p.entryDate) {
        add('exit_before_entry', p, `exit #${e.id} dated ${e.exitDate}, entry is ${p.entryDate}`);
      }
    }

    if (exited > p.quantity + 1e-9) {
      add('exits_exceed_quantity', p, `exits close ${exited} of a ${p.quantity} position`);
    }

    const shouldBeClosed = p.remainingQuantity <= 1e-9;
    if (shouldBeClosed !== (p.status === 'closed')) {
      add(
        'status_disagrees_with_remaining',
        p,
        `status is "${p.status}" with ${p.remainingQuantity} of ${p.quantity} remaining`,
      );
    }

    if (p.status === 'open' && p.accountId === null && isBrokerTracked(p) && knownAccounts.size > 0) {
      add('broker_tracked_without_account', p, `open and broker-tracked, but no account recorded`);
    }
  }

  const counts = new Map<IntegrityCheckId, number>();
  for (const f of findings) counts.set(f.check, (counts.get(f.check) ?? 0) + 1);

  return {
    generatedAt: now,
    marketDate,
    positionsExamined: positions.length,
    exitsExamined: positions.reduce((s, p) => s + p.exits.length, 0),
    // Every check is listed with its count, including the zeroes — "we looked
    // and found none" is a different statement from "we didn't look", and this
    // report's entire purpose is not to leave that ambiguous.
    checks: (Object.keys(CHECK_META) as IntegrityCheckId[]).map((id) => ({
      id,
      ...CHECK_META[id],
      count: counts.get(id) ?? 0,
    })),
    findings,
    clean: findings.length === 0,
  };
}

import { addExit, listPositions, Position } from '../db/positions';
import { getProvider } from '../providers';
import { ExpiredOptionFinding, classifyExpiredOptions, findExpiredOpenOptions, optionLabel } from './expiredOptions';

// ---------------------------------------------------------------------------
// The I/O half of the expired-option sweep: resolve each expired-but-open
// option's underlying close on its expiry date, book the ones that
// unambiguously expired worthless, and hand back everything that needs a human.
//
// The classification itself is pure (services/expiredOptions.ts). This module
// only fetches prices and performs the writes.
// ---------------------------------------------------------------------------

/** Today (YYYY-MM-DD) on the US market calendar. Expiry is an ET concept, and
 *  on a UTC-deployed box local "today" is already tomorrow for part of the
 *  session — which would sweep positions on their own expiration day. */
export function etToday(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface ExpiredOptionsSweepResult {
  /** Expired-but-open option positions examined. */
  examined: number;
  /** Positions closed at $0 because they unambiguously expired worthless. */
  closed: ExpiredOptionFinding[];
  /** Left open on purpose — needs a human (in the money, or undeterminable). */
  needsReview: ExpiredOptionFinding[];
}

/**
 * Fetch each symbol's daily closes around the expiry dates in play, and build a
 * lookup of (symbol, date) → close. One candle request per symbol, covering the
 * whole span needed, rather than one per position.
 *
 * A symbol whose history can't be fetched simply produces no entries, which the
 * classifier reads as "unknown" and flags — never as worthless.
 */
async function buildCloseLookup(positions: Position[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bySymbol = new Map<string, string[]>();
  for (const p of positions) {
    if (!p.expiration) continue;
    const list = bySymbol.get(p.symbol) ?? [];
    list.push(p.expiration);
    bySymbol.set(p.symbol, list);
  }

  const provider = getProvider();
  for (const [symbol, dates] of bySymbol) {
    const earliest = dates.reduce((a, b) => (a < b ? a : b));
    try {
      // A small lead-in so a weekend/holiday expiry can fall back to the prior
      // session's close below.
      const start = shiftDays(earliest, -7);
      const candles = await provider.getCandles(symbol, 'daily', { start });
      for (const c of candles) {
        const day = new Date(c.time).toISOString().slice(0, 10);
        out.set(`${symbol}|${day}`, c.close);
      }
    } catch {
      // Leave this symbol absent — the classifier flags it rather than guessing.
    }
  }
  return out;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the underlying close for a position's expiry date, walking back up to
 * a few days when that exact date has no bar (a Saturday-dated expiry, or a
 * market holiday). Returns null when nothing usable is within reach, which the
 * classifier treats as unknown.
 */
function closeAtExpiry(closes: Map<string, number>, p: Position): number | null {
  if (!p.expiration) return null;
  for (let back = 0; back <= 5; back++) {
    const day = shiftDays(p.expiration, -back);
    const hit = closes.get(`${p.symbol}|${day}`);
    if (hit !== undefined && Number.isFinite(hit) && hit > 0) return hit;
  }
  return null;
}

/**
 * Sweep expired-but-open option positions.
 *
 * Books a $0 exit for each one that unambiguously expired worthless, and
 * returns everything else for review rather than guessing at it. Safe to run
 * repeatedly: a closed position no longer appears as open, so the next run
 * simply finds fewer.
 *
 * `dryRun` classifies without writing — what the UI banner uses so a user can
 * see what WOULD be closed before anything is.
 */
export async function sweepExpiredOptions(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<ExpiredOptionsSweepResult> {
  const today = etToday(opts.now);
  const expired = findExpiredOpenOptions(listPositions({ status: 'open', assetType: 'option' }), today);
  if (expired.length === 0) return { examined: 0, closed: [], needsReview: [] };

  const closes = await buildCloseLookup(expired);
  const findings = classifyExpiredOptions(expired, (p) => closeAtExpiry(closes, p));

  const closed: ExpiredOptionFinding[] = [];
  const needsReview: ExpiredOptionFinding[] = [];

  for (const f of findings) {
    if (f.disposition !== 'worthless') {
      needsReview.push(f);
      continue;
    }
    if (opts.dryRun) {
      closed.push(f);
      continue;
    }
    // Dated on the expiration itself, not today — that IS when the position
    // ceased to exist, and the journal's realized P&L should fall in the period
    // it actually belongs to rather than whenever this sweep happened to run.
    const result = addExit(f.positionId, {
      quantity: f.remainingQuantity,
      exitPrice: 0,
      exitDate: f.expiration,
      notes: `Expired worthless — auto-recorded by the expired-option sweep (${f.reason})`,
    });
    if (result) closed.push(f);
    else
      needsReview.push({
        ...f,
        disposition: 'unknown',
        reason: 'the $0 exit could not be recorded — the position may have changed since it was read',
      });
  }

  return { examined: expired.length, closed, needsReview };
}

/** Label helper re-exported so routes/UI can describe a position consistently. */
export { optionLabel };

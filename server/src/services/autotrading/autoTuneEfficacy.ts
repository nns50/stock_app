import { listPositions, Position } from '../../db/positions';
import { computeJournalStats, JournalStats } from '../pnl';
import { listAutotradeEvents } from '../../db/autotradeEvents';

// ---------------------------------------------------------------------------
// Did auto-tune's own past risk-% adjustments (autoTune.ts) actually help?
// Reports before/after realized-trade stats around each adjustment's own
// date — informational only, by design: this does NOT auto-revert a change
// that looks bad, for the same statistical-soundness reason autoTune.ts
// itself waits for autoTuneMinTrades before acting on a Kelly reading in the
// first place — judging "did this help" off however few trades have closed
// since a recent adjustment would be noise-chasing, not signal, and telling
// a genuine bad adjustment apart from an unrelated regime shift is genuinely
// hard. A human reviewing the numbers stays in the loop; the system never
// silently walks its own sizing back.
//
// Scoped to autotrade's OWN positions (isAutotradePosition below), not the
// whole journal the way routes/journal.ts's /stats and /benchmark are —
// deliberately: a risk-% change only ever affects autotrade's own sizing, so
// a manually-placed trade's outcome has nothing to say about whether it
// helped. Same "autotrade-scoped, not account-wide" reasoning riskCheck.ts's
// own header comment gives for getPortfolioSnapshot().
// ---------------------------------------------------------------------------

/** Duplicated from riskCheck.ts's own (unexported) copy rather than
 *  imported — riskCheck.ts has no reason to depend on this file, and this is
 *  the same small-pure-helper-duplication convention already used between
 *  riskCheck.ts/liveExecute.ts/execute.ts for this exact helper. */
const isAutotradePosition = (p: Position): boolean => p.tags.includes('autotrade');

/** Today's date (YYYY-MM-DD) in US/Eastern, NOT UTC — same "trading day"
 *  convention riskCheck.ts's/autoTune.ts's own etDateStr() copies use
 *  (duplicated here for the same circular-import-avoidance reason). UTC
 *  midnight falls at 7-8pm ET, squarely inside typical after-hours activity,
 *  so a UTC-based split would misclassify any event in that window. */
function etDateStr(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface RiskAdjustedEventDetail {
  from: number;
  to: number;
  kellySuggested: number;
  sampleSize: number;
}

export interface RiskAdjustmentEfficacy {
  eventId: number;
  /** Epoch ms the adjustment was made. */
  adjustedAt: number;
  from: number;
  to: number;
  /** What Kelly suggested (and the sample size behind it) at the moment of
   *  this specific adjustment — not recomputed with hindsight. */
  kellySuggestedAtTheTime: number;
  sampleSizeAtTheTime: number;
  /** Full journal-stats breakdown (same shape the Journal page's own Kelly
   *  panel already uses) for autotrade's own trades entered BEFORE this
   *  adjustment — i.e. sized under the OLD riskPerTradePct. */
  before: JournalStats;
  /** Same, for trades entered ON OR AFTER this adjustment — sized under the
   *  NEW riskPerTradePct. Naturally shrinks toward empty for a very recent
   *  adjustment; that's the sample-size fields telling you it's too soon to
   *  read anything into it, not a bug. */
  after: JournalStats;
}

/** Every past auto_tune_risk_adjusted event (newest first, matching
 *  listAutotradeEvents' own convention), each paired with a before/after
 *  split of autotrade's own closed trades by ENTRY date — entry date, not
 *  exit date, since riskPerTradePct governs sizing at entry; a trade opened
 *  before the change still reflects the OLD sizing even if it happens to
 *  close afterward. */
export function computeAutoTuneRiskEfficacy(limit = 20): RiskAdjustmentEfficacy[] {
  const events = listAutotradeEvents({ stage: 'config', actions: ['auto_tune_risk_adjusted'], limit });
  if (events.length === 0) return [];

  const closed = listPositions({ status: 'closed' }).filter(isAutotradePosition);
  return events.map((e) => {
    const detail = e.detail ? (JSON.parse(e.detail) as RiskAdjustedEventDetail) : null;
    const adjustedDate = etDateStr(e.createdAt);
    // An undated trade cannot be attributed to either side of an adjustment,
    // so it counts toward neither. Left in both (or, as `null < date` would
    // have it, silently all in `after`) would misattribute the adjustment's
    // effect to trades that may predate it.
    const dated = closed.filter((p): p is typeof p & { entryDate: string } => p.entryDate !== null);
    const before = dated.filter((p) => p.entryDate < adjustedDate);
    const after = dated.filter((p) => p.entryDate >= adjustedDate);
    return {
      eventId: e.id,
      adjustedAt: e.createdAt,
      from: detail?.from ?? 0,
      to: detail?.to ?? 0,
      kellySuggestedAtTheTime: detail?.kellySuggested ?? 0,
      sampleSizeAtTheTime: detail?.sampleSize ?? 0,
      before: computeJournalStats(before),
      after: computeJournalStats(after),
    };
  });
}

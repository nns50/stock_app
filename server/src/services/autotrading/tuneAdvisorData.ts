import { getAutotradeConfig } from '../../db/autotradeConfig';
import { getLastEdgeLeakScan } from '../../db/edgeLeakScans';
import { listDailyResults } from '../../db/dailyResults';
import { listPositions } from '../../db/positions';
import { listLiveOptionsPositions } from '../../db/autotradeLiveOptionsPositions';
import { buildSessionPaths, goalInR, isActiveSession, simulateSession } from './dailyTargetSweep';
import { collectBook, DEFAULT_LOOKBACK_SESSIONS, realizedEdgeOf } from './dailyTargetSweepData';
import { dailyGoalEvidence } from './targetTune';
import { buildSizingReview, sizingChangedOn } from './gatedSwitchesData';
import { buildTuneAdvice, TuneAdvice } from './tuneAdvisor';

// ---------------------------------------------------------------------------
// The DB half of the tune advisor: assemble the readings it ranks against.
//
// Nothing here COLLECTS anything new. The goal evidence, the edge-leak scan and
// the review window are all already being kept for their own reasons; the
// advisor's whole contribution is putting them in one frame and ranking what
// they imply. That is deliberate — a recommender with its own private data
// source is a recommender whose numbers can disagree with the cards the
// operator is already reading.
// ---------------------------------------------------------------------------

export function buildTuneAdviceFromDb(
  now: number = Date.now(),
  lookbackSessions = DEFAULT_LOOKBACK_SESSIONS,
): TuneAdvice {
  const config = getAutotradeConfig();
  const closedAutotrade = listPositions({ status: 'closed' }).filter((p) => p.tags.includes('autotrade'));
  const liveOptionsClosed = listLiveOptionsPositions({ status: 'closed' });
  const book = collectBook('live', lookbackSessions, now, { closed: closedAutotrade, liveOptionsClosed });

  // The goal rate, counted the way the dashboard and the sweep count it — one
  // derivation, so the advisor can never quote a rate the goal card disagrees
  // with (CLAUDE.md: two places deriving the same quantity must agree by
  // construction).
  const storedTargetR = goalInR(config.targetDailyGainPct, config.riskPerTradePct);
  const { paths } = buildSessionPaths(book.trades, book.sessionDates);
  const active = paths.filter(isActiveSession);
  const goalReachedSessions =
    storedTargetR === null ? 0 : active.filter((p) => simulateSession(p, 'bank', storedTargetR).reached).length;

  return buildTuneAdvice({
    config,
    evidence: dailyGoalEvidence(realizedEdgeOf(book), config.riskPerTradePct, config.targetDailyGainPct, {
      storedTargetR,
      goalReachedSessions,
      activeSessionsCounted: active.length,
    }),
    scan: getLastEdgeLeakScan()?.result ?? null,
    review: buildSizingReview(listDailyResults(), sizingChangedOn(now)),
    asOf: now,
  });
}

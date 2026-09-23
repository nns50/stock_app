import { describe, it, expect } from 'vitest';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';
import {
  buildTuneAdvice,
  fieldForUntakenReason,
  liveDifferenceOnSameEntryR,
  REVIEW_SESSIONS,
  SAME_TICK_MIN_PAIRS,
  TuneAdvisorInput,
} from '../src/services/autotrading/tuneAdvisor';

// ---------------------------------------------------------------------------
// A recommender is only useful if it can be wrong out loud, so these tests are
// about the three things that keep it honest: every estimate goes through the
// app's own identity, an execution defect outranks a small distribution finding
// whatever the arithmetic says, and nothing that would widen exposure mid-trial
// is ever presented as actionable.
// ---------------------------------------------------------------------------

const CONFIG = { ...defaultAutotradeConfig(), riskPerTradePct: 2.5, targetDailyGainPct: 3, liveMinSignalScore: 72 };

function evidence(over: Record<string, unknown> = {}) {
  return {
    avgR: 0.05,
    rTrades: 100,
    tradesPerSession: 4,
    sessions: 40,
    activeSessions: 20,
    sessionsWithoutEntries: 20,
    droppedTrades: 0,
    remappedEvents: 0,
    eventsOutsideWindow: 0,
    lookbackSessions: 40,
    reliable: true,
    impliedDailyGainPct: 0.5,
    targetOverImplied: 6,
    storedTargetR: 1.2,
    goalReachedSessions: 4,
    activeSessionsCounted: 20,
    goalRatePct: 20,
    ...over,
  } as TuneAdvisorInput['evidence'];
}

function scan(over: Record<string, unknown> = {}) {
  return {
    asOf: 1,
    lookbackSessions: 40,
    books: ['live', 'paper'],
    leaks: [],
    watches: [],
    findings: [],
    dimensions: [],
    dayLevel: {
      activeSessions: 20,
      sessions: 40,
      storedTargetR: 1.2,
      goalReachedSessions: 4,
      goalRatePct: 20,
      oneRSessions: 4,
      redSessions: 0,
      meanRedSessionR: null,
      worstSessionR: null,
      redSessionDrivers: [],
    },
    attribution: {
      pairedTrades: 20,
      meanDiffR: -0.1,
      ciLow: null,
      ciHigh: null,
      pValue: null,
      meanEntrySlippagePct: 0.2,
      untaken: [],
      pairs: [],
      // No same-tick reading by default, so paper's R is used as it stands and
      // the flow tests below are not also testing the live pricing.
      sameTick: { n: 0, meanDiffR: null, ciLow: null, ciHigh: null },
      optionsExcluded: { live: 0, paper: 0 },
    },
    coverage: {
      liveTrades: 100,
      paperTrades: 120,
      liveDropped: 0,
      paperDropped: 0,
      sessions: 40,
      extensionQuality: { measured: 0, staleBars: 0, unusable: 0 },
    },
    ...over,
  } as unknown as NonNullable<TuneAdvisorInput['scan']>;
}

const advise = (over: Partial<TuneAdvisorInput> = {}) =>
  buildTuneAdvice({
    config: CONFIG,
    evidence: evidence(),
    scan: scan(),
    review: {
      activeSessionsSinceChange: 20,
      meanDayPct: 0.4,
      goalRatePct: 20,
      goalRateJudgedSessions: 20,
      meanRedDayPct: null,
      worstDayPct: null,
      haltsMaxIn5: 0,
    },
    asOf: 1,
    ...over,
  });

describe('the gap is the frame', () => {
  it('decomposes the identity rather than just naming the shortfall', () => {
    const { gap } = advise();
    expect(gap).toMatchObject({
      targetDailyGainPct: 3,
      impliedDailyGainPct: 0.5,
      gapPct: 2.5,
      tradesPerSession: 4,
      riskPerTradePct: 2.5,
      avgR: 0.05,
      storedTargetR: 1.2,
    });
  });

  it('carries the review clock as a FIELD, distinct from the lookback window', () => {
    // The daily routine reports this number every evening. Before it was a
    // field it existed only inside a blocked recommendation's statusReason,
    // so on a day with nothing blocked the routine had nothing to read --
    // a consumer written against a value the producer never emitted.
    const { gap } = advise({
      evidence: evidence({ activeSessionsCounted: 20 }),
      review: {
        activeSessionsSinceChange: 3,
        meanDayPct: 0.4,
        goalRatePct: 20,
        goalRateJudgedSessions: 3,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 0,
      },
    });
    expect(gap.activeSessions).toBe(20);
    expect(gap.activeSessionsSinceChange).toBe(3);
    expect(gap.reviewSessionsRequired).toBe(REVIEW_SESSIONS);
  });

  it('says when the identity disagrees with what the book actually produced', () => {
    // The identity uses the CONFIGURED risk %. Every sizing modifier cuts and
    // none raises, so it runs high — measured at 0.95% realized against 1.25%
    // configured on 2026-09-12, a third too generous. Nothing compared the
    // estimate to the recorded days, so nothing said so.
    const a = advise({
      evidence: evidence({ impliedDailyGainPct: 0.5 }),
      recordedDayPcts: [0.1, 0.2, 0.05, -0.1, 0.15, 0.2],
    });
    expect(a.gap.measuredMeanDayPct).toBeCloseTo(0.1, 2);
    expect(a.gap.measuredSessions).toBe(6);
    expect(a.headline).toMatch(/identity estimates 0\.5% a day; the book has actually produced 0\.1%/);
    expect(a.headline).toMatch(/trust the measurement/);
  });

  it('stays quiet when the estimate and the measurement agree', () => {
    const a = advise({
      evidence: evidence({ impliedDailyGainPct: 0.5 }),
      recordedDayPcts: [0.5, 0.52, 0.48, 0.51, 0.49, 0.5],
    });
    expect(a.headline).not.toMatch(/trust the measurement/);
  });

  it('will not second-guess the identity on a handful of sessions', () => {
    // Four recorded days is noise, not a calibration.
    const a = advise({
      evidence: evidence({ impliedDailyGainPct: 0.5 }),
      recordedDayPcts: [0.01, 0.02, 0.0, -0.3],
    });
    expect(a.gap.measuredSessions).toBe(4);
    expect(a.headline).not.toMatch(/trust the measurement/);
  });

  it('says so plainly when no scan has run', () => {
    expect(advise({ scan: null }).headline).toMatch(/No edge-leak scan has run yet/);
  });

  it('refuses to place the book against its goal without closed trades', () => {
    const a = advise({ evidence: evidence({ avgR: null, impliedDailyGainPct: null, tradesPerSession: null }) });
    expect(a.headline).toMatch(/Not enough closed trades/);
  });
});

describe('every estimate goes through the identity', () => {
  it('sizes a refused flow class as trades/session x risk% x its paper R', () => {
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.3, paperTotalR: 6 }],
        },
      }),
    });
    const rec = a.recommendations.find((r) => r.id === 'flow:live_score_floor_skipped');
    // 20 trades / 20 active sessions = 1.0 per session x 2.5% x 0.3R = 0.75 pts
    expect(rec?.expectedDayPctDelta).toBeCloseTo(0.75, 3);
    expect(rec?.factor).toBe('flow');
    expect(rec?.action).toMatchObject({ kind: 'config', field: 'liveMinSignalScore', direction: 'exposure' });
  });

  it('spreads a leak over the WHOLE book, not just its own bucket', () => {
    const a = advise({
      scan: scan({
        leaks: [
          {
            dimension: 'round',
            dimensionLabel: 'Round within symbol-day',
            bucket: '2',
            n: 23,
            meanR: -0.24,
            ciLow: -0.4,
            ciHigh: -0.05,
            totalPnlUsd: -132,
            severityR: 5,
            verdict: 'leak',
            lever: {
              kind: 'config',
              field: 'symbolReentryCooldownMinutes',
              value: 390,
              direction: 'safe',
              detail: 'one entry per symbol per session',
            },
          },
        ],
      }),
    });
    const rec = a.recommendations.find((r) => r.id === 'edge:round:2');
    // 5R over 100 live trades = +0.05R avg, x 4 trades/session x 2.5% = 0.5 pts.
    // Using the bucket's own -0.24R mean would have overstated it fivefold.
    expect(rec?.expectedDayPctDelta).toBeCloseTo(0.5, 3);
    expect(rec?.action).toMatchObject({ kind: 'config', field: 'symbolReentryCooldownMinutes', to: 390 });
  });

  const extensionLeak = {
    dimension: 'pctOfRange',
    dimensionLabel: 'Entry as % of session range',
    bucket: '70-85',
    n: 20,
    meanR: -0.4,
    ciLow: -0.8,
    ciHigh: -0.03,
    totalPnlUsd: -101,
    severityR: 8,
    verdict: 'leak' as const,
    lever: null,
  };

  it('will not rank an extension cut while the window still holds impossible readings', () => {
    // 2026-09-14. pctOfRange divides an entry price by a session range, and
    // before that date the two were measured at different moments: five of the
    // first 43 live readings put the price outside its own range, FCX by 30
    // percentage points of it. Those rows are dropped from the buckets, but a
    // window that still contains them cannot support a cut at 50/70/85 — which
    // band a trade fell in was partly chosen by measurement error. The
    // non-monotonic first read (<50 -0.08, 50-70 -0.11, 70-85 -0.40, 85+ +0.18)
    // is what that looks like from the outside.
    const a = advise({
      scan: scan({
        leaks: [extensionLeak],
        coverage: { ...scan().coverage, extensionQuality: { measured: 38, staleBars: 6, unusable: 5 } },
      }),
    });
    const rec = a.recommendations.find((r) => r.id === 'edge:pctOfRange:70-85');
    expect(rec?.status).toBe('needs_data');
    expect(rec?.statusReason).toMatch(/outside 0-100% of their own session range/);
  });

  it('ranks the same extension leak once the window is all post-fix readings', () => {
    // The other half: the downgrade must be about the DATA, not about the
    // dimension. With nothing unusable in the window the same leak is
    // actionable — otherwise the guard would bury the finding forever and read
    // as "extension is never a lever", which is not what the evidence says.
    const a = advise({
      scan: scan({
        leaks: [extensionLeak],
        coverage: { ...scan().coverage, extensionQuality: { measured: 43, staleBars: 6, unusable: 0 } },
      }),
    });
    expect(a.recommendations.find((r) => r.id === 'edge:pctOfRange:70-85')?.status).toBe('actionable');
  });

  it('leaves a dimension that is not measured against a session range alone', () => {
    // Only pctOfRange and vwapExtension divide a price by a range; a round or
    // score-band leak in the same window is unaffected by how stale the bars
    // were.
    const a = advise({
      scan: scan({
        leaks: [{ ...extensionLeak, dimension: 'round', dimensionLabel: 'Round within symbol-day', bucket: '2' }],
        coverage: { ...scan().coverage, extensionQuality: { measured: 38, staleBars: 6, unusable: 5 } },
      }),
    });
    expect(a.recommendations.find((r) => r.id === 'edge:round:2')?.status).toBe('actionable');
  });

  it('will not rank "unexplained" flow when the journal read was truncated', () => {
    // no_live_row means "the live journal says nothing". That is only evidence
    // of a recording gap if the journal was read IN FULL. On 2026-09-12 the
    // scan read 1,000 of 1,928 skip rows, so the bucket filled with entries
    // whose skip simply was not fetched — and this recommendation went out as
    // the top-ranked, strong-confidence item.
    const untaken = [{ reason: 'no_live_row', n: 102, paperMeanR: 0.0155, paperTotalR: 1.5841 }];
    const complete = advise({
      scan: scan({ attribution: { ...scan().attribution, untaken } }),
    });
    const truncated = advise({
      scan: scan({
        attribution: { ...scan().attribution, untaken },
        coverage: { ...scan().coverage, journalSkipsTruncated: true },
      }),
    });
    const a = complete.recommendations.find((r) => r.id === 'flow:no_live_row');
    const b = truncated.recommendations.find((r) => r.id === 'flow:no_live_row');
    expect(a?.status).not.toBe('needs_data');
    expect(b?.status).toBe('needs_data');
    expect(b?.statusReason).toMatch(/truncated/);
    // And it stops inflating "everything measurable adds N points".
    expect(truncated.headline).not.toEqual(complete.headline);
  });

  it('still trusts a NAMED skip reason when the read was truncated', () => {
    // Truncation makes "the journal said nothing" unreliable. It does not make
    // a skip the journal DID name unreliable — that row was read.
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.3, paperTotalR: 6 }],
        },
        coverage: { ...scan().coverage, journalSkipsTruncated: true },
      }),
    });
    expect(a.recommendations.find((r) => r.id === 'flow:live_score_floor_skipped')?.status).not.toBe('needs_data');
  });

  it('never invents a number for an execution defect', () => {
    const a = advise({
      scan: scan({
        findings: [
          {
            id: 'execution:live_options_exit_failed',
            kind: 'execution',
            label: 'An options exit could not be placed',
            count: 12,
            detail: '12 in the last 10 sessions',
            lever: null,
          },
        ],
      }),
    });
    const rec = a.recommendations[0];
    expect(rec.factor).toBe('execution');
    expect(rec.expectedDayPctDelta).toBeNull();
    expect(rec.action.kind).toBe('code');
  });
});

describe('ranking', () => {
  it('puts an execution defect above a larger-looking distribution finding', () => {
    const a = advise({
      scan: scan({
        findings: [
          {
            id: 'execution:live_position_unprotected',
            kind: 'execution',
            label: 'A live position had no resting stop',
            count: 1,
            detail: '1 in the last 10 sessions',
            lever: null,
          },
        ],
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_score_floor_skipped', n: 40, paperMeanR: 0.5, paperTotalR: 20 }],
        },
      }),
    });
    // The flow finding estimates at 2.5 points — far bigger on paper — and the
    // single unprotected position still outranks it. A broken stop is not a
    // distribution.
    expect(a.recommendations[0].factor).toBe('execution');
    expect(a.recommendations[1].expectedDayPctDelta).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // …but only while the defect is still HAPPENING. The first production read
  // (2026-09-12) returned 261 options exit failures, 147 refused scale-outs,
  // 62 blocked stop ratchets and 11 bracket re-arms as the top four
  // actionable items — every one of them from before the fix that closed it,
  // still inside the ten-session window and ranked as tonight's work. Nine
  // more evenings of that is how a reader learns to skip the section.
  // -------------------------------------------------------------------------
  const executionFinding = (over: Record<string, unknown> = {}) => ({
    id: 'execution:live_options_exit_failed',
    kind: 'execution',
    label: 'An options exit could not be placed',
    count: 261,
    detail: '261 in the last 10 sessions',
    lever: null,
    ...over,
  });

  it('drops an execution class below the measurable findings once it stops recurring', () => {
    const a = advise({
      scan: scan({
        findings: [executionFinding({ lastSeenEtDate: '2026-09-11', sessionsSinceLastSeen: 1 })],
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.3, paperTotalR: 6 }],
        },
      }),
    });
    expect(a.recommendations[0].factor).toBe('flow');
    const exec = a.recommendations.find((r) => r.factor === 'execution');
    // Still present — dormant is not the same as fixed, and the scan has no
    // evidence a deploy happened.
    expect(exec).toBeDefined();
    expect(exec?.sessionsSinceLastSeen).toBe(1);
    expect(exec?.statusReason).toMatch(/last occurred 2026-09-11, 1 session\(s\) ago/);
    expect(exec?.action.detail).toMatch(/Check whether the fix for this landed after 2026-09-11/);
  });

  it('keeps a class seen in the LATEST session at the top', () => {
    const a = advise({
      scan: scan({
        findings: [executionFinding({ lastSeenEtDate: '2026-09-12', sessionsSinceLastSeen: 0 })],
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.3, paperTotalR: 6 }],
        },
      }),
    });
    expect(a.recommendations[0].factor).toBe('execution');
    expect(a.recommendations[0].sessionsSinceLastSeen).toBe(0);
  });

  it('does not let a dormant class claim the headline, but does mention it', () => {
    const a = advise({
      scan: scan({
        findings: [executionFinding({ lastSeenEtDate: '2026-09-11', sessionsSinceLastSeen: 1 })],
      }),
    });
    expect(a.headline).not.toMatch(/outrank/);
    expect(a.headline).toMatch(/1 execution class\(es\) in the window but not in the latest session — confirm fixed/);
  });

  it('treats an unknown recency as current — silence is not evidence of a fix', () => {
    const a = advise({ scan: scan({ findings: [executionFinding()] }) });
    expect(a.recommendations[0].factor).toBe('execution');
    expect(a.recommendations[0].sessionsSinceLastSeen).toBeNull();
    expect(a.headline).toMatch(/outrank/);
  });

  it('orders the estimable ones by size', () => {
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [
            { reason: 'symbol_cooldown_skipped', n: 10, paperMeanR: 0.1, paperTotalR: 1 },
            { reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.4, paperTotalR: 8 },
          ],
        },
      }),
    });
    expect(a.recommendations.map((r) => r.id)).toEqual([
      'flow:live_score_floor_skipped',
      'flow:symbol_cooldown_skipped',
    ]);
  });
});

describe('the review rule holds the exposure recommendations', () => {
  const withFlow = {
    scan: scan({
      attribution: {
        ...scan().attribution,
        untaken: [{ reason: 'live_score_floor_skipped', n: 20, paperMeanR: 0.3, paperTotalR: 6 }],
      },
    }),
  };

  it('blocks a widening mid-trial and names the session count that unblocks it', () => {
    const a = advise({
      ...withFlow,
      review: {
        activeSessionsSinceChange: 3,
        meanDayPct: 0.2,
        goalRatePct: 10,
        goalRateJudgedSessions: 3,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 0,
      },
    });
    const rec = a.recommendations[0];
    expect(rec.status).toBe('blocked_by_review');
    expect(rec.statusReason).toMatch(new RegExp(`${REVIEW_SESSIONS}-session review \\(3 so far\\)`));
  });

  it('lets it through once the review window is complete', () => {
    const a = advise({
      ...withFlow,
      review: {
        activeSessionsSinceChange: REVIEW_SESSIONS,
        meanDayPct: 0.2,
        goalRatePct: 10,
        goalRateJudgedSessions: REVIEW_SESSIONS,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 0,
      },
    });
    expect(a.recommendations[0].status).toBe('actionable');
  });

  it('does NOT hold a leak that cuts — the review guards widening, not plugging a hole', () => {
    const a = advise({
      review: {
        activeSessionsSinceChange: 1,
        meanDayPct: 0.2,
        goalRatePct: 10,
        goalRateJudgedSessions: 1,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 0,
      },
      scan: scan({
        leaks: [
          {
            dimension: 'round',
            dimensionLabel: 'Round',
            bucket: '2',
            n: 23,
            meanR: -0.24,
            ciLow: -0.4,
            ciHigh: -0.05,
            totalPnlUsd: -132,
            severityR: 5,
            verdict: 'leak',
            lever: { kind: 'config', field: 'symbolReentryCooldownMinutes', value: 390, direction: 'safe', detail: '' },
          },
        ],
      }),
    });
    expect(a.recommendations[0].status).toBe('actionable');
  });

  it('marks an unconfirmed leak as needing data rather than as a change', () => {
    const a = advise({
      scan: scan({
        leaks: [
          {
            dimension: 'weekday',
            dimensionLabel: 'Weekday',
            bucket: 'Mon',
            n: 16,
            meanR: -0.2,
            ciLow: -0.4,
            ciHigh: -0.02,
            totalPnlUsd: -50,
            severityR: 3,
            verdict: 'unconfirmed',
            lever: null,
          },
        ],
      }),
    });
    expect(a.recommendations[0].status).toBe('needs_data');
    expect(a.recommendations[0].action.kind).toBe('code');
  });
});

describe('recommendations that are code, not settings', () => {
  it('says what to build when no field governs the refusal', () => {
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'no_live_row', n: 12, paperMeanR: 0.25, paperTotalR: 3 }],
        },
      }),
    });
    const rec = a.recommendations[0];
    expect(rec.action.kind).toBe('code');
    expect(rec.action.detail).toMatch(/No single setting governs/);
    expect(rec.title).toMatch(/nothing the journal explains/);
  });

  it('never recommends loosening the live book’s own stand-down', () => {
    // live_entries_halted is the day BANKED at +3%, the give-back guard
    // protecting a fading green day, or the kill switch. Every one of those is
    // the plan working. Left in the ranking it would get louder exactly as the
    // book got better at reaching the target, and its only honest lever would
    // be "stop banking the day" — which Decision 2 settled.
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'live_entries_halted', n: 14, paperMeanR: 0.5, paperTotalR: 7 }],
        },
      }),
    });
    expect(a.recommendations.filter((r) => r.factor === 'flow')).toEqual([]);
  });

  it('maps the refusal classes that DO have a field', () => {
    expect(fieldForUntakenReason('live_risk_blocked:max_concurrent_positions')).toEqual({
      field: 'maxConcurrentPositions',
      direction: 'exposure',
    });
    expect(fieldForUntakenReason('live_score_floor_skipped')?.field).toBe('liveMinSignalScore');
    // An unmapped rule returns null rather than guessing at a field name.
    expect(fieldForUntakenReason('live_risk_blocked:something_new')).toBeNull();
    expect(fieldForUntakenReason('no_live_row')).toBeNull();
    // The END-OF-DAY cutoff. It became a reachable class on 2026-09-12 (the
    // batch row carries no symbol, so it used to land in no_live_row). It has a
    // field, and the detail has to say the cutoff is DERIVED — there is no
    // cutoff setting to turn, and the flatten window it comes from also decides
    // when open positions get closed.
    const cutoff = fieldForUntakenReason('entry_window_closed');
    expect(cutoff?.field).toBe('endOfDayFlattenMinutes');
    expect(cutoff?.direction).toBe('exposure');
    expect(cutoff?.detail).toMatch(/DERIVED/);
    expect(cutoff?.detail).toMatch(/stagnationExitMinutes/);
    // Paper is the control for this gate by design, so the bucket is a
    // measurement rather than a recording gap — the advice must not read like
    // no_live_row's "unexplained".
    expect(cutoff?.detail).toMatch(/control/);
    // The market-direction gate (2026-09-23): its breadth bar decides how
    // one-sided a market must be before it refuses, so that is the dial.
    const direction = fieldForUntakenReason('live_market_direction_skipped');
    expect(direction).toMatchObject({ field: 'marketDirectionBreadthPct', direction: 'exposure' });
    expect(direction?.detail).toMatch(/turn the gate off/);
    // The level veto (2026-09-23): live-only, paper is its control.
    const veto = fieldForUntakenReason('level_veto');
    expect(veto).toMatchObject({ field: 'levelMinRewardR', direction: 'exposure' });
    expect(veto?.detail).toMatch(/levelExitsEnabled/);
    expect(veto?.detail).toMatch(/control/);
    // The live book tried and the order did not go in: no setting widens that.
    for (const r of ['live_entry_failed', 'live_entry_blocked', 'live_order_outcome_unknown']) {
      expect(fieldForUntakenReason(r)).toBeNull();
    }
  });

  it("names the level veto's lever and a broker refusal in words, not action names", () => {
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [
            { reason: 'level_veto', n: 20, paperMeanR: 0.3, paperTotalR: 6, trades: [] },
            { reason: 'live_entry_failed', n: 10, paperMeanR: 0.2, paperTotalR: 2, trades: [] },
          ],
        },
      }),
    });
    const veto = a.recommendations.find((r) => r.id === 'flow:level_veto');
    expect(veto?.action).toMatchObject({ kind: 'config', field: 'levelMinRewardR', direction: 'exposure' });
    expect(JSON.stringify(veto)).toMatch(/the level veto/);
    const failed = a.recommendations.find((r) => r.id === 'flow:live_entry_failed');
    expect(JSON.stringify(failed)).toMatch(/the broker refusing the order/);
  });

  // 2026-09-23. A refused entry was priced at what PAPER made of it. On
  // fourteen same-tick pairs (one decision, one price) the live book made
  // 0.19R a trade less, because paper checks its stop once a minute and books
  // it at the stop price while live's rests at the broker. An entry admitted to
  // the live book is filled the live way.
  describe('a refused entry is priced the way the live book fills it', () => {
    const withSameTick = (
      untaken: { reason: string; n: number; paperMeanR: number; paperTotalR: number }[],
      sameTick: { n: number; meanDiffR: number | null } | undefined,
    ) => {
      const base = scan().attribution;
      const attribution = {
        ...base,
        untaken: untaken.map((u) => ({ ...u, trades: [] })),
        ...(sameTick ? { sameTick: { ...sameTick, ciLow: null, ciHigh: null } } : {}),
      };
      if (!sameTick) delete (attribution as { sameTick?: unknown }).sameTick;
      return advise({ scan: scan({ attribution }) });
    };
    const floor = (paperMeanR: number) => ({
      reason: 'live_score_floor_skipped',
      n: 10,
      paperMeanR,
      paperTotalR: paperMeanR * 10,
    });
    const rec = (a: ReturnType<typeof advise>) =>
      a.recommendations.find((r) => r.id === 'flow:live_score_floor_skipped');

    it('drops a class the live book would not have made money on', () => {
      // +0.15R in paper, -0.05R once the measured -0.20R is applied.
      expect(rec(withSameTick([floor(0.15)], { n: SAME_TICK_MIN_PAIRS, meanDiffR: -0.2 }))).toBeUndefined();
    });

    it('ranks a class that survives the difference at the live figure, and says both', () => {
      const r = rec(withSameTick([floor(0.5)], { n: SAME_TICK_MIN_PAIRS, meanDiffR: -0.2 }));
      // 10 entries over 20 active sessions at 2.5% risk and 0.30R: 0.5 x 2.5 x 0.3.
      expect(r?.expectedDayPctDelta).toBeCloseTo(0.375, 4);
      expect(r?.evidence).toMatch(/mean 0\.5R/);
      expect(r?.evidence).toMatch(
        /0\.3R a trade once the live book's measured difference on the same entry \(-0\.2R over 10 same-tick pairs\)/,
      );
    });

    it('uses paper as it stands below the minimum pairs, and says it has', () => {
      const r = rec(withSameTick([floor(0.15)], { n: SAME_TICK_MIN_PAIRS - 1, meanDiffR: -0.2 }));
      expect(r?.expectedDayPctDelta).toBeCloseTo(0.5 * 2.5 * 0.15, 2);
      expect(r?.evidence).toMatch(/not measured yet \(9 same-tick pairs, 10 needed\)/);
    });

    it('reads a scan saved before the reading existed as unmeasured, not as a crash', () => {
      const r = rec(withSameTick([floor(0.15)], undefined));
      expect(r?.expectedDayPctDelta).toBeCloseTo(0.5 * 2.5 * 0.15, 2);
      expect(r?.evidence).toMatch(/not measured yet \(0 same-tick pairs/);
    });

    it("is the attribution's own number, not a second derivation of it", () => {
      const a = { ...scan().attribution, sameTick: { n: 14, meanDiffR: -0.1852, ciLow: -0.45, ciHigh: 0.02 } };
      expect(liveDifferenceOnSameEntryR(a as never)).toBe(-0.1852);
      expect(liveDifferenceOnSameEntryR({ ...a, sameTick: { ...a.sameTick, n: 9 } } as never)).toBeNull();
    });
  });

  it('recommends RESEARCH before changing the exit that dominates red days', () => {
    const a = advise({
      scan: scan({
        dayLevel: {
          ...scan().dayLevel,
          redSessions: 6,
          meanRedSessionR: -1.4,
          worstSessionR: -3.3,
          redSessionDrivers: [{ reason: 'stop_loss', totalR: -8, trades: 12 }],
        },
      }),
    });
    const rec = a.recommendations.find((r) => r.id === 'edge:red_day_driver:stop_loss');
    expect(rec?.action.kind).toBe('research');
    expect(rec?.action.detail).toMatch(/is not always the reason that caused the loss/);
  });
});

describe('the headline can say "this will not get you there"', () => {
  it('leads with the execution defects when nothing measurable is worth much', () => {
    const a = advise({
      scan: scan({
        findings: [
          {
            id: 'execution:live_options_exit_failed',
            kind: 'execution',
            label: 'An options exit could not be placed',
            count: 200,
            detail: '200 in the last 10 sessions',
            lever: null,
          },
        ],
      }),
    });
    expect(a.headline).toMatch(/execution defect\(s\) outrank everything measurable/);
    expect(a.headline).toMatch(/Fix what is broken before tuning what is merely small/);
  });

  it('says how little of the gap the measurable findings close', () => {
    const a = advise({
      scan: scan({
        attribution: {
          ...scan().attribution,
          untaken: [{ reason: 'symbol_cooldown_skipped', n: 6, paperMeanR: 0.1, paperTotalR: 0.6 }],
        },
      }),
    });
    expect(a.headline).toMatch(/The rest is distribution, not a setting/);
  });

  it('names the goal’s height in R when the book reaches 1R far more often', () => {
    const a = advise({
      evidence: evidence({ storedTargetR: 2.4, goalReachedSessions: 1, goalRatePct: 5 }),
      scan: scan({ dayLevel: { ...scan().dayLevel, storedTargetR: 2.4, oneRSessions: 8 } }),
      review: {
        activeSessionsSinceChange: 20,
        meanDayPct: 0.4,
        goalRatePct: 5,
        goalRateJudgedSessions: 20,
        meanRedDayPct: null,
        worstDayPct: null,
        haltsMaxIn5: 0,
      },
    });
    const rec = a.recommendations.find((r) => r.id === 'goal:height_in_r');
    expect(rec).toBeTruthy();
    expect(rec?.action).toMatchObject({ kind: 'config', field: 'riskPerTradePct', to: 3 });
    // It refuses to claim a day-% delta: raising risk moves where the bar sits,
    // not what the book earns.
    expect(rec?.expectedDayPctDelta).toBeNull();
    expect(rec?.action.detail).toMatch(/raises the size of every red day by the same factor/);
  });
});

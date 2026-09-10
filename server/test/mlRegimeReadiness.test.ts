import { describe, it, expect } from 'vitest';
import { previousTradingSession, sessionDatesEndingAt } from '../src/services/trading/marketCalendar';
import {
  compareMlRegimeParity,
  computeMlRegimeReadiness,
  INERT_REVERT_AT,
  READINESS_SESSIONS,
  ReadinessInput,
} from '../src/services/mlRegimeReadiness';
import type { MlRegimeParityDetail, MlRegimeReadingRow } from '../src/db/mlRegimeReadings';
import type { MlRegime } from '../src/services/regimeModel';
import type { MlRegimeProbabilities, MlRegimeReading, MlRegimeSource } from '../src/services/mlRegime';

// ---------------------------------------------------------------------------
// The enabling rules, counted (2026-09-10). A Friday as "today" so the window
// holds four whole Monday–Friday weeks plus the Friday: the Friday/Monday
// switch case below needs a week boundary inside it.
// ---------------------------------------------------------------------------

const TODAY = '2026-10-02';
const MODEL = { version: '2026.09.1', retrainBy: '2027-01-01' };
const P: MlRegimeProbabilities = { high_vol_bearish: 0.1, low_vol_bullish: 0.7, sideways: 0.2 };
const WINDOW = sessionDatesEndingAt(TODAY, READINESS_SESSIONS);

type Row = MlRegimeReadingRow<Partial<MlRegimeReading>>;
interface RowOpts {
  regime?: MlRegime;
  stale?: boolean;
  source?: MlRegimeSource;
  modelVersion?: string;
  drift?: boolean;
  previous?: MlRegime | null;
  threshold?: number;
  probabilities?: MlRegimeProbabilities;
  /** 'agree' / 'disagree' store a verdict on the row as it is; 'outdated'
   *  stores an agreeing verdict on a DIFFERENT vector — the reading refreshed. */
  parity?: 'agree' | 'disagree' | 'outdated' | null;
}

function detailFor(regime: MlRegime, asOf: string, probabilities: MlRegimeProbabilities): MlRegimeParityDetail {
  return {
    checkedAt: 1,
    submitted: { regime, asOf, probabilities },
    server: { regime, asOf, probabilities, previous: null, threshold: 0.6 },
    maxAbsDiff: 0,
    reasons: [],
  };
}

function row(etDate: string, o: RowOpts = {}): Row {
  const regime = o.regime ?? 'low_vol_bullish';
  const asOf = previousTradingSession(etDate);
  const probabilities = o.probabilities ?? P;
  const reading: Partial<MlRegimeReading> = {
    regime,
    asOf,
    stale: o.stale ?? false,
    source: o.source ?? 'fred',
    drift: o.drift ?? false,
    previous: o.previous ?? null,
    threshold: o.threshold ?? 0.6,
    probabilities,
  };
  let parityAgrees: boolean | null = null;
  let parityDetail: MlRegimeParityDetail | null = null;
  if (o.parity === 'agree' || o.parity === 'disagree') {
    parityAgrees = o.parity === 'agree';
    parityDetail = detailFor(regime, asOf, probabilities);
  } else if (o.parity === 'outdated') {
    parityAgrees = true;
    parityDetail = detailFor(regime, asOf, { ...probabilities, low_vol_bullish: probabilities.low_vol_bullish - 0.05 });
  }
  return {
    etDate,
    regime,
    asOf,
    reading,
    modelVersion: o.modelVersion ?? MODEL.version,
    parityAgrees,
    parityDetail,
    createdAt: 1,
    updatedAt: 1,
  };
}

const clean = (opts: RowOpts = { parity: 'agree' }) => WINDOW.map((d) => row(d, opts));
const compute = (rows: Row[], extra: Partial<ReadinessInput> = {}) =>
  computeMlRegimeReadiness({ rows, changedDates: [], today: TODAY, model: MODEL, ...extra });

describe('computeMlRegimeReadiness — rules 2–4 from the persisted rows', () => {
  it('is ready on 20 counted, agreeing sessions with no switches, no drift and a fresh model', () => {
    const r = compute(clean());
    expect(r.windowSessions).toEqual(WINDOW);
    expect(r.windowSessions).toHaveLength(20);
    expect(r).toMatchObject({
      sessionsWithReading: 20,
      sessionsRequired: 20,
      switches: { total: 0, maxIn5Sessions: 0, limitPerWeek: 2, dates: [] },
      inertStreak: 0,
      drift: false,
      parity: { checked: 20, agreed: 20, disagreed: 0, unchecked: [] },
      overrideSessions: 0,
      otherModelSessions: 0,
      modelVersion: '2026.09.1',
      retrainBy: '2027-01-01',
      retrainOverdue: false,
      ready: true,
      blockers: [],
    });
    expect(r.gridDecision).toMatch(/recorded by hand in docs\/AUTOTRADING_SPEC\.md/);
  });

  it('names the count while sessions are still accruing', () => {
    const r = compute(clean().slice(1));
    expect(r.sessionsWithReading).toBe(19);
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toBe('19 of 20 sessions have a counted reading');
  });

  it('a session with no row neither counts nor is stale: it is inert, and today is skipped until it has a row', () => {
    const rows = clean().filter((x) => x.etDate !== TODAY && x.etDate !== WINDOW[18]);
    const r = compute(rows);
    // Today has no row yet (skipped); yesterday has none (inert); the day
    // before is a fresh reading (ends the streak).
    expect(r.sessionsWithReading).toBe(18);
    expect(r.inertStreak).toBe(1);
    expect(r.blockers).toContain('the latest 1 session(s) had no usable reading');
  });

  it('counts a stale, an unknown and a missing row alike as inert; a fresh reading ends the streak', () => {
    const rows = clean().map((x) => {
      if (x.etDate === WINDOW[19]) return row(x.etDate, { stale: true, parity: 'agree' });
      if (x.etDate === WINDOW[18]) return row(x.etDate, { regime: 'unknown', parity: null });
      return x;
    });
    const r = compute(rows.filter((x) => x.etDate !== WINDOW[17]));
    expect(r.inertStreak).toBe(3);
    expect(r.sessionsWithReading).toBe(17);
    const fresh = compute(rows);
    expect(fresh.inertStreak).toBe(2);
  });

  it(`says the spec reverts the overlay at ${INERT_REVERT_AT} inert sessions in a row`, () => {
    const inert = new Set(WINDOW.slice(15));
    const r = compute(clean().map((x) => (inert.has(x.etDate) ? row(x.etDate, { stale: true }) : x)));
    expect(r.inertStreak).toBe(5);
    expect(r.blockers).toContain('5 inert sessions in a row — the spec reverts the overlay to OFF at 5');
  });

  it('caps switches over any 5 consecutive sessions — two on a Friday and two on the Monday is four, not two per week', () => {
    // WINDOW[4] is the first Friday, WINDOW[5] the Monday after it.
    const friday = WINDOW[4];
    const monday = WINDOW[5];
    expect(new Date(`${friday}T12:00:00Z`).getUTCDay()).toBe(5);
    expect(new Date(`${monday}T12:00:00Z`).getUTCDay()).toBe(1);
    const r = compute(clean(), { changedDates: [friday, friday, monday, monday] });
    expect(r.switches).toMatchObject({ total: 4, maxIn5Sessions: 4, dates: [friday, monday] });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain('4 switches within 5 sessions (limit 2 per week)');
    const spread = compute(clean(), { changedDates: [WINDOW[0], WINDOW[7], WINDOW[14]] });
    expect(spread.switches).toMatchObject({ total: 3, maxIn5Sessions: 1 });
    expect(spread.ready).toBe(true);
  });

  it('lands a weekend switch on the next session', () => {
    const saturday = '2026-09-26';
    expect(new Date(`${saturday}T12:00:00Z`).getUTCDay()).toBe(6);
    const r = compute(clean(), { changedDates: [saturday] });
    expect(r.switches).toMatchObject({ total: 1, maxIn5Sessions: 1, dates: [saturday] });
  });

  it('blocks on drift in the latest counted reading and counts drift sessions', () => {
    const r = compute(clean().map((x) => (x.etDate === TODAY ? row(TODAY, { drift: true, parity: 'agree' }) : x)));
    expect(r.drift).toBe(true);
    expect(r.driftSessions).toBe(1);
    expect(r.blockers).toContain('the latest counted reading flags model drift — retrain first');
  });

  it('lists the unchecked sessions with the inputs regime:predict needs, and never counts a disagreement as ready', () => {
    const rows = clean().map((x) => {
      if (x.etDate === WINDOW[3]) return row(x.etDate, { parity: null, previous: 'sideways', threshold: 0.65 });
      if (x.etDate === WINDOW[9]) return row(x.etDate, { parity: 'disagree' });
      return x;
    });
    const r = compute(rows);
    expect(r.parity).toMatchObject({ checked: 19, agreed: 18, disagreed: 1 });
    expect(r.parity.unchecked).toEqual([
      { etDate: WINDOW[3], asOf: previousTradingSession(WINDOW[3]), previous: 'sideways', threshold: 0.65 },
    ]);
    expect(r.blockers).toContain('1 counted session(s) disagree with regime:predict');
    expect(r.blockers).toContain('1 counted session(s) have no parity check yet');
  });

  it('reads a verdict on a since-refreshed reading as unchecked, never as agreed', () => {
    const r = compute(clean().map((x) => (x.etDate === WINDOW[10] ? row(x.etDate, { parity: 'outdated' }) : x)));
    expect(r.parity).toMatchObject({ agreed: 19, disagreed: 0 });
    expect(r.parity.unchecked.map((u) => u.etDate)).toEqual([WINDOW[10]]);
    expect(r.ready).toBe(false);
  });

  it('excludes a dev-override day from the count and blocks on it', () => {
    const r = compute(clean().map((x) => (x.etDate === WINDOW[6] ? row(x.etDate, { source: 'override' }) : x)));
    expect(r.overrideSessions).toBe(1);
    expect(r.sessionsWithReading).toBe(19);
    expect(r.blockers).toContain('1 session(s) in the window read from the dev override, not the model');
  });

  it('restarts the count at a retrain: rows under another model version are excluded and named', () => {
    const old = new Set(WINDOW.slice(0, 3));
    const r = compute(
      clean().map((x) => (old.has(x.etDate) ? row(x.etDate, { modelVersion: '2026.06.1', parity: 'agree' }) : x)),
    );
    expect(r.otherModelSessions).toBe(3);
    expect(r.sessionsWithReading).toBe(17);
    expect(r.blockers).toContain('3 session(s) were read by another model version — the count restarts at a retrain');
    const none = compute(clean(), { model: null });
    expect(none.blockers[0]).toBe('no regime model is loaded');
    expect(none.sessionsWithReading).toBe(0);
  });

  it('blocks once the retrain-by date has passed', () => {
    const r = compute(clean(), { model: { version: '2026.09.1', retrainBy: '2026-09-30' } });
    expect(r.retrainOverdue).toBe(true);
    expect(r.blockers).toEqual(["the model's retrain-by date 2026-09-30 has passed"]);
  });
});

describe('compareMlRegimeParity — rule 3, to 1e-6', () => {
  const server = { regime: 'sideways' as const, asOf: '2026-09-09', probabilities: P };

  it('agrees on the same date, label and probabilities, within the tolerance', () => {
    expect(compareMlRegimeParity(server, { ...server })).toEqual({ agrees: true, maxAbsDiff: 0, reasons: [] });
    const near = compareMlRegimeParity(server, {
      ...server,
      probabilities: { ...P, low_vol_bullish: P.low_vol_bullish + 1e-7 },
    });
    expect(near.agrees).toBe(true);
    expect(near.maxAbsDiff).toBeCloseTo(1e-7, 9);
  });

  it('disagrees beyond the tolerance, on another data date, on another label, and when the server has no vector', () => {
    const far = compareMlRegimeParity(server, { ...server, probabilities: { ...P, sideways: P.sideways + 2e-6 } });
    expect(far.agrees).toBe(false);
    expect(far.reasons[0]).toMatch(/probabilities differ by up to 2\.00e-6 \(tolerance 0\.000001\)/);
    expect(compareMlRegimeParity(server, { ...server, asOf: '2026-09-08' }).reasons).toEqual([
      'asOf differs (server 2026-09-09, submitted 2026-09-08)',
    ]);
    expect(compareMlRegimeParity(server, { ...server, regime: 'low_vol_bullish' }).reasons).toEqual([
      'regime differs (server sideways, submitted low_vol_bullish)',
    ]);
    const none = compareMlRegimeParity({ ...server, probabilities: null }, { ...server });
    expect(none).toEqual({ agrees: false, maxAbsDiff: null, reasons: ['the server reading carries no probabilities'] });
  });
});

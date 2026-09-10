import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  getLatestMlRegimeReading,
  getMlRegimeReading,
  getPreviousKnownMlRegime,
  listMlRegimeReadings,
  MlRegimeParityDetail,
  recordMlRegimeParity,
  saveMlRegimeReading,
} from '../src/db/mlRegimeReadings';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM ml_regime_readings'));

const reading = (regime: string) => ({ regime, note: 'test' });

describe('ml_regime_readings', () => {
  it('saves one reading per ET day and overwrites it in place, keeping createdAt', () => {
    saveMlRegimeReading(
      {
        etDate: '2026-09-04',
        regime: 'sideways',
        asOf: '2026-09-03',
        reading: reading('sideways'),
        modelVersion: 'v1',
      },
      100,
    );
    saveMlRegimeReading(
      {
        etDate: '2026-09-04',
        regime: 'low_vol_bullish',
        asOf: '2026-09-03',
        reading: reading('low_vol_bullish'),
        modelVersion: 'v1',
      },
      200,
    );
    const row = getMlRegimeReading<{ regime: string }>('2026-09-04');
    expect(row?.regime).toBe('low_vol_bullish');
    expect(row?.reading.regime).toBe('low_vol_bullish');
    expect(row?.createdAt).toBe(100);
    expect(row?.updatedAt).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ml_regime_readings').get()).toEqual({ n: 1 });
  });

  it('finds the latest reading on or before a day', () => {
    saveMlRegimeReading({
      etDate: '2026-09-02',
      regime: 'sideways',
      asOf: '2026-09-01',
      reading: {},
      modelVersion: 'v1',
    });
    saveMlRegimeReading({
      etDate: '2026-09-04',
      regime: 'low_vol_bullish',
      asOf: '2026-09-03',
      reading: {},
      modelVersion: 'v1',
    });
    expect(getLatestMlRegimeReading()?.etDate).toBe('2026-09-04');
    expect(getLatestMlRegimeReading('2026-09-03')?.etDate).toBe('2026-09-02');
    expect(getLatestMlRegimeReading('2026-09-01')).toBeNull();
  });

  it("the sticky rule's previous regime is the newest KNOWN day strictly before today", () => {
    saveMlRegimeReading({
      etDate: '2026-09-01',
      regime: 'high_vol_bearish',
      asOf: '2026-08-31',
      reading: {},
      modelVersion: 'v1',
    });
    saveMlRegimeReading({ etDate: '2026-09-02', regime: 'unknown', asOf: null, reading: {}, modelVersion: 'v1' });
    saveMlRegimeReading({ etDate: '2026-09-03', regime: 'unknown', asOf: null, reading: {}, modelVersion: 'v1' });
    expect(getPreviousKnownMlRegime('2026-09-04')).toBe('high_vol_bearish');
    expect(getPreviousKnownMlRegime('2026-09-01')).toBeNull();
    saveMlRegimeReading({
      etDate: '2026-09-04',
      regime: 'sideways',
      asOf: '2026-09-03',
      reading: {},
      modelVersion: 'v1',
    });
    // Today's own row is never its own "previous".
    expect(getPreviousKnownMlRegime('2026-09-04')).toBe('high_vol_bearish');
  });

  it('lists readings from a date, oldest first, and skips a row whose JSON is corrupt', () => {
    saveMlRegimeReading({ etDate: '2026-09-01', regime: 'sideways', asOf: null, reading: {}, modelVersion: 'v1' });
    saveMlRegimeReading({ etDate: '2026-09-03', regime: 'sideways', asOf: null, reading: {}, modelVersion: 'v1' });
    db.prepare(
      `INSERT INTO ml_regime_readings (et_date, regime, as_of, reading, model_version, created_at, updated_at)
       VALUES ('2026-09-02', 'sideways', NULL, '{not json', 'v1', 1, 1)`,
    ).run();
    expect(listMlRegimeReadings({ since: '2026-09-02' }).map((r) => r.etDate)).toEqual(['2026-09-03']);
    expect(listMlRegimeReadings().map((r) => r.etDate)).toEqual(['2026-09-01', '2026-09-03']);
    expect(getMlRegimeReading('2026-09-02')).toBeNull();
    expect(listMlRegimeReadings({ until: '2026-09-02' }).map((r) => r.etDate)).toEqual(['2026-09-01']);
    expect(listMlRegimeReadings({ since: '2026-09-01', until: '2026-09-01' }).map((r) => r.etDate)).toEqual([
      '2026-09-01',
    ]);
  });

  it("stores rule 3's verdict beside the reading, and a refresh of the reading leaves it in place", () => {
    const P = { high_vol_bearish: 0.1, low_vol_bullish: 0.7, sideways: 0.2 };
    const detail: MlRegimeParityDetail = {
      checkedAt: 5,
      submitted: { regime: 'sideways', asOf: '2026-09-09', probabilities: P },
      server: { regime: 'sideways', asOf: '2026-09-09', probabilities: P, previous: null, threshold: 0.6 },
      maxAbsDiff: 0,
      reasons: [],
    };
    // Nothing to compare against yet.
    expect(recordMlRegimeParity('2026-09-10', { agrees: true, detail })).toBe(false);
    saveMlRegimeReading(
      {
        etDate: '2026-09-10',
        regime: 'sideways',
        asOf: '2026-09-09',
        reading: reading('sideways'),
        modelVersion: 'v1',
      },
      100,
    );
    expect(getMlRegimeReading('2026-09-10')).toMatchObject({ parityAgrees: null, parityDetail: null });
    expect(recordMlRegimeParity('2026-09-10', { agrees: false, detail })).toBe(true);
    expect(getMlRegimeReading('2026-09-10')).toMatchObject({ parityAgrees: false, parityDetail: detail });
    // The loop's mid-morning refresh overwrites the reading, not the verdict —
    // whether the verdict still describes the new reading is the readiness
    // computation's question (services/mlRegimeReadiness.ts).
    saveMlRegimeReading(
      {
        etDate: '2026-09-10',
        regime: 'low_vol_bullish',
        asOf: '2026-09-09',
        reading: reading('low_vol_bullish'),
        modelVersion: 'v1',
      },
      200,
    );
    const row = getMlRegimeReading<{ regime: string }>('2026-09-10');
    expect(row).toMatchObject({ regime: 'low_vol_bullish', parityAgrees: false, parityDetail: detail, updatedAt: 200 });
    // A verdict whose JSON cannot be read is dropped, not thrown on.
    db.prepare('UPDATE ml_regime_readings SET parity_detail = ? WHERE et_date = ?').run('{not json', '2026-09-10');
    expect(getMlRegimeReading('2026-09-10')).toMatchObject({ parityAgrees: false, parityDetail: null });
  });
});

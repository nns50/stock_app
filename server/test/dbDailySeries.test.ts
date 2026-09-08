import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { getDailySeries, latestDailySeriesDate, upsertDailySeries } from '../src/db/dailySeries';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM daily_series'));

describe('daily_series', () => {
  it('round-trips a series oldest first and answers since/until windows', () => {
    upsertDailySeries('SP500', [
      { date: '2026-09-03', value: 6500 },
      { date: '2026-09-01', value: 6450 },
      { date: '2026-09-02', value: 6480 },
    ]);
    expect(getDailySeries('SP500').map((p) => p.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(getDailySeries('SP500', { since: '2026-09-02' }).map((p) => p.value)).toEqual([6480, 6500]);
    expect(getDailySeries('SP500', { until: '2026-09-02' }).map((p) => p.value)).toEqual([6450, 6480]);
    expect(getDailySeries('SP500', { since: '2026-09-02', until: '2026-09-02' })).toEqual([
      { date: '2026-09-02', value: 6480 },
    ]);
  });

  it('replaces a re-fetched close and keeps series apart', () => {
    upsertDailySeries('SP500', [{ date: '2026-09-03', value: 6500 }], 1);
    upsertDailySeries('SP500', [{ date: '2026-09-03', value: 6501.5 }], 2);
    upsertDailySeries('VIXCLS', [{ date: '2026-09-03', value: 14.3 }], 2);
    expect(getDailySeries('SP500')).toEqual([{ date: '2026-09-03', value: 6501.5 }]);
    expect(getDailySeries('VIXCLS')).toEqual([{ date: '2026-09-03', value: 14.3 }]);
    expect(db.prepare('SELECT fetched_at FROM daily_series WHERE series_id = ?').get('SP500')).toEqual({
      fetched_at: 2,
    });
  });

  it('reports the newest stored date, or null when nothing is stored', () => {
    expect(latestDailySeriesDate('SP500')).toBeNull();
    upsertDailySeries('SP500', [
      { date: '2026-09-01', value: 1 },
      { date: '2026-09-04', value: 2 },
    ]);
    expect(latestDailySeriesDate('SP500')).toBe('2026-09-04');
    expect(latestDailySeriesDate('VIXCLS')).toBeNull();
  });
});

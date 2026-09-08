import { describe, it, expect } from 'vitest';
import { loadRegimeModel } from '../src/services/regimeModel';
import { etToday } from '../src/util/marketDate';

// A deliberate time bomb (docs/MARKET_REGIME_MODEL.md §10): the shipped regime
// model carries a `retrainBy` date 120 days after the data it was trained
// through, and this test goes red the day after. The fix is a retrain, or an
// explicit `retrainBy` bump recorded in docs/AUTOTRADING_SPEC.md's decision
// log — never deleting or skipping this test. A model that quietly ages past
// its window keeps producing confident readings about a tape it has not seen.

describe('the shipped market-regime model', () => {
  it('has not passed its retrainBy date', () => {
    const model = loadRegimeModel();
    expect(model).not.toBeNull();
    const today = etToday();
    const { retrainBy, trainedThrough } = model!.training;
    expect(
      retrainBy >= today,
      `server/data/regimeModel.json (${model!.version}) was trained through ${trainedThrough} and its retrainBy ` +
        `${retrainBy} has passed (today ${today}). Retrain it: python3 -m venv ml/.venv && . ml/.venv/bin/activate && ` +
        `pip install -r ml/requirements.txt && npm run regime:train -- --version <YYYY.MM.n> && ` +
        `npm run regime:evaluate -- --version <same>, then commit the artifact, fixture, history and reports ` +
        `(docs/MARKET_REGIME_MODEL.md §10). Do not delete this test.`,
    ).toBe(true);
  });
});

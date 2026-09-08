import { describe, expect, it } from 'vitest';
import { getAutotradeConfig, defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';

// ---------------------------------------------------------------------------
// The guard for task #46's whole bug class.
//
// setAutotradeConfig is a PARTIAL patch over one config row every test file
// shares, so a file that does not name a field inherits whatever the file
// before it left there. finishLineWiring.test.ts was bitten three times by
// three different fields before the cause was understood.
//
// This file's NAME is load-bearing. The order is pinned by path
// (vitest.config.ts), so `configIsolation` runs after every `autotrade*` and
// `backtest*` file — including autotradeLoop (39 config patches),
// autotradeOptionsExecute (28), autotradeExecute (19) and autotradeDashboard
// (16). If cross-file leakage were still possible, this is exactly where it
// would show. Do not rename it to something that sorts earlier.
// ---------------------------------------------------------------------------
describe('autotrade config isolation between test files', () => {
  it('starts at the DEFAULTS, not at whatever the previous file left behind', () => {
    // Deep equality, deliberately: naming individual fields would only ever
    // catch the ones that have already bitten, which is the mistake the earlier
    // per-field pinning made.
    expect(getAutotradeConfig()).toEqual(defaultAutotradeConfig());
  });

  it('names the fields that have actually leaked, so a failure says which', () => {
    const cfg = getAutotradeConfig();
    const d = defaultAutotradeConfig();
    // endOfDayFlattenMinutes: left at 5 by autotradeLiveExecute.test.ts.
    expect(cfg.endOfDayFlattenMinutes).toBe(d.endOfDayFlattenMinutes);
    // liveMinSignalScore: left at 72 by explainRoute.test.ts.
    expect(cfg.liveMinSignalScore).toBe(d.liveMinSignalScore);
    // liveAccountId: set by nearly every live test file.
    expect(cfg.liveAccountId).toBe(d.liveAccountId);
  });

  it('still lets a file patch its own config normally', () => {
    // The reset is per FILE, not per test — files that set config in their own
    // beforeAll and rely on it across cases must keep working.
    setAutotradeConfig({ liveMinSignalScore: 91 });
    expect(getAutotradeConfig().liveMinSignalScore).toBe(91);
  });
});

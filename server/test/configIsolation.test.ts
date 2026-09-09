import { describe, expect, it } from 'vitest';
import { getAutotradeConfig, defaultAutotradeConfig, setAutotradeConfig } from '../src/db/autotradeConfig';
import { getTradingConfig, setTradingConfig } from '../src/db/trading';
import { defaultTradingConfig } from '../src/services/trading/guardrails';
import { db } from '../src/db';

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
//
// It now guards ROWS as well as the config row (2026-09-09). Signature D was a
// leaked POSITION, not a leaked setting: liveOptionsExpiry.test.ts left a
// closed $200 option behind and livePreview.test.ts's guardrails read it as a
// realized loss it never traded. Both are the same bug — shared state that
// outlives the file that wrote it — so both are reset in the same place and
// proved here in the same place.
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

describe('shared BOOK isolation between test files', () => {
  // Every table setupConfigIsolation.ts resets. Named individually rather than
  // looped so a failure says which one carried rows, and asserted as counts so
  // it says how many.
  const VOLATILE = [
    'position_exits',
    'positions',
    'order_events',
    'order_intents',
    'autotrade_events',
    'autotrade_paper_positions',
    'autotrade_options_paper_positions',
    'autotrade_live_orders',
    'autotrade_live_options_orders',
    'autotrade_live_options_positions',
    'daily_series',
    'ml_regime_readings',
  ];

  it('starts with an EMPTY book, however many positions the files before it opened', () => {
    // This runs after autotradeLoop, autotradeExecute, autotradeLiveExecute and
    // every other file that opens fixtures — several of which never delete what
    // they created. Without the per-file reset these counts are not zero, which
    // is what makes this a real guard and not a tautology.
    const counts = Object.fromEntries(
      VOLATILE.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
    );
    expect(counts).toEqual(Object.fromEntries(VOLATILE.map((t) => [t, 0])));
  });

  it('starts at the TRADING defaults too — the other shared config row', () => {
    // setTradingConfig has the identical partial-patch-over-one-row shape, and
    // a killSwitch left engaged by one file refuses everything in the next.
    expect(getTradingConfig()).toEqual(defaultTradingConfig());
  });

  it('still lets a file set its own trading config normally', () => {
    setTradingConfig({ killSwitch: true });
    expect(getTradingConfig().killSwitch).toBe(true);
  });
});

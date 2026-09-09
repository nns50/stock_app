import { beforeAll } from 'vitest';
import { initDb, db } from '../src/db';

// ---------------------------------------------------------------------------
// EVERY TEST FILE STARTS FROM THE DEFAULT AUTOTRADE CONFIG (2026-09-08, #46).
//
// setAutotradeConfig is a PARTIAL patch over a single config row that every
// test file in the suite shares. A file that does not name a field inherits
// whatever the file before it left there — so what a test runs against depends
// on which files ran earlier. That is the coupling behind task #46's "2 in 6
// runs, unattributed", and it has bitten finishLineWiring.test.ts three times
// under three different fields:
//
//   endOfDayFlattenMinutes  left at 5   by autotradeLiveExecute.test.ts
//   liveMinSignalScore      left at 72  by explainRoute.test.ts
//
// Pinning the file ORDER (see vitest.config.ts) made those failures
// deterministic and bisectable. It did not remove the coupling — it only
// stopped it moving around. This does remove it.
//
// PER FILE, NOT PER TEST. setupFiles runs once per test file, so `beforeAll`
// here fires at the start of each file and never between the tests inside one.
// That is deliberate: plenty of files set their config in their own `beforeAll`
// and rely on it across their cases, and resetting per test would break them
// for no benefit. The leak this closes is strictly BETWEEN files.
//
// A survey on 2026-09-08 found ELEVEN files patching this row without ever
// spreading defaults — autotradeLoop (39 calls), autotradeOptionsExecute (28),
// autotradeExecute (19), autotradeDashboard (16) and seven more. Fixing them
// one file at a time would have meant touching all eleven and still leaving the
// twelfth to be written next week.
//
// initDb() first because a test file's own `beforeAll` has not run yet at this
// point, so the table may not exist. It is `CREATE TABLE IF NOT EXISTS`
// throughout, so calling it here is free and idempotent.
// ---------------------------------------------------------------------------
// AND FROM AN EMPTY BOOK (2026-09-09, #46's residual sweep).
//
// The config row was half of it. The other half is ROWS: signature D was
// liveOptionsExpiry.test.ts closing a $200 option at $0 and clearing
// autotrade_live_options_positions only in `beforeEach`, so the closed position
// survived the file and realizedTodayFromBook() handed livePreview.test.ts's
// guardrails a $200 realized loss it never traded — two tests failing on money
// no fixture there had. Occasional while the file order moved; permanent once
// it was pinned.
//
// Cleaning up at the WRITER does not generalise: the next file to leave rows
// behind has no idea who reads them, and a survey found several already doing
// it (stopAdjust.test.ts creates positions and never deletes any). Starting
// every file from an empty book does generalise, and it is the same argument
// the config reset above already won.
//
// Order note: vitest runs setupFiles' hooks BEFORE the test file's own
// `beforeAll`, so a file that seeds in `beforeAll` and relies on it across its
// cases is unaffected — this wipes first, then it seeds.
//
// Deliberately NOT every table. These are the volatile ones a test writes as
// fixture data and another file's assertions read as money or as counts.
// Reference data a suite seeds once (universe, macro events) is left alone.
const VOLATILE_TABLES = [
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
];

beforeAll(() => {
  initDb();
  // trading_config alongside autotrade_config: setTradingConfig is the same
  // partial-patch-over-one-shared-row shape, and two files patch it without
  // ever clearing it. A killSwitch left engaged by one file is a whole suite's
  // worth of confusing refusals in the next.
  db.exec('DELETE FROM autotrade_config; DELETE FROM trading_config');
  for (const table of VOLATILE_TABLES) db.exec(`DELETE FROM ${table}`);
});

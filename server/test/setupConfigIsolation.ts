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
beforeAll(() => {
  initDb();
  db.exec('DELETE FROM autotrade_config');
});

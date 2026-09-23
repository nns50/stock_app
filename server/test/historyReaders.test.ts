import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { initDb, db } from '../src/db';
import { closePaperPosition, listPaperPositions, openPaperPosition } from '../src/db/autotradePaperPositions';
import {
  closeOptionsPaperPosition,
  listOptionsPaperPositions,
  openOptionsPaperPosition,
} from '../src/db/autotradeOptionsPaperPositions';
import {
  closeLiveOptionsPosition,
  createLiveOptionsPosition,
  listLiveOptionsPositions,
} from '../src/db/autotradeLiveOptionsPositions';
import { collectBook } from '../src/services/autotrading/dailyTargetSweepData';
import { paperDayFor } from '../src/services/autotrading/dailyResults';
import { listAutotradeLivePositions } from '../src/services/autotrading/liveExecute';
import { seedClosedAutotradeSessions } from './helpers/autotradeSessions';

// ---------------------------------------------------------------------------
// The four autotrade position lists used to cap an unlimited call at the
// newest 200 rows. Every history reader called them without a limit (the leak
// scan's paper control, the daily-target sweep, the results backfill, the
// tune advisor, the cooldowns), so the day the paper book passed 200 closed
// trades each of them would have started dropping the oldest ones without a
// word. Production had 179 on 2026-09-23. The assertions below are at the
// CONSUMERS as well as the lists: a list that returns every row proves nothing
// about a reader that passes its own cap (CLAUDE.md, "assert at the consumer").
// ---------------------------------------------------------------------------

const N = 205; // past the old cap
const OLD_DAY = '2026-06-01';
const OLD_EXIT = Date.parse('2026-06-01T17:00:00Z'); // 13:00 ET
const NEW_EXIT = Date.parse('2026-09-01T17:00:00Z');

let oldestPaperId = 0;

// The app's listener is guarded (require.main === module), so bind a port here,
// as routes.integration.test.ts does.
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

beforeAll(() => {
  initDb();
  // One old paper trade, then N − 1 newer ones: the old one is the row the
  // cap dropped first.
  for (let i = 0; i < N; i++) {
    const p = openPaperPosition({
      symbol: `P${i}`,
      side: 'buy',
      quantity: 10,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      riskAmount: 50,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    if (i === 0) oldestPaperId = p.id;
    closePaperPosition(p.id, { exitPrice: 105, exitReason: 'target' });
    db.prepare('UPDATE autotrade_paper_positions SET entry_at = ?, exit_at = ? WHERE id = ?').run(
      (i === 0 ? OLD_EXIT : NEW_EXIT) - 60 * 60 * 1000,
      i === 0 ? OLD_EXIT : NEW_EXIT + i * 1000,
      p.id,
    );
  }
  for (let i = 0; i < N; i++) {
    const p = openOptionsPaperPosition({
      symbol: `O${i}`,
      side: 'call',
      contractSymbol: `O${i}261016C00100000`,
      strike: 100,
      expiration: '2026-10-16',
      quantity: 1,
      entryPrice: 1,
      riskAmount: 70,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    closeOptionsPaperPosition(p.id, { exitPrice: 1.2, exitReason: 'take_profit' });
  }
  for (let i = 0; i < N; i++) {
    const p = createLiveOptionsPosition({
      symbol: `L${i}`,
      side: 'call',
      contractSymbol: `L${i}261016C00100000`,
      strike: 100,
      expiration: '2026-10-16',
      quantity: 1,
      entryPrice: 1,
      riskAmount: 70,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    closeLiveOptionsPosition(p.id, { exitPrice: 1.2, exitReason: 'take_profit', exitAt: NEW_EXIT + i * 1000 });
  }
  // Live stock: N closed autotrade trades, one per session-day row.
  seedClosedAutotradeSessions({
    sessions: { '2026-09-01': Array.from({ length: N }, () => ({ entryTime: '10:00', r: 1 })) },
  });
});

describe('the four position lists return every row unless the caller asks for a page', () => {
  it('paper stock', () => {
    expect(listPaperPositions({ status: 'closed' })).toHaveLength(N);
    const page = listPaperPositions({ status: 'closed', limit: 10 });
    expect(page).toHaveLength(10);
    expect(page[0].id).toBeGreaterThan(page[9].id); // newest first, as before
  });

  it('paper options', () => {
    expect(listOptionsPaperPositions({ status: 'closed' })).toHaveLength(N);
    expect(listOptionsPaperPositions({ status: 'closed', limit: 10 })).toHaveLength(10);
  });

  it('live options', () => {
    expect(listLiveOptionsPositions({ status: 'closed' })).toHaveLength(N);
    expect(listLiveOptionsPositions({ status: 'closed', limit: 10 })).toHaveLength(10);
  });

  it('live stock', () => {
    expect(listAutotradeLivePositions({ status: 'closed' })).toHaveLength(N);
    expect(listAutotradeLivePositions({ status: 'closed', limit: 10 })).toHaveLength(10);
  });
});

describe('the history readers see the whole book', () => {
  it('the daily-target sweep collects every paper trade, stock and options', () => {
    const paper = collectBook('paper');
    expect(paper.trades).toHaveLength(2 * N);
    expect(paper.trades.some((t) => t.id === `paper:${oldestPaperId}`)).toBe(true);
  });

  it('the daily-target sweep collects every live options trade', () => {
    const live = collectBook('live');
    expect(live.trades.filter((t) => t.id.startsWith('lopt:'))).toHaveLength(N);
  });

  it('the results row finds the paper book’s oldest day', () => {
    // The one trade closed that day: 10 shares × (105 − 100).
    expect(paperDayFor(OLD_DAY)).toBe(50);
  });
});

describe('the positions routes keep the page size the Auto page has always had', () => {
  it.each(['paper-positions', 'options-paper-positions', 'live-options-positions', 'live-positions'])(
    '%s returns the newest 200 by default, and every row up to 1,000 on request',
    async (route) => {
      const page = (await (await fetch(`${base}/api/autotrade/${route}?status=closed`)).json()) as {
        positions: unknown[];
      };
      expect(page.positions).toHaveLength(200);
      const all = (await (await fetch(`${base}/api/autotrade/${route}?status=closed&limit=1000`)).json()) as {
        positions: unknown[];
      };
      expect(all.positions).toHaveLength(N);
    },
  );
});

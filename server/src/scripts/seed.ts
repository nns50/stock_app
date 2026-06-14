import { initDb } from '../db';
import { createPosition, addExit, listPositions, type PositionInput, type ChecklistItem } from '../db/positions';
import { addToWatchlist } from '../services/watchlist';

// CLI: `npm run seed` — populates the SQLite DB with a handful of demo trades and
// watchlist symbols so the dashboard, journal, and analytics have something to
// show on first open. Idempotent: refuses to double-seed unless given --force.
// Closed trades carry deterministic realized P&L (independent of the data
// provider); open trades pick up live/synthetic marks when the app runs.

const disciplined: ChecklistItem[] = [
  { rule: 'Trade fits my plan / setup', checked: true },
  { rule: 'Risk is within my budget (position sized)', checked: true },
  { rule: 'Exit plan defined — target and stop', checked: true },
];
const sloppy: ChecklistItem[] = [
  { rule: 'Trade fits my plan / setup', checked: true },
  { rule: 'Risk is within my budget (position sized)', checked: false },
  { rule: 'Exit plan defined — target and stop', checked: false },
];

interface ClosedSpec {
  pos: PositionInput;
  exit: { price: number; date: string; fees?: number };
}

// 3 winners / 2 losers — gives a 60% win rate, realized streaks, R-multiples
// (each has a stop), and disciplined-vs-sloppy journal stats.
const closed: ClosedSpec[] = [
  {
    pos: {
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 190,
      entryDate: '2026-05-05',
      fees: 1,
      stopPrice: 184,
      targetPrice: 208,
      tags: ['breakout', 'earnings'],
      grade: 'A',
      checklist: disciplined,
      notes: 'Clean breakout over the range high on volume.',
    },
    exit: { price: 205.5, date: '2026-05-20', fees: 1 },
  },
  {
    pos: {
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 50,
      entryPrice: 410,
      entryDate: '2026-05-08',
      fees: 1,
      stopPrice: 400,
      targetPrice: 435,
      tags: ['pullback'],
      grade: 'C',
      checklist: sloppy,
      notes: 'Bought the dip too early — no confirmation.',
    },
    exit: { price: 398, date: '2026-05-18', fees: 1 },
  },
  {
    pos: {
      assetType: 'stock',
      symbol: 'NVDA',
      side: 'long',
      quantity: 40,
      entryPrice: 118,
      entryDate: '2026-05-12',
      fees: 1,
      stopPrice: 112,
      targetPrice: 134,
      tags: ['momentum'],
      grade: 'B',
      checklist: disciplined,
      notes: 'Trend continuation, trailed the stop up.',
    },
    exit: { price: 131, date: '2026-06-02', fees: 1 },
  },
  {
    pos: {
      assetType: 'stock',
      symbol: 'TSLA',
      side: 'short',
      quantity: 30,
      entryPrice: 250,
      entryDate: '2026-05-15',
      fees: 1,
      stopPrice: 260,
      targetPrice: 228,
      tags: ['mean-reversion'],
      grade: 'B',
      checklist: disciplined,
      notes: 'Faded an extended move into resistance.',
    },
    exit: { price: 235, date: '2026-05-29', fees: 1 },
  },
  {
    pos: {
      assetType: 'stock',
      symbol: 'AMD',
      side: 'long',
      quantity: 60,
      entryPrice: 165,
      entryDate: '2026-05-22',
      fees: 1,
      stopPrice: 160,
      targetPrice: 178,
      tags: ['breakout'],
      grade: 'D',
      checklist: sloppy,
      notes: 'Chased a failed breakout, stopped out.',
    },
    exit: { price: 158.5, date: '2026-06-01', fees: 1 },
  },
];

// Open positions — one stock, one option (future expiry so it shows under
// "upcoming expirations"); both carry a stop + target for the management line.
const open: PositionInput[] = [
  {
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 50,
    entryPrice: 200,
    entryDate: '2026-06-09',
    fees: 1,
    stopPrice: 192,
    targetPrice: 220,
    tags: ['swing'],
    grade: null,
    checklist: disciplined,
    notes: 'Re-entry after the breakout retest held.',
  },
  {
    assetType: 'option',
    symbol: 'SPY',
    side: 'long',
    quantity: 2,
    entryPrice: 8.5,
    entryDate: '2026-06-10',
    fees: 1.3,
    optionType: 'call',
    strike: 600,
    expiration: '2026-07-17',
    stopPrice: 5,
    targetPrice: 15,
    tags: ['index'],
    grade: null,
    checklist: disciplined,
    notes: 'Directional call on continued strength.',
  },
];

const WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY', 'QQQ', 'AMD'];

function main(): void {
  // Create the schema / run migrations if this is a fresh DB — the same
  // bootstrap the server does on startup.
  initDb();

  const force = process.argv.includes('--force');
  const existing = listPositions();

  // Watchlist add is idempotent (dedups), so it's always safe to apply.
  for (const sym of WATCHLIST) addToWatchlist(sym);

  if (existing.length > 0 && !force) {
    console.log(
      `Skipping trade seed — the database already has ${existing.length} position(s).\n` +
        `Watchlist ensured (${WATCHLIST.length} symbols). Re-run with --force to add demo trades anyway.`,
    );
    return;
  }

  let closedCount = 0;
  for (const c of closed) {
    const pos = createPosition(c.pos);
    addExit(pos.id, {
      quantity: c.pos.quantity,
      exitPrice: c.exit.price,
      exitDate: c.exit.date,
      fees: c.exit.fees ?? 0,
      notes: null,
    });
    closedCount++;
  }

  let openCount = 0;
  for (const o of open) {
    createPosition(o);
    openCount++;
  }

  console.log(
    `Seeded ${closedCount} closed + ${openCount} open position(s) and ${WATCHLIST.length} watchlist symbols.\n` +
      `Start the app with \`npm run dev\` and open http://localhost:5173`,
  );
}

main();

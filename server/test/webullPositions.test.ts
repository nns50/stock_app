import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { listPositions, createPosition, getPosition } from '../src/db/positions';
import { config } from '../src/config';
import {
  extractPositions,
  mapWebullPosition,
  looksLikeOption,
  previewWebullPositions,
  importWebullPositions,
  syncClosedWebullPositions,
  runWebullPositionsSync,
  comparePositionsToBroker,
} from '../src/providers/webull/positions';
import { priceMap } from '../src/services/quotes';
import { listAutotradeEvents } from '../src/db/autotradeEvents';

vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM position_exits; DELETE FROM positions; DELETE FROM webull_miss_streak; DELETE FROM autotrade_events;',
  );
  vi.mocked(priceMap).mockReset();
  // Default: price every probed position at $10 unless a test overrides it.
  vi.mocked(priceMap).mockImplementation(
    async (positions) => new Map(positions.map((p) => [p.id, { price: 10, stale: false, asOf: 0 }])),
  );
});

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
  vi.mocked(priceMap).mockReset();
});

function mockPositions(rows: unknown) {
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  } as Response);
}

describe('webull positions mapping', () => {
  it('extracts the list from common payload wrappers', () => {
    expect(extractPositions([{ symbol: 'AAPL' }])).toHaveLength(1);
    expect(extractPositions({ positions: [{ symbol: 'AAPL' }] })).toHaveLength(1);
    expect(extractPositions({ holdings: [{ symbol: 'A' }, { symbol: 'B' }] })).toHaveLength(2);
    expect(extractPositions({ nope: 1 })).toEqual([]);
  });

  it('maps a stock position (string fields, long)', () => {
    const p = mapWebullPosition({ symbol: 'aapl', asset_type: 'STOCK', quantity: '100', cost_price: '187.50' }, 'ACC1');
    expect(p).toMatchObject({ assetType: 'stock', symbol: 'AAPL', side: 'long', quantity: 100, entryPrice: 187.5 });
    expect(p?.tags).toContain('webull');
  });

  it('stamps the account it was fetched under, so a later sync can tell accounts apart', () => {
    const p = mapWebullPosition({ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '100' }, 'ACC1');
    expect(p?.accountId).toBe('ACC1');
    const p2 = mapWebullPosition({ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '100' }, 'ACC2');
    expect(p2?.accountId).toBe('ACC2');
  });

  it('maps an option position with strike/expiration/type', () => {
    const p = mapWebullPosition(
      {
        symbol: 'TSLA',
        instrument_type: 'OPTION',
        quantity: '2',
        cost_price: '5.40',
        option_type: 'CALL',
        strike_price: '400',
        option_expire_date: '2026-12-18',
      },
      'ACC1',
    );
    expect(p).toMatchObject({
      assetType: 'option',
      symbol: 'TSLA',
      quantity: 2,
      entryPrice: 5.4,
      optionType: 'call',
      strike: 400,
      expiration: '2026-12-18',
      multiplier: 100,
    });
  });

  it('infers short from a negative quantity and drops unusable rows', () => {
    expect(mapWebullPosition({ symbol: 'NVDA', quantity: '-50', cost_price: '100' }, 'ACC1')?.side).toBe('short');
    expect(mapWebullPosition({ symbol: '', quantity: '1' }, 'ACC1')).toBeNull(); // no symbol
    expect(mapWebullPosition({ symbol: 'X', quantity: '0' }, 'ACC1')).toBeNull(); // flat
    expect(
      mapWebullPosition({ symbol: 'Y', instrument_type: 'OPTION', quantity: '1', cost_price: '1' }, 'ACC1'),
    ).toBeNull(); // option missing legs
  });

  it('parses camelCase / synonym option field names (strikePrice, expirationDate, right)', () => {
    const p = mapWebullPosition(
      {
        symbol: 'AMD',
        assetType: 'OPTION',
        quantity: '3',
        avgCost: '2.10',
        right: 'P',
        strikePrice: '120',
        expirationDate: '2027-01-15',
      },
      'ACC1',
    );
    expect(p).toMatchObject({
      assetType: 'option',
      symbol: 'AMD',
      optionType: 'put',
      strike: 120,
      expiration: '2027-01-15',
    });
  });

  it('infers an option from a full option shape even when the payload gives no option asset type', () => {
    // A real cause of options never importing: the row carries strike +
    // expiration + type but its asset_type is blank/unrecognized. All three
    // present is a strong enough signal to classify it as an option.
    const p = mapWebullPosition(
      {
        symbol: 'SPY',
        quantity: '1',
        cost_price: '3.00',
        option_type: 'CALL',
        strike: '500',
        expiration: '2026-09-18',
        // no asset_type / instrument_type at all
      },
      'ACC1',
    );
    expect(p).toMatchObject({ assetType: 'option', optionType: 'call', strike: 500, expiration: '2026-09-18' });
  });

  it('does NOT misclassify a plain stock as an option from a stray partial field', () => {
    // Only a FULL option shape triggers inference — a stock with, say, a lone
    // strike-like field must stay a stock, not get dropped as an unparseable option.
    const p = mapWebullPosition({ symbol: 'KO', quantity: '10', cost_price: '60', strike: '999' }, 'ACC1');
    expect(p).toMatchObject({ assetType: 'stock', symbol: 'KO', quantity: 10 });
  });

  it('maps a real single-leg Webull option strategy from its nested legs[] (strike in option_exercise_price)', () => {
    // The exact shape a real account returns: a SINGLE strategy container whose
    // contract details live in legs[0], with the strike under
    // option_exercise_price — the field the old mapper never looked for.
    const p = mapWebullPosition(
      {
        quantity: '20',
        cost: '680.00',
        symbol: 'NFLX',
        option_strategy: 'SINGLE',
        instrument_type: 'OPTION',
        cost_price: '0.34',
        legs: [
          {
            symbol: 'NFLX',
            cost: '0.34',
            instrument_type: 'OPTION',
            option_type: 'PUT',
            option_expire_date: '2026-07-24',
            option_exercise_price: '68.00',
            option_contract_multiplier: '100',
          },
        ],
      },
      'ACC1',
    );
    expect(p).toMatchObject({
      assetType: 'option',
      symbol: 'NFLX',
      side: 'long',
      quantity: 20,
      entryPrice: 0.34,
      optionType: 'put',
      strike: 68,
      expiration: '2026-07-24',
      multiplier: 100,
    });
  });

  it('leaves a genuine MULTI-leg option strategy (a spread) unmapped — the journal is one contract per row', () => {
    // Two legs, and no per-leg buy/sell side in the payload — can't be
    // represented as a single journal row, so it's left for the unmappedOptions
    // diagnostic rather than imported wrong.
    const p = mapWebullPosition(
      {
        quantity: '1',
        symbol: 'SPY',
        option_strategy: 'VERTICAL',
        instrument_type: 'OPTION',
        cost_price: '1.20',
        legs: [
          { symbol: 'SPY', option_type: 'CALL', option_expire_date: '2026-09-18', option_exercise_price: '500' },
          { symbol: 'SPY', option_type: 'CALL', option_expire_date: '2026-09-18', option_exercise_price: '510' },
        ],
      },
      'ACC1',
    );
    expect(p).toBeNull();
  });
});

describe('previewWebullPositions unmapped-options diagnostics', () => {
  it('flags a stock vs an option-looking row via looksLikeOption', () => {
    expect(looksLikeOption({ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10' })).toBe(false);
    expect(looksLikeOption({ symbol: 'AAPL', asset_type: 'OPTION', quantity: '1' })).toBe(true);
    expect(looksLikeOption({ symbol: 'AAPL', strikePrice: '100', quantity: '1' })).toBe(true); // option-defining field
  });

  it('counts how many unmapped rows looked like options and samples their keys', async () => {
    mockPositions([
      { symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '150' }, // maps fine
      // Option-looking but unparseable (no expiration) — the "why aren't my options showing" case.
      { symbol: 'TSLA', asset_type: 'OPTION', quantity: '1', cost_price: '5', option_type: 'CALL', strike: '400' },
      { nonsense: true }, // unmapped, not option-like
    ]);

    const preview = await previewWebullPositions('ACC1');
    expect(preview.ok).toBe(true);
    expect(preview.positions.map((p) => p.symbol)).toEqual(['AAPL']);
    expect(preview.unmapped).toBe(2);
    expect(preview.unmappedOptions).toBe(1);
    // Option-looking sample sorted first, exposing the row's field names.
    expect(preview.unmappedSample[0]).toMatchObject({ looksLikeOption: true });
    expect(preview.unmappedSample[0].keys).toEqual(
      expect.arrayContaining(['symbol', 'asset_type', 'option_type', 'strike']),
    );
  });
});

describe('importWebullPositions', () => {
  it('adds new open positions and skips ones already in the journal under the SAME account', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
      accountId: 'ACC1',
    });
    mockPositions([
      { symbol: 'AAPL', asset_type: 'STOCK', quantity: '100', cost_price: '150' }, // dup -> skip
      { symbol: 'MSFT', asset_type: 'STOCK', quantity: '20', cost_price: '410' }, // new -> import
      { symbol: '', quantity: '1' }, // unmapped
    ]);

    const r = await importWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, imported: 1, skipped: 1, unmapped: 1 });
    const open = listPositions({ status: 'open' });
    expect(open.map((p) => p.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  // The actual reported bug: a second real account of the same user buys a
  // symbol the first account already holds. Before accountId existed, this
  // silently deduped against the first account's row (matchesOpen was
  // symbol-only) instead of creating a distinct position for the new holding.
  it('does NOT dedupe a same-symbol holding in a DIFFERENT account — creates a distinct position', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
      accountId: 'CASH',
    });
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '50', cost_price: '180' }]);

    const r = await importWebullPositions('MARGIN');
    expect(r).toMatchObject({ ok: true, imported: 1, skipped: 0 });
    const open = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(open).toHaveLength(2);
    expect(open.map((p) => p.accountId).sort()).toEqual(['CASH', 'MARGIN']);
    expect(open.find((p) => p.accountId === 'CASH')!.quantity).toBe(100); // untouched
    expect(open.find((p) => p.accountId === 'MARGIN')!.quantity).toBe(50);
  });

  it('claims a legacy unassigned position for the account whose sync first confirms it', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
      // No accountId — a row from before this column existed.
    });
    expect(p.accountId).toBeNull();
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '100', cost_price: '150' }]);

    const r = await importWebullPositions('CASH');
    expect(r).toMatchObject({ imported: 0, skipped: 1 }); // matched, not duplicated
    expect(getPosition(p.id)!.accountId).toBe('CASH'); // backfilled
  });

  it('surfaces a Webull error without writing', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'INVALID_TOKEN' }),
    } as Response);
    const r = await importWebullPositions('ACC1');
    expect(r.ok).toBe(false);
    expect(r.imported).toBe(0);
    expect(listPositions()).toHaveLength(0);
  });
});

describe('syncClosedWebullPositions', () => {
  it('closes a Webull-tracked position no longer held at the broker, once confirmed on 2 consecutive syncs', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([]); // Webull shows nothing held anymore

    // First miss is NOT enough by itself — see the miss-streak debounce test
    // below for why (a single incomplete/flaky broker response used to
    // fabricate a close on the spot).
    const r1 = await syncClosedWebullPositions('ACC1');
    expect(r1).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 1, closedSymbols: ['VRAX'] });

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exits).toHaveLength(1);
    expect(closed.exits[0]).toMatchObject({ quantity: 50, exitPrice: 10 });
    expect(closed.exits[0].notes).toMatch(/Auto-closed via Webull sync/);
  });

  it('logs a position_reconciled_from_broker event once the close is confirmed (equity used to close silently)', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([]);

    await syncClosedWebullPositions('ACC1'); // first miss — no event yet
    expect(listAutotradeEvents({ actions: ['position_reconciled_from_broker'] })).toHaveLength(0);

    await syncClosedWebullPositions('ACC1');
    const events = listAutotradeEvents({ actions: ['position_reconciled_from_broker'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: 'VRAX', stage: 'execution' });
    expect(JSON.parse(events[0].detail!)).toMatchObject({
      via: 'broker_sync',
      accountId: 'ACC1',
      journalQtyBefore: 50,
      brokerQty: 0,
      gapClosed: 50,
      exitPrice: 10,
      fullyClosed: true,
    });
  });

  it('logs fullyClosed:false for a partial reconciliation (fewer shares than the journal, not zero)', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'KC',
      side: 'long',
      quantity: 100,
      entryPrice: 15,
      entryDate: '2026-01-02',
      tags: ['live'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'KC', asset_type: 'STOCK', quantity: '40', cost_price: '15' }]);

    await syncClosedWebullPositions('ACC1');
    await syncClosedWebullPositions('ACC1');

    const events = listAutotradeEvents({ actions: ['position_reconciled_from_broker'] });
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detail!)).toMatchObject({
      journalQtyBefore: 100,
      brokerQty: 40,
      gapClosed: 60,
      fullyClosed: false,
    });
  });

  // The other half of the reported bug: switching the configured account
  // from cash to margin wrongly auto-closed the cash account's still-open
  // real positions, because the old close-detector diffed ALL locally-open
  // Webull-tracked positions against just the ONE account being synced.
  it('does NOT close a Webull-tracked position that belongs to a DIFFERENT account', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'CASH',
    });
    mockPositions([]); // MARGIN shows nothing held — irrelevant, VRAX lives in CASH

    const r = await syncClosedWebullPositions('MARGIN');
    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');
    expect(getPosition(p.id)!.remainingQuantity).toBe(50);
  });

  it('self-heals a Webull-tracked legacy row with no account recorded when this is the only account known (single-account setup)', async () => {
    // A legacy row (tagged 'webull', never account-stamped) that was already
    // sold before any sync claimed it — the stuck-open-forever case. With no
    // OTHER account ever recorded, it can only belong to the account being
    // synced, so it's safe to close + claim it here.
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      // No accountId.
    });
    mockPositions([]);

    await syncClosedWebullPositions('ACC1'); // first miss — not confirmed yet
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 1, closedSymbols: ['VRAX'] });
    const after = getPosition(p.id)!;
    expect(after.status).toBe('closed');
    expect(after.accountId).toBe('ACC1'); // claimed to the syncing account
  });

  it('does NOT close an unassigned legacy row once a SECOND account is known (multi-account: can no longer be certain which account it belongs to)', async () => {
    // A different account's presence in the journal means an unassigned row is
    // no longer unambiguously this account's — closing it could be a
    // cross-account false close, so it's left strictly alone (surfaced via the
    // Compare-to-broker view instead), preserving the task #120 protection.
    createPosition({
      assetType: 'stock',
      symbol: 'KEEP',
      side: 'long',
      quantity: 10,
      entryPrice: 5,
      entryDate: '2026-01-01',
      tags: ['webull'],
      accountId: 'ACC2', // a second, distinct account exists
    });
    const legacy = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      // No accountId.
    });
    mockPositions([{ symbol: 'KEEP', asset_type: 'STOCK', quantity: '10', cost_price: '5' }]); // ACC1 shows nothing of VRAX

    await syncClosedWebullPositions('ACC1');
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(getPosition(legacy.id)!.status).toBe('open'); // preserved, not false-closed
    expect(getPosition(legacy.id)!.accountId).toBeNull();
  });

  it('never closes a plain manually-logged position with no Webull provenance', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'WRAP',
      side: 'long',
      quantity: 10,
      entryPrice: 5,
      entryDate: '2026-01-02',
      // No 'webull'/'live' tag and no sourceIntentId — e.g. tracked at another broker.
    });
    mockPositions([]); // not in Webull's list either, but that's expected — it's not Webull's

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('records a partial exit when Webull now shows fewer shares than the journal', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'KC',
      side: 'long',
      quantity: 100,
      entryPrice: 15,
      entryDate: '2026-01-02',
      tags: ['live'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'KC', asset_type: 'STOCK', quantity: '40', cost_price: '15' }]);

    await syncClosedWebullPositions('ACC1'); // first miss — not confirmed yet
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 1, closedSymbols: ['KC'] });
    const after = getPosition(p.id)!;
    expect(after.status).toBe('open'); // still holding 40
    expect(after.remainingQuantity).toBe(40);
  });

  it('closes the oldest lot first (FIFO) across two open lots of the same contract', async () => {
    const older = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 50,
      entryPrice: 150,
      entryDate: '2026-01-01',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    const newer = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 50,
      entryPrice: 160,
      entryDate: '2026-01-05',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    // Journal shows 100 total; broker now shows only 30 -> 70-share gap.
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '30', cost_price: '155' }]);

    await syncClosedWebullPositions('ACC1'); // first miss — not confirmed yet
    await syncClosedWebullPositions('ACC1');
    expect(getPosition(older.id)!.status).toBe('closed'); // fully closed first
    expect(getPosition(older.id)!.remainingQuantity).toBe(0);
    const afterNewer = getPosition(newer.id)!;
    expect(afterNewer.status).toBe('open');
    expect(afterNewer.remainingQuantity).toBe(30); // 50 - 20 taken to cover the rest of the gap
  });

  it('leaves the position open when a price cannot be resolved', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'ILLQ',
      side: 'long',
      quantity: 10,
      entryPrice: 3,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    // priceMap is only ever consulted once the miss is CONFIRMED (2nd
    // consecutive sync) — it's never called at all on the first, unconfirmed
    // miss, so queuing this mockResolvedValueOnce still lines up with the
    // call that actually needs it.
    vi.mocked(priceMap).mockResolvedValueOnce(new Map([[p.id, { price: null, stale: false, asOf: null }]]));
    mockPositions([]);

    const r1 = await syncClosedWebullPositions('ACC1');
    expect(r1).toMatchObject({ closed: 0, closedSymbols: [] });
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('logs a one-time position_reconcile_skipped event when a confirmed-gone position cannot be priced, so it is not silently stuck', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'ILLQ',
      side: 'long',
      quantity: 10,
      entryPrice: 3,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    // Unpriceable on both confirmed syncs (2nd and 3rd).
    vi.mocked(priceMap).mockResolvedValue(new Map([[p.id, { price: null, stale: false, asOf: null }]]));
    mockPositions([]);

    await syncClosedWebullPositions('ACC1'); // 1st miss — unconfirmed, no price attempt, no event
    expect(listAutotradeEvents({ actions: ['position_reconcile_skipped'] })).toHaveLength(0);

    await syncClosedWebullPositions('ACC1'); // 2nd miss — confirmed, priced null → one skip event
    await syncClosedWebullPositions('ACC1'); // still missing + unpriceable — must NOT log again (no spam)

    const events = listAutotradeEvents({ actions: ['position_reconcile_skipped'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: 'ILLQ', stage: 'execution' });
    expect(JSON.parse(events[0].detail!)).toMatchObject({ via: 'broker_sync', reason: 'no_price', brokerQty: 0 });
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('surfaces a Webull error without writing', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-01-02',
      tags: ['webull'],
    });
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'INVALID_TOKEN' }),
    } as Response);
    const r = await syncClosedWebullPositions('ACC1');
    expect(r.ok).toBe(false);
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });
});

// Regression coverage for the flapping bug: a low-priced/thinly-covered
// symbol intermittently missing from a single broker preview response used
// to be enough, by itself, to fabricate a close — and the very next
// successful sync would then re-import it as a brand-new position, cycling
// indefinitely (observed in production: hundreds of open/close cycles over
// several hours, each booking a fabricated realized loss). See
// webull_miss_streak's table comment (db/index.ts).
describe('miss-streak debounce (flapping-close bug fix)', () => {
  it('does NOT close on a single missing observation', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'IOTR',
      side: 'long',
      quantity: 2,
      entryPrice: 3.79,
      entryDate: '2026-07-09',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([]); // one flaky/incomplete preview omits it

    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');
    expect(getPosition(p.id)!.remainingQuantity).toBe(2);
  });

  it('closes once the same contract is missing on 2 CONSECUTIVE syncs', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'IOTR',
      side: 'long',
      quantity: 2,
      entryPrice: 3.79,
      entryDate: '2026-07-09',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([]);

    const r1 = await syncClosedWebullPositions('ACC1');
    expect(r1.closed).toBe(0);
    const r2 = await syncClosedWebullPositions('ACC1');
    expect(r2).toMatchObject({ ok: true, closed: 1, closedSymbols: ['IOTR'] });
  });

  it('a confirmed "still held" sync in between resets the streak — a later single miss does not close it', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'IOTR',
      side: 'long',
      quantity: 2,
      entryPrice: 3.79,
      entryDate: '2026-07-09',
      tags: ['webull'],
      accountId: 'ACC1',
    });

    mockPositions([]); // miss #1
    await syncClosedWebullPositions('ACC1');
    expect(getPosition(p.id)!.status).toBe('open');

    mockPositions([{ symbol: 'IOTR', asset_type: 'STOCK', quantity: '2', cost_price: '3.79' }]); // confirmed held
    await syncClosedWebullPositions('ACC1');
    expect(getPosition(p.id)!.status).toBe('open');

    mockPositions([]); // miss #1 again (streak was reset, not carried over)
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 0, closedSymbols: [] });
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('does not require re-confirmation across DIFFERENT contracts — each key has its own streak', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'IOTR',
      side: 'long',
      quantity: 2,
      entryPrice: 3.79,
      entryDate: '2026-07-09',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    const cjmb = createPosition({
      assetType: 'stock',
      symbol: 'CJMB',
      side: 'long',
      quantity: 356,
      entryPrice: 1.22,
      entryDate: '2026-07-17',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    // First sync: only IOTR misses. Second sync: only CJMB misses. Neither
    // should close — each contract needs its OWN 2 consecutive misses.
    mockPositions([{ symbol: 'CJMB', asset_type: 'STOCK', quantity: '356', cost_price: '1.22' }]);
    await syncClosedWebullPositions('ACC1');
    mockPositions([{ symbol: 'IOTR', asset_type: 'STOCK', quantity: '2', cost_price: '3.79' }]);
    const r = await syncClosedWebullPositions('ACC1');
    expect(r).toMatchObject({ closed: 0, closedSymbols: [] });
    expect(getPosition(cjmb.id)!.status).toBe('open');
  });
});

describe('runWebullPositionsSync', () => {
  it('closes and imports in the same pass off a single live-positions fetch, once the close is confirmed', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 50,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    // VRAX no longer held; MSFT is new.
    mockPositions([{ symbol: 'MSFT', asset_type: 'STOCK', quantity: '20', cost_price: '410' }]);

    const r1 = await runWebullPositionsSync('ACC1');
    // First miss isn't confirmed yet, but import is never debounced — MSFT
    // shows up immediately (only the destructive close side waits).
    expect(r1).toMatchObject({ ok: true, closed: 0, imported: 1, skipped: 0 });

    const r = await runWebullPositionsSync('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 1, closedSymbols: ['VRAX'], imported: 0, skipped: 1 });
    expect(getPosition(p.id)!.status).toBe('closed');
    expect(listPositions({ status: 'open' }).map((x) => x.symbol)).toEqual(['MSFT']);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // one shared preview fetch per call, not two per call
  });

  it('reports nothing to do when the journal already matches the broker', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 150,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '150' }]);

    const r = await runWebullPositionsSync('ACC1');
    expect(r).toMatchObject({ ok: true, closed: 0, imported: 0, skipped: 1 });
  });

  // End-to-end regression test for the exact reported scenario: switching
  // the synced account from cash to margin must neither close the cash
  // account's real open position nor merge the margin account's new buy
  // into it.
  it('switching accounts never closes the old account and never merges the new account onto it', async () => {
    const cashAapl = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'CASH',
    });

    // User switches the configured account to MARGIN, which also holds AAPL.
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '50', cost_price: '180' }]);
    const r = await runWebullPositionsSync('MARGIN');

    expect(r).toMatchObject({ ok: true, closed: 0, closedSymbols: [], imported: 1, skipped: 0 });
    expect(getPosition(cashAapl.id)!.status).toBe('open'); // still open
    expect(getPosition(cashAapl.id)!.remainingQuantity).toBe(100); // untouched

    const open = listPositions({ status: 'open', symbol: 'AAPL' });
    expect(open).toHaveLength(2); // CASH's original + a NEW row for MARGIN
    expect(open.find((p) => p.accountId === 'MARGIN')!.quantity).toBe(50);
  });
});

describe('comparePositionsToBroker', () => {
  it('reports a match when the journal and broker agree', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 150,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '10', cost_price: '150' }]);

    const r = await comparePositionsToBroker('ACC1');
    expect(r).toMatchObject({ ok: true, accountId: 'ACC1' });
    expect(r.rows).toEqual([expect.objectContaining({ symbol: 'AAPL', brokerQty: 10, journalQty: 10, matches: true })]);
  });

  it('reports a mismatch, in either direction, without writing anything', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'CJMB',
      side: 'long',
      quantity: 427,
      entryPrice: 1.22,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'CJMB', asset_type: 'STOCK', quantity: '356', cost_price: '1.22' }]);

    const r = await comparePositionsToBroker('ACC1');
    expect(r.rows).toEqual([
      expect.objectContaining({ symbol: 'CJMB', brokerQty: 356, journalQty: 427, matches: false }),
    ]);
    // Read-only — a real gap this large would take 2 confirmed syncs to close;
    // comparing must never itself write an exit or touch the miss streak.
    expect(getPosition(p.id)!.remainingQuantity).toBe(427);
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('includes a symbol only the broker holds (never imported) and one only the journal holds (never sold)', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'ONLYJOURNAL',
      side: 'long',
      quantity: 5,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    mockPositions([{ symbol: 'ONLYBROKER', asset_type: 'STOCK', quantity: '3', cost_price: '9' }]);

    const r = await comparePositionsToBroker('ACC1');
    expect(r.rows).toContainEqual(
      expect.objectContaining({ symbol: 'ONLYBROKER', brokerQty: 3, journalQty: 0, matches: false }),
    );
    expect(r.rows).toContainEqual(
      expect.objectContaining({ symbol: 'ONLYJOURNAL', brokerQty: 0, journalQty: 5, matches: false }),
    );
  });

  it('is scoped to the requested account only, ignoring a different account holding the same symbol', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 150,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'CASH',
    });
    mockPositions([{ symbol: 'AAPL', asset_type: 'STOCK', quantity: '50', cost_price: '180' }]);

    const r = await comparePositionsToBroker('MARGIN');
    expect(r.rows).toEqual([expect.objectContaining({ symbol: 'AAPL', brokerQty: 50, journalQty: 0, matches: false })]);
  });

  it('includes a legacy unassigned journal row (permissive, unlike the close-detector)', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'SLND',
      side: 'long',
      quantity: 39,
      entryPrice: 1.06,
      entryDate: '2026-01-02',
      tags: ['webull'],
      // No accountId — legacy row.
    });
    mockPositions([{ symbol: 'SLND', asset_type: 'STOCK', quantity: '39', cost_price: '1.06' }]);

    const r = await comparePositionsToBroker('ACC1');
    expect(r.rows).toEqual([expect.objectContaining({ symbol: 'SLND', brokerQty: 39, journalQty: 39, matches: true })]);
  });

  it('surfaces a Webull error without writing', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'INVALID_TOKEN' }),
    } as Response);

    const r = await comparePositionsToBroker('ACC1');
    expect(r).toMatchObject({ ok: false, accountId: 'ACC1', rows: [] });
    expect(r.error).toBeTruthy();
  });
});

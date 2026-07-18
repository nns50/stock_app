import {
  AssetType,
  ImportablePosition,
  OptionType,
  Position,
  Side,
  addExit,
  createPosition,
  listPositions,
  updatePosition,
} from '../../db/positions';
import { priceMap } from '../../services/quotes';
import { webullClient, webullConfigured } from './account';
import { bumpMissStreak, clearMissStreak, MISS_CONFIRM_THRESHOLD } from '../../db/webullMissStreak';
import { logAutotradeEvent } from '../../db/autotradeEvents';

// ---------------------------------------------------------------------------
// Sync open brokerage positions from Webull into the trade journal.
//
// Webull's /openapi/assets/positions response shape isn't published (the docs
// block automated fetch and the SDK only models requests), so the mapper reads
// a range of likely field names and the flow is PREVIEW-AND-CONFIRM: the UI
// shows the parsed rows + the raw payload before anything is written, and the
// mapping gets verified against a real position on first sync. Import only ever
// *adds* open positions the journal doesn't already have — it never edits or
// deletes existing journal entries.
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== null && o[k] !== undefined && o[k] !== '') return o[k];
  }
  return undefined;
}

/** Pull the position list out of whatever wrapper Webull returns. */
export function extractPositions(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    for (const key of ['positions', 'holdings', 'items', 'data', 'list']) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function toIsoDate(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : undefined;
}

function toOptionType(v: unknown): OptionType | undefined {
  const s = String(v ?? '').toUpperCase();
  if (s.startsWith('C')) return 'call';
  if (s.startsWith('P')) return 'put';
  return undefined;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Map one raw Webull position to an importable journal position (or null if
 *  unusable). `accountId` is stamped onto the result so the reconciliation
 *  below can tell one brokerage account's holdings apart from another's — see
 *  the account_id column comment in db/index.ts for why that matters. */
export function mapWebullPosition(p: Record<string, unknown>, accountId: string): ImportablePosition | null {
  const symbol = String(pick(p, ['symbol', 'ticker', 'instrument_symbol', 'underlying_symbol']) ?? '').toUpperCase();
  if (!symbol) return null;

  const rawType = String(pick(p, ['asset_type', 'instrument_type', 'category', 'sec_type']) ?? '').toUpperCase();
  const assetType: AssetType = rawType.includes('OPTION') ? 'option' : 'stock';

  const signedQty = num(pick(p, ['quantity', 'position', 'qty', 'holding_quantity', 'total_quantity']));
  const quantity = signedQty === undefined ? 0 : Math.abs(signedQty);
  if (quantity <= 0) return null;

  const sideRaw = String(pick(p, ['side', 'direction', 'position_side']) ?? '').toUpperCase();
  const side: Side = sideRaw.includes('SHORT') || (signedQty ?? 0) < 0 ? 'short' : 'long';

  const entryPrice = num(pick(p, ['cost_price', 'avg_cost', 'average_cost', 'cost', 'avg_price', 'open_price'])) ?? 0;
  const entryDate =
    toIsoDate(pick(p, ['open_date', 'entry_date', 'position_date', 'create_time', 'created_at'])) ?? today();

  const out: ImportablePosition = {
    assetType,
    symbol,
    side,
    quantity,
    entryPrice,
    entryDate,
    status: 'open',
    tags: ['webull'],
    notes: 'Imported from Webull',
    accountId,
  };

  if (assetType === 'option') {
    out.optionType = toOptionType(pick(p, ['option_type', 'put_call', 'call_or_put']));
    out.strike = num(pick(p, ['strike_price', 'strike']));
    out.expiration = toIsoDate(pick(p, ['option_expire_date', 'expiration', 'expire_date', 'exp_date']));
    out.multiplier = num(pick(p, ['multiplier', 'unit'])) ?? 100;
    // An option we can't fully describe can't be journaled.
    if (!out.optionType || !out.strike || !out.expiration) return null;
  }

  return out;
}

export interface PositionsPreview {
  ok: boolean;
  url?: string;
  accountId: string;
  /** Successfully mapped, journal-ready positions. */
  positions: ImportablePosition[];
  /** Raw Webull payload, so the mapping can be eyeballed before import. */
  raw?: unknown;
  /** Rows present in the payload that couldn't be mapped. */
  unmapped: number;
  error?: string;
}

async function fetchPositions(accountId: string): Promise<{ ok: boolean; url: string; status: number; raw: unknown }> {
  const r = await webullClient().call('GET', '/openapi/assets/positions', {
    query: { account_id: accountId },
    surface: 'trade',
  });
  return { ok: r.ok, url: r.url, status: r.status, raw: r.data };
}

/** Fetch + map live Webull positions for an account, writing nothing. */
export async function previewWebullPositions(accountId: string): Promise<PositionsPreview> {
  if (!webullConfigured()) {
    return { ok: false, accountId, positions: [], unmapped: 0, error: 'Webull is not configured.' };
  }
  const r = await fetchPositions(accountId);
  if (!r.ok) {
    const j = (r.raw ?? {}) as { msg?: string; message?: string };
    return {
      ok: false,
      url: r.url,
      accountId,
      positions: [],
      unmapped: 0,
      raw: r.raw,
      error: j.msg || j.message || `Webull request failed (${r.status})`,
    };
  }
  const rows = extractPositions(r.raw);
  const positions = rows
    .map((row) => mapWebullPosition(row, accountId))
    .filter((p): p is ImportablePosition => p !== null);
  return { ok: true, url: r.url, accountId, positions, raw: r.raw, unmapped: rows.length - positions.length };
}

/** The existing open journal position an importable position matches, if any.
 *  `open` is expected to already be scoped to this account (plus unassigned
 *  legacy rows — see PositionFilter.includeUnassignedAccount) by the caller;
 *  this only re-checks contract identity, not account. */
function findMatch(open: Position[], p: ImportablePosition): Position | undefined {
  return open.find(
    (o) =>
      o.symbol === p.symbol.toUpperCase() &&
      o.assetType === p.assetType &&
      (p.assetType !== 'option' ||
        (o.strike === (p.strike ?? null) &&
          o.expiration === (p.expiration ?? null) &&
          o.optionType === (p.optionType ?? null))),
  );
}

export interface ContractLike {
  symbol: string;
  assetType: AssetType;
  optionType?: OptionType | null;
  strike?: number | null;
  expiration?: string | null;
}

/** Groups a Position/ImportablePosition by underlying contract — same identity
 *  `findMatch` already uses (symbol + asset type + option legs), NOT side, NOT
 *  account. A long flipping to a short in the same symbol between syncs is a
 *  known, pre-existing blind spot shared with findMatch — this mirrors it
 *  rather than inventing stricter matching only the close-detector below
 *  applies. Account scoping happens one level up, in which Positions the
 *  caller passes in (see closePositionsFromPreview) — not in this key.
 *  Exported so liveOptionsExecute.ts's own broker-truth backstop (over the
 *  SEPARATE autotrade_live_options_positions table, not this file's
 *  `positions`) can identify the same contract identity per LEG, without
 *  duplicating this matching logic. */
export function contractKey(p: ContractLike): string {
  if (p.assetType !== 'option') return `${p.symbol.toUpperCase()}|stock`;
  return `${p.symbol.toUpperCase()}|option|${p.optionType ?? ''}|${p.strike ?? ''}|${p.expiration ?? ''}`;
}

export interface ImportSummary {
  ok: boolean;
  accountId: string;
  imported: number;
  /** Already present as an open journal position. */
  skipped: number;
  /** Present in the payload but not journal-mappable. */
  unmapped: number;
  created: Position[];
  error?: string;
}

function importFromPreview(accountId: string, preview: PositionsPreview): ImportSummary {
  const open = listPositions({ status: 'open', accountId, includeUnassignedAccount: true });
  const created: Position[] = [];
  let skipped = 0;
  for (const p of preview.positions) {
    const match = findMatch(open, p);
    if (match) {
      skipped++;
      // A legacy row from before account tracking existed — claim it now
      // that a sync against this specific account has confirmed it belongs
      // here, so future syncs no longer need to treat it as unassigned.
      if (match.accountId === null) updatePosition(match.id, { accountId });
      continue;
    }
    created.push(createPosition(p));
  }
  return { ok: true, accountId, imported: created.length, skipped, unmapped: preview.unmapped, created };
}

/**
 * Import open Webull positions the journal doesn't already have. Re-fetches live
 * (authoritative) rather than trusting a client-supplied list, and only adds —
 * never edits or removes existing journal entries.
 */
export async function importWebullPositions(accountId: string): Promise<ImportSummary> {
  const preview = await previewWebullPositions(accountId);
  if (!preview.ok) {
    return {
      ok: false,
      accountId,
      imported: 0,
      skipped: 0,
      unmapped: preview.unmapped,
      created: [],
      error: preview.error,
    };
  }
  return importFromPreview(accountId, preview);
}

/** An open journal position counts as Webull-attributable only if the app
 *  itself put it there from this brokerage: imported by this same sync
 *  (tagged 'webull'), opened by a live autotrade fill (tagged 'live'), or
 *  linked to a live order_intent (sourceIntentId). A plain manually-logged
 *  position (e.g. tracked at a different broker) is left alone even though
 *  it isn't in Webull's live list — closing it based on Webull's holdings
 *  would be a false positive. */
export function isWebullTracked(p: Position): boolean {
  return p.tags.includes('webull') || p.tags.includes('live') || p.sourceIntentId !== null;
}

export interface ClosedSyncResult {
  ok: boolean;
  accountId: string;
  /** Number of exit records written (one lot closed FIFO can span several rows). */
  closed: number;
  /** Distinct symbols that had at least one exit recorded. */
  closedSymbols: string[];
  error?: string;
}

const NOTE_AUTO_CLOSED =
  'Auto-closed via Webull sync — no longer held at the broker. Exit price is an ESTIMATE from the ' +
  'latest quote (not a confirmed fill); edit it if you have your broker confirmation.';

/**
 * Close the gap between what the journal thinks is open (for Webull-tracked
 * positions only) and what Webull's live position list actually shows,
 * oldest-lot-first (FIFO) — the read side of the sync, complementing
 * importFromPreview's add side. This is what neither the order-status
 * reconcile (services/trading/reconcile.ts, autotrading/liveExecute.ts —
 * both only poll orders THIS app placed) nor the plain import above (add-only
 * by design) ever did: notice a position sold at the broker OUTSIDE any order
 * this app tracked (e.g. placed directly in the Webull app) and record the
 * exit. Priced via the same quote/mark resolver Positions/Journal already use
 * (services/quotes.ts's priceMap) since there's no broker fill to read a
 * price from; a contract priceMap can't resolve is left open rather than
 * guessed at $0 — it'll be picked up on a later sync once pricing recovers.
 * A contract only comes up short here once — on the very first sync that
 * doesn't show it — WITHOUT necessarily meaning it's gone from the broker: a
 * single incomplete/flaky preview response is enough to trigger this. So a
 * gap is NOT acted on immediately; see webull_miss_streak (db/index.ts) for
 * the consecutive-confirmation debounce that guards against exactly that.
 */
async function closePositionsFromPreview(
  preview: PositionsPreview,
): Promise<{ closed: number; closedSymbols: string[] }> {
  const liveQtyByKey = new Map<string, number>();
  for (const p of preview.positions) {
    const key = contractKey(p);
    liveQtyByKey.set(key, (liveQtyByKey.get(key) ?? 0) + p.quantity);
  }

  // Strictly this account's own rows — deliberately NOT includeUnassignedAccount
  // (unlike importFromPreview's add-side): closing something we're not certain
  // belongs to THIS account is exactly the false-close bug this exists to
  // prevent. A legacy unassigned row only becomes close-eligible once some
  // account's import pass has claimed it (see importFromPreview above).
  const open = listPositions({ status: 'open', accountId: preview.accountId }).filter(isWebullTracked);
  const lotsByKey = new Map<string, Position[]>();
  for (const p of open) {
    const key = contractKey(p);
    (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push(p);
  }

  const toClose = new Map<string, { lots: Position[]; qty: number; journalQtyBefore: number; brokerQty: number }>();
  for (const [key, lots] of lotsByKey) {
    lots.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id - b.id); // FIFO: oldest first
    const journalQty = lots.reduce((s, p) => s + p.remainingQuantity, 0);
    const brokerQty = liveQtyByKey.get(key) ?? 0;
    const gap = journalQty - brokerQty;
    if (gap > 1e-9) {
      // Missing (fully or partially) from THIS preview — require it to stay
      // missing on MISS_CONFIRM_THRESHOLD consecutive syncs, with no
      // fully-confirmed observation in between, before trusting it enough to
      // write a close. See the doc comment above and webull_miss_streak's
      // table comment for the flapping bug this prevents.
      const streak = bumpMissStreak(preview.accountId, key);
      if (streak >= MISS_CONFIRM_THRESHOLD)
        toClose.set(key, { lots, qty: gap, journalQtyBefore: journalQty, brokerQty });
    } else {
      // Fully accounted for in this preview — any earlier miss streak was wrong.
      clearMissStreak(preview.accountId, key);
    }
  }
  if (toClose.size === 0) return { closed: 0, closedSymbols: [] };

  // Price once per contract (any lot of the same contract shares one live price).
  const prices = await priceMap(Array.from(toClose.values(), ({ lots }) => lots[0]));

  const exitDate = today();
  const closedSymbols = new Set<string>();
  let closed = 0;
  for (const [key, { lots, qty, journalQtyBefore, brokerQty }] of toClose) {
    const exitPrice = prices.get(lots[0].id)?.price;
    if (exitPrice == null) continue; // can't price it — leave open, retry next sync
    let remaining = qty;
    let reconciled = 0;
    for (const p of lots) {
      if (remaining <= 1e-9) break;
      const take = Math.min(remaining, p.remainingQuantity);
      if (take <= 1e-9) continue;
      const result = addExit(p.id, { quantity: take, exitPrice, exitDate, notes: NOTE_AUTO_CLOSED });
      if (result) {
        closed++;
        reconciled += take;
        closedSymbols.add(p.symbol);
      }
      remaining -= take;
    }
    // Unlike the options side's syncLiveOptionsPositionsFromBroker (which
    // always logs a 'live_options_position_closed' event), this used to close
    // equity positions SILENTLY — the only trace was the exit's own note text
    // on the position itself, nothing on the Recent Activity feed. Logging
    // here brings equity to parity, so a broker-truth reconciliation (whether
    // it fully closes a lot or just trims a quantity mismatch across several
    // lots, as FIFO can) is visible as its own event, not just discoverable
    // later by noticing the P&L or open quantity looks wrong.
    if (reconciled > 1e-9) {
      logAutotradeEvent({
        symbol: lots[0].symbol,
        stage: 'execution',
        action: 'position_reconciled_from_broker',
        detail: {
          via: 'broker_sync',
          accountId: preview.accountId,
          journalQtyBefore,
          brokerQty,
          gapClosed: reconciled,
          exitPrice,
          fullyClosed: journalQtyBefore - reconciled <= 1e-9,
        },
      });
    }
    // Acted on this contract's gap — a further gap next sync starts a fresh count.
    clearMissStreak(preview.accountId, key);
  }
  return { closed, closedSymbols: Array.from(closedSymbols) };
}

/** Standalone close-detection pass — fetches its own live positions preview.
 *  Prefer runWebullPositionsSync() when also importing, so the live list is
 *  only fetched once. */
export async function syncClosedWebullPositions(accountId: string): Promise<ClosedSyncResult> {
  const preview = await previewWebullPositions(accountId);
  if (!preview.ok) return { ok: false, accountId, closed: 0, closedSymbols: [], error: preview.error };
  const { closed, closedSymbols } = await closePositionsFromPreview(preview);
  return { ok: true, accountId, closed, closedSymbols };
}

export interface WebullSyncResult {
  ok: boolean;
  accountId: string;
  closed: number;
  closedSymbols: string[];
  imported: number;
  skipped: number;
  unmapped: number;
  error?: string;
}

/**
 * The full two-way sync: close what Webull no longer shows as held, then
 * import anything new — one live positions fetch shared by both halves. This
 * is what both the manual "Sync now" action and the background scheduler
 * (services/webullPositionsScheduler.ts) call.
 */
export async function runWebullPositionsSync(accountId: string): Promise<WebullSyncResult> {
  const preview = await previewWebullPositions(accountId);
  if (!preview.ok) {
    return {
      ok: false,
      accountId,
      closed: 0,
      closedSymbols: [],
      imported: 0,
      skipped: 0,
      unmapped: 0,
      error: preview.error,
    };
  }
  const closeResult = await closePositionsFromPreview(preview);
  const importResult = importFromPreview(accountId, preview);
  return {
    ok: true,
    accountId,
    closed: closeResult.closed,
    closedSymbols: closeResult.closedSymbols,
    imported: importResult.imported,
    skipped: importResult.skipped,
    unmapped: preview.unmapped,
  };
}

interface ContractInfo {
  symbol: string;
  assetType: AssetType;
  optionType: OptionType | null;
  strike: number | null;
  expiration: string | null;
}

function contractInfoOf(p: ContractLike): ContractInfo {
  return {
    symbol: p.symbol.toUpperCase(),
    assetType: p.assetType,
    optionType: p.optionType ?? null,
    strike: p.strike ?? null,
    expiration: p.expiration ?? null,
  };
}

export interface PositionComparisonRow extends ContractInfo {
  brokerQty: number;
  journalQty: number;
  matches: boolean;
}

export interface PositionComparison {
  ok: boolean;
  accountId: string;
  rows: PositionComparisonRow[];
  error?: string;
}

/**
 * On-demand, full side-by-side snapshot of every contract the broker
 * currently shows held for this account vs. what the journal shows open —
 * unlike the sync (which only ever acts once a gap is confirmed missing),
 * this reports EVERYTHING, matches included, so a mismatch is visible the
 * moment you look rather than only discoverable later from a wrong P&L
 * number or open quantity (see docs/USER_GUIDE.md's account-reconciliation
 * section for the incident this is meant to catch earlier next time).
 * Permissive on the journal side (includeUnassignedAccount): a comparison
 * should surface a legacy unassigned row too, not just already-claimed
 * ones — visibility is the whole point here, not the close-detector's
 * conservative certainty requirement.
 */
export async function comparePositionsToBroker(accountId: string): Promise<PositionComparison> {
  const preview = await previewWebullPositions(accountId);
  if (!preview.ok) return { ok: false, accountId, rows: [], error: preview.error };

  const brokerQtyByKey = new Map<string, number>();
  const infoByKey = new Map<string, ContractInfo>();
  for (const p of preview.positions) {
    const key = contractKey(p);
    brokerQtyByKey.set(key, (brokerQtyByKey.get(key) ?? 0) + p.quantity);
    if (!infoByKey.has(key)) infoByKey.set(key, contractInfoOf(p));
  }

  const journal = listPositions({ status: 'open', accountId, includeUnassignedAccount: true });
  const journalQtyByKey = new Map<string, number>();
  for (const p of journal) {
    const key = contractKey(p);
    journalQtyByKey.set(key, (journalQtyByKey.get(key) ?? 0) + p.remainingQuantity);
    if (!infoByKey.has(key)) infoByKey.set(key, contractInfoOf(p));
  }

  const keys = new Set([...brokerQtyByKey.keys(), ...journalQtyByKey.keys()]);
  const rows: PositionComparisonRow[] = Array.from(keys, (key) => {
    const brokerQty = brokerQtyByKey.get(key) ?? 0;
    const journalQty = journalQtyByKey.get(key) ?? 0;
    return { ...infoByKey.get(key)!, brokerQty, journalQty, matches: Math.abs(brokerQty - journalQty) < 1e-9 };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { ok: true, accountId, rows };
}

import {
  AssetType,
  ImportablePosition,
  OptionType,
  Position,
  Side,
  addExit,
  createPosition,
  listKnownAccountIds,
  listPositions,
  updatePosition,
} from '../../db/positions';
import { orderingDateOf } from '../../db/positions';
import { priceMap } from '../../services/quotes';
import { etToday } from '../../util/marketDate';
import { webullClient, webullConfigured } from './account';
import { bumpMissStreak, clearMissStreak, MISS_CONFIRM_THRESHOLD } from '../../db/webullMissStreak';
import { logAutotradeEvent } from '../../db/autotradeEvents';
import { classifyExpiredOptions, ExpiredOptionFinding } from '../../services/expiredOptions';
import { resolveExpiryCloses } from '../../services/expiredOptionsSweep';

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

const LIST_WRAPPER_KEYS = ['positions', 'holdings', 'items', 'data', 'list'];

/** Pull the position list out of whatever wrapper Webull returns. Looks one
 *  level deep too (`{ code, data: { items: [...] } }` is a common envelope),
 *  so an extra wrapper layer doesn't read a full account as empty. */
export function extractPositions(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    for (const key of LIST_WRAPPER_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === 'object') {
        for (const inner of LIST_WRAPPER_KEYS) {
          const nested = (v as Record<string, unknown>)[inner];
          if (Array.isArray(nested)) return nested as Record<string, unknown>[];
        }
      }
    }
  }
  return [];
}

/** True when `raw` is a shape extractPositions can actually read a list from —
 *  a recognized-but-EMPTY list included. This distinction matters because a
 *  zero-row extraction has two very different meanings: "the account holds
 *  nothing" (a real empty list) versus "we couldn't find the list in this
 *  payload" (a shape these wrappers don't cover). The close-detector treats
 *  "holds nothing" as "every open journal position here has been sold" — so
 *  conflating the two would let a silent Webull response-shape change
 *  mass-close the whole journal at fabricated prices after the miss-streak
 *  debounce. An unrecognized payload is surfaced as an ERROR instead. */
export function isRecognizedPositionsPayload(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  if (raw && typeof raw === 'object') {
    for (const key of LIST_WRAPPER_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) return true;
      if (
        v &&
        typeof v === 'object' &&
        LIST_WRAPPER_KEYS.some((k) => Array.isArray((v as Record<string, unknown>)[k]))
      ) {
        return true;
      }
    }
  }
  return false;
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

/** The market's today (ET), not the box's UTC clock. This sync runs on a
 *  5-minute background schedule and writes real journal rows, so on a
 *  UTC-deployed box every run from 20:00 ET onward used to date its exits
 *  tomorrow — see util/marketDate.ts. */
const today = () => etToday();

/** Map one raw Webull position to an importable journal position (or null if
 *  unusable). `accountId` is stamped onto the result so the reconciliation
 *  below can tell one brokerage account's holdings apart from another's — see
 *  the account_id column comment in db/index.ts for why that matters. */
// Field-name aliases for an option's three defining attributes. A real Webull
// account confirmed (2026-07-23) that options come back as a STRATEGY container
// whose contract details live one level down in a `legs` array — the strike is
// `option_exercise_price`, the type `option_type`, the expiry
// `option_expire_date` — NOT at the top level. The extra snake_case/camelCase/
// synonym aliases (`right` = C/P, `strikePrice`, `expirationDate`, …) are kept
// for robustness against other shapes. Broadening these is safe — an extra
// alias can only help a real option row parse; a stock row won't carry all
// three (see hasFullOptionShape below).
const OPTION_TYPE_KEYS = ['option_type', 'put_call', 'call_or_put', 'optionType', 'contract_type', 'right', 'cp_flag'];
const OPTION_STRIKE_KEYS = [
  'option_exercise_price', // confirmed Webull field
  'strike_price',
  'strike',
  'strikePrice',
  'exercise_price',
];
const OPTION_EXPIRY_KEYS = [
  'option_expire_date',
  'expiration',
  'expire_date',
  'exp_date',
  'expireDate',
  'expirationDate',
  'maturity_date',
];
const OPTION_MULTIPLIER_KEYS = ['option_contract_multiplier', 'multiplier', 'unit'];

/** For a single-leg option strategy, Webull nests the contract details in a
 *  one-element `legs` array; returns that leg so the mapper can read the
 *  option fields from it. Returns null for a flat row (no legs — the leg
 *  fields are read from the top level instead) OR a genuine MULTI-leg strategy
 *  (a spread), which the journal's one-contract-per-row `positions` table
 *  can't represent as a single row — and which the payload gives no per-leg
 *  buy/sell side to split correctly — so it's deliberately left unmapped
 *  (surfaced via the preview's unmappedOptions count) rather than imported
 *  wrong. */
function singleOptionLeg(p: Record<string, unknown>): Record<string, unknown> | null {
  const legs = p.legs;
  if (Array.isArray(legs) && legs.length === 1 && legs[0] && typeof legs[0] === 'object') {
    return legs[0] as Record<string, unknown>;
  }
  return null;
}

/** True when a raw row carries any option-defining field, an option asset
 *  type, or a nested legs array — used to tell "this looked like an option but
 *  couldn't be parsed" (worth surfacing to the user) apart from an ordinary
 *  unmappable row. Does NOT require the full shape (unlike the mapper's own
 *  gate): a partial or multi-leg option row is exactly the case we most want
 *  to flag. */
export function looksLikeOption(p: Record<string, unknown>): boolean {
  const rawType = String(pick(p, ['asset_type', 'instrument_type', 'category', 'sec_type']) ?? '').toUpperCase();
  if (rawType.includes('OPTION')) return true;
  if (Array.isArray(p.legs) && p.legs.length > 0) return true;
  const leg = singleOptionLeg(p) ?? p;
  return [...OPTION_TYPE_KEYS, ...OPTION_STRIKE_KEYS, ...OPTION_EXPIRY_KEYS].some(
    (k) => leg[k] !== null && leg[k] !== undefined && leg[k] !== '',
  );
}

export function mapWebullPosition(p: Record<string, unknown>, accountId: string): ImportablePosition | null {
  const symbol = String(pick(p, ['symbol', 'ticker', 'instrument_symbol', 'underlying_symbol']) ?? '').toUpperCase();
  if (!symbol) return null;

  const rawType = String(pick(p, ['asset_type', 'instrument_type', 'category', 'sec_type']) ?? '').toUpperCase();

  const signedQty = num(pick(p, ['quantity', 'position', 'qty', 'holding_quantity', 'total_quantity']));
  const quantity = signedQty === undefined ? 0 : Math.abs(signedQty);
  if (quantity <= 0) return null;

  const sideRaw = String(pick(p, ['side', 'direction', 'position_side']) ?? '').toUpperCase();
  const side: Side = sideRaw.includes('SHORT') || (signedQty ?? 0) < 0 ? 'short' : 'long';

  const entryPrice = num(pick(p, ['cost_price', 'avg_cost', 'average_cost', 'cost', 'avg_price', 'open_price'])) ?? 0;
  // Null, not today(). This endpoint returns an aggregate of CURRENT HOLDINGS
  // — quantity and an AVERAGE cost — so for a lot built from several buys
  // there is no single open date for it to report, and in practice it often
  // reports none at all. Stamping the import date turned "unknown" into a
  // confident wrong answer that then fed hold-time buckets, the wash-sale
  // window and the equity curve; it also produced entry dates AFTER an
  // already-expired contract for a position the broker was still listing
  // overnight. Unknown is recorded as unknown, and the stats that need a date
  // exclude the row and say so.
  const entryDate =
    toIsoDate(pick(p, ['open_date', 'entry_date', 'position_date', 'create_time', 'created_at'])) ?? null;

  // The option's defining fields live in the single leg (Webull's confirmed
  // shape) when present, else at the top level (a flat row). Parse them up
  // front so the asset type can be INFERRED from a fully-formed option shape
  // even when the top-level type field is missing/unrecognized. Requiring all
  // three (type + strike + expiration) keeps a plain stock — which never
  // carries all three — from being misclassified.
  const optSrc = singleOptionLeg(p) ?? p;
  const optionType = toOptionType(pick(optSrc, OPTION_TYPE_KEYS));
  const strike = num(pick(optSrc, OPTION_STRIKE_KEYS));
  const expiration = toIsoDate(pick(optSrc, OPTION_EXPIRY_KEYS));
  const hasFullOptionShape = !!optionType && strike !== undefined && !!expiration;
  const assetType: AssetType = rawType.includes('OPTION') || hasFullOptionShape ? 'option' : 'stock';

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
    out.optionType = optionType;
    out.strike = strike;
    out.expiration = expiration;
    out.multiplier = num(pick(optSrc, OPTION_MULTIPLIER_KEYS)) ?? 100;
    // An option we can't fully describe can't be journaled — this is the path a
    // genuine MULTI-leg strategy (a spread) also falls through, since
    // singleOptionLeg() returns null for it and the top level has no strike/
    // expiration. The preview's unmappedOptions count surfaces how often this
    // happens, so a shape these aliases still don't cover stays visible.
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
  /** Of those unmapped rows, how many LOOKED like an option (had an option
   *  asset type or an option-defining field) but couldn't be fully parsed —
   *  the specific "why aren't my options showing up" signal. Non-zero means
   *  the payload carries options whose field shape these aliases still don't
   *  cover; check unmappedSample / the raw payload to see which fields to add. */
  unmappedOptions: number;
  /** The top-level keys of the first few unmapped rows (option-looking ones
   *  first), so an unrecognized payload shape can be diagnosed from the UI
   *  without dumping the whole raw payload. */
  unmappedSample: { keys: string[]; looksLikeOption: boolean }[];
  /** Distinct symbols carried by the unmapped rows (top level or any leg).
   *  The close-detector freezes its miss streaks for these symbols: a row the
   *  mapper couldn't parse still proves the broker holds SOMETHING in that
   *  symbol, so "missing from the mapped rows" is not evidence of a sale. The
   *  concrete case: a journal-tracked single-leg option whose broker row turns
   *  into a MULTI-leg strategy container (the user legs into a spread) — the
   *  container is deliberately unmapped, and without this the leg would be
   *  "missing" two syncs running and get auto-closed while still held. */
  unmappedSymbols: string[];
  error?: string;
}

async function fetchPositions(accountId: string): Promise<{ ok: boolean; url: string; status: number; raw: unknown }> {
  const r = await webullClient().call('GET', '/openapi/assets/positions', {
    query: { account_id: accountId },
    surface: 'trade',
  });
  return { ok: r.ok, url: r.url, status: r.status, raw: r.data };
}

const EMPTY_UNMAPPED = {
  unmappedOptions: 0,
  unmappedSample: [] as { keys: string[]; looksLikeOption: boolean }[],
  unmappedSymbols: [] as string[],
};

const SYMBOL_KEYS = ['symbol', 'ticker', 'instrument_symbol', 'underlying_symbol'];

/** Every symbol a raw row mentions — top level plus any legs. Used only for
 *  the unmappedSymbols freeze list, so being generous is safe: an extra symbol
 *  here can only make the close-detector MORE conservative this sync. */
function symbolsOf(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const top = pick(row, SYMBOL_KEYS);
  if (top) out.push(String(top).toUpperCase());
  if (Array.isArray(row.legs)) {
    for (const leg of row.legs) {
      if (leg && typeof leg === 'object') {
        const s = pick(leg as Record<string, unknown>, SYMBOL_KEYS);
        if (s) out.push(String(s).toUpperCase());
      }
    }
  }
  return out;
}

/** Fetch + map live Webull positions for an account, writing nothing. */
export async function previewWebullPositions(accountId: string): Promise<PositionsPreview> {
  if (!webullConfigured()) {
    return { ok: false, accountId, positions: [], unmapped: 0, ...EMPTY_UNMAPPED, error: 'Webull is not configured.' };
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
      ...EMPTY_UNMAPPED,
      raw: r.raw,
      error: j.msg || j.message || `Webull request failed (${r.status})`,
    };
  }
  const rows = extractPositions(r.raw);
  // Zero rows out of a payload whose shape isn't recognized is NOT an empty
  // account — it's a list we failed to find (see isRecognizedPositionsPayload).
  // Reported as an error so the sync skips this cycle and the failure is
  // visible (Sync-now toast, scheduler failure event), instead of the
  // close-detector reading it as "everything here has been sold".
  if (rows.length === 0 && !isRecognizedPositionsPayload(r.raw)) {
    return {
      ok: false,
      url: r.url,
      accountId,
      positions: [],
      unmapped: 0,
      ...EMPTY_UNMAPPED,
      raw: r.raw,
      error:
        'Webull returned a positions payload in a shape this app does not recognize — refusing to treat it as an ' +
        'empty account. Check the raw payload via Settings → Webull → Preview.',
    };
  }
  const positions: ImportablePosition[] = [];
  const unmappedRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    const mapped = mapWebullPosition(row, accountId);
    if (mapped) positions.push(mapped);
    else unmappedRows.push(row);
  }
  const unmappedOptions = unmappedRows.filter(looksLikeOption).length;
  // Option-looking rows first (the ones the user most needs to see), then a
  // few others — capped so this stays a diagnostic hint, not a payload dump.
  const unmappedSample = [...unmappedRows]
    .sort((a, b) => Number(looksLikeOption(b)) - Number(looksLikeOption(a)))
    .slice(0, 5)
    .map((row) => ({ keys: Object.keys(row), looksLikeOption: looksLikeOption(row) }));
  const unmappedSymbols = [...new Set(unmappedRows.flatMap(symbolsOf))];
  return {
    ok: true,
    url: r.url,
    accountId,
    positions,
    raw: r.raw,
    unmapped: unmappedRows.length,
    unmappedOptions,
    unmappedSample,
    unmappedSymbols,
  };
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
  /** Options the broker still lists whose expiration has already PASSED — see
   *  importFromPreview. Reported rather than folded into `skipped`, because
   *  "we already have this" and "this contract no longer exists" are different
   *  facts and only one of them is a duplicate. */
  expiredSkipped: number;
  /** Present in the payload but not journal-mappable. */
  unmapped: number;
  created: Position[];
  error?: string;
}

function importFromPreview(accountId: string, preview: PositionsPreview): ImportSummary {
  const open = listPositions({ status: 'open', accountId, includeUnassignedAccount: true });
  const today = etToday();
  const created: Position[] = [];
  let skipped = 0;
  let expiredSkipped = 0;
  for (const p of preview.positions) {
    // A contract whose expiration has PASSED cannot be a newly-opened
    // position — the same impossibility the journal-integrity report calls
    // entry_after_expiration. A broker still listing it is settlement lag: an
    // expired option stays in Webull's holdings until it clears, which over a
    // weekend means all of Saturday and Sunday.
    //
    // Without this, that lag fights the expired-option sweep and loses money
    // in the journal. The sweep closes the expired lot at $0 (booking its
    // real loss); this import then finds no OPEN position matching it — the
    // dedup below only looks at open rows — and creates a brand-new one; the
    // sweep closes that too, booking the SAME loss a second time. It repeats
    // every sync until the broker finally drops the contract. Deleting the
    // duplicate doesn't help either, since the next sync re-adds it.
    //
    // Strictly BEFORE today (ET), matching findExpiredOpenOptions: a contract
    // expiring TODAY is still tradeable all session and imports normally.
    if (p.assetType === 'option' && p.expiration && p.expiration < today) {
      expiredSkipped++;
      continue;
    }
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
  return {
    ok: true,
    accountId,
    imported: created.length,
    skipped,
    expiredSkipped,
    unmapped: preview.unmapped,
    created,
  };
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
      expiredSkipped: 0,
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

const NOTE_EXPIRED_AUTO_CLOSED =
  'Auto-closed via Webull sync — no longer listed at the broker, and the contract finished clearly out of ' +
  'the money at expiry, so a $0 exit dated on the expiry is recorded (the same disposition the expired-option ' +
  'sweep applies). Edit it if your broker statement says otherwise.';

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

  // This account's own rows are always close-eligible. A legacy row with NO
  // account recorded (never claimed by an import — e.g. it was already sold
  // before any sync ran against it, so the claim-on-match path never fired)
  // is close-eligible ONLY when this is a single-account setup: if the journal
  // has never recorded any OTHER account, an unassigned row can only belong to
  // the account we're syncing, so closing it here can't be a cross-account
  // false close (the exact bug the strict scoping below was added to prevent —
  // see task #120). The moment a second account is known, unassigned rows go
  // back to being left strictly alone (surfaced via the Compare-to-broker view
  // instead), since we can no longer be certain which account they belong to.
  const otherAccountKnown = listKnownAccountIds().some((a) => a !== preview.accountId);
  const scoped = listPositions({ status: 'open', accountId: preview.accountId });
  const unassigned = otherAccountKnown ? [] : listPositions({ status: 'open' }).filter((p) => p.accountId === null);
  const open = [...scoped, ...unassigned].filter(isWebullTracked);
  const lotsByKey = new Map<string, Position[]>();
  for (const p of open) {
    const key = contractKey(p);
    (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push(p);
  }

  // Symbols whose broker rows (partly) failed to parse THIS preview. A row we
  // couldn't map still proves the broker holds SOMETHING in that symbol, so a
  // gap against only the mapped rows is not evidence of a sale — the streak is
  // frozen (neither bumped nor cleared) rather than fed unreliable data. The
  // concrete case is a tracked single leg whose broker row becomes a multi-leg
  // strategy container the mapper deliberately leaves unmapped.
  const unmappedSymbols = new Set(preview.unmappedSymbols ?? []);

  const toClose = new Map<
    string,
    { lots: Position[]; qty: number; journalQtyBefore: number; brokerQty: number; justConfirmed: boolean }
  >();
  for (const [key, lots] of lotsByKey) {
    // FIFO: oldest first. An undated lot orders by the day it was recorded
    // (orderingDateOf) — FIFO needs SOME sequence, and that proxy never leaks
    // into a statistic the way writing it to entry_date would have.
    lots.sort((a, b) => orderingDateOf(a).localeCompare(orderingDateOf(b)) || a.id - b.id);
    const journalQty = lots.reduce((s, p) => s + p.remainingQuantity, 0);
    const brokerQty = liveQtyByKey.get(key) ?? 0;
    const gap = journalQty - brokerQty;
    if (gap > 1e-9) {
      if (unmappedSymbols.has(lots[0].symbol.toUpperCase())) continue;
      // Missing (fully or partially) from THIS preview — require it to stay
      // missing on MISS_CONFIRM_THRESHOLD consecutive syncs, with no
      // fully-confirmed observation in between, before trusting it enough to
      // write a close. See the doc comment above and webull_miss_streak's
      // table comment for the flapping bug this prevents.
      const streak = bumpMissStreak(preview.accountId, key);
      if (streak >= MISS_CONFIRM_THRESHOLD)
        toClose.set(key, {
          lots,
          qty: gap,
          journalQtyBefore: journalQty,
          brokerQty,
          // True only on the sync that first crosses the threshold, so the
          // "confirmed gone but couldn't price it" diagnostic below logs once
          // per stuck episode rather than on every subsequent sync.
          justConfirmed: streak === MISS_CONFIRM_THRESHOLD,
        });
    } else {
      // Fully accounted for in this preview — any earlier miss streak was wrong.
      clearMissStreak(preview.accountId, key);
    }
  }
  if (toClose.size === 0) return { closed: 0, closedSymbols: [] };

  // A confirmed-gone contract is priced one of two ways. A LIVE contract gets
  // the same quote/mark the Positions page shows (an estimate, flagged as such
  // in the exit note). An option whose expiration has already PASSED has no
  // live mark to get — resolveOptionMarks correctly refuses to invent one —
  // and pricing it that way left the position stuck open FOREVER: every sync
  // confirmed it gone, found no price, and "retried next sync" against a
  // contract that will never quote again. The value such a contract actually
  // ended at is the expired-option sweep's question, so its classification is
  // reused here: unambiguously worthless → a $0 exit dated on the expiry
  // (exactly what the sweep's own button would book); in-the-money / pin-risk
  // / unpriceable → left open for the human, same as the sweep, since a
  // fabricated cash exit would misstate an exercise or assignment.
  const todayEt = today();
  const isExpiredOption = (p: Position) => p.assetType === 'option' && !!p.expiration && p.expiration < todayEt;
  const liveLots: Position[] = [];
  const expiredLots: Position[] = [];
  for (const { lots } of toClose.values()) (isExpiredOption(lots[0]) ? expiredLots : liveLots).push(lots[0]);

  // Price once per contract (any lot of the same contract shares one live price).
  const prices = await priceMap(liveLots);
  const expiredFindings = new Map<number, ExpiredOptionFinding>();
  if (expiredLots.length) {
    const closeAtExpiry = await resolveExpiryCloses(expiredLots);
    for (const f of classifyExpiredOptions(expiredLots, closeAtExpiry)) expiredFindings.set(f.positionId, f);
  }

  const closedSymbols = new Set<string>();
  let closed = 0;
  for (const [key, { lots, qty, journalQtyBefore, brokerQty, justConfirmed }] of toClose) {
    const expired = expiredFindings.get(lots[0].id);
    let exitPrice: number;
    let exitDate: string;
    let notes: string;
    if (expired) {
      if (expired.disposition !== 'worthless') {
        // Needs a human — same split the expired-option sweep applies. Logged
        // once (on the confirming sync) so it's visible on Recent Activity;
        // the Positions page's expired-options banner explains what to do.
        if (justConfirmed) {
          logAutotradeEvent({
            symbol: lots[0].symbol,
            stage: 'execution',
            action: 'position_reconcile_skipped',
            detail: {
              via: 'broker_sync',
              accountId: preview.accountId,
              reason: `expired_${expired.disposition}`,
              journalQty: journalQtyBefore,
              brokerQty,
              note: `The broker no longer lists this expired contract, but it is not safe to close automatically: ${expired.reason}. Record the real outcome from the Positions page's expired-options banner.`,
            },
          });
        }
        continue; // leave open for the human / the banner
      }
      exitPrice = 0;
      // Dated on the expiry itself, not today — that is when the position
      // ceased to exist, matching the expired-option sweep's own bookkeeping.
      exitDate = lots[0].expiration!;
      notes = NOTE_EXPIRED_AUTO_CLOSED;
    } else {
      const livePrice = prices.get(lots[0].id)?.price;
      if (livePrice == null) {
        // Confirmed gone at the broker but there's no price to record the exit at
        // (e.g. an illiquid contract the quote resolver can't reach right now).
        // Left open to retry next sync — but log it ONCE so a position that stays
        // stuck this way is visible on Recent Activity instead of silently never
        // closing. Only on the confirming sync, to avoid one event per tick.
        if (justConfirmed) {
          logAutotradeEvent({
            symbol: lots[0].symbol,
            stage: 'execution',
            action: 'position_reconcile_skipped',
            detail: {
              via: 'broker_sync',
              accountId: preview.accountId,
              reason: 'no_price',
              journalQty: journalQtyBefore,
              brokerQty,
              note: 'Confirmed sold at the broker but no live price was available to record the exit — will retry on the next sync. Close it manually from Positions if it stays stuck.',
            },
          });
        }
        continue; // can't price it — leave open, retry next sync
      }
      exitPrice = livePrice;
      exitDate = todayEt;
      notes = NOTE_AUTO_CLOSED;
    }
    let remaining = qty;
    let reconciled = 0;
    let claimedUnassigned = false;
    for (const p of lots) {
      if (remaining <= 1e-9) break;
      const take = Math.min(remaining, p.remainingQuantity);
      if (take <= 1e-9) continue;
      const result = addExit(p.id, { quantity: take, exitPrice, exitDate, notes });
      if (result) {
        closed++;
        reconciled += take;
        closedSymbols.add(p.symbol);
        // A previously-unassigned legacy row being closed here (single-account
        // setup only) — claim it to this account too, so its now-closed record
        // is attributed like every other row and future syncs treat it
        // normally, mirroring importFromPreview's own claim-on-match.
        if (p.accountId === null) {
          updatePosition(p.id, { accountId: preview.accountId });
          claimedUnassigned = true;
        }
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
          // How the exit price was arrived at, so the event reads honestly:
          // a live-quote ESTIMATE vs the $0 an expired-worthless contract
          // factually ended at (dated on the expiry, not today).
          pricedBy: expired ? 'expired_worthless' : 'live_quote',
          fullyClosed: journalQtyBefore - reconciled <= 1e-9,
          // Flags the self-heal path (a legacy unassigned row closed + claimed
          // in a single-account setup) so it's auditable as distinct from a
          // normal same-account reconciliation.
          claimedFromUnassigned: claimedUnassigned,
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

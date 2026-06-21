import {
  AssetType,
  ImportablePosition,
  OptionType,
  Position,
  Side,
  createPosition,
  listPositions,
} from '../../db/positions';
import { webullClient, webullConfigured } from './account';

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

/** Map one raw Webull position to an importable journal position (or null if unusable). */
export function mapWebullPosition(p: Record<string, unknown>): ImportablePosition | null {
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
  const positions = rows.map(mapWebullPosition).filter((p): p is ImportablePosition => p !== null);
  return { ok: true, url: r.url, accountId, positions, raw: r.raw, unmapped: rows.length - positions.length };
}

/** True when an importable position matches an existing open journal position. */
function matchesOpen(open: Position[], p: ImportablePosition): boolean {
  return open.some(
    (o) =>
      o.symbol === p.symbol.toUpperCase() &&
      o.assetType === p.assetType &&
      (p.assetType !== 'option' ||
        (o.strike === (p.strike ?? null) &&
          o.expiration === (p.expiration ?? null) &&
          o.optionType === (p.optionType ?? null))),
  );
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
  const open = listPositions({ status: 'open' });
  const created: Position[] = [];
  let skipped = 0;
  for (const p of preview.positions) {
    if (matchesOpen(open, p)) {
      skipped++;
      continue;
    }
    created.push(createPosition(p));
  }
  return { ok: true, accountId, imported: created.length, skipped, unmapped: preview.unmapped, created };
}

// Parse a trade CSV (a spreadsheet journal or a broker export) into the same
// shape the JSON importer uses. Tolerant: headers are matched case-insensitively
// against a set of common aliases, numbers may carry $ and thousands commas, and
// each row is validated independently so one bad row doesn't sink the import.
//
// One row = one position (a logged trade). If a row has an exit price + date,
// a single closing exit is attached. `side` is the position's DIRECTION
// (long/short); buy→long and sell→short are accepted aliases.

export interface ParsedTrade {
  assetType: 'stock' | 'option';
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  fees?: number;
  optionType?: 'call' | 'put' | null;
  strike?: number | null;
  expiration?: string | null;
  tags?: string[];
  grade?: string | null;
  notes?: string | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  exits?: { quantity: number; exitPrice: number; exitDate: string; fees?: number }[];
}

export interface CsvParseResult {
  positions: ParsedTrade[];
  errors: string[];
}

/** Canonical field → accepted header aliases (compared after normalization). */
const ALIASES: Record<string, string[]> = {
  symbol: ['symbol', 'ticker', 'underlying'],
  assetType: ['assettype', 'type', 'instrument', 'securitytype'],
  side: ['side', 'direction', 'action', 'buysell', 'longshort'],
  quantity: ['quantity', 'qty', 'shares', 'contracts', 'size', 'amount'],
  entryPrice: ['entryprice', 'price', 'entry', 'avgprice', 'averageprice', 'cost', 'fillprice', 'openprice'],
  entryDate: ['entrydate', 'date', 'opened', 'opendate', 'tradedate', 'executiondate', 'datetime'],
  fees: ['fees', 'fee', 'commission', 'commissions', 'comm'],
  optionType: ['optiontype', 'putcall', 'callput', 'right'],
  strike: ['strike', 'strikeprice'],
  expiration: ['expiration', 'expiry', 'expirationdate', 'expdate', 'expdatetime'],
  exitPrice: ['exitprice', 'closeprice', 'sellprice', 'closingprice'],
  exitDate: ['exitdate', 'closedate', 'closed', 'closingdate'],
  tags: ['tags', 'tag', 'setup', 'strategy'],
  grade: ['grade', 'rating'],
  notes: ['notes', 'note', 'comment', 'comments', 'memo'],
  stopPrice: ['stop', 'stopprice', 'stoploss'],
  targetPrice: ['target', 'targetprice', 'takeprofit'],
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function num(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** RFC-4180-ish tokenizer: handles quoted fields with embedded commas, quotes and newlines. */
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export function parseTradeCsv(text: string): CsvParseResult {
  const rows = tokenize(text);
  if (rows.length < 2)
    return { positions: [], errors: ['No data rows found (need a header row plus at least one trade).'] };

  // Map each header column to a canonical field.
  const header = rows[0].map(norm);
  const colOf: Partial<Record<keyof typeof ALIASES, number>> = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colOf[field as keyof typeof ALIASES] = idx;
  }
  for (const req of ['symbol', 'quantity', 'entryPrice', 'entryDate'] as const) {
    if (colOf[req] === undefined) {
      return {
        positions: [],
        errors: [`Missing a required column for "${req}". Recognized headers: ${ALIASES[req].join(', ')}.`],
      };
    }
  }

  const get = (cols: string[], field: keyof typeof ALIASES): string | undefined => {
    const i = colOf[field];
    return i === undefined ? undefined : cols[i]?.trim();
  };

  const positions: ParsedTrade[] = [];
  const errors: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const where = `Row ${r + 1}`;
    const symbol = get(cols, 'symbol')?.toUpperCase();
    const quantity = num(get(cols, 'quantity'));
    const entryPrice = num(get(cols, 'entryPrice'));
    const entryDate = get(cols, 'entryDate');

    if (!symbol || quantity === undefined || entryPrice === undefined || !entryDate) {
      errors.push(`${where}: missing symbol/quantity/entryPrice/entryDate — skipped.`);
      continue;
    }

    const sideRaw = norm(get(cols, 'side') ?? 'long');
    const side: 'long' | 'short' = ['short', 'sell', 'sold', 's', 'sellshort'].includes(sideRaw) ? 'short' : 'long';

    const optRaw = norm(get(cols, 'optionType') ?? '');
    const optionType: 'call' | 'put' | null = optRaw.startsWith('c') ? 'call' : optRaw.startsWith('p') ? 'put' : null;
    const strike = num(get(cols, 'strike'));
    const expiration = get(cols, 'expiration') || null;
    const typeRaw = norm(get(cols, 'assetType') ?? '');
    const isOption = typeRaw.startsWith('opt') || optionType !== null || (strike !== undefined && !!expiration);

    const tagsRaw = get(cols, 'tags');
    const exitPrice = num(get(cols, 'exitPrice'));
    const exitDate = get(cols, 'exitDate');

    const trade: ParsedTrade = {
      assetType: isOption ? 'option' : 'stock',
      symbol,
      side,
      quantity: Math.abs(quantity),
      entryPrice,
      entryDate,
      fees: num(get(cols, 'fees')) ?? 0,
      optionType: isOption ? (optionType ?? 'call') : null,
      strike: isOption ? (strike ?? null) : null,
      expiration: isOption ? expiration : null,
      tags: tagsRaw
        ? tagsRaw
            .split(/[;|]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      grade: get(cols, 'grade') || null,
      notes: get(cols, 'notes') || null,
      stopPrice: num(get(cols, 'stopPrice')) ?? null,
      targetPrice: num(get(cols, 'targetPrice')) ?? null,
    };
    if (exitPrice !== undefined && exitDate) {
      trade.exits = [{ quantity: Math.abs(quantity), exitPrice, exitDate }];
    }
    positions.push(trade);
  }

  return { positions, errors };
}

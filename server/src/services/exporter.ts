import { Position } from '../db/positions';
import { realizedPnlOf } from './pnl';

// ---------------------------------------------------------------------------
// Pure serialization of positions/journal for export. No DB or HTTP here so it
// can be unit-tested directly.
// ---------------------------------------------------------------------------

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n');
}

const POSITION_COLUMNS = [
  'id',
  'status',
  'assetType',
  'symbol',
  'side',
  'optionType',
  'strike',
  'expiration',
  'quantity',
  'multiplier',
  'entryPrice',
  'entryDate',
  'fees',
  'exitsCount',
  'lastExitDate',
  'realizedPnl',
  'grade',
  'tags',
  'notes',
  'rulesChecked',
] as const;

function positionRow(p: Position): unknown[] {
  const lastExit = p.exits.length ? p.exits[p.exits.length - 1].exitDate : '';
  return [
    p.id,
    p.status,
    p.assetType,
    p.symbol,
    p.side,
    p.optionType ?? '',
    p.strike ?? '',
    p.expiration ?? '',
    p.quantity,
    p.multiplier,
    p.entryPrice,
    p.entryDate,
    p.fees,
    p.exits.length,
    lastExit,
    // Realized P&L is meaningful for closed/partially-closed trades; 0 otherwise.
    Number(realizedPnlOf(p).toFixed(2)),
    p.grade ?? '',
    p.tags.join('|'),
    p.notes ?? '',
    p.checklist.length ? `${p.checklist.filter((c) => c.checked).length}/${p.checklist.length}` : '',
  ];
}

/** One row per position, with realized P&L — the spreadsheet/tax view. */
export function positionsToCsv(positions: Position[]): string {
  return toCsv([...POSITION_COLUMNS], positions.map(positionRow));
}

/** A structured, round-trippable snapshot (includes each position's exits). */
export interface PositionsExport {
  app: 'stock-app';
  kind: 'positions';
  version: 1;
  exportedAt: number;
  count: number;
  positions: Position[];
}

export function positionsToJson(positions: Position[]): PositionsExport {
  return {
    app: 'stock-app',
    kind: 'positions',
    version: 1,
    exportedAt: Date.now(),
    count: positions.length,
    positions,
  };
}

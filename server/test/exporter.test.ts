import { describe, it, expect } from 'vitest';
import { csvField, toCsv, positionsToCsv, positionsToJson } from '../src/services/exporter';
import type { Position } from '../src/db/positions';

function pos(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 100,
    entryPrice: 100,
    entryDate: '2026-01-02',
    fees: 1,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    status: 'closed',
    tags: ['breakout', 'a+'],
    grade: 'A',
    notes: 'clean setup',
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    createdAt: 1,
    updatedAt: 1,
    exits: [
      {
        id: 1,
        positionId: 1,
        quantity: 100,
        exitPrice: 110,
        exitDate: '2026-01-05',
        fees: 1,
        notes: null,
        createdAt: 2,
      },
    ],
    remainingQuantity: 0,
    ...overrides,
  };
}

describe('csvField', () => {
  it('passes plain values through', () => {
    expect(csvField('AAPL')).toBe('AAPL');
    expect(csvField(42)).toBe('42');
    expect(csvField(null)).toBe('');
  });
  it('quotes and escapes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
  it('neutralizes formula-injection in text fields with a leading quote', () => {
    expect(csvField('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvField('+1-800-EVIL')).toBe("'+1-800-EVIL");
    expect(csvField('-2+3')).toBe("'-2+3");
  });
  it('does NOT mangle a negative number passed as a number (P&L stays numeric)', () => {
    expect(csvField(-100)).toBe('-100');
    expect(csvField(-12.5)).toBe('-12.5');
  });
});

describe('toCsv', () => {
  it('joins headers and rows with CRLF', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        [1, 2],
        [3, 4],
      ],
    );
    expect(csv).toBe('a,b\r\n1,2\r\n3,4');
  });
});

describe('positionsToCsv', () => {
  it('includes a header and one row per position with realized P&L', () => {
    const csv = positionsToCsv([pos()]);
    const [header, row] = csv.split('\r\n');
    expect(header.startsWith('id,status,assetType,symbol')).toBe(true);
    // long 100sh entry 100 -> exit 110, fees 1 entry + 1 exit = (110-100)*100 - 1 - 1 = 998
    expect(row).toContain('998');
    expect(row).toContain('AAPL');
    expect(row).toContain('breakout|a+'); // tags joined with |
  });
  it('escapes a note containing a comma', () => {
    const csv = positionsToCsv([pos({ notes: 'sold, too early' })]);
    expect(csv).toContain('"sold, too early"');
  });
  it('summarizes the pre-trade checklist as checked/total', () => {
    const csv = positionsToCsv([
      pos({
        checklist: [
          { rule: 'a', checked: true },
          { rule: 'b', checked: false },
          { rule: 'c', checked: true },
        ],
      }),
    ]);
    expect(csv.trim().split('\r\n')[1]).toMatch(/,2\/3$/);
  });
});

describe('positionsToJson', () => {
  it('wraps positions with metadata and preserves exits', () => {
    const out = positionsToJson([pos()]);
    expect(out.app).toBe('stock-app');
    expect(out.kind).toBe('positions');
    expect(out.version).toBe(1);
    expect(out.count).toBe(1);
    expect(out.positions[0].exits).toHaveLength(1);
  });
});

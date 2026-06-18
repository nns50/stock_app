import { describe, it, expect } from 'vitest';
import { parseTradeCsv } from './tradeCsv';

describe('parseTradeCsv', () => {
  it('parses a basic CSV, coercing $ and commas and upper-casing symbols', () => {
    const csv = 'symbol,side,quantity,entryPrice,entryDate,fees\naapl,buy,100,$190.50,2026-05-01,1.00';
    const { positions, errors } = parseTradeCsv(csv);
    expect(errors).toEqual([]);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: 'AAPL',
      side: 'long',
      quantity: 100,
      entryPrice: 190.5,
      entryDate: '2026-05-01',
      fees: 1,
      assetType: 'stock',
    });
  });

  it('matches header aliases and maps sell→short', () => {
    const csv = 'Ticker,Direction,Qty,Price,Date\nMSFT,Sell,50,"1,200.00",2026-05-02';
    const { positions } = parseTradeCsv(csv);
    expect(positions[0]).toMatchObject({ symbol: 'MSFT', side: 'short', quantity: 50, entryPrice: 1200 });
  });

  it('detects options and attaches a closing exit', () => {
    const csv = [
      'symbol,type,side,quantity,entryPrice,entryDate,optionType,strike,expiration,exitPrice,exitDate',
      'SPY,option,long,2,8.50,2026-06-10,call,600,2026-07-17,15,2026-06-20',
    ].join('\n');
    const { positions } = parseTradeCsv(csv);
    expect(positions[0]).toMatchObject({
      assetType: 'option',
      optionType: 'call',
      strike: 600,
      expiration: '2026-07-17',
    });
    expect(positions[0].exits).toEqual([{ quantity: 2, exitPrice: 15, exitDate: '2026-06-20' }]);
  });

  it('skips invalid rows but keeps the good ones, collecting errors', () => {
    const csv = ['symbol,quantity,entryPrice,entryDate', 'AAPL,100,190,2026-05-01', ',,,', 'TSLA,,250,2026-05-02'].join(
      '\n',
    );
    const { positions, errors } = parseTradeCsv(csv);
    expect(positions.map((p) => p.symbol)).toEqual(['AAPL']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing/i);
  });

  it('errors when a required column is absent', () => {
    const { positions, errors } = parseTradeCsv('foo,bar\n1,2');
    expect(positions).toEqual([]);
    expect(errors[0]).toMatch(/required column/i);
  });

  it('handles quoted fields containing commas', () => {
    const csv = 'symbol,quantity,entryPrice,entryDate,notes\nAAPL,10,100,2026-05-01,"bought breakout, added later"';
    const { positions } = parseTradeCsv(csv);
    expect(positions[0].notes).toBe('bought breakout, added later');
  });

  it('splits tags on ; or |', () => {
    const csv = 'symbol,quantity,entryPrice,entryDate,tags\nAAPL,10,100,2026-05-01,breakout;earnings';
    const { positions } = parseTradeCsv(csv);
    expect(positions[0].tags).toEqual(['breakout', 'earnings']);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  getCachedContracts,
  isExpirationRangeFetched,
  logFetchedExpirationRange,
  saveContracts,
} from '../src/db/backtestOptionContracts';
import { OptionContractRef } from '../src/services/autotrading/polygonOptionsClient';

beforeAll(() => initDb());
beforeEach(() => db.exec("DELETE FROM backtest_option_contracts WHERE underlying LIKE 'BTOPT%'"));

const contract = (underlying: string, ticker: string, strike: number, expiration: string): OptionContractRef => ({
  ticker,
  underlying,
  contractType: 'call',
  strike,
  expiration,
});

describe('backtest_option_contracts cache', () => {
  it('round-trips saved contracts through getCachedContracts, ordered by expiration then strike', () => {
    saveContracts('BTOPT1', [
      contract('BTOPT1', 'O:BTOPT1-B', 105, '2024-03-15'),
      contract('BTOPT1', 'O:BTOPT1-A', 100, '2024-02-15'),
      contract('BTOPT1', 'O:BTOPT1-C', 95, '2024-03-15'),
    ]);
    const result = getCachedContracts('BTOPT1', '2024-01-01', '2024-12-31');
    expect(result.map((c) => c.ticker)).toEqual(['O:BTOPT1-A', 'O:BTOPT1-C', 'O:BTOPT1-B']);
  });

  it('is case-insensitive on underlying', () => {
    saveContracts('btopt2', [contract('BTOPT2', 'O:BTOPT2-A', 100, '2024-03-15')]);
    expect(getCachedContracts('BTOPT2', '2024-01-01', '2024-12-31')).toHaveLength(1);
  });

  it('filters strictly to the requested expiration range', () => {
    saveContracts('BTOPT3', [
      contract('BTOPT3', 'O:BTOPT3-A', 100, '2024-01-15'),
      contract('BTOPT3', 'O:BTOPT3-B', 100, '2024-06-15'),
    ]);
    expect(getCachedContracts('BTOPT3', '2024-01-01', '2024-03-01').map((c) => c.ticker)).toEqual(['O:BTOPT3-A']);
  });

  it('upserts — re-saving the same (underlying, ticker) updates fields instead of duplicating', () => {
    saveContracts('BTOPT4', [contract('BTOPT4', 'O:BTOPT4-A', 100, '2024-03-15')]);
    saveContracts('BTOPT4', [contract('BTOPT4', 'O:BTOPT4-A', 999, '2024-03-15')]);
    const result = getCachedContracts('BTOPT4', '2024-01-01', '2024-12-31');
    expect(result).toHaveLength(1);
    expect(result[0].strike).toBe(999);
  });

  it('saveContracts with an empty array is a no-op', () => {
    saveContracts('BTOPT5', []);
    expect(getCachedContracts('BTOPT5', '2024-01-01', '2024-12-31')).toEqual([]);
  });

  it('keeps different underlyings independent', () => {
    saveContracts('BTOPT6A', [contract('BTOPT6A', 'O:BTOPT6A-A', 100, '2024-03-15')]);
    saveContracts('BTOPT6B', [contract('BTOPT6B', 'O:BTOPT6B-A', 100, '2024-03-15')]);
    expect(getCachedContracts('BTOPT6A', '2024-01-01', '2024-12-31')).toHaveLength(1);
    expect(getCachedContracts('BTOPT6B', '2024-01-01', '2024-12-31')).toHaveLength(1);
  });
});

describe('backtest_option_contracts_fetch_log', () => {
  beforeEach(() => db.exec("DELETE FROM backtest_option_contracts_fetch_log WHERE underlying LIKE 'BTOPTLOG%'"));

  it('reports unfetched when nothing has been logged', () => {
    expect(isExpirationRangeFetched('BTOPTLOG1', '2024-01-01', '2024-12-31')).toBe(false);
  });

  it('reports fetched for the exact logged range', () => {
    logFetchedExpirationRange('BTOPTLOG2', '2024-01-01', '2024-12-31');
    expect(isExpirationRangeFetched('BTOPTLOG2', '2024-01-01', '2024-12-31')).toBe(true);
  });

  it('reports fetched for a range strictly inside a wider logged range', () => {
    logFetchedExpirationRange('BTOPTLOG3', '2024-01-01', '2025-12-31');
    expect(isExpirationRangeFetched('BTOPTLOG3', '2024-06-01', '2024-06-30')).toBe(true);
  });

  it('reports unfetched when the request extends beyond the logged range', () => {
    logFetchedExpirationRange('BTOPTLOG4', '2024-01-01', '2024-06-30');
    expect(isExpirationRangeFetched('BTOPTLOG4', '2024-01-01', '2024-12-31')).toBe(false);
  });

  it('keeps different underlyings independent', () => {
    logFetchedExpirationRange('BTOPTLOG5A', '2024-01-01', '2024-12-31');
    expect(isExpirationRangeFetched('BTOPTLOG5B', '2024-01-01', '2024-12-31')).toBe(false);
  });
});

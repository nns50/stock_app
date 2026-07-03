import { db } from './index';
import { OptionContractRef } from '../services/autotrading/polygonOptionsClient';

// ---------------------------------------------------------------------------
// Local cache of which option contracts (strike/expiration/type) existed for
// an underlying (docs/AUTOTRADING_SPEC.md, Phase 11) — the reference-data
// counterpart to backtestBars.ts's PRICE-bar cache (that file is reused
// unchanged for a contract's own price history once its ticker is known; see
// optionsHistoricalData.ts). Same "explicit fetch log, not inferred from the
// cached data's own extent" rationale as backtest_fetch_log.
// ---------------------------------------------------------------------------

interface ContractRow {
  underlying: string;
  ticker: string;
  contract_type: string;
  strike: number;
  expiration: string;
}

function mapRow(r: ContractRow): OptionContractRef {
  return {
    ticker: r.ticker,
    underlying: r.underlying,
    contractType: r.contract_type as 'call' | 'put',
    strike: r.strike,
    expiration: r.expiration,
  };
}

/** Cached contracts for `underlying` with expiration in [fromExp, toExp]. */
export function getCachedContracts(underlying: string, fromExp: string, toExp: string): OptionContractRef[] {
  const rows = db
    .prepare(
      `SELECT underlying, ticker, contract_type, strike, expiration FROM backtest_option_contracts
       WHERE underlying = ? AND expiration >= ? AND expiration <= ?
       ORDER BY expiration ASC, strike ASC`,
    )
    .all(underlying.toUpperCase(), fromExp, toExp) as ContractRow[];
  return rows.map(mapRow);
}

/** Upsert contracts into the cache — idempotent, safe with overlapping ranges. */
export function saveContracts(underlying: string, contracts: OptionContractRef[]): void {
  if (!contracts.length) return;
  const sym = underlying.toUpperCase();
  const insert = db.prepare(
    `INSERT INTO backtest_option_contracts (underlying, ticker, contract_type, strike, expiration)
     VALUES (?,?,?,?,?)
     ON CONFLICT(underlying, ticker) DO UPDATE SET
       contract_type = excluded.contract_type, strike = excluded.strike, expiration = excluded.expiration`,
  );
  const tx = db.transaction((items: OptionContractRef[]) => {
    for (const c of items) insert.run(sym, c.ticker, c.contractType, c.strike, c.expiration);
  });
  tx(contracts);
}

/** True if a PRIOR fetch already covered [fromExp, toExp] (YYYY-MM-DD) for
 *  this underlying — same lexicographic-string-range-containment check as
 *  backtestBars.ts's isRangeFetched. */
export function isExpirationRangeFetched(underlying: string, fromExp: string, toExp: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM backtest_option_contracts_fetch_log
       WHERE underlying = ? AND from_expiration <= ? AND to_expiration >= ? LIMIT 1`,
    )
    .get(underlying.toUpperCase(), fromExp, toExp);
  return !!row;
}

/** Record that [fromExp, toExp] was fetched for this underlying. */
export function logFetchedExpirationRange(underlying: string, fromExp: string, toExp: string): void {
  db.prepare(
    'INSERT INTO backtest_option_contracts_fetch_log (underlying, from_expiration, to_expiration, fetched_at) VALUES (?,?,?,?)',
  ).run(underlying.toUpperCase(), fromExp, toExp, Date.now());
}

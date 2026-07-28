import { db } from './index';
import { etToday } from '../util/marketDate';

/** Record (upsert) today's ATM implied vol for a symbol. "Today" is the US
 *  market's calendar day (ET), not the box's UTC date — a chain viewed from
 *  the Options page after 20:00 ET would otherwise accrue its once-per-day
 *  IV sample under TOMORROW's date (see util/marketDate.ts). */
export function recordAtmIv(symbol: string, atmIv: number, date = etToday()): void {
  db.prepare(
    `INSERT INTO iv_history(symbol, date, atm_iv, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET atm_iv = excluded.atm_iv, updated_at = excluded.updated_at`,
  ).run(symbol.toUpperCase(), date, atmIv, Date.now());
}

/** Recorded ATM IV samples for a symbol, oldest → newest. */
export function getIvHistory(symbol: string, limit = 252): number[] {
  const rows = db
    .prepare('SELECT atm_iv FROM iv_history WHERE symbol = ? ORDER BY date DESC LIMIT ?')
    .all(symbol.toUpperCase(), limit) as { atm_iv: number }[];
  return rows.map((r) => r.atm_iv).reverse();
}

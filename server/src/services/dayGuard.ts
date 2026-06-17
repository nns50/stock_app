import { Position } from '../db/positions';

// Daily discipline guardrail. Summarizes a single calendar day's trading — P&L
// booked from exits on that day and how many positions were opened — so the UI
// can warn when a user-set daily loss limit or trade cap is reached. Pure: the
// caller passes the date (the client's local "today") and the positions.

export interface DayStats {
  date: string;
  /** Realized P&L booked from exits dated `date` (gross move net of exit fees). */
  realizedPnl: number;
  /** Exit events on `date`. */
  exits: number;
  /** Positions opened on `date` (the over-trading metric). */
  entries: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeDayStats(positions: Position[], date: string): DayStats {
  let realizedPnl = 0;
  let exits = 0;
  let entries = 0;
  for (const p of positions) {
    if (p.entryDate === date) entries += 1;
    const sign = p.side === 'long' ? 1 : -1;
    for (const e of p.exits) {
      if (e.exitDate !== date) continue;
      exits += 1;
      realizedPnl += (e.exitPrice - p.entryPrice) * e.quantity * p.multiplier * sign - e.fees;
    }
  }
  return { date, realizedPnl: round2(realizedPnl), exits, entries };
}

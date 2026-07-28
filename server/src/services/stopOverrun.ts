// ---------------------------------------------------------------------------
// Stop overrun: when a stock trade's stop actually executed, how far BEYOND
// the declared stop price did the exit land? This is the cost the zero-cost
// backtests structurally cannot see (they fill stops exactly), and the journal
// audit that motivated it found a fifth of realized losses landing past their
// declared stops — gap-throughs and wide spreads, concentrated in cheap
// tickers. Complementary to services/slippage.ts, which compares LIVE fills
// to their order LIMIT prices: this report compares ANY journaled stock
// exit that was a stop execution to the position's own declared stop, so
// manual, imported, and paper-era trades all count.
//
// Signed so POSITIVE always means the overrun cost you money:
//   long : stopPrice − exitPrice   (sold lower than the stop = bad)
//   short: exitPrice − stopPrice   (covered higher than the stop = bad)
// A negative overrun (filled better than the stop) is kept, not clamped —
// the bias of the average is the finding.
//
// Pure and DB-free so it's directly unit-testable; the route does the DB
// orchestration (see routes/journal.ts), including deciding WHICH exits are
// stop executions: exitReason 'stop' where recorded (2026-07-26+), and for
// legacy rows without a reason, an exit at-or-beyond the declared stop
// ('inferred' — the basis is carried per row so the report can say how much
// of itself rests on inference).
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface StopOverrunInput {
  positionId: number;
  symbol: string;
  side: 'long' | 'short';
  /** The exit's date — null when the exit is undated. */
  date: string | null;
  entryPrice: number;
  stopPrice: number;
  exitPrice: number;
  quantity: number;
  /** 'recorded' = the exit row says exitReason 'stop'; 'inferred' = a legacy
   *  reasonless exit at-or-beyond the declared stop. */
  basis: 'recorded' | 'inferred';
}

export interface StopOverrunRow extends StopOverrunInput {
  /** Signed $ per share; positive = exited beyond the stop (cost you money). */
  overrunPerShare: number;
  /** overrunPerShare as a % of the stop price (signed). */
  overrunPct: number;
  /** overrunPerShare as a fraction of the position's own 1R (|entry − stop|
   *  per share) — 0.25 means the stop execution cost a quarter-R more than
   *  the plan. Null when the declared risk distance is zero. */
  overrunR: number | null;
  /** overrunPerShare × quantity (stock multiplier 1). */
  totalUsd: number;
}

/** Decide whether one exit was a stop EXECUTION, and on what basis:
 *  'recorded' when the exit row itself says so; 'inferred' when a legacy
 *  reasonless exit landed at-or-beyond the declared stop; null when it wasn't
 *  a stop execution at all. An exit with a DIFFERENT recorded reason
 *  (target/manual/time_exit) is never counted, even if it landed past the
 *  stop — a deliberate sale below the stop is a decision, not an execution. */
export function classifyStopExit(
  side: 'long' | 'short',
  stopPrice: number,
  exitPrice: number,
  exitReason: string | null,
): 'recorded' | 'inferred' | null {
  if (exitReason === 'stop') return 'recorded';
  if (exitReason != null) return null;
  const beyondOrAt = side === 'long' ? exitPrice <= stopPrice : exitPrice >= stopPrice;
  return beyondOrAt ? 'inferred' : null;
}

export function computeStopOverrun(input: StopOverrunInput): StopOverrunRow {
  const overrunPerShare = input.side === 'long' ? input.stopPrice - input.exitPrice : input.exitPrice - input.stopPrice;
  const riskPerShare = Math.abs(input.entryPrice - input.stopPrice);
  return {
    ...input,
    overrunPerShare: round2(overrunPerShare),
    overrunPct: input.stopPrice !== 0 ? round2((overrunPerShare / input.stopPrice) * 100) : 0,
    overrunR: riskPerShare > 0 ? Math.round((overrunPerShare / riskPerShare) * 100) / 100 : null,
    totalUsd: round2(overrunPerShare * input.quantity),
  };
}

/** Entry-price bands — the micro-cap tax question in one dimension: cheap
 *  tickers gap through stops and trade wide, and this is where it shows. */
export const STOP_OVERRUN_BANDS = [
  { label: '<$5', min: 0, max: 5 },
  { label: '$5–15', min: 5, max: 15 },
  { label: '$15–50', min: 15, max: 50 },
  { label: '≥$50', min: 50, max: Infinity },
] as const;

export interface StopOverrunBand {
  label: string;
  trades: number;
  /** Share of this band's stop exits that landed beyond the stop. */
  beyondPct: number | null;
  avgOverrunR: number | null;
  totalUsd: number;
}

export interface StopOverrunReport {
  /** Stop executions measured (recorded + inferred). */
  trades: number;
  recorded: number;
  inferred: number;
  /** How many landed beyond the stop (overrun > 0), and as a share. */
  beyondCount: number;
  beyondPct: number | null;
  avgOverrunPct: number | null;
  medianOverrunPct: number | null;
  /** Sum across rows; positive = stop executions cost money vs. the plan. */
  totalUsd: number;
  /** Average extra loss per stop execution, in that trade's own R. */
  avgOverrunR: number | null;
  bands: StopOverrunBand[];
  /** Most costly first (by totalUsd, descending). */
  rows: StopOverrunRow[];
}

export function aggregateStopOverruns(rows: StopOverrunRow[]): StopOverrunReport {
  const beyond = rows.filter((r) => r.overrunPerShare > 0);
  const withR = rows.filter((r): r is StopOverrunRow & { overrunR: number } => r.overrunR !== null);
  const pcts = rows.map((r) => r.overrunPct).sort((a, b) => a - b);
  const median =
    pcts.length === 0
      ? null
      : pcts.length % 2
        ? pcts[(pcts.length - 1) / 2]
        : round2((pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2);

  const bands: StopOverrunBand[] = STOP_OVERRUN_BANDS.map((band) => {
    const group = rows.filter((r) => r.entryPrice >= band.min && r.entryPrice < band.max);
    const groupWithR = group.filter((r) => r.overrunR !== null);
    return {
      label: band.label,
      trades: group.length,
      beyondPct: group.length ? round2((group.filter((r) => r.overrunPerShare > 0).length / group.length) * 100) : null,
      avgOverrunR: groupWithR.length
        ? round2(groupWithR.reduce((s, r) => s + (r.overrunR as number), 0) / groupWithR.length)
        : null,
      totalUsd: round2(group.reduce((s, r) => s + r.totalUsd, 0)),
    };
  });

  return {
    trades: rows.length,
    recorded: rows.filter((r) => r.basis === 'recorded').length,
    inferred: rows.filter((r) => r.basis === 'inferred').length,
    beyondCount: beyond.length,
    beyondPct: rows.length ? round2((beyond.length / rows.length) * 100) : null,
    avgOverrunPct: rows.length ? round2(rows.reduce((s, r) => s + r.overrunPct, 0) / rows.length) : null,
    medianOverrunPct: median,
    totalUsd: round2(rows.reduce((s, r) => s + r.totalUsd, 0)),
    avgOverrunR: withR.length ? round2(withR.reduce((s, r) => s + r.overrunR, 0) / withR.length) : null,
    bands,
    rows: [...rows].sort((a, b) => b.totalUsd - a.totalUsd),
  };
}

// "Am I beating the index?" Compares your realized trading return over your
// trading period against simply buying & holding a benchmark (default SPY) over
// the same dates. Honest scorecard — active trading should clear buy-and-hold.

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BenchmarkResult {
  symbol: string;
  startDate: string | null;
  endDate: string | null;
  benchStart: number | null;
  benchEnd: number | null;
  /** Benchmark buy-and-hold return over the period, %. */
  benchmarkReturnPct: number | null;
  totalRealized: number;
  accountSize: number | null;
  /** Your realized return over the period = totalRealized / accountSize, %. */
  userReturnPct: number | null;
  /** userReturnPct − benchmarkReturnPct (out/under-performance vs the index). */
  alphaPct: number | null;
}

export interface BenchmarkInput {
  symbol: string;
  startDate: string | null;
  endDate: string | null;
  benchStart: number | null;
  benchEnd: number | null;
  totalRealized: number;
  accountSize: number | null;
}

export function computeBenchmark(i: BenchmarkInput): BenchmarkResult {
  const benchmarkReturnPct =
    i.benchStart && i.benchEnd && i.benchStart > 0 ? round2(((i.benchEnd - i.benchStart) / i.benchStart) * 100) : null;
  const userReturnPct = i.accountSize && i.accountSize > 0 ? round2((i.totalRealized / i.accountSize) * 100) : null;
  const alphaPct =
    userReturnPct !== null && benchmarkReturnPct !== null ? round2(userReturnPct - benchmarkReturnPct) : null;
  return {
    symbol: i.symbol,
    startDate: i.startDate,
    endDate: i.endDate,
    benchStart: i.benchStart,
    benchEnd: i.benchEnd,
    benchmarkReturnPct,
    totalRealized: round2(i.totalRealized),
    accountSize: i.accountSize,
    userReturnPct,
    alphaPct,
  };
}

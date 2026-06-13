// Portfolio concentration / exposure across OPEN positions. Exposure is measured
// by current market value (falling back to cost basis when no live price), split
// by direction and by the universe sector of each symbol. Helps answer "am I
// over-concentrated in one sector or one side?" — risk management, not advice.

export interface ExposureInput {
  symbol: string;
  side: 'long' | 'short';
  /** Magnitude of capital in the position (market value, or cost basis). */
  value: number;
}

export interface ExposureSlice {
  key: string;
  gross: number;
  pct: number; // % of total gross exposure
  count: number;
}

export interface Exposure {
  gross: number; // sum of |value| across open positions
  net: number; // long - short
  long: number;
  short: number;
  bySector: ExposureSlice[];
  /** Largest single position as a share of gross exposure (concentration). */
  largest: { symbol: string; pct: number } | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeExposure(items: ExposureInput[], sectorOf: (symbol: string) => string | null): Exposure {
  let long = 0;
  let short = 0;
  let largestVal = 0;
  let largestSym = '';
  const sectors = new Map<string, { gross: number; count: number }>();

  for (const it of items) {
    const v = Math.abs(it.value);
    if (v === 0) continue;
    if (it.side === 'long') long += v;
    else short += v;
    const sector = sectorOf(it.symbol) || 'Unclassified';
    const s = sectors.get(sector) ?? { gross: 0, count: 0 };
    s.gross += v;
    s.count += 1;
    sectors.set(sector, s);
    if (v > largestVal) {
      largestVal = v;
      largestSym = it.symbol;
    }
  }

  const gross = long + short;
  const bySector = [...sectors.entries()]
    .map(([key, s]) => ({
      key,
      gross: round2(s.gross),
      pct: gross ? round2((s.gross / gross) * 100) : 0,
      count: s.count,
    }))
    .sort((a, b) => b.gross - a.gross);

  return {
    gross: round2(gross),
    net: round2(long - short),
    long: round2(long),
    short: round2(short),
    bySector,
    largest: gross > 0 && largestSym ? { symbol: largestSym, pct: round2((largestVal / gross) * 100) } : null,
  };
}

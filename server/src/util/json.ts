/**
 * Parse a JSON string, returning `fallback` instead of throwing on null or
 * malformed input. Used at DB read boundaries so one corrupt row can't 500 a
 * whole endpoint — mirroring the try/catch already in getTradingConfig() and
 * the alerts parsePlan().
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

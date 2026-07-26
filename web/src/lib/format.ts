export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtSignedUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtPct(n: number | null | undefined, digits = 2, signed = true): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${signed && n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return 'text-slate-300';
  return n > 0 ? 'text-bull' : 'text-bear';
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(value: number | string | null | undefined): string {
  if (!value) return '—';
  // A date-only string (YYYY-MM-DD) parses as UTC midnight, which
  // toLocaleDateString then renders as the PREVIOUS calendar day in any
  // negative-UTC (US) timezone. Parse it as a LOCAL date so an option expiry /
  // entry / exit date shows the day it actually is. Epoch numbers and full
  // datetime strings keep their exact instant.
  const d =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Whole CALENDAR days from today until a `YYYY-MM-DD` date, in the viewer's own
 * timezone. Negative for past dates, 0 for today. Null for absent/malformed.
 *
 * The obvious version — `Date.parse(`${d}T00:00:00Z`) - Date.now()` — mixes a
 * UTC instant with a local one and so counts wrong for part of every day in any
 * negative-UTC (US) timezone: at 21:00 ET on the 30th, tomorrow's date is
 * already "today" in UTC, so an option expiring the 31st reports 0 days left
 * instead of 1. Same trap fmtDate above documents, on the numbers that drive the
 * expiry and earnings warnings rather than on the label.
 *
 * Both sides are floored to LOCAL midnight, and the division is rounded rather
 * than ceil'd so a DST boundary (a 23- or 25-hour day) can't shift the count.
 */
export function daysUntilLocal(date?: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export const todayISO = (): string => new Date().toISOString().slice(0, 10);

import { ReactNode, useEffect } from 'react';
import { cx, fmtSignedUsd, pnlClass } from '../lib/format';

/**
 * Gain/loss readout that doesn't rely on color alone: a ▲/▼ caret encodes
 * direction for color-blind users, alongside the (already-signed) value and the
 * green/red color. The caret is aria-hidden — the signed value carries the
 * meaning for screen readers. `format` controls how the number is rendered
 * (defaults to signed USD; pass fmtPct for percentages).
 */
export function PnL({
  value,
  format = fmtSignedUsd,
  className,
}: {
  value: number | null | undefined;
  format?: (n: number | null | undefined) => string;
  className?: string;
}) {
  const dir = value === null || value === undefined || value === 0 ? 0 : value > 0 ? 1 : -1;
  const caret = dir > 0 ? '▲' : dir < 0 ? '▼' : '';
  return (
    <span className={cx('inline-flex items-center gap-1 tabular-nums', pnlClass(value), className)}>
      {caret && (
        <span aria-hidden="true" className="text-[0.7em] leading-none">
          {caret}
        </span>
      )}
      {format(value)}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('card', className)}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-500 border-t-accent" />
      {label ?? 'Loading…'}
    </div>
  );
}

/** A single shimmering placeholder block. Width/height via className. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

/** Placeholder for a stat-tile row while data loads. */
export function SkeletonStats({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-3 space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder rows shaped like a table while it loads. */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-1" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cx('h-4 flex-1', c === 0 ? 'max-w-24' : '')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <div className="text-slate-300 font-medium">{title}</div>
      {hint && <div className="text-slate-500 text-sm mt-1 max-w-md mx-auto">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const code = (error as { code?: string }).code;
  return (
    <div className="text-center py-10 px-4">
      <div className="text-bear font-medium">Something went wrong</div>
      <div className="text-slate-400 text-sm mt-1 max-w-lg mx-auto">{error.message}</div>
      {code && <div className="text-slate-600 text-xs mt-1">code: {code}</div>}
      {onRetry && (
        <button className="btn-ghost mt-3" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Badge({
  color = 'slate',
  children,
}: {
  color?: 'slate' | 'green' | 'red' | 'blue' | 'amber';
  children: ReactNode;
}) {
  const map: Record<string, string> = {
    slate: 'bg-ink-600 text-slate-300',
    green: 'bg-bull/15 text-bull',
    red: 'bg-bear/15 text-bear',
    blue: 'bg-accent/15 text-accent',
    amber: 'bg-amber-500/15 text-amber-400',
  };
  return <span className={cx('chip', map[color])}>{children}</span>;
}

/** Horizontal 0–100 score bar, colored by magnitude. */
export function ScoreBar({ value, width = 64 }: { value: number; width?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 66 ? 'bg-bull' : v >= 40 ? 'bg-amber-400' : 'bg-bear';
  return (
    <div className="inline-flex items-center gap-2">
      <div className="rounded bg-ink-600 overflow-hidden" style={{ width, height: 6 }}>
        <div className={cx('h-full', color)} style={{ width: `${v}%` }} />
      </div>
      <span className="tabular-nums text-xs text-slate-300 w-9 text-right">{v.toFixed(1)}</span>
    </div>
  );
}

/**
 * Small "ⓘ" affordance with an on-hover/on-focus explanation. Keyboard
 * accessible (it's a focusable button) and carries a native `title` so the
 * text is reachable even without the popover.
 */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  return (
    <span className="relative inline-flex group align-middle">
      <button
        type="button"
        title={text}
        aria-label={label ?? text}
        className="ml-1 h-3.5 w-3.5 inline-flex items-center justify-center rounded-full bg-ink-600 text-slate-400 text-[9px] font-semibold leading-none hover:bg-ink-500 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-accent"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full z-50 mb-1 hidden w-56 -translate-x-1/2 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-left text-[11px] font-normal normal-case tracking-normal text-slate-300 shadow-xl group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  sub,
  valueClass,
  info,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
  info?: string;
}) {
  return (
    <Card className="px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 flex items-center">
        {label}
        {info && <InfoTip text={info} label={`About ${label}`} />}
      </div>
      <div className={cx('text-lg font-semibold tabular-nums mt-0.5', valueClass)}>{value}</div>
      {sub !== undefined && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </Card>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-0.5">{hint}</span>}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className="input"
      value={value ?? ''}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto animate-overlay-in"
      onMouseDown={onClose}
    >
      <div
        className={cx('card w-full mt-12 mb-12 animate-modal-in', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-600/60 px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button className="text-slate-400 hover:text-slate-200" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-600/60 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export type SortDir = 'asc' | 'desc';

export function SortTh({
  label,
  k,
  active,
  dir,
  onSort,
  className,
  align = 'left',
}: {
  label: string;
  k: string;
  active: string;
  dir: SortDir;
  onSort: (k: string) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  const is = active === k;
  return (
    <th
      className={cx('th cursor-pointer hover:text-slate-200', align === 'right' && 'text-right', className)}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={cx('text-[9px]', is ? 'text-accent' : 'text-slate-600')}>
          {is ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  );
}

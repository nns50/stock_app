import { isValidElement, ReactNode, useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { cx, fmtSignedUsd, pnlClass } from '../lib/format';
import { useLocalStorage } from '../lib/hooks';

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

/**
 * A Card with a collapsible body: click the header to hide/show `children`.
 * Collapsed state persists to localStorage under `id`, so it survives a
 * reload — `id` must be stable and unique among the collapsible cards
 * rendered at once (e.g. "dashboard.watchlist"). The title is wrapped in a
 * real heading element (`headingLevel`, default h3) containing the toggle
 * button — the WAI-ARIA accordion pattern — so collapsing a tile everywhere
 * in the app doesn't flatten the page's heading outline for screen readers;
 * `contents` keeps that wrapper invisible to layout.
 */
export function CollapsibleCard({
  id,
  title,
  icon,
  action,
  defaultCollapsed = false,
  headingLevel = 'h3',
  children,
}: {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  defaultCollapsed?: boolean;
  headingLevel?: 'h2' | 'h3' | 'h4';
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useLocalStorage(`tile.collapsed.${id}`, defaultCollapsed);
  const Heading = headingLevel;
  return (
    <Card className="p-4">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-2',
          !collapsed && 'mb-3 pb-2 border-b border-ink-700/50',
        )}
      >
        <Heading className="contents">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-200 hover:text-accent"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
            )}
            {icon}
            <span className="truncate">{title}</span>
          </button>
        </Heading>
        {!collapsed && action}
      </div>
      {!collapsed && children}
    </Card>
  );
}

/**
 * Consistent page header: a bold title, optional subtitle, and a right-aligned
 * actions slot. Standardizes the top of every page.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">{title}</h1>
        {subtitle && <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
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

/**
 * The outcome of a live order request, when it is neither success nor refusal.
 *
 * A place / close / modify whose broker response was LOST is not "not placed" —
 * the order may be working or already filled at the broker. Rendering it in the
 * same red "✕ Not placed" box as a rejection tells the user the opposite of the
 * truth, and on a close it invites a second one (oversell; for a long, a flip to
 * short). Amber and explicitly unresolved, so the next action is to check rather
 * than to retry.
 */
export function UnknownOutcomeNotice({ message }: { message: string }) {
  return <div className="rounded-md bg-amber-500/15 text-amber-400 text-sm p-2">⚠ Outcome unknown — {message}</div>;
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
    <Card className="px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center font-medium">
        {label}
        {info && <InfoTip text={info} label={`About ${label}`} />}
      </div>
      <div className={cx('text-xl font-semibold tabular-nums mt-1', valueClass)}>{value}</div>
      {sub !== undefined && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </Card>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const captionId = useId();
  const captionHint = hint && <span className="block text-[11px] text-slate-500 mt-0.5">{hint}</span>;

  // A button group (our Segmented) must NOT sit inside a <label>: a <label>
  // forwards padding/caption clicks to its first button (the Strategy-tile reset
  // bug) and prefixes that button's accessible name with the caption (so the
  // "Single" tab reads "Strategy Single"). Render those as a labelled
  // role="group" instead — no forwarding, clean names.
  if (isValidElement(children) && children.type === Segmented) {
    return (
      <div className="block" role="group" aria-labelledby={captionId}>
        <span className="label" id={captionId}>
          {label}
        </span>
        {children}
        {captionHint}
      </div>
    );
  }

  // A single input keeps a real <label>: clicking the caption focuses the field
  // and the caption is its accessible name. The onClick guard is a belt-and-
  // suspenders against any other (non-Segmented) button group slipping in.
  return (
    <label
      className="block"
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest('input, textarea, select, button')) return; // clicked the control itself
        if (e.currentTarget.querySelector('input, textarea, select, button') instanceof HTMLButtonElement) {
          e.preventDefault();
        }
      }}
    >
      <span className="label">{label}</span>
      {children}
      {captionHint}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  // step is a display hint only (this is a text field, no spinner); min/max are
  // enforced in `onChange` below so an out-of-range value can't reach the caller.
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  // A controlled text field (not type="number") so an in-progress decimal like
  // "0." / "1." / ".5" isn't sanitized back to an integer on each keystroke (the
  // browser rewrites a number input's own `.value`). We hold the raw text and
  // re-sync only when the controlled `value` no longer matches it.
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    const current = text === '' ? undefined : Number(text);
    if (value !== current) setText(value === undefined ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="input"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        let t = e.target.value;
        if (t !== '' && !/^-?\d*\.?\d*$/.test(t)) return; // ignore non-numeric keystrokes
        // No minus sign at all when the field has a non-negative floor (min >= 0),
        // so a negative strike/quantity/threshold can't be entered. (A lower
        // bound > 0 is NOT enforced per-keystroke — every prefix of a valid
        // number, e.g. "0" while typing "0.5", would be below it — so that stays
        // an app-level validation concern.)
        if (t.startsWith('-') && min !== undefined && min >= 0) return;
        // Drop a leading zero once a real digit follows it (so a default "0" + "4"
        // becomes "4", not "04") — but keep "0", "0.x" and "-0.x" intact.
        t = t.replace(/^(-?)0+(\d)/, '$1$2');
        const n = t === '' || t === '-' || t === '.' || t === '-.' ? undefined : Number(t);
        // Reject a keystroke that would push the value ABOVE max (e.g. an exit
        // qty over the remaining size) rather than silently sending it to the
        // API. Safe per-keystroke: any left-prefix of a positive number is <= it.
        if (n !== undefined && !Number.isNaN(n) && max !== undefined && n > max) return;
        setText(t);
        onChange(n !== undefined && Number.isNaN(n) ? undefined : n);
      }}
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto animate-overlay-in"
      onMouseDown={onClose}
    >
      <div
        className={cx('card shadow-pop w-full mt-12 mb-12 animate-modal-in', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-600/60 px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button
            className="p-1 -mr-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-ink-700 transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-ink-600/60 px-5 py-3.5 bg-ink-850/40 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reusable segmented control (pill toggle). Replaces ad-hoc inline toggles for
 * a consistent look. `full` makes it stretch with equal-width segments.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  full,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  full?: boolean;
}) {
  return (
    <div
      className={cx('p-0.5 rounded-lg bg-ink-900 border border-ink-600 gap-0.5', full ? 'flex' : 'inline-flex')}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'px-3 py-1 rounded-md text-sm font-medium transition-colors',
            full && 'flex-1',
            value === o.value ? 'bg-ink-600 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
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
  // The control is a real <button>, not a click handler on the <th>: sorting
  // was mouse-only — unreachable by keyboard and invisible to a screen reader,
  // which saw a plain column label with no hint it did anything. `aria-sort`
  // on the cell is what announces the current direction.
  return (
    <th
      scope="col"
      aria-sort={is ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx('th', align === 'right' && 'text-right', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        title={`Sort by ${label}`}
        className={cx('inline-flex items-center gap-1 hover:text-slate-200', align === 'right' && 'w-full justify-end')}
      >
        {label}
        <span aria-hidden="true" className={cx('text-[9px]', is ? 'text-accent' : 'text-slate-600')}>
          {is ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

import { NumberInput } from './ui';
import type { OptionsChain } from '../api/types';

// Pickers that turn the live option chain into dropdowns for the Trade builder,
// so strikes/expiries come from real, tradeable contracts instead of free text
// (which produced "invalid market / strike" broker rejections). Both gracefully
// fall back to a plain input when the chain isn't available (provider has none,
// still loading, or an unlisted symbol) so you're never blocked from entering.

/** Sorted, de-duplicated strikes for one side (call/put) of a chain. */
export function chainStrikes(chain: OptionsChain | null | undefined, type: 'call' | 'put'): number[] {
  if (!chain) return [];
  const arr = type === 'call' ? chain.calls : chain.puts;
  return [...new Set(arr.map((c) => c.strike))].sort((a, b) => a - b);
}

/** Expiration picker — a <select> of chain expirations, or a free-text
 *  YYYY-MM-DD input when none are available. */
export function ExpirySelect({
  value,
  options,
  loading,
  onChange,
}: {
  value: string;
  options: string[];
  loading?: boolean;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) {
    return (
      <input
        className="input"
        placeholder={loading ? 'loading…' : 'YYYY-MM-DD'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
    </select>
  );
}

/** Strike picker — a <select> of chain strikes, or a numeric input fallback. */
export function StrikeSelect({
  value,
  options,
  loading,
  onChange,
}: {
  value: number | undefined;
  options: number[];
  loading?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  if (options.length === 0) {
    return <NumberInput value={value} onChange={onChange} min={0} placeholder={loading ? 'loading…' : undefined} />;
  }
  return (
    <select
      className="input"
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    >
      <option value="">—</option>
      {options.map((s) => (
        <option key={s} value={String(s)}>
          {s}
        </option>
      ))}
    </select>
  );
}

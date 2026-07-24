import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Click-to-sort state for a table. `getValue(row, key)` returns the comparable
 * value for a column (numbers compare numerically, strings via localeCompare,
 * null/undefined always sort last). Pass a STABLE `getValue` (module-level or
 * memoized) to avoid needless re-sorts. Unsorted (no column active) returns the
 * rows untouched, preserving their natural order.
 */
export function useSort<T>(
  rows: T[],
  getValue: (row: T, key: string) => number | string | null | undefined,
  initial?: { key: string; dir: SortDir },
): { sorted: T[]; sortKey: string; sortDir: SortDir; onSort: (key: string) => void } {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initial ?? null);
  const onSort = useCallback((key: string) => {
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  }, []);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = getValue(a, sort.key);
      const vb = getValue(b, sort.key);
      const na = va === null || va === undefined;
      const nb = vb === null || vb === undefined;
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return String(va).localeCompare(String(vb)) * mul;
    });
  }, [rows, sort, getValue]);
  return { sorted, sortKey: sort?.key ?? '', sortDir: sort?.dir ?? 'desc', onSort };
}

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Run an async loader on mount + when deps change; expose a manual reload. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  const run = useCallback(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(undefined);
    loader()
      .then((d) => {
        if (id === reqId.current) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (id === reqId.current) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // Deps changed (a new query — e.g. a different symbol): drop the previous
    // result so consumers gating on `!data` show a loading state instead of the
    // PRIOR entity's data under the new one. A manual reload() calls run()
    // directly (not via this effect), so it still keeps showing data while
    // refreshing. On first mount data is already undefined, so this is a no-op.
    setData(undefined);
    run();
  }, [run]);
  return { data, error, loading, reload: run };
}

/** Call `cb` every `intervalMs` ms; pass null to disable. */
export function usePolling(cb: () => void, intervalMs: number | null): void {
  const saved = useRef(cb);
  saved.current = cb;
  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore quota errors */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

import { useCallback, useEffect, useRef, useState } from 'react';

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

  useEffect(() => run(), [run]);
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

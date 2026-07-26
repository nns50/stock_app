import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsync, usePolling, useSort } from './hooks';

type Row = { s: string; n: number | null };
const rows: Row[] = [
  { s: 'b', n: 2 },
  { s: 'a', n: 3 },
  { s: 'c', n: 1 },
];
const get = (r: Row, k: string): number | string | null => (k === 's' ? r.s : r.n);

describe('useSort', () => {
  it('leaves rows in natural order until a column is chosen', () => {
    const { result } = renderHook(() => useSort(rows, get));
    expect(result.current.sorted.map((r) => r.s)).toEqual(['b', 'a', 'c']);
  });

  it('sorts desc on first click of a column, then asc on the second', () => {
    const { result } = renderHook(() => useSort(rows, get));
    act(() => result.current.onSort('n'));
    expect(result.current.sorted.map((r) => r.n)).toEqual([3, 2, 1]);
    act(() => result.current.onSort('n'));
    expect(result.current.sorted.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it('sorts strings via localeCompare and keeps nulls last', () => {
    const withNull: Row[] = [
      { s: 'b', n: 2 },
      { s: 'a', n: null },
    ];
    const { result } = renderHook(() => useSort(withNull, get));
    act(() => result.current.onSort('s'));
    expect(result.current.sorted.map((r) => r.s)).toEqual(['b', 'a']);
    act(() => result.current.onSort('n'));
    expect(result.current.sorted.map((r) => r.n)).toEqual([2, null]); // null last in both directions
  });
});

describe('useAsync', () => {
  it('clears data when deps change so the previous entity is not shown under the new one', async () => {
    let resolveB!: (v: string) => void;
    const loader = (key: string) => (key === 'a' ? Promise.resolve('A') : new Promise<string>((r) => (resolveB = r)));

    const { result, rerender } = renderHook(({ key }) => useAsync(() => loader(key), [key]), {
      initialProps: { key: 'a' },
    });

    // First query resolves to 'A'.
    await waitFor(() => expect(result.current.data).toBe('A'));

    // Deps change → a new, still-pending query. Old 'A' must NOT linger.
    rerender({ key: 'b' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);

    // Resolving the new query shows 'B'.
    await act(async () => resolveB('B'));
    await waitFor(() => expect(result.current.data).toBe('B'));
  });
});

describe('usePolling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  };

  it('skips ticks while the tab is hidden', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    setHidden(false);
    renderHook(() => usePolling(cb, 1000));

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    // A background tab has nobody reading it, but its poll still spends a real
    // provider call every interval.
    setHidden(true);
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('catches up immediately when the tab becomes visible again', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    setHidden(true);
    renderHook(() => usePolling(cb, 1000));
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();

    // This is what makes skipping safe: you come back to fresh data rather
    // than to whatever was on screen when you left.
    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when polling is disabled', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    setHidden(false);
    renderHook(() => usePolling(cb, null));
    vi.advanceTimersByTime(5000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

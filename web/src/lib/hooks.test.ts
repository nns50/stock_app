import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsync, useSort } from './hooks';

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

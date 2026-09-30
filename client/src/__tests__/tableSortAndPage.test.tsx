import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTableSort } from '../utils/useTableSort';
import { useClientPage } from '../utils/useClientPage';

interface Row {
  name: string;
  amount: number | null;
}

const ROWS: Row[] = [
  { name: 'Item 10', amount: 500 },
  { name: 'item 2', amount: null },
  { name: 'Item 1', amount: 1500 },
];

const accessors = { name: (r: Row) => r.name, amount: (r: Row) => r.amount };

describe('useTableSort', () => {
  it('sorts text naturally and case-insensitively ("Item 2" before "Item 10")', () => {
    const { result } = renderHook(() => useTableSort(ROWS, accessors, { key: 'name', direction: 'asc' }));
    expect(result.current.sorted?.map((r) => r.name)).toEqual(['Item 1', 'item 2', 'Item 10']);
  });

  it('flips direction on the active column and restarts ascending on a new one', () => {
    const { result } = renderHook(() => useTableSort(ROWS, accessors, { key: 'name', direction: 'asc' }));
    act(() => result.current.toggle('name'));
    expect(result.current.sort).toEqual({ key: 'name', direction: 'desc' });
    expect(result.current.sorted?.map((r) => r.name)).toEqual(['Item 10', 'item 2', 'Item 1']);
    act(() => result.current.toggle('amount'));
    expect(result.current.sort).toEqual({ key: 'amount', direction: 'asc' });
  });

  it('keeps missing values last in both directions', () => {
    const { result } = renderHook(() => useTableSort(ROWS, accessors, { key: 'amount', direction: 'asc' }));
    expect(result.current.sorted?.map((r) => r.amount)).toEqual([500, 1500, null]);
    act(() => result.current.toggle('amount'));
    expect(result.current.sorted?.map((r) => r.amount)).toEqual([1500, 500, null]);
  });

  it('re-sorts when a late-loading input changes', () => {
    let lookup = new Map<string, number>();
    const { result, rerender } = renderHook(({ map }) =>
      useTableSort(ROWS, { name: (r: Row) => r.name, balance: (r: Row) => map.get(r.name) ?? null }, { key: 'balance', direction: 'asc' }, [map]),
      { initialProps: { map: lookup } },
    );
    expect(result.current.sorted?.map((r) => r.name)).toEqual(['Item 10', 'item 2', 'Item 1']); // all missing: server order
    lookup = new Map([['Item 1', 1], ['item 2', 2], ['Item 10', 3]]);
    rerender({ map: lookup });
    expect(result.current.sorted?.map((r) => r.name)).toEqual(['Item 1', 'item 2', 'Item 10']);
  });
});

describe('useClientPage', () => {
  const many = Array.from({ length: 60 }, (_, i) => i + 1);

  it('slices pages and reports totals', () => {
    const { result } = renderHook(() => useClientPage(many, 25));
    expect(result.current.pageRows).toHaveLength(25);
    expect(result.current.totalPages).toBe(3);
    act(() => result.current.setPage(3));
    expect(result.current.pageRows).toEqual(many.slice(50));
  });

  it('returns to page 1 when the list changes', () => {
    const { result, rerender } = renderHook(({ rows }) => useClientPage(rows, 25), { initialProps: { rows: many } });
    act(() => result.current.setPage(3));
    rerender({ rows: many.slice(0, 30) });
    expect(result.current.page).toBe(1);
  });

  it('holds its page while the list is unchanged', () => {
    const { result, rerender } = renderHook(({ rows }) => useClientPage(rows, 25), { initialProps: { rows: many } });
    act(() => result.current.setPage(2));
    rerender({ rows: many });
    expect(result.current.page).toBe(2);
  });
});

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedInput } from '../utils/useDebouncedInput';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedInput', () => {
  it('commits once, after typing pauses', () => {
    const commit = vi.fn();
    const { result } = renderHook(({ committed }) => useDebouncedInput(committed, commit, 300), {
      initialProps: { committed: '' },
    });

    act(() => result.current[1]('b'));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current[1]('br'));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current[1]('bra'));
    expect(commit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('bra');
  });

  it('a cleared committed value empties the draft, and a pending keystroke never writes the old text back', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(({ committed }) => useDebouncedInput(committed, commit, 300), {
      initialProps: { committed: 'steel' },
    });

    act(() => result.current[1]('steel bracket')); // typing, not yet settled
    rerender({ committed: '' }); // "Clear filters"
    expect(result.current[0]).toBe('');

    act(() => vi.advanceTimersByTime(1000));
    expect(commit).not.toHaveBeenCalled();
  });

  it('clearing a settled search does not write it back (draft and debounced both still hold the old text)', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(({ committed }) => useDebouncedInput(committed, commit, 300), {
      initialProps: { committed: 'aws' },
    });
    expect(result.current[0]).toBe('aws');

    rerender({ committed: '' });
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current[0]).toBe('');
    expect(commit).not.toHaveBeenCalled();
  });
});

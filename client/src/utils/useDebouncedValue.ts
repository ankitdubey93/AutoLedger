import { useEffect, useState } from 'react';

/**
 * `value`, but only after it has stopped changing for `delayMs`. A search box
 * binds its input to the live value and its fetch to the debounced one, so
 * typing "bracket" sends one request instead of seven.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

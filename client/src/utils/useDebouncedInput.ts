import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from './useDebouncedValue';

/**
 * A text input whose value is committed somewhere slower — typically the URL,
 * which re-runs a fetch — only once typing pauses. Returns the draft the
 * input binds to and its setter; `commit` is called with the settled value.
 *
 * Two rules keep the draft and the committed value from fighting:
 *   - a committed value that changes from elsewhere (a "Clear filters"
 *     button, the back button) replaces the draft immediately;
 *   - a commit fires only on a *transition* of the debounced value. When
 *     "Clear filters" empties the URL, the effect in that same render still
 *     sees the old draft and the old debounced text — equal to each other and
 *     different from the now-empty URL — so a rule keyed on those alone would
 *     write the old search straight back. Keying on "the debounced value just
 *     changed" means an outside change never triggers a commit.
 */
export function useDebouncedInput(committed: string, commit: (value: string) => void, delayMs = 300): [string, (value: string) => void] {
  const [draft, setDraft] = useState(committed);
  const debounced = useDebouncedValue(draft, delayMs);
  const previousDebounced = useRef(debounced);

  useEffect(() => {
    setDraft(committed);
  }, [committed]);

  useEffect(() => {
    const changed = debounced !== previousDebounced.current;
    previousDebounced.current = debounced;
    if (changed && debounced === draft && debounced !== committed) commit(debounced);
  }, [debounced, draft, committed, commit]);

  return [draft, setDraft];
}

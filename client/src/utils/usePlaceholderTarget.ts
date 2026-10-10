import { useRef } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement;

export interface PlaceholderTarget {
  /**
   * Spread onto an input or textarea that placeholders can be inserted into.
   * `set` is the field's own state setter — the field stays controlled.
   */
  bind: (key: string, set: (value: string) => void) => { ref: (el: Field | null) => void; onFocus: () => void };
  /** Inserts `token` at the caret of the last-focused bound field (or `fallbackKey`). */
  insert: (token: string) => void;
}

/**
 * Phase 40 — "Insert placeholder" for any number of fields on one form
 * (notes plus every line's description, say). Generalises Phase 39b's
 * statement-email chips.
 *
 * The caret position survives the field losing focus to the picker: an
 * input's `selectionStart`/`selectionEnd` are kept on the element after blur.
 * The insert splices the token into the field's current value through its
 * own setter, then — after React has re-rendered the new value — puts focus
 * and the caret back just after the token. Done in requestAnimationFrame,
 * because setting the selection synchronously would apply it to the old
 * value, which React is about to replace.
 */
export function usePlaceholderTarget(fallbackKey: string): PlaceholderTarget {
  const elements = useRef(new Map<string, Field>());
  const setters = useRef(new Map<string, (value: string) => void>());
  const focused = useRef<string | null>(null);

  function bind(key: string, set: (value: string) => void) {
    setters.current.set(key, set);
    return {
      ref: (el: Field | null) => {
        if (el === null) elements.current.delete(key);
        else elements.current.set(key, el);
      },
      onFocus: () => {
        focused.current = key;
      },
    };
  }

  function insert(token: string) {
    const key = focused.current !== null && elements.current.has(focused.current) ? focused.current : fallbackKey;
    const element = elements.current.get(key);
    const set = setters.current.get(key);
    if (element === undefined || set === undefined) return;
    const text = element.value;
    const start = element.selectionStart ?? text.length;
    const end = element.selectionEnd ?? text.length;
    set(`${text.slice(0, start)}${token}${text.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return { bind, insert };
}

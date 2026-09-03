# Accessible Confirmation Dialogs

> `window.confirm()` is the one-line fix that's wrong on every axis that matters: it blocks the JS event loop for every user of the tab, it can't be styled, and it can't be driven from a test — so a hand-rolled dialog isn't gold-plating, it's the only option that's actually testable.

**Category:** React
**Introduced by:** Phase 3.8 — confirming a journal-entry reversal, an invoice issue, and an invoice void, all irreversible actions that previously fired immediately on click
**Verified against:** React 19, `@testing-library/react` 16.x, `@testing-library/user-event` 14.x

---

## Mechanism

### Why `window.confirm` was never a candidate

`window.confirm()` is a **synchronous, blocking** browser API — calling it suspends JavaScript execution (and, in most engines, the whole render) until the user dismisses it. That is disqualifying by itself in an SPA that might have in-flight fetches or timers expecting to run. It also cannot be styled to match the app, cannot be positioned, and — the practical reason it was rejected here — it cannot be triggered or dismissed from `@testing-library/user-event` in jsdom, because jsdom does not implement it at all; a component that calls `window.confirm()` is untestable without a manual `vi.stubGlobal('confirm', ...)` workaround that only proves the stub was called, not that a real user could operate the dialog.

The alternative is a dialog built from ordinary DOM elements with the right ARIA roles and the right keyboard/focus behavior wired in by hand.

### The accessibility contract

A confirmation dialog is a `role="dialog"` that additionally sets `aria-modal="true"`. `role="dialog"` alone tells assistive technology "this is a distinct grouped region"; `aria-modal="true"` is what tells it "everything *outside* this region is inert while it's open" — a screen reader honoring `aria-modal` stops exposing the background content to its virtual cursor, which is the accessible equivalent of the visual overlay. `aria-labelledby` pointing at the dialog's own `<h3>` gives it an accessible name ("Reverse this entry?") without duplicating that text into an `aria-label` string.

```tsx
<div role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
  <h3 id="confirm-dialog-title">{title}</h3>
  ...
</div>
```

None of this is enforced by the browser — `aria-modal` is a hint to assistive technology, not a mechanism that traps mouse clicks or blocks background scripts. The "modal" behavior for sighted, mouse-driven users has to be built separately (below); ARIA and visual/interactive modality are two different problems that happen to need solving together.

### Focus management on mount

A dialog that opens without moving focus leaves a screen-reader or keyboard user still "at" whatever they were interacting with before — the dialog exists on screen but is invisible to their next Tab press. The fix is a `ref` on the primary action and an effect that focuses it on mount:

```tsx
const confirmRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
  confirmRef.current?.focus();
  ...
}, []);
```

Focusing the *confirm* button rather than the dialog container itself means the very next keystroke (Enter, or Tab-then-Enter) does something meaningful, and it's a deliberate choice about which control gets the "free" first keystroke — some dialog conventions instead focus Cancel by default for a destructive action, trading one keystroke of safety for one keystroke of friction. This implementation focuses Confirm and relies on `tone="danger"` styling plus explicit copy to signal the stakes, matching the existing codebase's terse-confirmation style.

### Dismissal: Escape and outside-click

Two independent escape hatches, both implemented as native DOM listeners rather than React synthetic events, because they need to work regardless of what currently has focus inside the dialog:

```tsx
useEffect(() => {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') onCancel();
  }
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

Escape is bound to `window`, not the dialog element, because focus starts on the confirm button — a `keydown` handler on the dialog `<div>` would only fire if the div itself (or a descendant) has focus, which it does here, but binding to `window` is more robust against focus moving unexpectedly and matches how most native modal implementations behave.

Outside-click dismissal uses the classic "compare `event.target` to `event.currentTarget`" trick on the *overlay*, not a global listener:

```tsx
<div
  className="fixed inset-0 ... bg-black/50"
  onClick={(event) => {
    if (event.target === event.currentTarget) onCancel();
  }}
>
  <div role="dialog" ...>...</div>
</div>
```

`onClick` on the outer overlay div fires for every click inside it, including clicks on the dialog panel nested within — because React's synthetic events bubble like native DOM events. The `target === currentTarget` check discriminates "the click landed directly on the overlay background" from "the click landed on something inside the overlay and bubbled up to it," so clicking inside the dialog panel never closes it. This is simpler and more robust than the common alternative — a `ref` on the panel and checking `panelRef.current.contains(event.target)` in a `document`-level listener — because it needs no ref at all and no separate listener lifecycle to manage.

### Why this beats the native `<dialog>` element

HTML has a native `<dialog>` element with a `showModal()` method that provides a real top-layer (rendered above everything, including `position: fixed` siblings, without `z-index` tricks), automatic Escape-to-close, and a backdrop pseudo-element — solving several of the problems above for free. It was not used here for two reasons specific to this codebase: it needs imperative `ref.current.showModal()` / `.close()` calls rather than fitting the app's fully-declarative `{condition && <Dialog />}` conditional-render idiom used everywhere else (`ConfirmDialog` unmounts entirely when not needed, which `<dialog>`'s imperative API works against), and its default focus-trap and Escape behavior differ slightly across browsers in ways that would need testing regardless — at which point the hand-rolled version, already fully controlled by React state, was less total work than reconciling `<dialog>`'s imperative lifecycle with the rest of the app.

### Testing a confirmation flow

Because the dialog is ordinary DOM with real ARIA roles, Testing Library queries it exactly like anything else — no dialog-specific test utilities needed:

```tsx
await user.click(screen.getByRole('button', { name: 'Reverse entry' }));  // opens it
const dialog = screen.getByRole('dialog');
expect(within(dialog).getByRole('button', { name: 'Reverse entry' })).toBeInTheDocument();
await user.click(within(dialog).getByRole('button', { name: 'Reverse entry' })); // confirms
```

`within(dialog)` matters here specifically because the trigger button and the dialog's confirm button share the same accessible name by design (both read "Reverse entry") — a bare `screen.getByRole('button', { name: 'Reverse entry' })` while the dialog is open would throw on multiple matches. Scoping the query to the dialog's own subtree disambiguates without needing different copy on the two buttons, which would otherwise be the "easy" fix but would make the UI's own labeling worse to satisfy a test.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `window.confirm()` | One line, zero code | Rejected — blocks the event loop, unstylable, not present in jsdom for automated testing |
| Hand-rolled `<div role="dialog">` fully controlled by React state | Full control over styling and the app's declarative conditional-render idiom; must implement focus/Escape/outside-click by hand | **Chosen** |
| Native `<dialog>` + `showModal()` | Free top-layer stacking, native Escape/backdrop | Rejected — imperative API fights the codebase's `{condition && <X/>}` idiom used everywhere else; cross-browser focus-trap quirks still need testing |
| A dialog library (Radix, Headless UI) | Handles all of the above, battle-tested | Rejected — guardrails rule 14 (no dependency before the phase that needs it); three call sites don't justify a new dependency when the ARIA contract is this small |

## Where it lives in this codebase

- `client/src/Pages/ledger-core/ConfirmDialog.tsx` — the component itself
- `client/src/Pages/ledger-core/JournalsPage.tsx`, `JournalDetailPage.tsx` — confirming a reversal
- `client/src/Pages/ledger-core/InvoiceDetailPage.tsx` — confirming issue and void, each with its own title/body/tone
- `client/src/__tests__/ledgerCoreJournals.test.tsx`, `ledgerCoreInvoices.test.tsx` — the `within(dialog)` disambiguation pattern

## Gotchas

- The confirm button and the trigger button sharing an accessible name is a deliberate choice (consistent verb across the flow), but it means every test interacting with the dialog must scope its query with `within(dialog)` — a bare `screen.getByRole` will throw "multiple elements found" the instant the dialog is open.
- Binding `keydown` to `window` means an *unrelated* Escape press anywhere on the page while the dialog happens to be mounted will close it — acceptable for a single modal dialog, but would need a stack-aware handler (only the topmost dialog responds) if nested dialogs were ever introduced.
- `aria-modal="true"` does not stop background elements from receiving *mouse* clicks or being included in the *native* Tab order in every browser — screen readers respect it, but true visual/keyboard containment (a focus trap cycling Tab within the dialog) is a separate mechanism this implementation does not add, because the two-button, two-action dialogs here don't have enough interactive content for the omission to be noticeable. A dialog with a longer form inside it would need an explicit focus trap.
- The overlay `onClick` trick (`target === currentTarget`) breaks if the overlay itself ever gets padding or children between it and the panel that could receive the click and not equal `currentTarget` — the check is deliberately about the *element identity*, not "was the click outside the panel's bounding box."

## Interview Q&A

**Q: Why not just use `window.confirm()` for a "are you sure" prompt?**
A: It's a synchronous, blocking call — it freezes the JS event loop, which is a bad citizen in an SPA with other things potentially in flight, and it can't be styled or positioned. The disqualifying issue for this project specifically is that jsdom (the DOM implementation `@testing-library/react` runs tests against) doesn't implement it at all, so a component that calls it directly can't be driven by `user-event` in a test without stubbing the global — which only proves the stub fired, not that a real user could use the dialog.

**Q: How do you make a custom dialog accessible to a screen reader?**
A: `role="dialog"` plus `aria-modal="true"` on the container, `aria-labelledby` pointing at the element that names it (usually the heading) so it announces with a name rather than as an anonymous region, and moving focus onto something inside the dialog when it opens — otherwise a screen-reader user's next interaction still targets whatever was focused before the dialog appeared, even though visually the dialog is what's showing.

**Q: How did you handle dismissing the dialog — Escape key, clicking outside?**
A: Both, as two independent mechanisms. Escape is a `keydown` listener bound to `window` in a `useEffect`, cleaned up on unmount, checking `event.key === 'Escape'`. Outside-click uses an `onClick` handler on the overlay div that compares `event.target === event.currentTarget` — since React's synthetic click events bubble, a click on the panel itself bubbles up to the overlay's handler too, and that comparison is what distinguishes "clicked the overlay background directly" from "clicked something inside it that bubbled up."

**Q: Why didn't you use the native HTML `<dialog>` element — doesn't it handle a lot of this for you?**
A: It does provide real top-layer stacking and built-in Escape handling, but its API is imperative — you call `ref.current.showModal()` and `.close()` — which fights this codebase's fully-declarative pattern of conditionally rendering `{condition && <Dialog />}` everywhere else. Reconciling an imperative lifecycle with React state for three call sites was more total complexity than the ARIA-role-plus-manual-focus approach, which stays declarative throughout.

**Q: How do you write a test that clicks through a confirmation flow, given the confirm button and the trigger button have the same label?**
A: Scope the second query to the dialog's own subtree with Testing Library's `within(dialog)` helper, using `screen.getByRole('dialog')` to get that subtree first. A bare `screen.getByRole('button', { name: ... })` while the dialog is open throws on ambiguity — matching the trigger *and* the confirm button — so the fix is querying inside the dialog specifically rather than changing the button copy to be artificially different, which would make the UI itself worse just to satisfy a test.

## Follow-ups they'll dig into

- What happens if the dialog needs to trap Tab focus so it can't reach elements behind it? (Not implemented here — with two buttons, cycling focus manually via `onKeyDown` checking `Tab`/`Shift+Tab` against the first/last focusable element would be the next step, or reaching for a focus-trap utility once the dialog's content grows.)
- How would you support stacking two dialogs (a confirmation on top of another dialog)? (The current `window`-scoped Escape listener would need to become stack-aware — a shared array of open dialog ids, with only the topmost one's handler responding — otherwise Escape on the top dialog would also propagate logic intended for the one beneath it.)

## See also

- [../architecture/document-lifecycle-fsm.md](../architecture/document-lifecycle-fsm.md) — why these three actions (reverse, issue, void) are exactly the ones that need a confirmation gate: each is a one-way state transition
- [context-effects-and-data-fetching.md](context-effects-and-data-fetching.md) — the `ignore`-flag effect-cleanup idiom this codebase uses elsewhere, contrasted with the plain listener-cleanup pattern used here

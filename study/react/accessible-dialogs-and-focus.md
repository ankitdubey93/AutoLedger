# Accessible Confirmation Dialogs

> `window.confirm()` is the one-line fix that's wrong on every axis that matters: it blocks the JS event loop for every user of the tab, it can't be styled, and it can't be driven from a test — so a hand-rolled dialog isn't gold-plating, it's the only option that's actually testable.

**Category:** React
**Introduced by:** Phase 3.8 — confirming a journal-entry reversal, an invoice issue, and an invoice void, all irreversible actions that previously fired immediately on click
**Extended by:** Phase 31 — a shared `Menu` component (the app switcher, the theme toggle, the user menu, "+ New") built on the WAI-ARIA **menu button** pattern, a sibling of the dialog pattern above but with a different keyboard contract; see "The menu-button pattern" below
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

### The menu-button pattern

A dropdown menu — the app switcher, the theme toggle, the "+ New" button — is a *different* ARIA pattern from a dialog, not a smaller version of the same one, and confusing the two produces a component with the wrong keyboard behaviour even though it "looks right" visually. A dialog is `role="dialog"` + `aria-modal`, is expected to trap or at least dominate focus, and is dismissed with a single Escape. A menu is `role="menu"` containing `role="menuitem"` children, is navigated with arrow keys the way a native `<select>` is, and both opening and selecting move focus in specific, scripted ways defined by the [WAI-ARIA APG "Menu Button" pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).

```tsx
<button aria-haspopup="menu" aria-expanded={open} onClick={toggle}>New</button>
{open && (
  <div role="menu" aria-label="Create new">
    <Link role="menuitem" tabIndex={-1} to="/invoices/new">Invoice</Link>
    <Link role="menuitem" tabIndex={-1} to="/journals/new">Journal entry</Link>
  </div>
)}
```

Three mechanical pieces make this behave like a native menu instead of a styled `<div>` that happens to contain links:

**`tabIndex={-1}` on every item, plus scripted focus.** A menu should not be part of the page's normal Tab order at all — Tab should skip straight from the trigger button to whatever comes *after* the whole menu, the same way it skips over the options inside a closed `<select>`. Every `role="menuitem"` therefore gets `tabIndex={-1}` (removable from Tab order, but still focusable programmatically), and the component moves focus itself: onto the first item the instant the menu opens (`itemRefs.current[0]?.focus()` inside a `useEffect` keyed on `open`), and between items on ArrowUp/ArrowDown by calling `.focus()` on the next ref rather than relying on the browser's own Tab-order traversal.

**Roving among only the selectable items, not every child.** A separator (`role="separator"`, a plain divider `<div>`) sits in the same array as the real menu items but must never receive focus or count toward "next"/"previous." The fix is deriving a parallel array of *just the indexes that are selectable* (`items.map((item, i) => item.type === 'separator' ? -1 : i).filter(i => i >= 0)`) and moving through *that* array's positions, wrapping at the ends — ArrowDown past the last real item goes to the first, not off the end of the menu.

**Selecting an item both runs its action and closes the menu, in that order.** For a `<Link>` item this means the router navigation and the `setOpen(false)` both happen from the same `onClick`; for a `<button>` item it's the same shape with `onSelect()` in place of navigation. The ordering isn't arbitrary — running the action *before* closing means a synchronous handler still has a mounted, focused menu to work against if it needs to read anything from the DOM, though in practice neither call site here does.

Opening, closing, and outside-click reuse the exact same primitives `ConfirmDialog` established above — a `pointerdown` listener on `document` compared against a `containerRef`, and a `keydown` listener checking `Escape` — but Escape's job is different here: a dialog's Escape cancels an *action*; a menu's Escape closes the menu **and explicitly returns focus to the trigger button** (`triggerRef.current?.focus()`), because unlike a dialog (which was opened from, and dismisses back to, a stable point in the page) a menu trigger is often one of several equally-styled buttons in a row, and losing track of which one opened the menu would strand keyboard focus at the top of the document.

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
- `client/src/components/ui/Menu.tsx` — the shared menu-button component (Phase 31)
- `client/src/components/layout/AppTopBar.tsx` — the app-switcher, theme-toggle, and user menus built on it
- `client/src/Pages/ledger-core/CreateMenu.tsx` — the original hand-rolled "+ New" menu, rewritten in Phase 31 to render through `Menu` instead of duplicating its own outside-click/Escape effect
- `client/src/__tests__/menu.test.tsx` — arrow-key roving, Escape-returns-focus, outside-click, and selection-closes-the-menu, asserted with `toHaveFocus()`

## Gotchas

- The confirm button and the trigger button sharing an accessible name is a deliberate choice (consistent verb across the flow), but it means every test interacting with the dialog must scope its query with `within(dialog)` — a bare `screen.getByRole` will throw "multiple elements found" the instant the dialog is open.
- Binding `keydown` to `window` means an *unrelated* Escape press anywhere on the page while the dialog happens to be mounted will close it — acceptable for a single modal dialog, but would need a stack-aware handler (only the topmost dialog responds) if nested dialogs were ever introduced.
- `aria-modal="true"` does not stop background elements from receiving *mouse* clicks or being included in the *native* Tab order in every browser — screen readers respect it, but true visual/keyboard containment (a focus trap cycling Tab within the dialog) is a separate mechanism this implementation does not add, because the two-button, two-action dialogs here don't have enough interactive content for the omission to be noticeable. A dialog with a longer form inside it would need an explicit focus trap.
- The overlay `onClick` trick (`target === currentTarget`) breaks if the overlay itself ever gets padding or children between it and the panel that could receive the click and not equal `currentTarget` — the check is deliberately about the *element identity*, not "was the click outside the panel's bounding box."
- **Focusing a menu item synchronously right after `setState({open: true})` doesn't work — it has to be a `useEffect` keyed on the open state, not code in the click handler that opened it.** The DOM node for the first `role="menuitem"` doesn't exist yet at the moment `onClick` runs; it's created when React commits the render triggered by that state update, which is exactly what a `useEffect` (which runs after commit) is timed for and a same-tick call is not.
- **`requestAnimationFrame` is not a substitute for `useEffect` for "wait until the DOM exists."** A first pass at the command palette's autofocus used `requestAnimationFrame(() => inputRef.current?.focus())` on the theory that it needed to wait a frame for the element to exist — but a passive effect already runs after the browser has committed the DOM, so the element exists the moment the effect body executes; the deferred call was not just unnecessary, it broke the very test asserting the focus (`toHaveFocus()` ran before the next animation frame had fired in jsdom). Reach for `useEffect` first, and only add an actual delay if there's a specific, named reason the DOM isn't ready by then.
- **A separator or a disabled item must be excluded from the roving-focus array, not merely skipped visually.** Filtering only in the render (e.g. graying out a disabled `<button>` but leaving it in the same focus-order array) still lets ArrowDown land focus on it — the array used for "what is the next selectable index" has to be a genuinely different, filtered list from "what is rendered."

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

**Q: What's the actual difference between a dialog and a dropdown menu, from an accessibility-pattern standpoint — aren't they both just "a floating box that appears"?**
A: They're different ARIA patterns with different keyboard contracts, not a big and small version of the same thing. A dialog is `role="dialog"` (optionally `aria-modal`), dismissed by one Escape, and its content can be anything — a form, prose, buttons — with no expectation that arrow keys do anything special inside it. A menu is `role="menu"` containing only `role="menuitem"` children, is navigated with arrow keys the same way a native `<select>` is, removed entirely from the page's normal Tab order (every item gets `tabIndex={-1}`), and selecting an item is expected to both act and close in one keystroke. Building a menu out of the dialog pattern would give you a floating box with no arrow-key navigation and items sitting in the ordinary Tab order — visually similar, behaviourally wrong for a keyboard or screen-reader user who expects `<select>`-like behaviour.

**Q: How do you make arrow-key navigation skip a separator or a disabled item in a menu?**
A: Don't filter in the render layer — derive a second array up front that's just the indexes of the selectable items (`items.map((item, i) => isSelectable(item) ? i : -1).filter(i => i >= 0)`), and do all "next"/"previous" arithmetic against *that* array's positions, not the raw items array. `Math.min`/`Math.max` won't wrap correctly either — the standard shape is `(position + direction + length) % length`, which wraps ArrowDown past the last selectable item back to the first, matching how a native `<select>` behaves.

**Q: A menu opens and you want the first item focused automatically. Where does that focus call go, and why not just call `.focus()` right in the button's `onClick`?**
A: It has to be a `useEffect` that runs when the open state becomes true, not code inside the click handler that flips that state. At the moment `onClick` runs, React has only scheduled the re-render — the menu's DOM nodes, including the first item you want to focus, don't exist yet. A `useEffect` runs after React commits the DOM for that render, which is the first point the node is guaranteed to exist, so it's the correct place for any "the DOM must already reflect this state change" logic, focus included.

## Follow-ups they'll dig into

- What happens if the dialog needs to trap Tab focus so it can't reach elements behind it? (Not implemented here — with two buttons, cycling focus manually via `onKeyDown` checking `Tab`/`Shift+Tab` against the first/last focusable element would be the next step, or reaching for a focus-trap utility once the dialog's content grows.)
- How would you support stacking two dialogs (a confirmation on top of another dialog)? (The current `window`-scoped Escape listener would need to become stack-aware — a shared array of open dialog ids, with only the topmost one's handler responding — otherwise Escape on the top dialog would also propagate logic intended for the one beneath it.)
- What about typeahead — pressing "J" in an open menu to jump to the item starting with J, the way a native `<select>` supports? (Not implemented in `Menu.tsx`. It's an APG-recommended enhancement, not a requirement, and would mean tracking a short-lived buffer of recently-typed characters and matching against each item's label — a reasonable next step if the menus grow past a handful of items.)

## See also

- [../architecture/document-lifecycle-fsm.md](../architecture/document-lifecycle-fsm.md) — why these three actions (reverse, issue, void) are exactly the ones that need a confirmation gate: each is a one-way state transition
- [context-effects-and-data-fetching.md](context-effects-and-data-fetching.md) — the `ignore`-flag effect-cleanup idiom this codebase uses elsewhere, contrasted with the plain listener-cleanup pattern used here
- [routing-nested-and-dynamic-segments.md](routing-nested-and-dynamic-segments.md) — "A fetch keyed by tenant, not by route param" covers `ShellContext`'s and `ThemeContext`'s shared "safe default instead of throw" choice, the same reasoning applied to a different context
- [utility-first-css-tailwind.md](utility-first-css-tailwind.md) — the `pop-in`/`fade-in` open animations these menus and dialogs use, and why they're gated behind `prefers-reduced-motion`

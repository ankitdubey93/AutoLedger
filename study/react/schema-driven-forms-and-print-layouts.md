# Schema-Driven Forms and Print Layouts

> A form whose fields come from data instead of JSX doesn't need a new component every time a tenant invents a new field — and a page meant for paper needs a second, entirely separate set of layout rules from the one meant for a screen.

**Category:** React
**Introduced by:** Phase 28 — StockLedger's `AttributeFields` (per-category custom fields, rendered from `stock_attribute_definitions`) and the QR label sheet's print stylesheet
**Verified against:** React 19

---

## Mechanism

### Rendering a form from data instead of writing it

Every other form in this codebase (an invoice's line items, a journal entry) has a fixed, known-at-compile-time set of fields — JSX names each `<input>` explicitly. StockLedger's per-item custom attributes can't work that way: which fields an item needs (`tower`/`floor`/`carpet_area_sqft` for real estate; `fabric_type`/`gsm` for textiles) is decided by each organization at setup time, not by this codebase's source. `AttributeFields` solves this by treating the field list itself as data — an array of `StockAttributeDefinition` fetched from the server — and mapping over it to produce the actual `<input>` elements:

```tsx
{definitions.map((def) => {
  const inputId = `${idPrefix}-${def.key}`;
  if (def.dataType === 'BOOLEAN') return <Checkbox .../>;
  if (def.dataType === 'SELECT') return <Select options={def.options ?? []} .../>;
  return <input type={def.dataType === 'DATE' ? 'date' : 'text'} .../>;
})}
```

This is the same "component driven by a runtime shape, not a hardcoded one" idea behind `hand-rolled-svg-charts.md`'s data-driven rendering, applied to form fields instead of chart bars. The component itself has exactly one job — turn a `data_type` into the right input element and wire its `value`/`onChange` — and needs to be written once, ever, regardless of how many custom fields any organization eventually defines.

### `key`, `id`, and why both matter here

Two different identifiers are doing two different jobs in this component, and confusing them is a real gotcha. React's list `key={def.key}` tells the reconciler which array element a given rendered node corresponds to across re-renders — it's invisible to the DOM and exists purely to let React match old and new elements correctly when the `definitions` array changes (see `react-foundations.md` on reconciliation). The `id={inputId}` attribute, `` `${idPrefix}-${def.key}` ``, is an entirely separate, DOM-visible identifier that exists so a `<label htmlFor>` can be associated with its `<input>` for accessibility, *and* — deliberately, in this codebase — so an automated test or a browser-driven smoke test can target a specific dynamic field without knowing its label text in advance (`#serial-A-1204-tower`, `#new-item-attr-project`). The `idPrefix` argument exists specifically because `AttributeFields` is reused on more than one page (a new-item form, a per-serial attribute editor during a receipt) — without a prefix, two `AttributeFields` instances rendered on the same page for two different serials would produce colliding `id="tower"` attributes, breaking every `<label htmlFor="tower">` association on the page.

### NUMBER stays a string end to end

`AttributeFields` never calls `Number(value)` on a `NUMBER`-typed field's input value — the raw string from the `<input type="text" inputMode="decimal">` element is stored and passed through unchanged, all the way to the server, which validates it as a well-formed decimal string and stores it as a JSON *string* inside the item's `attributes` JSONB (`postgresql/jsonb-user-defined-attributes.md` covers why the server side makes this same choice). This is a client/server contract, not just a server-side rule: if the client parsed the input to a `number` at any point before sending it, a value like a very long serial-style numeric code or a high-precision area measurement could silently lose precision the moment it round-tripped through a 64-bit float — exactly the class of bug this codebase's money-as-integer-cents rule exists to prevent for currency, applied here to any precision-sensitive user-defined value. `inputMode="decimal"` is purely a mobile-keyboard hint (it tells the on-screen keyboard to show a numeric layout) — it has no effect on the underlying value's type, which stays `string` from keystroke to database column.

### The debounced live preview: a second `useEffect`, deliberately decoupled from the submit path

`StockNewItemPage` shows a live example of what the item's code *will* look like as the user fills in category and attribute fields, without generating a real code (that only happens on actual submit, inside the counter-locked transaction). The relevant effect:

```tsx
useEffect(() => {
  if (codeMode !== 'generate' || categoryId === '' || codeSchemeId === '') {
    setPreview(null);
    return undefined;
  }
  const timer = setTimeout(() => {
    previewStockCodePattern({ pattern: scheme.pattern, categoryId, attributes })
      .then((res) => setPreview(res))
      .catch(() => undefined);
  }, 300);
  return () => clearTimeout(timer);
}, [codeMode, categoryId, codeSchemeId, attributes, codeSchemes]);
```

Three things worth naming precisely:

- **Debouncing via the effect's own cleanup function**, not a separate library. Every keystroke that changes `attributes` re-runs the effect; each run first tears down the *previous* run's pending `setTimeout` via the returned cleanup function (React calls it before running the effect again, or on unmount), so only the timer from the most recent keystroke ever actually fires. Typing five characters in a row schedules and cancels four timers and lets the fifth's 300ms wait complete — a real network request is only sent once input has paused, not once per keystroke.
- **The preview calls a dedicated, side-effect-free endpoint** (`previewStockCodePattern`, backed by `codeSchemeService.ts`'s `previewPattern`, which calls the same pure `parseCodePattern`/`renderCode` functions `discriminated-unions-and-parsers.md` documents) — it never touches the counter table, never allocates a real sequence value, and is safe to call an unbounded number of times with no side effect on the eventually-generated real code.
- **`.catch(() => undefined)`** deliberately swallows a preview failure rather than surfacing an error banner — a transient network hiccup on a preview that re-fires every keystroke shouldn't interrupt the user filling out a form; the *real* validation error, if any, surfaces properly when they actually submit.

### `@media print`, `@page`, and physical units for a label sheet

Everything on screen in this codebase is laid out in CSS pixels via Tailwind's utility classes. A label sheet is different in kind, not just styling — it's explicitly meant to be printed onto physical label stock at an exact physical size, so the sizing has to be expressed in physical units the browser's print engine understands directly:

```css
@page {
  margin: 8mm;
}
.label-sheet .label {
  break-inside: avoid;
}
.label-sm { width: 38mm; height: 25mm; }
.label-md { width: 50mm; height: 30mm; }
.label-lg { width: 100mm; height: 50mm; }
```

`@page` is a print-only at-rule (ignored entirely on screen) that controls the physical page box itself — here, an 8mm margin on every printed page, so labels near the sheet's edge don't get clipped by a printer's own unprintable margin. `mm` (millimeters) is used instead of `px`/`rem` specifically because the browser's print pipeline converts CSS physical units (`mm`, `cm`, `in`, `pt`) to the printer's actual dot grid using the OS's print-resolution setting, while a `px`/`rem` value would be interpreted as a *screen* pixel size and print at whatever arbitrary physical size the browser's default CSS-pixel-to-inch assumption (96 CSS px = 1 inch) happens to produce — which is not the label size a shelf-mounted physical adhesive label was bought to be.

`break-inside: avoid` is the print/pagination cousin of a concern that doesn't exist on an infinitely-scrolling screen: when a browser paginates content across multiple physical pages for printing, an element can otherwise be sliced in half exactly at a page boundary — a label whose QR code prints half on one sheet and half on the next is useless. `break-inside: avoid` (the modern name for the older `page-break-inside: avoid`) tells the print layout engine to push a label element to the start of the next page whole, rather than splitting it, if it wouldn't otherwise fit in the remaining space on the current page.

This whole stylesheet lives alongside, but conceptually separate from, this codebase's existing `.no-print`/`@media print` block for invoices — both exist under the same `@media print` conceptual umbrella but govern genuinely different things: `.no-print` hides screen-only chrome (buttons, nav) when printing an on-screen document; `@page`/`.label-*` define a physical, size-exact layout that only makes sense in print at all, with no screen equivalent to hide.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| A hardcoded form component per industry/category | Simple JSX, no runtime data shape to reason about | Rejected — the whole premise of per-org custom fields is that the field set isn't known until an org configures it; a hardcoded component can't represent that |
| Parse a `NUMBER` field's input to a JS `number` for a "nicer" state shape | Slightly more ergonomic in-component arithmetic if ever needed | Rejected — risks float-precision loss on the client exactly as it would on the server; string-in, string-out end to end avoids the question entirely |
| A generic debounce utility/hook shared across the codebase | Reusable, less inline `setTimeout` | Not built — the plain `useEffect` cleanup pattern is the idiomatic React primitive for this and needs no dependency; a shared hook would be a reasonable extraction once a third debounced-preview use case appears |
| Sizing label print CSS in `px`/`rem` | Consistent with every other stylesheet in the app | Rejected — a screen pixel unit does not correspond to a fixed physical size when printed; `mm` is what makes a "50mm × 30mm" label preset actually print at 50mm × 30mm |
| Inline QR SVG via `dangerouslySetInnerHTML` | Slightly simpler than a data-URI `<img>` | Rejected — see `barcodes-and-qr-codes.md`; an `<img src="data:...">` never lets the DOM parse the string as live markup |

## Where it lives in this codebase

- `client/src/Pages/stock/AttributeFields.tsx` — the schema-driven field renderer
- `client/src/Pages/stock/StockNewItemPage.tsx` — the debounced live code-pattern preview effect
- `client/src/Pages/stock/StockLabelsPage.tsx` — renders the generated labels, including the size-preset class switch
- `client/src/index.css` — `@page`, `.label-sheet .label { break-inside: avoid }`, `.label-sm/-md/-lg`
- `server/src/utils/stockAttributes.ts` — the server-side counterpart validating the same NUMBER-as-string contract
- `client/src/__tests__/stockNewItem.test.tsx` — includes the 422-message-shown-verbatim test that fills every required custom field precisely because native HTML5 `required` would otherwise block the fetch the test is trying to exercise
- `client/src/__tests__/stockLabels.test.tsx` — `'size preset switches the class'`, asserting the label-size class swap on selection

## Gotchas

- **Forgetting the `idPrefix` on a page rendering more than one `AttributeFields` instance** produces duplicate DOM ids — silently breaking `<label htmlFor>` associations (a screen reader announces the wrong label, or none) with no visible error, since browsers don't reject duplicate ids outright.
- **`key` and `id` look similar and are easy to conflate** — `key` is a React-internal reconciliation hint invisible to the DOM; `id` is a real DOM attribute other things (labels, tests, CSS) can target. Using the same value for both is fine as long as it's genuinely unique per rendered instance, but they solve unrelated problems and neither can substitute for the other.
- **A debounced effect's cleanup function must actually run for debouncing to work at all** — if the effect's dependency array is wrong (missing a value that should trigger a new debounce cycle, or including one that shouldn't), either stale data gets previewed or every keystroke fires a fresh request with no debouncing, silently defeating the whole point.
- **`px`/`rem` sizing anywhere inside a print-only block is a common mistake** that looks correct in a browser's print preview at default zoom (because most browsers default to treating 96 CSS px as 1 inch, matching the eventual physical inch) but drifts the moment print scaling, a different OS DPI setting, or "fit to page" is involved — `mm`/`in` sizing is immune to all of that because it's resolved against the physical page, not the screen's pixel density.
- **`break-inside: avoid` is a request, not a guarantee** — if a single element is taller than one physical page, the browser has no choice but to split it regardless of the property; it only prevents *unnecessary* splits when the element would otherwise fit whole.

## Interview Q&A

**Q: How do you render a form whose fields aren't known until runtime?**
A: Treat the field list as data instead of markup — fetch or receive an array describing each field (a key, a label, a data type, whether it's required, options for a select), and `map` over it to produce the actual input elements, switching on the data type to pick which kind of input to render. The component itself stays fixed and simple; all the variability lives in the array it's given, which is exactly the shape you want when the *set* of fields is a runtime, per-tenant decision rather than something the codebase can hardcode.

**Q: You have a React list `key` and a DOM `id` on the same rendered element. Aren't they redundant?**
A: No — they solve different problems for different consumers. `key` is invisible to the DOM; it's a hint React's reconciler uses internally to match array elements across renders so it can correctly preserve or discard component state and DOM nodes when the list changes. `id` is a real, visible DOM attribute other things can reference — a `<label htmlFor>`, a CSS selector, a test's element query. They can share the same underlying value for convenience, but removing one doesn't substitute for the other: dropping `key` breaks reconciliation (list items get replaced instead of updated, losing focus/state); dropping `id` breaks anything outside React that needs to address that specific element.

**Q: Why keep a numeric form field's value as a string in component state instead of converting it to a number for easier math?**
A: Because a JSON/JS `number` is a 64-bit float with no guaranteed precision for arbitrary decimal input, and converting early risks silently losing precision on a value that later needs to be exact — the same reasoning this codebase applies to money, just generalized to any precision-sensitive user-defined field. Keeping it a string from the input's `onChange` all the way to the request body means nothing in the client ever performs an unnecessary float round-trip; validation and any real arithmetic happen once, server-side, against the original string.

**Q: Walk me through how you'd debounce an API call tied to a text input in React, without a library.**
A: A `useEffect` whose dependency array includes the input's current value, which starts a `setTimeout` for the delay you want and calls the API when it fires. The key piece is the effect's cleanup function — returned from the effect, and called by React automatically before the effect re-runs (or on unmount) — which clears that same timer. Every keystroke re-runs the effect, which first cancels the previous keystroke's pending timer via cleanup, then schedules a new one; only the last keystroke in a burst ever gets far enough to have its timer actually fire, so you get a real network call once input pauses rather than one per keystroke, with zero external dependencies.

**Q: Why does a print stylesheet for physical labels use millimeters instead of the same CSS units the rest of the app uses?**
A: Because CSS pixels (and units derived from them, like `rem`) are a *screen* concept — a browser maps them to physical size using an assumed density (96 px per inch, by convention), not the printer's actual resolution. Physical units like `mm`, `cm`, `in`, and `pt` are resolved by the browser's print pipeline against the actual page and printer, so a label declared as 50mm wide prints at 50mm regardless of screen DPI or zoom level. If the stylesheet used `px` instead, the label would print at whatever size the browser's default pixel-to-inch assumption happens to produce, which is very unlikely to match the physical adhesive label stock it's meant to be printed onto.

**Q: What does `break-inside: avoid` actually do, and when would it fail to help?**
A: It tells the browser's print pagination engine not to split a given element across two physical pages if it can be avoided — if the element doesn't fit in the remaining space on the current page, push it whole onto the next page rather than slicing it at the page boundary. It's a request the layout engine honors when it can, not an absolute guarantee: an element taller than one entire physical page has to be split regardless, because there's no valid layout that keeps it whole on a single page.

## Follow-ups they'll dig into

- "What if two custom field definitions had the same `key` in different categories?" — fine by design; `key` uniqueness is scoped per-category server-side, and the client only ever renders the definitions for the one category currently selected, so a collision across categories never actually appears on the same page.
- "How would you test a debounced effect without waiting 300ms in every test run?" — fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTime()`), advancing virtual time instead of real time so the test runs instantly but still exercises the debounce logic itself.
- "What's the accessibility story for a dynamically-generated form field?" — the same as any form field: a `<label htmlFor>` paired to the input's `id`, `required` reflected as a real HTML attribute (not just a visual asterisk), and a `SELECT`-typed custom field using a real `<select>` rather than a styled `<div>` so screen readers and keyboard navigation get native behavior for free.

## See also

- [../architecture/barcodes-and-qr-codes.md](../architecture/barcodes-and-qr-codes.md) — the QR image rendering that shares this note's label-sheet print layout
- [../postgresql/jsonb-user-defined-attributes.md](../postgresql/jsonb-user-defined-attributes.md) — the server-side definitions table and validation this form renders and submits against
- [../typescript/discriminated-unions-and-parsers.md](../typescript/discriminated-unions-and-parsers.md) — the pure code-pattern renderer the live preview effect calls
- [hand-rolled-svg-charts.md](hand-rolled-svg-charts.md) — the other place in this codebase a component's shape is driven entirely by runtime data rather than hardcoded JSX
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — the money-as-integer-cents rule this note's NUMBER-as-string contract generalizes

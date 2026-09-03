# Utility-First CSS & Tailwind v4

> Utility classes trade readable markup for the elimination of an entire class of CSS problem — naming, dead rules, and specificity wars — and Tailwind v4 moves configuration out of JavaScript into CSS itself.

**Category:** React
**Introduced by:** Phase 3 — LedgerCore's first real UI: a chart-of-accounts tree, a multi-line journal entry form, a trial balance grid
**Verified against:** Tailwind CSS 4.3.3, `@tailwindcss/vite` 4.3.3, Vite 8, React 19

---

## Mechanism

### What the build actually does

Tailwind is a build step that **scans source files for class-name-shaped strings** and emits CSS only for the ones it finds. It does not parse your JSX or understand your code — it runs a regex-ish extractor over the raw text.

That has one consequence worth internalising: **a class name assembled at runtime does not exist at build time.**

```tsx
<div className={`text-${color}-500`} />        // ✗ nothing to find; no CSS emitted
<div className={color === 'red' ? 'text-red-500' : 'text-sky-500'} />  // ✓ both literals present
```

Every utility must appear as a complete literal somewhere in the scanned source. This is why the codebase's type badges use a lookup object of full class strings rather than interpolating the type name.

### v4's real change: configuration in CSS

Tailwind v3 was a PostCSS plugin configured by `tailwind.config.js`, with `@tailwind base/components/utilities` directives. v4 is different in three ways:

```css
@import "tailwindcss";     /* replaces the three @tailwind directives */

@theme {
  --color-brand: #3fb950;  /* generates bg-brand, text-brand, border-brand… */
}
```

1. **One `@import`**, not three directives.
2. **`@theme` in CSS replaces `tailwind.config.js`.** Design tokens are CSS custom properties, so they exist at runtime too — readable by JavaScript and overridable per media query, which the JS config could never do.
3. **A dedicated Vite plugin** (`@tailwindcss/vite`) rather than a PostCSS pass, with the engine rewritten in Rust. There is no `tailwind.config.js` in a v4 project, and creating one does nothing.

### Cascade layers, and why the old CSS survived

The interesting mechanical detail in this codebase. Everything Tailwind ships is wrapped in cascade layers:

```css
@layer theme, base, components, utilities;
```

CSS cascade layers have a rule that surprises people: **unlayered CSS beats layered CSS**, regardless of source order or specificity. Layered styles are considered *before* unlayered ones in the cascade, so any rule outside a layer wins.

That is exactly what made adopting Tailwind safe here. The client had 431 lines of hand-written CSS driving the auth pages and the app chooser. Preflight — Tailwind's reset — zeroes margins, unstyles headings and buttons, and would normally wreck them. But Preflight lives in `@layer base`, and the existing rules are unlayered, so they win automatically. The old pages kept their styling with no changes, and new pages are built utility-first.

Without layers, adopting Tailwind into an existing stylesheet is a specificity fight resolved with `!important`.

### The trade the utilities make

Utility-first is not "inline styles with extra steps" — inline styles cannot do hover, focus, media queries, or dark mode, and do not dedupe. What it actually trades:

**Gained:** no naming (the hardest part of CSS); no dead rules, because deleting a component deletes its styles; no specificity escalation, since every utility has identical specificity; styles are colocated with markup, so changing one component cannot break another; the output is bounded by the number of *distinct* utilities used, not by codebase size.

**Lost:** markup is noisy. A styled table row can carry a dozen classes, and reading the JSX is harder than reading a class name that says what the thing *is*. The repeated-markup problem is real too — the answer is extracting a React component, not a CSS class, which is the same abstraction boundary you already had.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Extend the existing hand-written `index.css` | Zero dependencies, consistent with Phases 0–2 | Rejected — a data-dense enterprise UI is where 431 lines becomes 2,000 and the naming problem dominates |
| **Tailwind v4 + `lucide-react`** | Noisy markup; two dependencies | **Chosen** |
| CSS Modules | Scoped, no new vocabulary | Rejected — solves collisions, not naming or dead rules |
| CSS-in-JS (styled-components, Emotion) | Dynamic styles, colocation | Rejected — runtime cost and a React 19 / RSC story that is still unsettled |
| A component library (MUI, Chakra) | Fastest to a polished UI | Rejected — the point of this project is demonstrating the engineering, and a component library makes the UI someone else's work |

`lucide-react` came along because the alternative is inline SVG in the JSX, and it tree-shakes per icon.

---

## Where it lives in this codebase

- `client/vite.config.ts` — `tailwindcss()` in the plugins array; **there is no `tailwind.config.js`**
- `client/src/index.css` — `@import "tailwindcss";` as the first line, followed by the pre-existing unlayered rules that still drive the older pages
- `client/src/Pages/ledger-core/` — `AccountsPage`, `JournalEntryPage`, `TrialBalancePage`, all utility-first
- Colours are referenced as `bg-[var(--panel)]` and `text-[var(--muted)]` — arbitrary-value syntax reaching the *existing* custom properties, so the new pages inherit the established dark/light palette rather than introducing a second one

---

## Gotchas

- **Dynamically constructed class names produce no CSS.** `` `text-${color}-500` `` emits nothing. Use complete literals in a lookup map.
- **There is no `tailwind.config.js` in v4.** Creating one is silently ignored; configure with `@theme` in CSS.
- **Unlayered CSS beats layered CSS.** Load-bearing here — it is why Preflight did not break the old pages. It also means a stray unlayered rule will silently override a utility.
- **Preflight is opinionated.** It removes default heading sizes, list markers and button styling. Expect unstyled-looking output until utilities are applied.
- **`@apply` is a trap in bulk.** It recreates the naming and dead-rule problems the utilities removed. Extract a component instead.
- **Arbitrary values need no spaces**: `bg-[var(--panel)]`, not `bg-[var( --panel )]`.
- **Class order does not matter** — output order is determined by Tailwind, not by the order in the attribute. `p-2 p-4` is not "last wins"; use a conditional.

---

## Interview Q&A

**Q: How does Tailwind actually generate CSS?**
A: It's a build step that scans source files for strings that look like class names and emits CSS only for the ones it finds — so the output is bounded by the number of distinct utilities you actually use, not by the size of the codebase. It doesn't parse the JSX or understand the code; it's essentially a text extractor. The important consequence is that a class name assembled at runtime doesn't exist at build time, so `` `text-${color}-500` `` produces no CSS at all. Every utility has to appear as a complete literal somewhere in the scanned source, which is why conditional styling uses a lookup of full class strings.

**Q: What changed in v4?**
A: Three things. Configuration moved from `tailwind.config.js` into CSS via `@theme`, so design tokens are real CSS custom properties — which means they exist at runtime, readable from JavaScript and overridable per media query, which the JS config could never do. The three `@tailwind` directives collapsed to one `@import "tailwindcss"`. And it ships a dedicated Vite plugin with the engine rewritten in Rust instead of running as a PostCSS pass. In practice: no config file, one import line, one plugin.

**Q: You adopted Tailwind into a codebase with 431 lines of existing CSS. How did you avoid breaking it?**
A: Cascade layers did it for me, though I checked before relying on it. Everything Tailwind ships is inside `@layer theme, base, components, utilities`, and CSS has a rule that unlayered styles beat layered ones regardless of source order or specificity. The existing stylesheet is unlayered, so it automatically wins over Preflight's resets — the old auth and chooser pages kept their styling with no changes at all. That let me adopt it additively: new LedgerCore pages are utility-first, old pages untouched, no big-bang restyle and no `!important`. I also referenced the existing CSS custom properties from the utilities with arbitrary-value syntax, so the new pages inherit the established palette instead of introducing a second one.

**Q: What's the honest downside?**
A: The markup gets noisy — a styled table row can carry a dozen classes, and reading it is genuinely harder than reading a semantic class name that says what the thing is. I don't think the usual rebuttal ("it's colocated, you get used to it") fully answers that; it's a real cost you're paying for something else. What you're buying is that naming disappears, dead CSS disappears because deleting a component deletes its styles, and specificity wars disappear because every utility has the same specificity. On a project where I'm the only person writing CSS and the UI is data-dense, that trade is worth it. On a team with a dedicated designer working in CSS, I'd think harder.

---

## Follow-ups they'll dig into

- *"How do you handle repeated markup?"* Extract a React component, not an `@apply` class. `@apply` recreates the naming and dead-rule problems in a new syntax.
- *"How does dark mode work?"* This codebase does it with CSS custom properties redefined under `prefers-color-scheme`, which the utilities reach through arbitrary values — so one palette definition serves both.
- *"What about unused CSS in production?"* There is none by construction: only scanned utilities are emitted. The Phase 3 build's CSS is ~20 kB, ~5 kB gzipped.
- *"Would you use it on a design-system team?"* Probably as the implementation layer beneath named components, so consumers get `<Button variant="primary">` and the utilities stay internal.

---

## See also

- [react-foundations.md](react-foundations.md)
- [typescript-build-and-dev-tooling.md](../tooling/typescript-build-and-dev-tooling.md) — where the Vite plugin runs
- [routing-nested-and-dynamic-segments.md](routing-nested-and-dynamic-segments.md) — the routes these pages mount under

# Fluid Motion Without an Animation Library

> Every animation in the app uses CSS or a browser API. Knowing which tool fits which job removes most of the reason to add a library.

**Category:** React
**Introduced by:** the Warm Current redesign (2026-11-06) — a request for a fluid, animated interface across about 320 component files
**Verified against:** React 19, Chrome 153 (measured in the running app). Browser support and table-containment remarks below are from memory, not checked here, so confirm them before quoting them.

---

## Mechanism

### What the browser does when something animates

Rendering runs style, layout, paint, composite. Changing `transform` or `opacity` can usually skip to composite, so the compositor thread can run it even while the main thread is busy. Changing `width`, `height` or `grid-template-rows` forces layout on every frame, on the main thread.

That does not mean layout animation is forbidden. It means its cost scales with what it reflows. A sidebar panel or a bar in a small card is cheap; a large table would not be. We use `transform` and `opacity` for anything big or frequent, and accept layout animation for small, short-lived things.

### Animating to `height: auto`

`height` cannot interpolate to `auto`, because `auto` is not a length. The old workaround was animating `max-height` to a guessed large number, which makes the easing wrong. Grid tracks can interpolate between `fr` values:

```css
.nav-group__panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 500ms var(--ease); }
.nav-group--open .nav-group__panel { grid-template-rows: 1fr; }
.nav-group__inner { min-height: 0; overflow: hidden; }
```

The track grows from nothing to the content's natural height, with no measuring. `min-height: 0` is what lets the child shrink below its content. A closed panel's links stay in the DOM, so they must be removed from keyboard and screen-reader reach. `visibility: hidden` handles that in the browser, and `inert` plus `aria-hidden` state it in the markup.

### A route entrance with the Web Animations API

The obvious way to replay a CSS animation is to change a `key`, which remounts the subtree. On a route container that throws away page state and refetches data just to animate. `element.animate()` runs the same animation imperatively:

```ts
useLayoutEffect(() => {
  if (!prefersMotion()) return;
  pageRef.current?.animate(
    [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
    { duration: 450, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}, [pathname]);
```

With no `fill`, the animation leaves nothing behind on the element. `useLayoutEffect` matters: it runs before paint, while `useEffect` could let one frame of the new page show at full opacity first.

### View transitions, and why `flushSync`

`document.startViewTransition(callback)` captures the current page, runs the callback, captures the new state, then animates between them. An element with its own `view-transition-name` is tracked separately, so a bank line that moves, appears or disappears animates on its own.

The browser takes the "after" capture when the callback finishes. React batches state updates, so without intervention the DOM has not changed yet. `flushSync` forces React to commit inside the callback:

```ts
document.startViewTransition(() => { flushSync(update); });
```

Each name must be unique on the page at capture time, which is why the row name includes the transaction id.

### The sliding pill

Tabs have different widths, so the pill's position must be measured. Two observers keep that measurement honest. `MutationObserver` watches `aria-current` and `aria-selected`: with route tabs, `NavLink` sets `aria-current` and the parent may not re-render, so watching the DOM is more reliable than a prop. `ResizeObserver` catches the web font arriving, which changes every width after the first measurement. The pill then moves by `transform`, with a CSS transition doing the animation.

### A seamless wave

The wave's SVG path repeats every 720 of its 1440 units, and the SVG is twice its container's width. Translating by exactly `-50%` therefore lands on an identical frame, so a linear infinite animation has no visible seam. Two layers at different speeds, one reversed, stop it looking mechanical.

### A count-up that cannot lie

This is money, so the animation must never change the value. Intermediate frames are `Math.round`ed decoration. The last frame assigns the exact integer `cents` prop rather than a computed value, so floating-point easing can never reach the final figure.

### Reduced motion needs two checks

A global CSS rule under `@media (prefers-reduced-motion: reduce)` stops CSS animations and transitions. It cannot touch a `requestAnimationFrame` loop or a call to `element.animate()`, so `prefersMotion()` guards those. The same check has a useful side effect: jsdom has no `matchMedia`, so `prefersMotion()` is false in tests and `CountUp` renders its final text at once. Existing tests asserting exact amounts kept passing without fake timers.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| CSS and browser APIs | No bundle cost, no dependency, native reduced-motion handling. No spring physics or interruptible gesture animation | **Chosen** |
| Framer Motion (`motion`) | Excellent exit animations and layout animation, but adds bundle weight and needs wrapper components across hundreds of files. Rule 14 asks for a real need first | Rejected |
| `key` remount for page entrance | One line, but discards state and refetches | Rejected |
| `max-height` trick for accordions | Works everywhere, but the guessed height distorts the easing | Rejected |

## Where it lives in this codebase

- `client/src/utils/motion.ts` — `prefersMotion` and `fluidUpdate`
- `client/src/routes/WorkspaceLayout.tsx` — the route entrance
- `client/src/components/layout/AppSidebar.tsx` and `index.css` (`.nav-group__*`) — the accordion
- `client/src/components/ui/SlidingTabs.tsx` — `useSlidingThumb`, also used by `TabBar` and the bank lines page
- `client/src/components/ui/CountUp.tsx`, `FluidBackdrop.tsx` — the hero
- `client/src/Pages/banking/BankTransactionsPage.tsx` — the view transition

## Gotchas

- **Writing a ref during render** breaks React's rules, and oxlint caught it in `CountUp`. The "where to count from" ref is written only inside the animation frame.
- **Row animation with `both` fill** starts at `opacity: 0`, so print must disable animation or a row could print invisible. `@media print` sets `animation: none !important`.
- **A closed accordion's links stay mounted.** Without `inert`, keyboard users could tab into invisible links. Tests had to change too: links in closed groups are no longer reachable by role until the group opens, as for a person.
- **White text over a moving shape.** The coral blob passed behind the hero text on a phone, where white on coral is hard to read. Decoration moves, so contrast has to hold wherever it can reach; narrow screens push the shapes into the corner.
- **Automated mid-flight checks need care.** A sample shortly after a click can read the start position, because React has not committed and the transition has not begun. Here the pill had not moved at 73ms and had by 155ms. Sample per frame before concluding an animation is broken.

## Interview Q&A

**Q: How do you animate an element to `height: auto`?**
A: `auto` is not a length, so `height` cannot interpolate to it. We put the content in a one-row grid and transition `grid-template-rows` from `0fr` to `1fr`, with `min-height: 0` and `overflow: hidden` on the child. The track animates to the natural height with no measuring, and no guessed `max-height` distorting the easing. Because the content stays mounted, I also make it `inert` when closed so keyboards can't reach it.

**Q: Why does `flushSync` appear in your view transition code?**
A: The browser captures the "after" state once the callback passed to `startViewTransition` finishes. React batches state updates and commits later, so without `flushSync` the DOM would still be in the old state at capture, and there would be nothing to animate. It is one of the few legitimate uses, because it should normally be avoided for performance reasons.

**Q: How would you animate a page in on each navigation without remounting it?**
A: Call `element.animate()` from a `useLayoutEffect` keyed on the pathname. A `key` on the container replays a CSS animation too, but it remounts the subtree, losing state and refetching data. The Web Animations API leaves no residue on the element when there is no fill, and the layout effect starts it before the browser paints.

**Q: Which properties are safe to animate, and is animating layout always wrong?**
A: `transform` and `opacity` can usually run on the compositor without layout or paint, so they stay smooth even with a busy main thread. Animating `width` or grid tracks forces layout each frame. It is not always wrong: the cost depends on how much reflows, so a sidebar panel is fine, and a large table's rows would not be. I decide by what reflows and measure if unsure.

**Q: What does respecting reduced motion involve beyond a media query?**
A: The CSS rule only covers CSS animations and transitions. JavaScript-driven motion, like a `requestAnimationFrame` count-up or `element.animate()`, ignores it, so those need a `matchMedia` check. Reduced motion should also still show the final state immediately, not hide content that was meant to animate in.

**Q: When would you reach for Framer Motion after all?**
A: Interruptible gestures, drag, spring physics, or exit animations across many components that unmount. React removes an element immediately, so exit animation needs either a library's presence tracking or something like view transitions. We had one list where exit mattered, so a view transition was enough. If exits were everywhere, the library would earn its weight.

**Q: Tell me about a time a redesign surfaced real bugs.**
A: Restyling AutoLedger, the dashboard's definition lists were laying out sideways and tiles ignored `grid-cols-*`. Both came from unlayered CSS rules, `dl` and `.grid`, which always beat Tailwind's layered utilities. Moving them into cascade layers fixed many pages at once. The same pass found colour variables that were used but never defined, so those badges had been rendering with no colour at all.

## Follow-ups they'll dig into

- What happens if a second navigation interrupts an entrance? A second `animate()` starts on the same element and overrides the first while both run. Both are short, but rapid clicking was not tested systematically.
- Browser support for view transitions: `fluidUpdate` feature-detects and falls back to a plain update, so an unsupported browser loses only the animation. Confirm current versions before quoting them.
- Could table rows use `view-transition-name`? I recall table internals having containment restrictions, which is one reason this was only applied to the bank lines, which are `div`s. I did not test it on a `tr`.

## See also

- [utility-first-css-tailwind.md](utility-first-css-tailwind.md) — cascade layers, and the theme remapping from the same redesign
- [charts-with-recharts.md](charts-with-recharts.md) — theming SVG with CSS variables
- [accessible-dialogs-and-focus.md](accessible-dialogs-and-focus.md) — the other half of keeping keyboard users in mind

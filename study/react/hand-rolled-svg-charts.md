# Hand-Rolled SVG Charts

> A bar chart is a handful of `<rect>` elements scaled into a `viewBox` — no charting library needed until the chart itself, not the data behind it, becomes the hard part.

**Category:** React
**Introduced by:** Phase 3.5 — `TrendChart` (revenue/expense trend); extended Phase 3.9 — `BarChart` (AR/AP aging)
**Verified against:** React 19.2

---

## Mechanism

### The SVG coordinate system, and `viewBox`

An `<svg>` element has two independent coordinate systems: its rendered pixel size (set by CSS — `className="w-full h-28"`) and its internal drawing coordinates, set by `viewBox="minX minY width height"`. Every child element (`<rect x=... y=...>`) is positioned in the *internal* system, and the browser scales that whole system to fit the rendered size. This is what lets `BarChart` draw in a fixed, easy-to-reason-about space — `VIEW_WIDTH = 320`, `VIEW_HEIGHT = 120` — regardless of how large the container actually renders; the scaling is free, handled once, at the SVG boundary, rather than recomputed per element.

SVG's Y axis points **down** — `y=0` is the top. Bar charts grow upward from a baseline, so every bar's height computation has to subtract from the baseline rather than add to it:

```ts
const height = (datum.amountCents / maxCents) * CHART_HEIGHT;
// y = CHART_BOTTOM - height, not y = CHART_TOP + height
```

Getting this backwards draws bars hanging from the top of the chart, growing downward — a common first mistake with SVG charts coming from a mental model of Cartesian axes.

### Scaling without a library

The entire "chart library" a bar chart needs is one linear scale: value → pixel height.

```ts
const maxCents = Math.max(1, ...data.map((d) => d.amountCents));
const height = (datum.amountCents / maxCents) * CHART_HEIGHT;
```

`Math.max(1, ...)` guards the degenerate all-zero case — without the floor of `1`, an all-zero dataset divides by zero and every bar becomes `NaN` height, which SVG silently renders as nothing (not an error), the kind of bug that's invisible until someone notices an empty chart on a fresh organization with no data. A real charting library (`d3-scale`, `recharts`) generalizes this into `scaleLinear().domain([0, max]).range([0, height])`, clamping and handling negative domains — genuinely more capable, and unnecessary for a chart whose values are never negative (an outstanding balance) and whose only edge case is "all zero."

### The zero-value bar

A bucket with no outstanding invoices still gets a bar — at zero height, but present, with its label:

```ts
{data.map((datum, index) => { ... height = 0 for a zero amount ... })}
```

This mirrors the same "gap-filled, never a gap" rule the server enforces for aging buckets (`agingService.loadBuckets`, via a `VALUES`-list `LEFT JOIN`) and for the trend chart's months (`dashboardService.loadTrend`, via `generate_series`): the shape of the report should not depend on which slices of it happen to have data. A chart that silently drops empty categories misleads by omission — five buckets becoming three because two happened to be empty reads as "there are only three buckets," which is false.

### The accessible baseline: `role="img"`, `<title>`, and a shadow table

An `<svg>` is, to assistive technology, an opaque image unless told otherwise. Three things establish the accessible floor:

1. **`role="img"`** on the `<svg>` tells a screen reader to treat the whole element as a single described image, rather than trying to read its internal `<rect>`/`<text>` DOM structure node by node (which would announce as meaningless, disconnected shapes).
2. **`<title>`** as the SVG's first child provides the accessible name for that image role — analogous to `alt` text on an `<img>`. `TrendChart`'s `<svg>` additionally sets `aria-hidden="true"` because it also has hover-driven interactivity that isn't essential (a below-chart readout duplicates the hovered value); `BarChart` has no such interaction, so it keeps `role="img"` active rather than hiding it.
3. **A `visually-hidden` `<table>`** repeats every value the chart shows, in prose-readable form (bucket name, amount) — this is the actual data delivery mechanism for a screen-reader user, not a decorative afterthought. `visually-hidden` (a CSS class clipping the element to a 1px box while keeping it in the accessibility tree) is the standard technique for "present to assistive tech, absent visually" — distinct from `display: none` or `aria-hidden`, both of which would remove it from *both*.

The three together mean a sighted user gets the visual shape, a screen-reader user gets the same numbers as a table, and neither experience depends on the other rendering correctly.

### Interaction without a focusable target

`TrendChart` adds a hover-driven readout: a transparent `<rect data-hit>` per month, sized to the full chart height, capturing `onMouseEnter`/`onMouseLeave` to drive a state-based caption below the SVG. This is deliberately **hover-only, not keyboard-focusable** — the `<rect>` has no `tabIndex`, no `role="button"`, nothing that would insert it into tab order. That's not an oversight: the information the hover reveals (this month's exact revenue/expense/net) is already fully present in the `visually-hidden` table, so a keyboard or screen-reader user loses nothing by the hover interaction being mouse-only chrome layered on top of data that's accessible another way. Making every hoverable element also focusable is the wrong instinct when the same information already has an accessible path — it just adds tab stops that announce redundant content.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| A charting library (`recharts`, `chart.js`, `d3`) | Handles scales, axes, legends, animation, tooltips for free | Rejected — guardrails rule 14 (no dependency before the phase that needs it); a five-bar aging chart and a twelve-bar trend chart need none of what a library adds |
| Canvas-based drawing | More control over pixel-level rendering, can be faster for very large datasets | Rejected — no accessibility tree at all without a fully separate accessible fallback; SVG *is* DOM, so it composes with ARIA and CSS for free |
| **Hand-rolled inline SVG** | Have to compute your own scale, own accessible fallback, own hover state | **Chosen** — a handful of `<rect>`s, `viewBox` does the scaling, a shadow table does the accessibility, and the whole thing is under 100 lines |

`BarChart` is a **second**, separate component from `TrendChart`, not a generalization of it — they draw genuinely different shapes (grouped-pair bars over time vs. single bars over a fixed category axis) and `TrendChart`'s hover state has no equivalent need in the aging panels. Forcing one component to cover both would mean prop-flag branching for "is this the trend chart or the aging chart," which is the same kind of premature abstraction this codebase's own conventions warn against.

---

## Where it lives in this codebase

- `client/src/Pages/ledger-core/TrendChart.tsx` — the original: grouped bars, hover state, `aria-hidden` SVG + visible caption + shadow table
- `client/src/Pages/ledger-core/BarChart.tsx` — the AR/AP aging chart: single bars, `role="img"` (no hover), same shadow-table pattern
- `client/src/Pages/ledger-core/DashboardPage.tsx` — consumes both, side by side
- `client/src/__tests__/ledgerCoreDashboard.test.tsx` — `'renders exactly 6 bar groups for a 6-point trend'` counts `svg rect[data-bar]`/`[data-hit]` directly, proving the chart renders the right shape without a snapshot test

---

## Gotchas

- **Divide-by-zero on an all-zero dataset.** `Math.max(1, ...values)` is the whole fix; forgetting the floor produces `NaN` heights that silently vanish rather than erroring loudly.
- **SVG's Y axis points down.** Every bar-height calculation needs `y = baseline - height`, not `y = top + height`. Get it backwards and bars grow the wrong direction, which is easy to miss visually if the values happen to be small.
- **`aria-hidden="true"` and `role="img"` are not both needed on the same element.** `role="img"` says "this is a described image, read the description"; `aria-hidden="true"` says "skip this entirely." `TrendChart` uses `aria-hidden` because its shadow table is the real accessible content and the SVG's hover behavior is presentation-only; `BarChart` has no hover crutch to hide behind, so it stays `role="img"` and described via `<title>`.
- **A `visually-hidden` class must actually keep the element in the accessibility tree.** `display: none` and `visibility: hidden` remove an element from both the visual render *and* the accessibility tree — the opposite of what a shadow table needs. The correct technique clips to `1px × 1px`, uses `overflow: hidden`, and avoids `display`/`visibility` entirely.
- **Hover-only interaction is only accessible-safe if the same data is reachable another way.** If `TrendChart`'s hover readout were the *only* place a given month's numbers appeared, hiding it from keyboard/screen-reader users would be a real accessibility bug, not a reasonable simplification.

---

## Interview Q&A

**Q: Why didn't you just use a charting library?**
A: Two bar charts and a grouped-bar trend chart don't need what a charting library actually earns its dependency weight on — animated transitions, zoom/pan, dozens of chart types, a themeable legend system. What they need is "scale a number to a pixel height and draw a rectangle," which is a few lines of arithmetic. The project's own rule is no dependency before the phase that actually needs its capability, and nothing here has reached that bar yet.

**Q: How do you scale values to pixel heights without a library?**
A: A linear scale is just a ratio: `height = (value / maxValue) * chartHeight`. The one thing you have to guard is the all-zero case — if every value is zero, `maxValue` is zero and you divide by zero, which in JavaScript gives `NaN`, and SVG silently draws nothing for a `NaN` height rather than erroring. I floor `maxValue` at `1` to avoid that.

**Q: SVG isn't naturally accessible — how did you handle that?**
A: Three layers. `role="img"` tells assistive tech to treat the SVG as one described image rather than trying to parse its internal shapes. A `<title>` element gives that image its accessible name, the SVG equivalent of `alt` text. And underneath, a `visually-hidden` table repeats every data point the chart shows, in plain rows — that's the actual mechanism a screen-reader user gets the numbers through, not the SVG itself.

**Q: Your trend chart has a hover interaction — is that keyboard accessible?**
A: No, and deliberately so — it's mouse-only. The hover reveals a caption with that month's exact figures, but those same figures are already in the shadow table underneath, so a keyboard or screen-reader user isn't missing information, just a convenience layered on top of data they already have another path to. If the hover were the *only* place those numbers appeared, that would be a real accessibility gap I'd need to fix — probably by making the hit-areas focusable buttons.

**Q: What's the actual failure mode of getting the Y axis backwards?**
A: Since SVG's origin is top-left with Y increasing downward, if you compute `y = top + height` instead of `y = bottom - height`, your bars start at the top of the chart and grow *downward* into the middle — visually looking like they're hanging from the ceiling instead of rising from a baseline. It's easy to not notice with small values because the bars stay short either way; it becomes obvious once you have a value close to the chart's max.

**Q: When would this hand-rolled approach stop being the right call?**
A: The moment a chart needs real interactivity — zooming, panning, tooltips that track the cursor precisely, or animated transitions between data updates — or the moment there are enough distinct chart types in the app that the accumulated hand-rolled code outweighs a library's bundle cost. Neither is true yet; three simple, static bar/line charts is comfortably inside "write it by hand" territory.

---

## Follow-ups they'll dig into

- *"How would you add a tooltip that follows the cursor exactly, not per-bar hover?"* You'd need pointer coordinates translated from screen space into the SVG's `viewBox` space — `getScreenCTM().inverse()` — which is where hand-rolled SVG starts costing real code, and is a reasonable point to reconsider a library.
- *"What about very large datasets — hundreds of bars?"* SVG keeps one DOM node per shape, so hundreds of `<rect>`s is hundreds of DOM nodes; past a few thousand, Canvas (one bitmap, no per-shape DOM cost) usually wins on render performance, at the cost of rebuilding accessibility and hit-testing from scratch.
- *"Could you animate the bars on data change?"* CSS transitions on `height`/`y` work for simple cases; SVG's `<animate>` element or a spring-based library (`framer-motion`) handles more complex sequencing — neither is currently wired up.
- *"How would you test this without a snapshot?"* Query the rendered DOM for the actual shape you expect — `container.querySelectorAll('svg rect[data-bar]')` and assert a count — which is what this codebase does, rather than snapshotting pixel output or SVG markup wholesale, which breaks on every incidental styling change.

---

## See also

- [aggregating-a-ledger.md](../postgresql/aggregating-a-ledger.md) — the server-side "gap-filled, never a gap" rule this chart's zero-value bars mirror
- [accessible-dialogs-and-focus.md](accessible-dialogs-and-focus.md) — the sibling accessibility pattern for `ConfirmDialog`/`PaymentDialog`, focus management rather than a shadow-table fallback

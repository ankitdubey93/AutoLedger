# Charts with Recharts (a React chart library)

> Recharts describes a chart as nested React elements; the library measures the container, scales the data and emits SVG. We adopted it in Phase 47 for the business snapshot while leaving the four hand-rolled SVG charts alone.

**Category:** React
**Introduced by:** Phase 47 — Business snapshot page (`PositionChart`, `ProfitabilityChart`, `AgingStackChart`, `RatioTrendChart`)
**Verified against:** `recharts@3.10.1` (exact pin) with `react@19.2.8` and `react-is@19.2.8`; source read in `node_modules/recharts/es6`. Not verified: rendering of `var(--token)` in SVG attributes inside the in-app browser (the user's manual check covers it), and the bundle-size delta (not measured).

---

## Mechanism

### Declarative composition: children as configuration

```tsx
<LineChart data={points}>
  <XAxis dataKey="month" />
  <YAxis yAxisId="times" />
  <Line yAxisId="times" dataKey="currentRatioBp" />
  <Tooltip /><Legend />
</LineChart>
```

In Recharts 3 the chart does not walk `props.children` and read their props (the 1.x/2.x approach). Each graphical child (`Line`, `Bar`, axes, ...) is a normal component that, in an effect, **dispatches its props into an internal Redux store** (`state/SetGraphicalItem.js` calls `addCartesianGraphicalItem` on mount, `replaceCartesianGraphicalItem` on prop change and `removeCartesianGraphicalItem` on cleanup). Selectors (`reselect`) then derive scales, ticks and layout from that store plus the chart's `data`, and the items render their paths from the derived state. Practical consequences: children can be wrapped in your own components, and a chart renders once empty and again after children register. (Recharts depends on `@reduxjs/toolkit`, `react-redux`, `reselect` and `immer`, visible in its `package.json`.)

### ResponsiveContainer and ResizeObserver

`ResponsiveContainer` renders a div; in one effect it creates a `ResizeObserver`, reads the initial size with `getBoundingClientRect()`, and then observes the div (`component/ResponsiveContainer.js`). It stores the size rounded with `Math.round` and passes it to the chart. If `ResizeObserver` is undefined, the effect returns early (`typeof ResizeObserver === 'undefined'`), so the size stays at `initialDimension`. The parent must have a real size: a percentage height on a parent with no height gives 0 and Recharts logs a "width/height should be greater than 0" warning. We wrap each chart in a div with an explicit pixel height (260).

### Why jsdom renders zero-size charts

jsdom does no layout: `getBoundingClientRect()` returns zeros and it has no `ResizeObserver`. Our `client/src/__tests__/setup.ts` installs an inert `ResizeObserver` stub, so charts render at zero size and draw no marks. In 3.10.1 the stub is defensive rather than required: every `ResizeObserver` use in Recharts (`ResponsiveContainer`, `RechartsWrapper`, `useElementOffset`) checks `typeof ResizeObserver !== 'undefined'` first, so it would not throw without one. The stub keeps the tests on the same code path a browser takes and protects against a future version that drops the guard. Tests therefore assert against the **visually-hidden data table** each chart renders beside its SVG, which is also the accessibility fallback.

### Theming through CSS custom properties

Series colours are passed as `stroke="var(--accent)"`. The tokens (`--accent --good --bad --warn --muted --border`) change with the light/dark theme, so the SVG re-colours with no JavaScript. This relies on the browser resolving `var()` inside SVG presentation attributes, which current Chrome, Firefox and Safari do; it is a CSS feature applied to the attribute-derived style, not something Recharts does. Flag: not verified in the in-app browser.

### Accessible fallback

Each chart is a `<figure>`; the SVG area is `aria-hidden`, and a `visually-hidden` `<table>` with a caption carries the same numbers for screen readers and tests (the pattern from the hand-rolled charts).

### Two axes, two units

`RatioTrendChart` initially put debt ratio (a percentage) on the same axis as current ratio and debt to equity (multiples), so 43.33% displayed as "0.43x". The fix is a second `YAxis` with `orientation="right"` and its own `yAxisId`, with each `Line` bound to the right axis by `yAxisId`. Mixed units never share an axis.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Keep hand-rolling SVG ([hand-rolled-svg-charts.md](hand-rolled-svg-charts.md)) | Fine for one bar series; the snapshot needs dual axes, lines, stacks, legends, tooltips | Fine for the existing four, not extended |
| Recharts | Declarative, React-native, SVG (inspectable, CSS-themable); larger bundle | **Chosen** |
| Canvas (Chart.js, ECharts) | Wins at thousands of points; harder to theme and make accessible | Rejected: 12 points per series |
| D3 directly | Maximum control, most code | Rejected |
| Migrating the old charts | Churn with no user value | Rejected by decision |

Rule 14 allows a dependency in the phase that needs it: only `recharts` and the `react-is` peer were added.

## Where it lives in this codebase

- `client/src/components/charts/` — `PositionChart`, `ProfitabilityChart`, `AgingStackChart`, `RatioTrendChart`
- `client/src/Pages/reports/BusinessSnapshotPage.tsx` — the page
- `client/src/__tests__/setup.ts` — the `ResizeObserver` stub
- `client/src/__tests__/businessSnapshot.test.tsx`

## Gotchas

- A zero-height parent silently yields an empty chart.
- `react-is` must match React's version; Recharts lists it as a peer.
- `sideEffects: false` in Recharts' `package.json` lets the bundler tree-shake unused chart types, but the store and shared machinery are still included. Bundle impact was not measured here.
- SVG tooltips and animation are not asserted in jsdom; assert the data table.
- Colour-only distinction fails accessibility; the table and legend back it up.

## Interview Q&A

**Q: How does Recharts compose a chart from child elements?**
A: Each child component registers its props into an internal Redux store from an effect; selectors derive scales and layout; the series then render paths from that state. The chart does not parse its `children` props directly (verified in v3.10.1 source).

**Q: Why does a chart render blank in jsdom?**
A: jsdom has no layout, so the container measures 0x0 and there is no `ResizeObserver`. We stub the observer and assert against a hidden table with the same data.

**Q: How do you theme SVG charts for dark mode?**
A: Use CSS custom properties in the colour attributes (`stroke="var(--accent)"`); the theme swaps the tokens. It depends on the browser resolving `var()` in presentation attributes.

**Q: When is a library better than hand-rolled SVG, and when is canvas better?**
A: When you need axes, legends, tooltips, multiple series or dual axes, a library saves a lot of scaling code. Canvas wins with thousands of points because SVG creates a DOM node per mark.

**Q: What was the bug in the ratio trend chart?**
A: A percentage series shared an axis with multiples, so 43.33% was labelled "0.43x". The fix is a second right-hand axis for the percentage.

**Q: What is the cost of adding a chart library?**
A: Bundle size (it brings Redux Toolkit, react-redux, reselect, immer, and d3 modules through `victory-vendor`), one more upgrade surface, and a peer dependency. Not measured here; I would check with a bundle analyser before claiming a number.

## Follow-ups they'll dig into

- "How do you test charts?" Assert on the accessible table, not the SVG.
- "How would you handle 100k points?" Downsample server-side or switch to canvas.
- "Does `ResponsiveContainer` cause re-render storms?" It updates state only when the rounded size changes (the setter returns the previous state object otherwise, so React bails out). Its `debounce` prop is, despite the name, a **trailing throttle** (`throttle(callback, debounce, { leading: false, trailing: true })`).

## See also

- [hand-rolled-svg-charts.md](hand-rolled-svg-charts.md)
- [financial-ratios-in-integer-basis-points.md](../architecture/financial-ratios-in-integer-basis-points.md)

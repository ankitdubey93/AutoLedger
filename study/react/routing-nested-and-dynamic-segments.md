# Nested Routes, Layout Routes, and Dynamic Segments

> A React Router route tree isn't a flat list of paths matched to pages — it's a tree of components matched to *path segments*, and every ancestor whose path matches stays mounted and renders its own `<Outlet/>`, which is what makes shared chrome (a header, a sidebar) survive navigation to a child route without remounting.

**Category:** React
**Introduced by:** Phase 2 — the two-level chrome, `PlatformLayout` → `AppShell` → an app's own pages, plus the `/app/:appSlug` dynamic segment
**Verified against:** react-router-dom 7.18.3, React 19.2.8

---

## Mechanism

### Routes are a tree, not a lookup table

`<Routes>` doesn't hold a flat map of `"/login" → LoginPage`. It holds a nested component tree, and matching walks that tree from the root, trying to consume path segments at each level:

```tsx
<Route element={<ProtectedRoute />}>
  <Route element={<PlatformLayout />}>
    <Route path="/" element={<AppChooserPage />} />
    <Route path="/account" element={<AccountPage />} />
    <Route path="/app/:appSlug" element={<AppShell />}>
      {/* an app's own routes nest here */}
    </Route>
  </Route>
</Route>
```

For a request to `/app/ledger-core`, the router doesn't find one route that matches the whole string — it matches a **chain**: `ProtectedRoute` (no path segment consumed, it's a layout route with no `path`), then `PlatformLayout` (same), then `/app/:appSlug` matches and captures `appSlug: 'ledger-core'`. Every layout route in that chain renders, and each one's JSX contains an `<Outlet/>` — a placeholder that the router fills with whichever child actually matched. `PlatformLayout` renders once and stays mounted across `/`, `/account`, and every `/app/:slug` — only its `<Outlet/>`'s content changes, which is exactly why the org switcher in its header doesn't re-fetch or flicker when you navigate between the chooser and an app.

A route with no `path` prop (`<Route element={<ProtectedRoute />}>`) is called a **layout route** — it never itself "matches" a URL segment, it just wraps whatever does match beneath it. `ProtectedRoute` and `PlatformLayout` are both layout routes for exactly this reason: they need to run on every URL under them, not just one specific path.

### `<Outlet/>` is where the child renders

`<Outlet/>` is a component, not a special JSX tag — internally it reads the router's current matched-route context and renders the next route element down the matched chain, or nothing if there is no deeper match. `AppShell` illustrates the pattern one level in from `PlatformLayout`:

```tsx
// PlatformLayout renders <Outlet/> → router puts AppShell there for /app/:slug
// AppShell renders <Outlet/> → router puts the app's own page there
```

This is why the suite has *two* layout components instead of one: `PlatformLayout` owns chrome that's true for the whole authenticated app (brand, org switcher, sign out), and `AppShell` owns chrome that's true only inside one specific app (its name, a back-to-chooser link). Collapsing them into one component would mean every non-app page (`/`, `/account`) either grows app-shaped UI it doesn't need, or `AppShell`'s logic has to conditionally skip itself — nested routes let each layout own exactly the scope it's responsible for.

### Dynamic segments and `useParams`

`:appSlug` in `path="/app/:appSlug"` is a **dynamic segment** — it matches any non-empty path segment and captures its value under that name. `useParams<{ appSlug: string }>()` inside `AppShell` (via `useActiveApp`) reads it back:

```ts
const { appSlug } = useParams<{ appSlug: string }>();
```

The type parameter is a lie the compiler trusts, not a runtime guarantee — `useParams` returns `Readonly<Partial<{ appSlug: string }>>` under the hood in recent versions specifically because a route *can* render without every dynamic segment resolving (an optional segment, or the component reused under a different route), so the honest type has every param possibly `undefined`. This project's `useActiveApp` hook narrows it further by validating `appSlug` against the real app registry (`GET /apps`) rather than trusting the string — the union type from `AppSlug` (see the `const-assertions-and-satisfies` note) can't be produced from `useParams` alone, since a route param is always just `string`.

The alternative to a dynamic segment is a **splat** (`*`), which matches the rest of the path greedily rather than one segment — `path="/app/:appSlug/*"` would let an app own arbitrarily deep sub-routes under its own `<Routes>` nested inside its own page tree. AutoLedger doesn't need this yet, since no app has sub-pages, but the plan for it is recorded as a comment in `App.tsx` next to the app-routes block, so the shape is decided before it's needed.

### `<Navigate>` versus `navigate()` — declarative versus imperative redirects

Two ways to redirect exist, and this codebase deliberately uses only one of them for guard-style redirects:

```tsx
// Declarative — a component. Rendered means "redirect", not rendered means "don't".
return <Navigate to="/login" replace state={{ from: location.pathname }} />;

// Imperative — a function, called from an event handler or effect.
const navigate = useNavigate();
useEffect(() => { navigate('/login'); }, []);
```

`<Navigate>` composes naturally with conditional rendering — `ProtectedRoute` and `AppShell` are both just `if` statements returning either `<Navigate>` or `<Outlet/>`, so the redirect is a pure function of state, evaluated fresh on every render with no extra effect to get wrong (no missing dependency, no double-fire from React 18/19 Strict Mode's double-invoke). The imperative form is correct when a redirect is a *response to an event* — after a successful login, after a form submits — where there's no "render state" to express, only an action that already happened.

`replace` (on both forms) swaps the current history entry instead of pushing a new one. Without it, hitting Back after being redirected off a protected route lands you right back on the page that immediately redirects you away again — a broken-feeling loop. `state={{ from: location.pathname }}` is how `LoginPage` knows where to return the user afterward; it's ordinary React Router history state, not a query string, so it doesn't appear in the URL or get bookmarked.

### How a relative `to` is actually resolved

Every relative `to` — on a `<Link>`, a `<NavLink>`, a `<Navigate>`, or `navigate()` — goes through the same function, `resolveTo`, and it does **not** resolve against "the current route." It resolves against a specific pathname computed from the matched route chain, and which pathname that is depends on where in the tree the resolving component sits.

`useResolvedPath` (which every one of those APIs calls internally) does this, read directly from `react-router@7.18.3`'s `chunk-BV7QT456.mjs`:

```js
function getPathContributingMatches(matches) {
  return matches.filter(
    (match, index) => index === 0 || (match.route.path && match.route.path.length > 0)
  );
}
function getResolveToMatches(matches) {
  let pathMatches = getPathContributingMatches(matches);
  return pathMatches.map(
    (match, idx) => idx === pathMatches.length - 1 ? match.pathname : match.pathnameBase
  );
}
```

Two things matter here:

1. **Pathless routes are dropped**, except the root. A layout route with no `path` — `ProtectedRoute`, `PlatformLayout` — contributes nothing to this list. Only routes that actually consumed a URL segment count.
2. **The last contributing match is special.** Every match *except the last* contributes `match.pathnameBase` — the portion of the URL that route's own `path` matched, with no descendant segments. The **last** one contributes `match.pathname` instead — the full pathname matched by that route, descendants included. For a static `path="accounts"` route those are identical. For a **splat** route (`path="*"`), they are not: `pathnameBase` is the URL *up to* the splat, and `pathname` is the whole thing, splat segment and all.

`resolveTo` then takes `from = routePathnames[last index]`, and walks it up one entry per leading `..` in the `to` string:

```js
let routePathnameIndex = routePathnames.length - 1;
if (toPathname.startsWith('..')) {
  while (toSegments[0] === '..') { toSegments.shift(); routePathnameIndex -= 1; }
}
from = routePathnames[routePathnameIndex];
```

So `..` steps back **one route**, not one URL segment — and the very first `from` it starts from is `pathname`, not `pathnameBase`, whenever the deepest match in the chain is a splat.

This is exactly why `LedgerCoreSidebar`'s links used to append instead of replace. `AppPages`'s page routes (`accounts`, `journals`, …) render inside a `<Routes>` that itself sits under `App.tsx`'s `<Route path="*" element={<ActiveAppRoutes />} />` — a splat. That splat is the deepest path-contributing match at the point the sidebar resolves its links, so `from` is `match.pathname`: the *entire current URL*, not the app's base path. A bare `to="journals"` resolves against that full URL and appends. `to=""` and `to="onboarding"` did the same thing to `<Navigate>`'s target — `to=""` resolved to the current pathname (a no-op that re-triggers the same catch-all forever), and `to="onboarding"` appended `/onboarding` onto whatever deep, already-wrong path the URL had grown to, missing the `onboarding` route and falling through to the catch-all again. Both were infinite redirect loops, not just wrong URLs — `relative="path"` would not have fixed either one, since that prop only skips the `..` walk and leaves `from` unchanged. The fix used here is a `useAppBasePath()` hook that reads `:appSlug` and returns an absolute `/app/<slug>` prefix, so every in-app link and redirect targets an absolute path instead of depending on how deep the resolving component happens to sit in the tree.

### A third layout depth, and gating a route on data instead of auth

`ProtectedRoute` gates on *auth* state — a `checking` / `authenticated` / `anonymous` union already held in `AuthContext`. Phase 3.5 added a second, structurally identical gate one layer further in: LedgerCore's own routes redirect to an onboarding wizard until a `ledger_settings` row exists for the organization, and redirect *away* from the wizard once it does.

```tsx
function LedgerCoreGate() {
  const settings = useLedgerSettings(); // 'loading' | 'ready' | 'error'
  const base = useAppBasePath();
  if (settings.status === 'loading') return <Skeleton />;
  if (settings.status === 'error') return <ErrorMessage />;

  const onboarded = settings.settings.onboardedAt !== null;

  return (
    <Routes>
      <Route path="onboarding" element={onboarded ? <Navigate to={base} replace /> : <OnboardingPage />} />
      <Route path="*" element={onboarded ? <AppPages /> : <Navigate to={`${base}/onboarding`} replace />} />
    </Routes>
  );
}
```

The mechanism is identical to `ProtectedRoute`'s — a `<Navigate>` as a `<Route>`'s `element`, decided by a discriminated-union render-time state — but the *source* of that state generalizes: it's whatever context or fetch a given subtree needs to gate on, not specifically authentication.

The `to={base}` and `to={`${base}/onboarding`}` targets are absolute, and that isn't incidental — this component originally used relative targets (`to=".."` and `to="onboarding"`), on the theory that walking up or down one matched segment would reliably land on the LedgerCore root regardless of which app slug it's mounted under. That reasoning holds only if the deepest path-contributing match above this component is a normal segment. It isn't: `LedgerCoreGate` renders under `App.tsx`'s `<Route path="*" element={<ActiveAppRoutes />} />`, a splat, whose `pathname` (not `pathnameBase`) is what a relative `to` resolves against here — see "How a relative `to` is actually resolved" above. `to="onboarding"` appended onto the full current URL instead of the LedgerCore root, and `to=".."`/`to=""` resolved to the current pathname itself, so both redirects could — and, once the URL had drifted past a valid page route, did — loop forever. `useAppBasePath()` sidesteps the whole problem by building the target from the `:appSlug` route param directly rather than from tree position.

This also adds a **third** layout depth to the chrome stack from the previous section: `PlatformLayout` (suite chrome) → `AppShell` (per-app chrome) → now `LedgerCoreGate`'s own `<AppPages>` component, which renders a sidebar plus a further-nested `<Routes>` for the app's individual pages (dashboard, accounts, journals, trial balance, reports, settings). Each layer owns exactly the redirect logic and chrome relevant to its own scope — the platform layer doesn't know LedgerCore has an onboarding concept, and the onboarding gate doesn't know or care what suite chrome wraps it.

### The remount-by-`key` cache-invalidation trick

Not routing per se, but load-bearing on the route tree: `PlatformLayout`'s `<main>` is keyed on the active organization and a switch counter:

```tsx
<main key={`${organization?.id ?? 'none'}-${orgVersion}`}>
  <Outlet />
</main>
```

React's reconciliation compares elements by type *and* key at each position in the tree. Changing a `key` doesn't update the existing component instance — it tells React this is a **different** element, so the old subtree unmounts (cleanup effects run, all component state is discarded) and a brand-new subtree mounts from scratch. Every page under `<Outlet/>` — the chooser, the account page, any app's pages — refetches cleanly on an org switch, with no code in any of those pages aware that a switch happened. This is deliberate cache invalidation by identity rather than a fetch layer having to know to clear itself; the routing tree's own reconciliation rules do the work.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| One flat route list, one big layout component | Simple for a single-app dashboard | What Phase 1 had — broke as soon as a second layer of chrome (per-app) was needed |
| Nested routes, one layout route per chrome level | Each layout owns exactly its own scope; shared chrome never remounts on a child navigation | **Chosen** |
| A separate router instance per app (e.g. `createBrowserRouter` per app, mounted conditionally) | Real isolation, closer to micro-frontends | Wildly over-engineered for seven apps sharing one auth session and one deploy; would also break browser back/forward across app switches |
| Redirect guards as `useEffect` + `navigate()` everywhere | Familiar to anyone from an imperative router background | Rejected — a render-time `if / <Navigate>` is simpler to test (no timing, no missing dependency array) and can't accidentally fire twice |

## Where it lives in this codebase

- `client/src/App.tsx` — the full route tree; the `/app/:appSlug` dynamic segment and its comment about where a future `/*` splat lands
- `client/src/components/layout/PlatformLayout.tsx` — the outer layout route; the remount-by-`key` `<main>`
- `client/src/components/layout/AppShell.tsx` — the inner layout route; resolves `:appSlug` and redirects on `not-found`/`planned` via `<Navigate replace>`
- `client/src/apps/useActiveApp.ts` — `useParams` usage and the validation against the real registry
- `client/src/apps/useAppBasePath.ts` — the absolute `/app/<slug>` prefix every in-app link and redirect is built from, and why: a relative `to` resolves against the deepest path-contributing match's full `pathname`, which is the whole current URL once that match is a splat
- `client/src/components/ProtectedRoute.tsx` — the earliest layout route in the tree, from Phase 1
- `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` — the third layout depth: `LedgerCoreGate`'s data-driven `<Navigate>`, and `AppPages`'s nested sidebar + `<Routes>` (Phase 3.5)
- `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` — every `NavLink` built from `useAppBasePath()` rather than a bare relative suffix

## Gotchas

- **A layout route with no `path` still needs an `element`.** Forgetting one renders nothing and silently breaks every route beneath it — there's no error, just a blank `<Outlet/>` target.
- **Route matching is by specificity, not declaration order**, for sibling routes at the same level — but *nesting* order is structural, not a priority list. Don't rely on "routes declared earlier win" the way you might with an `if/else if` chain; two siblings that could both match the same path is a routing design bug to fix, not a thing to resolve by reordering JSX.
- **`useParams` types are a lie the compiler trusts.** The generic argument doesn't validate anything at runtime — a route rendered outside its expected path context, or a typo'd param name, both silently produce `undefined` rather than a type error. Validate against a real source of truth (here, the app registry) before trusting a param as a branded/union type.
- **Changing a `key` is not free.** It discards all component state and re-runs every mount effect in that subtree — correct here because a full refetch is exactly the desired behavior on an org switch, but the same trick used carelessly elsewhere (e.g. keying a frequently-updating list item on something that changes often) causes visible flicker and lost local state (like an open dropdown or a half-typed form).
- **`replace` matters more than it looks like it does.** Every redirect in a guard component (`ProtectedRoute`, `AppShell`) uses it; omitting it on just one of them reintroduces a specific back-button loop that's easy to miss in manual testing because it only shows up when you press Back, not on the redirect itself.
- **`to=""` and `to="."` are not no-ops — they resolve to the current pathname.** A catch-all `<Route path="*" element={<Navigate to="" replace />} />` nested inside a descendant `<Routes>` mounted under a splat is an infinite redirect loop: it navigates to exactly where it already is, which re-matches the same catch-all, which navigates again. This isn't hypothetical — it's what `AppPages`'s catch-all did before the fix, and it hung a Vitest worker until Node ran out of heap (`FATAL ERROR: Ineffective mark-compacts near heap limit`) rather than failing an assertion. A hanging test that OOMs, not a red assertion, is the signature of this specific bug class.
- **A relative link is only correct as deep as the tree stays shallow.** `to="../journals"` from a dashboard page and `to="journals"` from a sidebar can both be "correct" today purely by accident of how many path-contributing routes sit above them, and both silently start resolving somewhere else the moment a route is added or removed between them and the root. There's no lint rule that catches this — it has to be reasoned about explicitly, or avoided with an absolute path built from a route param.

## Interview Q&A

**Q: What's a layout route, and why would you use one with no `path`?**
A: A layout route is a `<Route>` that renders an element but doesn't itself match a URL segment — it wraps whatever child route does match, via `<Outlet/>`. You use one with no `path` when you have chrome or logic (an auth guard, a shared header, a data provider) that needs to apply across a whole subtree of otherwise-unrelated paths, without that logic being tied to any one specific URL. In this project, `ProtectedRoute` and `PlatformLayout` are both path-less layout routes for exactly that reason — they need to run for `/`, `/account`, and every `/app/:slug`.

**Q: How does `<Outlet/>` know what to render?**
A: It reads the router's matched-route state for its position in the tree and renders whichever child route matched one level deeper, given the current URL. It's not tied to a specific child by name — the same `<Outlet/>` in `PlatformLayout` renders `AppChooserPage`, `AccountPage`, or `AppShell` depending purely on which path currently matches. If no deeper route matches, it renders nothing.

**Q: Declarative `<Navigate>` versus calling `navigate()` in an effect — when do you use each?**
A: `<Navigate>` is a component, so it composes with conditional rendering — you return it as the render output when some state says "redirect," which makes the redirect a pure function of state with nothing to get wrong in a dependency array. It's the right tool for guard components like `ProtectedRoute`, where the redirect condition is derivable directly from existing state on every render. `navigate()` is imperative and belongs in event handlers or effects responding to something that already happened — after a form submits successfully, for instance — where there's no ongoing render-time condition to express, just a one-time action.

**Q: What does `key` do to a component when you change it, and why would you deliberately do that?**
A: React's reconciler compares an element's type and key at each tree position to decide whether to update the existing instance or replace it. Changing the key forces React to treat it as a different element: it unmounts the old instance (running cleanup) and mounts a fresh one, discarding all local state and re-running every effect. We do this deliberately on `PlatformLayout`'s `<main>`, keyed on the active organization — switching organizations should invalidate every page's fetched data, and remounting the whole subtree does that for free, without any individual page needing to know an org switch happened.

**Q: A dynamic segment like `:appSlug` gives you a `string` at runtime. How do you turn that into a checked, narrower type?**
A: You can't do it with a type annotation alone — `useParams`'s generic is unchecked, so declaring the type doesn't validate anything. You need an actual runtime check: a type predicate function, or in this case, comparing the param against a real list fetched from the server (the app registry) and only trusting it once it's found there. Anything short of an actual comparison is just telling the compiler to trust an assertion, which proves nothing about what a user could type into the address bar.

**Q: You've gated a route on authentication state. How would you gate a *different* subtree on some other piece of data, like "has this organization finished onboarding"?**
A: Same mechanism, different data source. `ProtectedRoute`'s gate is really just "read a discriminated-union state, return `<Navigate>` for one branch and `<Outlet/>`/the real page for the other" — nothing in that shape is specific to auth. LedgerCore's onboarding gate does exactly that against its own settings context instead: loading shows a skeleton, an onboarded organization renders its pages, an unonboarded one gets redirected to a wizard, and the wizard route itself redirects away once onboarding is done. It composes cleanly with the existing tree — it's just one more layout-route-shaped `if` a few levels deeper than `ProtectedRoute`'s.

**Q: Tell me about a routing decision you made because of state that needed to survive navigation.**
A: The two-layout split — `PlatformLayout` outside, `AppShell` inside — exists specifically so that suite-level UI, like the organization switcher in the header, stays mounted across every navigation within the authenticated app, including switching between different portfolio apps. If there were one combined layout, or if each app's routes each rendered their own copy of the header, either the header would remount (and potentially flicker or lose in-progress state, like a dropdown being open) on every app switch, or the header component would need to be duplicated per app. Nesting the routes let one instance of that chrome persist through the whole session, with only the `<Outlet/>` content changing underneath it.

**Q: You have a sidebar whose links append to the URL instead of replacing the page. Walk me through why.**
A: Every relative `to` resolves via `resolveTo`, which builds a `from` pathname out of the matched route chain — specifically, `getResolveToMatches` takes every route that actually consumed a path segment and, for all but the last one, uses `match.pathnameBase`; for the *last* one it uses `match.pathname` instead. Those two are the same for an ordinary segment route, but for a splat (`path="*"`) they diverge: `pathnameBase` stops before the splat, `pathname` includes everything the splat swallowed. If the sidebar's page routes render inside a `<Routes>` mounted under such a splat, that splat is the deepest contributing match, so `from` becomes the splat's full `pathname` — the entire current URL. A relative `to="journals"` then resolves against that whole URL and appends a segment instead of replacing the last one. It gets worse than a cosmetically wrong URL, too: with `to=""` on a catch-all route, `from` is the current pathname and the target *is* the current pathname, so the redirect fires, re-matches the same catch-all, and fires again — an infinite loop, not a wrong link.

**Q: When does a relative link inside a nested route work, and when does it break?**
A: It works exactly as long as the deepest path-contributing match above the link is an ordinary, non-splat route — then `pathnameBase` and `pathname` coincide and a relative `to` behaves the way you'd naively expect. It breaks the instant a splat, or one more layer of nested `<Routes>`, sits between the link and the app's logical root, because then the last contributing match's `pathname` includes segments the link's author never accounted for. The dangerous part is that correctness here is a property of the *tree shape at that moment*, not of the link itself — a link that's correct today can start resolving somewhere else after someone adds an unrelated route above it, with no error, type failure, or lint warning to catch it.

**Q: What are the trade-offs of absolute paths built from a route param versus relative links?**
A: An absolute path needs one extra piece of information — here, a `useAppBasePath()` hook that reads `:appSlug` and returns `/app/<slug>` — and it couples every consumer to knowing the platform's URL shape, even if only through that one hook. What it buys back is that resolution no longer depends on how deep in the route tree the link happens to sit: the target is the same string regardless of whether it's read from a sidebar three layers down or a page two layers up. Relative links need no such coupling and read naturally in isolation, but they're depth-fragile — their meaning is implicitly defined by the surrounding route tree, and that meaning silently changes if the tree changes, which is exactly the bug this project shipped and had to fix.

## Follow-ups they'll dig into

- "What's the difference between a dynamic segment and a splat?" (A segment `:x` matches exactly one path component and captures it by name; a splat `*` matches everything remaining, captured under the key `"*"`, useful for a sub-router owned by a lower-level route.)
- "How would you handle a route that needs data before it can render, to avoid a loading flash?" (React Router 7's data APIs — `loader` functions run before the route renders — this project deliberately doesn't use them yet, fetching in `useEffect` instead, to keep the client dependency-light per the project's dependency policy; a `loader`-based rewrite is a legitimate follow-up once data requirements grow.)
- "What happens if two sibling routes could both match the same URL?" (React Router picks the most specific match using a scoring algorithm — static segments outscore dynamic ones, which outscore splats — but relying on that for correctness rather than designing non-overlapping paths is a code smell worth calling out.)

## See also

- [context-effects-and-data-fetching.md](context-effects-and-data-fetching.md) — the `checking` state machine `ProtectedRoute` renders against, and the `ignore`-flag fetch pattern used inside routed pages
- [const-assertions-and-satisfies.md](../typescript/const-assertions-and-satisfies.md) — how `AppSlug` is derived, which is what `useActiveApp` validates a route param against
- `docs/architecture.md#suite-structure` — the platform-vs-app layer split this route tree implements

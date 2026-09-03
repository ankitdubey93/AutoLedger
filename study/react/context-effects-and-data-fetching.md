# Context, Effects & Data Fetching

> The login page flashing on reload, and the request that fails because another one was cancelled — both come from modelling "we don't know yet" badly.

**Category:** React
**Introduced by:** Phase 1 — `AuthContext`, `ProtectedRoute`, and the dashboard's data fetching
**Verified against:** React 19.2.8, react-router-dom 7.18.3, Vite 8.2

---

## Mechanism

### Three states, not two

The session lives in an httpOnly cookie the JavaScript cannot read. So on first render the app genuinely **does not know** whether anyone is signed in — it has to ask the server.

The tempting model is `user: User | null` plus `loading: boolean`. That's four combinations for three real states, and the illegal one (`loading && user`) is expressible, so the compiler can't help. A discriminated union makes the states exhaustive and mutually exclusive:

```ts
export type AuthState =
  | { status: 'checking' }
  | { status: 'authenticated'; user: PublicUser; organization: …; role: …; memberships: … }
  | { status: 'anonymous' };
```

**`checking` is the initial value, and that is the entire fix for the login flash.** With a boolean model the first render sees "no user" and redirects to `/login`; the session check resolves 80ms later and bounces the user back. Modelling ignorance explicitly means `ProtectedRoute` can render a skeleton instead of guessing:

```tsx
if (auth.status === 'checking') return <Skeleton />;
if (auth.status === 'anonymous') return <Navigate to="/login" replace state={{ from: location }} />;
return <Outlet />;
```

The bug is *treating "unknown" as "logged out"*. Verified in a real browser — sampling the DOM 180ms into a reload shows `"Restoring your session…"`, never the login page.

The other half is that the app must **always leave `checking`**. Every failure path — 401, network error, malformed response — lands in `anonymous`. A stuck spinner is worse than a login page: the user has no way out.

### `useEffect` cleanup and StrictMode

React 18+ StrictMode deliberately mounts, unmounts and remounts every component in development, running effects **twice**. It is not a bug to work around; it surfaces missing cleanup that would otherwise appear as a production leak.

The classic fetch-in-effect race: two requests in flight, and whichever resolves last wins — which may be the stale one. Two ways to handle it:

```tsx
// AbortController — cancels the request
useEffect(() => {
  const controller = new AbortController();
  fetchThing(controller.signal).then(setState).catch(ignoreAbortError);
  return () => controller.abort();
}, []);

// ignore flag — lets it finish, discards the result
useEffect(() => {
  let ignore = false;
  fetchThing().then((d) => { if (!ignore) setState(d); });
  return () => { ignore = true; };
}, []);
```

Phase 0 used `AbortController`. **Phase 1 had to switch to the `ignore` flag**, because of a genuinely surprising interaction described below.

### The abort/CORS-preflight interaction

Right after registering, two dashboard panels rendered "Failed to fetch" — but the same panels worked after a reload. Intermittently, which made it look like a backend flake.

It was neither. Chrome's network log showed:

```
-> OPTIONS /api/v1/organizations/members     (preflight)
-> GET     /api/v1/organizations/members     (StrictMode invocation 1)
-> GET     /api/v1/organizations/members     (StrictMode invocation 2)
!! FAILED: net::ERR_ABORTED canceled=true
```

A cross-origin `GET` carrying `Content-Type: application/json` is not a "simple request", so the browser sends a `OPTIONS` preflight first. On a fresh profile that preflight is uncached. StrictMode's cleanup aborts invocation 1 **while its preflight is still in flight** — and invocation 2, queued behind that same preflight, dies with it. It surfaces as a `TypeError: Failed to fetch`, not an `AbortError`, so the `catch` that carefully ignored `AbortError` reported it as a real failure.

It is a race, which is why it reproduced only sometimes: once the preflight is cached (Chrome caches per `Access-Control-Max-Age`), the window closes.

The `ignore` flag avoids it entirely — nothing is cancelled, so nothing else can be collaterally cancelled. Verified across three fresh browser profiles: zero occurrences after the change.

The general lesson: **`AbortController` is right for genuinely expensive requests you want to stop paying for; the `ignore` flag is right for cheap idempotent GETs.** Aborting is not free — it has side effects on shared browser state you don't control.

### Splitting a context to control re-renders

A context value is compared by reference. Any consumer of a context re-renders whenever the provider's value **identity** changes, regardless of whether the part it uses changed — and `value={{ state, actions }}` creates a new object every render, so everything re-renders on every state change.

Two contexts, split by change frequency:

```tsx
const AuthStateContext   = createContext<AuthState | null>(null);   // changes on login/logout
const AuthActionsContext = createContext<AuthActions | null>(null); // never changes

const actions = useMemo<AuthActions>(() => ({ login, register, logout, … }), []);
```

The actions object is memoised with an empty dependency array, so it is referentially stable for the provider's lifetime. A component that only calls `logout` subscribes to `AuthActionsContext` and never re-renders when the session data changes.

This also explains why context is not a state manager: it has no selector mechanism. Redux/Zustand let a component subscribe to a *slice*; context is all-or-nothing per provider, so the granularity has to come from how you split providers.

### Cache invalidation on organization switch

Switching organizations re-issues the token server-side and changes what every org-scoped query returns. Every mounted component now holds another tenant's data — a correctness problem, not a cosmetic one, and exactly the kind of leak `docs/guardrails.md` rule 1 is about.

Rather than tracking down every cache, the layout keys its outlet:

```tsx
<main key={`${organization?.id ?? 'none'}-${orgVersion}`}>
  <Outlet />
</main>
```

A changed `key` makes React treat it as a **different element**: the old subtree unmounts, state is discarded, and effects re-run from scratch. Cache invalidation by identity rather than by hand. `orgVersion` is a counter so that even re-selecting the same org forces a remount.

This is the same mechanism as `key` in a list — reconciliation matches elements by type and key, and a key change means "this is a different thing", not "this thing changed".

### React 19 notes

- **`use(promise)`** reads a promise during render, suspending until it resolves. Cleaner than the effect dance, but it needs a cache to avoid refetching on every render, so it really wants a framework or `React.cache`.
- **Actions / `useActionState`** handle pending/error state for form submissions. `LoginPage` uses explicit `useState` instead — the flow is simple, and being able to explain the state machine is worth more here than the newer API.
- **`ref` is a normal prop** — `forwardRef` is no longer needed.
- **The React Compiler** auto-memoises, which will make much manual `useMemo`/`useCallback` unnecessary. The context split above is about *subscription granularity*, not memoisation, so it stays relevant either way.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `user \| null` + `loading` boolean | Familiar; expresses impossible states; causes the login flash | Rejected |
| **Discriminated union with `checking`** | Slightly more verbose | **Chosen** |
| React Query / SWR | Caching, dedupe, revalidation — genuinely good | Rejected for now (rule 14). The natural revisit is Phase 3, when LedgerCore brings real lists to cache |
| One combined auth context | Simpler | Rejected — action-only consumers would re-render on every session change |
| `AbortController` everywhere | Frees the connection | Rejected for cheap GETs after the preflight interaction |
| Redirect from the fetch layer | Fewer moving parts | Rejected — a fetch helper navigating is a layering violation and untestable. It dispatches an event; `ProtectedRoute` redirects declaratively |

## Where it lives in this codebase

- `client/src/context/AuthContext.tsx` — the three-state machine, the split contexts, the boot effect
- `client/src/context/OrgContext.tsx` — active org derived from auth, `orgVersion`
- `client/src/components/ProtectedRoute.tsx` — the `checking` branch
- `client/src/components/layout/AppLayout.tsx` — the `key`-based remount
- `client/src/utils/fetchWithAutoRefresh.ts` — single-flight refresh (see below)
- `client/src/__tests__/ProtectedRoute.test.tsx` — asserts the login page is *not* rendered while checking

## Gotchas

- **Deriving state you already have.** `OrgContext` does not store the active organization — it reads it from `AuthContext`, because the authority is the signed token. A second copy is a second thing to keep in sync.
- **Provider order is load-bearing.** `BrowserRouter` must be outermost: `ProtectedRoute` and the providers use router hooks, and a hook cannot reach a context mounted below it.
- **A `null` default context is a feature.** It lets `useAuth` throw "must be used inside `<AuthProvider>`" instead of failing three components away with a property access on undefined.
- **Single-flight the refresh.** Five components mounting fire five requests; five simultaneous 401s would trigger five refreshes, four of which present an already-rotated token — which the server correctly reads as replay and responds to by killing the session. `refreshPromise ??= doRefresh().finally(() => { refreshPromise = null })`. Clearing in `finally` matters, or one failure wedges every future refresh onto a rejected promise.
- **StrictMode double-invoke is development-only.** Don't "fix" it by removing `<StrictMode>` — it is telling you something true.

## Interview Q&A

**Q: Why does a login page sometimes flash before the app loads, and how do you fix it?**
A: Because the app models "we don't know yet" as "logged out". With a session in an httpOnly cookie the client can't read it, so on first render it genuinely doesn't know and has to ask the server. If your state is `user | null`, the first render sees null, redirects to login, and then the check resolves and bounces back. The fix is a third state: a discriminated union of `checking | authenticated | anonymous`, with `checking` as the initial value, so the route guard renders a skeleton instead of guessing. The other half is guaranteeing you always *leave* `checking` — every failure path lands in `anonymous`, because a stuck spinner is worse than a login page.

**Q: Why does StrictMode run effects twice, and what does that force you to do?**
A: React deliberately mounts, unmounts and remounts in development so that missing cleanup shows up immediately rather than as a production leak. For data fetching it forces you to handle two in-flight requests where the last to resolve wins — which might be the stale one. Either abort in the cleanup, or set an `ignore` flag and discard the late result. The point isn't to work around it; it's that the bug it reveals is real, it's just usually hidden.

**Q: Tell me about a subtle bug you debugged in a React app.**
A: Right after registering, two dashboard panels showed "Failed to fetch", but they worked after a reload — and only sometimes, which made it look like a backend flake. It wasn't. Chrome's network log showed `net::ERR_ABORTED`. Because these are cross-origin JSON requests, the browser sends a CORS preflight first, and on a fresh profile it's uncached. StrictMode's cleanup aborted the discarded first request *while its preflight was still in flight*, and the second request — queued behind that same preflight — died with it. It surfaced as a TypeError, not an AbortError, so my `catch` that carefully ignored AbortError reported it as a genuine failure. I switched those effects to an `ignore` flag: nothing is cancelled, so nothing is collaterally cancelled. Verified across three fresh browser profiles. The takeaway is that aborting isn't free — it touches shared browser state you don't control — so it's right for expensive requests and wrong for cheap idempotent GETs.

**Q: Why split one context into two?**
A: Context values are compared by reference, so every consumer re-renders whenever the provider's value identity changes — and an inline object literal is new on every render. I split state from actions: the actions object is `useMemo`'d with an empty dependency array so it's referentially stable forever, which means a component that only needs `logout` never re-renders when the session data changes. It also illustrates why context isn't a state manager — there's no selector, so subscription granularity has to come from how you split providers.

**Q: A user switches organization. How do you make sure no component shows the previous tenant's data?**
A: I change the `key` on the layout's outlet. A changed key makes React treat it as a different element, so the old subtree unmounts, its state is discarded, and effects re-run — cache invalidation by identity instead of hunting down every cached value. It's the same reconciliation mechanism as keys in a list. I include a counter alongside the org id so re-selecting the same org still forces a remount. It matters for correctness, not polish: stale data here means showing one tenant another tenant's rows.

**Q: How do you stop several simultaneous 401s from each triggering a refresh?**
A: Single-flight it with a module-level promise: `refreshPromise ??= doRefresh().finally(() => { refreshPromise = null })`. The first 401 starts the refresh, everyone else awaits the same promise. It matters more than it sounds — our refresh tokens rotate, so five parallel refreshes means four presenting an already-rotated token, which the server correctly treats as replay and responds to by killing the whole session. A missing single-flight doesn't look like a slow page; it looks like users being randomly logged out. Clearing the promise in `finally` is also load-bearing, or one failure wedges every future attempt.

## Follow-ups they'll dig into

- *"Why not React Query?"* It would give caching, dedupe and revalidation for free — deliberately deferred under the dependency policy, with Phase 3's LedgerCore lists as the natural trigger.
- *"Does the client-side route guard provide security?"* No. It's UX. Every protected route is independently enforced by server middleware.
- *"What about `use()` in React 19?"* Cleaner, but needs a cache to avoid refetching each render.
- *"Would the React Compiler make the context split unnecessary?"* No — it auto-memoises, but the split is about subscription granularity, which is a different problem.
- *"How do you test the `checking` state?"* Stub `fetch` with a promise that never settles, then assert the login page is *not* in the document.

## See also

- [react-foundations.md](react-foundations.md) — reconciliation and keys
- [cookies-samesite-and-csrf.md](../security-auth/cookies-samesite-and-csrf.md) — why the client can't read the session
- [jwt-and-refresh-rotation.md](../security-auth/jwt-and-refresh-rotation.md) — what the single-flight refresh protects

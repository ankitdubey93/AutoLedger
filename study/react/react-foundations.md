# React — Foundations

> A library that lets you describe UI as a pure function of state and then works out the minimum DOM mutations to make reality match — trading raw performance for the elimination of manual DOM synchronisation, the single largest source of UI bugs.

**Category:** React · Foundations
**Verified against:** React 19

---

## What it is

A JavaScript library for building user interfaces from composable **components**, from Facebook (2013). Not a framework — it has no opinion on routing, data fetching, or global state, all of which come from the ecosystem.

Its central claim is **declarative rendering**: you write what the UI *should look like* for a given state, and React figures out how to get the DOM there. The imperative alternative — find the node, read its current content, mutate it, remember to also update the other three places that depend on the same data — is where UI bugs actually come from, because it requires you to correctly enumerate every consequence of every change.

```
UI = f(state)
```

## How it works

### JSX is a function call

JSX is syntax sugar. This:

```tsx
<button className="primary" onClick={save}>Save</button>
```

compiles (since React 17, via the automatic runtime `react/jsx-runtime`) to roughly:

```js
jsx('button', { className: 'primary', onClick: save, children: 'Save' })
```

which returns a **plain object** describing what to render — type, props, key, ref. Nothing has touched the DOM. A component is a function that returns a tree of these element objects.

Because elements are just objects, they're cheap to create and throw away, which is what makes the diffing approach viable at all.

### Reconciliation

When state changes, React re-invokes the component function to get a new element tree, compares it against the previous one, and computes the minimal set of DOM operations. The comparison uses two heuristics rather than a general tree-diff (which would be O(n³)):

1. **Different element type at a position → discard the whole subtree and rebuild.** Changing `<div>` to `<section>` throws away everything inside, including component state.
2. **Same type → keep the DOM node, update changed props, recurse into children.**

For lists, React needs identity: without it, inserting at the front looks like "every item changed." **Keys** provide that identity, which is why using an array index as a key is a bug — the index of an item changes when the list reorders, so React matches the wrong old element to the wrong new one, and component state (a focused input, a checkbox) follows the wrong row.

### Fiber — why rendering can be interrupted

React 16 rewrote the internals around **fibers**. A fiber is a mutable object representing one unit of work for one component, holding its props, state, hooks, and links to parent/child/sibling. The tree becomes a linked-list structure that can be walked iteratively rather than by recursion — and critically, the walk can be **paused, resumed, or abandoned**.

Rendering happens in two phases:

| Phase | Behaviour |
|---|---|
| **Render / reconcile** | Calls your components, builds the new fiber tree, computes changes. **Interruptible** — can be paused for higher-priority work, or thrown away entirely. No DOM changes. Must be side-effect free |
| **Commit** | Applies mutations to the DOM, runs layout effects, then passive effects. **Synchronous and uninterruptible** |

That split is why your component function must be pure: React may call it, discard the result, and call it again. It's also why `StrictMode` in development deliberately double-invokes components and effects — to surface impurity and missing cleanup early.

The scheduler yields to the browser between units of work (in practice via a `MessageChannel` task, not `requestIdleCallback`), which is what makes **concurrent features** possible: `useTransition` marks an update as interruptible so typing stays responsive while an expensive list re-renders, and `Suspense` lets a subtree declare "not ready yet" without blocking siblings.

### Hooks, and why the rules exist

Hooks let function components hold state and side effects. The implementation is the reason for the rules: **hooks are stored as an ordered linked list on the fiber**, and each call is matched to its slot *by call order*, not by name. There's no key, no identifier — just position.

So:

- **No hooks inside conditionals or loops.** Call order must be identical on every render, or `useState` #2 reads slot #1's value.
- **Only in components or other hooks.** Outside a render there's no fiber to attach to.

Core hooks:

- `useState` / `useReducer` — local state; setting it schedules a re-render of that component and its subtree
- `useEffect` — runs *after* commit and paint, for synchronising with things outside React (subscriptions, fetches, timers). The dependency array controls re-running; the returned function cleans up before the next run and on unmount
- `useLayoutEffect` — same, but before the browser paints, so it can measure and mutate without a visible flicker. Blocks paint, so use sparingly
- `useMemo` / `useCallback` — cache a value or function identity across renders. These are *optimisations*, not semantics; React may discard the cache
- `useContext` — read a context value without threading props
- `useRef` — a mutable box that doesn't trigger re-renders

### State updates and re-renders

Setting state doesn't mutate immediately — it **schedules**. Updates within the same event are **batched** into one re-render (in React 18+, including inside promises and timeouts). Setters are also queued, which is why `setCount(c => c + 1)` is correct and `setCount(count + 1)` is stale-prone when several updates land together.

**A re-render is not a DOM update.** React re-invokes the function and diffs; if the output is unchanged, no DOM operation happens. That distinction matters when reasoning about performance — "too many re-renders" is only a problem if the render work itself is expensive.

### Context and its cost

Context passes values down without prop threading. The mechanism to understand: **every consumer re-renders when the context value changes by identity**. Put an object literal in a provider and you create a new identity on every parent render, re-rendering every consumer. Hence: memoise provider values, and split contexts by change frequency — a rarely-changing auth/org context should not be the same provider as a fast-changing UI state.

### React 19 additions

- **`use()`** — read a promise or context during render, integrated with Suspense
- **Actions** and `useActionState` — form submission with built-in pending/error state
- **`useOptimistic`** — show a provisional result while a mutation is in flight
- **React Compiler** — a separate, opt-in build-time tool that inserts memoisation automatically, aiming to make manual `useMemo`/`useCallback` largely unnecessary. Adopt deliberately; it is not on by default.

## What it does best, and how

**Eliminating manual DOM synchronisation.** The mechanism is the diff: because you re-describe the whole UI for the new state and React computes the delta, you never enumerate consequences yourself. In imperative code, adding a field that appears in three places means remembering all three; in React it means rendering it from the same state. The bug class — "I updated the model but forgot one view" — stops existing.

**Composition at scale.** Components are functions returning data, so they compose like functions: extraction is refactoring, not rewriting. Custom hooks extend this to *behaviour* — `useJournalEntries()` can encapsulate fetching, caching, and error state, and be reused across pages with no shared base class or mixin machinery.

**Predictable data flow.** One-way flow, with state living above the components that read it, means you can answer "why does the screen look like this" by looking at state — not by reconstructing a history of mutations.

**Ecosystem and hireability.** Routing (React Router), server state (TanStack Query), forms (React Hook Form), tables (TanStack Table) are mature and interoperable. For a form-and-table-heavy ERP that's most of the UI already solved.

## Where it's weak

- **It's a library, not a framework.** Routing, data fetching, and global state are all decisions you must make, and the ecosystem shifts.
- **Runtime cost.** React ships a reconciler to the browser and diffs at runtime. Svelte and Solid compile that away and are faster and smaller for the same work.
- **Performance requires understanding the model.** Unnecessary re-renders from unstable identities, context churn, and missing memoisation are the standard performance complaints — all avoidable, none obvious to a beginner.
- **`useEffect` is over-used.** Most effects people write are either derived state (compute during render) or event handling. Effects are for synchronising with things *outside* React, and treating them as a general "run this when X changes" hook produces cascading renders and race conditions.
- **Server-state caching isn't included.** Naive `useEffect` + `fetch` has no deduplication, no cache, and real race conditions when responses arrive out of order.
- **Rules of hooks are a real constraint**, enforced by lint rather than the language.

## Why we chose it for AutoLedger

| Requirement | Why React |
|---|---|
| Dozens of stateful forms and data tables | Component composition; mature form and table libraries |
| Shared types with the Express backend | Same language; one payload type checked at both ends |
| Org switcher invalidating all cached data | Explicit, inspectable data flow makes "clear everything on org change" tractable |
| Long-lived project, hiring later | Largest talent pool and ecosystem of the options |

**Versus Svelte or Solid:** both are genuinely faster with smaller bundles, since they compile reactivity instead of diffing at runtime. Rejected on ecosystem depth and hiring, not on technical merit — for an ERP the UI complexity is in forms and tables, where React's library ecosystem is a large practical advantage.

**Versus Angular:** a full framework with routing, DI, and forms included, which is arguably a better fit for a large enterprise app with many modules. Rejected for the steeper learning curve and heavier abstraction.

**Versus server-rendered HTML** (Rails/Django-style, or htmx): genuinely simpler for CRUD, and a reasonable argument for much of an ERP. Rejected because the interaction-heavy parts — a journal entry form that live-validates that debits equal credits as you type — want real client state.

## Vocabulary that shows up in interviews

**declarative vs imperative** · **component** · **element** (the object JSX produces) · **props vs state** · **reconciliation / diffing** · **virtual DOM** · **fiber** · **render phase vs commit phase** · **key** · **hook** · **batching** · **lifting state up** · **controlled vs uncontrolled** · **memoisation** · **concurrent rendering / transitions** · **Suspense** · **error boundary**

## Interview Q&A

**Q: What problem does React actually solve?**
A: Keeping the DOM consistent with application state without you having to enumerate the consequences of every change. Imperatively, when data changes you must find every place it's displayed and update each one — and the bugs come from missing one, or from doing them in the wrong order. React inverts it: you write the UI as a function of state, re-describe the whole thing when state changes, and React diffs the description against the previous one to compute the minimal DOM mutations. You trade some runtime performance for eliminating an entire bug class.

**Q: Explain the virtual DOM. Is it faster than direct DOM manipulation?**
A: It's a tree of plain JavaScript objects describing the intended UI. On a state change React builds a new tree, diffs it against the old, and applies only the differences. And no — it is *not* faster than optimal hand-written DOM manipulation; it can't be, since it's doing extra work to figure out what that manipulation should be. It's faster than *typical* hand-written code, which over-updates, and the actual win is that it's declarative. The honest framing is that the virtual DOM buys maintainability, and its performance is good enough that you rarely pay for that.

**Q: Why can't you call hooks conditionally?**
A: Because hooks are stored as an ordered list on the component's fiber and matched to their slots by call order — there's no name or key involved. If a `useState` is skipped by an `if` on one render, every subsequent hook shifts by one position and reads the wrong slot's value. So the constraint isn't stylistic, it's structural to how hook state is stored. If you need conditional behaviour, put the condition *inside* the hook, or extract a separate component.

**Q: Why is using an array index as a key a bug?**
A: Keys give React identity for list items so it can tell "moved" from "changed." An index isn't identity — it describes position. Insert at the front and every index shifts, so React thinks item 0's content changed rather than that a new item appeared. Two consequences: it re-renders and re-mutates far more than needed, and worse, DOM and component state stay attached to positions rather than items, so a focused input or a checked checkbox follows the wrong row. Use a stable ID from the data.

**Q: What are the render and commit phases, and why does the distinction matter?**
A: Render is when React calls your components and reconciles the result into a new fiber tree — no DOM changes, and it's interruptible, so React may pause it, throw the result away, and start over for higher-priority work. Commit applies the mutations to the DOM and runs effects, synchronously and uninterruptibly. The practical consequence is that your component function must be pure: no mutation, no side effects, no assuming it runs exactly once per update. That's exactly why `StrictMode` double-invokes components and effects in development — it's surfacing impurity and missing cleanup that would otherwise only break under concurrent rendering.

**Q: When do you actually need `useMemo`, `useCallback`, or `React.memo`?**
A: Less often than they're used. `useMemo` when a computation is genuinely expensive and its inputs rarely change, or when a value's *identity* must be stable because it feeds a dependency array or a memoised child. `useCallback` mainly for identity stability, same reasoning. `React.memo` when a component is expensive and receives the same props while its parent re-renders frequently. All three cost memory and add a comparison, and none of them help if you then pass a fresh object literal as a prop and defeat the comparison. My default is to measure with the profiler first — and note that React 19's compiler is explicitly aiming to make most manual memoisation unnecessary.

**Q: How would you handle data fetching, and what goes wrong with `useEffect` plus `fetch`?**
A: I'd reach for a server-state library — TanStack Query — rather than hand-rolling. The naive effect-and-fetch approach has four problems: no deduplication, so two components asking for the same data make two requests; no cache, so navigating back refetches everything; race conditions, because if the ID changes fast, responses can arrive out of order and the stale one wins unless you cancel or guard with the cleanup function; and no shared loading or error state. It's also worth saying that server data isn't really "state" in the React sense — it's a cache of something you don't own, and it wants invalidation and staleness semantics, not `useState`.

**Q: Tell me about a React design decision on your project.**
A: On AutoLedger the interesting one is org switching. It's multi-tenant, and a user can belong to several organizations and switch between them. Every cached query — accounts, journal entries, reports — is scoped to the active org, so switching must invalidate all of it or you render org A's ledger under org B's header, which in a financial app is unacceptable. So the org ID belongs in the cache key of every query rather than being handled by an imperative "clear on switch," because a cache key is declarative and can't be forgotten when someone adds a new query later. That's the same reasoning as the backend rule that every query is scoped by `org_id` — make the scope structural rather than remembered.

## Follow-ups they'll dig into

- "What's an error boundary and what can't it catch?" (A component catching render-phase errors in its subtree; it does not catch errors in event handlers, async code, or itself.)
- "Controlled versus uncontrolled inputs — which for a large form?" (Controlled gives validation and derived state at the cost of a render per keystroke; uncontrolled via refs or React Hook Form scales better for big forms.)
- "How does `Suspense` actually work?" (A child signals it isn't ready — historically by throwing a promise, now via `use()` — and the nearest boundary renders a fallback until it resolves.)
- "What is prop drilling and when is context the wrong fix?" (When the value changes often — you convert a threading problem into a re-render problem. Composition or a state library may fit better.)
- "Why is `key` on a component sometimes used to force a reset?" (A changed key means a different element identity, so React discards the subtree and its state — a deliberate use of heuristic #1.)

## See also

- [../architecture/multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md) — why org switching must invalidate caches
- [../typescript/typescript-foundations.md](../typescript/typescript-foundations.md)

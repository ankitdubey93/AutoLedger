# Build plan — LedgerCore app shell & interactive dashboard (UX revision of Phase 3.5)

**Date:** 2026-09-03
**Status: DONE — 2026-09-03.** All 18 steps executed; 51 client tests green (47 + 4 new), typecheck
and production build both clean; `guardrail-review` and `docs-sync` both run and clean — zero
server files touched, `client/package.json` unchanged, five-account-type filter confirmed. Visual
behavior verified end-to-end with a scripted headless-browser pass (register → onboarding →
dashboard → filtered trial balance → clear filter → hover readout → suite pages unchanged).

> This file is now a historical record, not a live plan. The durable account of what shipped and
> what deliberately changed is [roadmap.md § Phase 3.5, as delivered](../docs/roadmap.md#phase-35-as-delivered).
> Safe to delete.

**Phase:** none — this is a **client-only UX revision of the already-delivered Phase 3.5.**
It renumbers nothing, adds no phase, and Phase 4 remains unstarted.
**Touches:** `client/` only. **No migration. No server file. No new npm package. No API change.**

---

## Starting state (verified on the filesystem, 2026-09-03)

Working tree clean at `f4e4e22`. `cd client && npm test` → **8 files, 47 tests, all passing.**

**Route tree today** (`client/src/App.tsx:35-61`):

```
BrowserRouter → AuthProvider → OrgProvider
  /login, /register
  ProtectedRoute
    PlatformLayout                       ← suite header on EVERY authenticated page
      /                AppChooserPage
      /account         AccountPage
      /dashboard       → Navigate /account
      /app/:appSlug    AppShell          ← "← All apps" + big <h1>{app.name}</h1>
        index, *       ActiveAppRoutes → APP_ELEMENTS[slug] → LedgerCoreRoutes
  *                    NotFoundPage
```

**Chrome that exists today**

- `client/src/components/layout/PlatformLayout.tsx` — `.app-header` with `<strong>AutoLedger</strong>`, org chip, `OrgSwitcher`, email link, Sign out; `<main className="app-main" key={`${organization?.id ?? 'none'}-${orgVersion}`}>`. **That `key` is load-bearing** — it remounts the app subtree on an org switch, which is what makes switching into a not-yet-onboarded org show the wizard again (`LedgerCoreRoutes.tsx:30-33`).
- `client/src/components/layout/AppShell.tsx` — resolves `:appSlug` via `useActiveApp()`, redirects `not-found`/`planned` to `/`, renders `← All apps` + `<h1>{app.name}</h1>`.
- `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` — flat 6-item `NAV` array, absolute `${base}/${to}` links.
- `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` — `AppPages` is `grid grid-cols-1 md:grid-cols-[13rem_1fr] gap-6`; `LedgerCoreGate` gates on `onboardedAt`.
- `client/src/index.css` — plain CSS (unlayered, so it beats Tailwind's layered utilities; see the file's own header comment). Contains `.app-main:has(.app-shell) { max-width: 90rem }` (lines 174-179) and `.app-shell`, `.app-shell__header`, `.app-shell__title` (lines 275-289).

**Dashboard today** (`client/src/Pages/ledger-core/DashboardPage.tsx`) — four flat `.card` position tiles, two flat performance `<dl>` cards, a `TrendChart` (hand-rolled SVG grouped bars, no interaction), a recent-entries table, and an integrity banner with `role="status"`.

**Data available with no server change** — `GET /ledger-core/reports/dashboard` returns `position{assets,liabilities,equity,currentEarnings,cash,equationHolds}`, `performance{yearToDate,currentMonth}`, `activity{entryCountYtd,recentEntries}`, `integrity`, `trend[6]`, `fiscalYear`. `GET /ledger-core/reports/trial-balance` returns per-account rows carrying `type` and `netBalanceCents`. `useOrg().organization.baseCurrency` gives the currency code.

**What does not exist and this plan does not invent:** no P&L, no balance sheet, no fiscal periods, no per-account ledger detail route, no `?type=` server parameter on the trial balance, no charting library, no audit trail.

---

## Gate

No gate applies. This is client presentation over endpoints that already ship. Nothing here depends on Phase 4, 7, 8, or any other gated phase, and nothing here unblocks one.

**Do not treat this as Phase 4.** If you find yourself wanting a balance sheet, a P&L, or a closed-period check to make a tile work — stop. Those are Phase 4 and out of scope.

---

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| A test fails after a layout change | Deleting or loosening the assertion | Fix the component. Where a test's *spec* genuinely changed, this plan says so by step number and gives the exact replacement — no other test may be edited |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| "I need a chart/animation library" | `npm install` | Stop and ask. Rule 14 — hand-rolled SVG, as `TrendChart` already is |
| A Tailwind utility does not apply over an `index.css` rule | `!important` on the utility | Unlayered CSS beats layered utilities. Add the override to `index.css` — this plan names each one |
| Needing a filter/aggregate the API does not return | Adding a query param to the server | Filter client-side over data already fetched. This plan is client-only; a server change means stop and replan |
| A tile needs an account-level drilldown page | Inventing a route | Link to the trial balance with the `?type=` filter this plan adds |

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

---

# Slice A — Invert the chrome: the app owns the frame

**Outcome:** inside `/app/:appSlug`, the suite header is gone; a slim app top bar carries a small AutoLedger mark on the left, the app's own name beside it, and the org/user controls on the right.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| New component | `AppTopBar` — `client/src/components/layout/AppTopBar.tsx`, default export |
| New component | `AppFrame` — `client/src/components/layout/AppFrame.tsx`, default export |
| Deleted | `client/src/components/layout/AppShell.tsx` |
| Unchanged | `PlatformLayout`, `OrgSwitcher`, `ActiveAppRoutes`, `useActiveApp`, `useAppBasePath` |
| CSS class | `app-topbar` (the only new class name in `index.css`) |
| Top-bar height | `h-14` (3.5rem) — the rail's `top-14` and `calc(100vh-3.5rem)` depend on this exact value |

---

### Step 1 — `AppTopBar`

- **Depends on:** nothing
- **Skill:** none (client component)
- **Read first:** `client/src/components/layout/PlatformLayout.tsx` — copy its `useAuth`/`useAuthActions`/`useOrg` usage and its Sign-out button verbatim. `client/src/components/layout/OrgSwitcher.tsx` — it self-hides when the user has ≤1 membership, so render it unconditionally.
- **Files:** `client/src/components/layout/AppTopBar.tsx` (new)
- **Contract — write this signature literally:**
  ```tsx
  import type { AppSummary } from '../../services/fetchServices';
  export default function AppTopBar({ app }: { app: AppSummary }): React.JSX.Element;
  ```
  Structure, in this order:
  ```tsx
  <header className="app-topbar sticky top-0 z-30 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)] bg-[var(--panel)]">
    <Link to="/" title="All AutoLedger apps"
          className="flex items-center gap-1.5 shrink-0 no-underline text-[var(--muted)] hover:text-[var(--text)] transition-colors">
      <Layers size={15} aria-hidden="true" />
      <span className="text-xs tracking-wide">AutoLedger</span>
    </Link>
    <span aria-hidden="true" className="text-[var(--border)]">/</span>
    <span className="font-semibold text-[15px] truncate">{app.name}</span>
    <div className="ml-auto flex items-center gap-3">
      <OrgSwitcher />
      {organization !== null && <span className="chip">{organization.name}</span>}
      <Link to="/account" className="muted">{email}</Link>
      <button type="button" className="btn btn--ghost" onClick={() => void logout()}>Sign out</button>
    </div>
  </header>
  ```
  `Layers` is imported from `lucide-react` (already a dependency). `email` is `auth.status === 'authenticated' ? auth.user.email : ''` — copied from `PlatformLayout.tsx:16`. `organization` and `logout` come from `useOrg()` and `useAuthActions()`.
- **Guardrails:** no new npm package (rule 14). The AutoLedger link must stay a real `<Link to="/">` — it is the only way back to the chooser from inside an app.
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** type error → fix the type. Do not proceed to Step 2 until typecheck is clean.
- **Owes:** nothing yet — docs land in Step 16.

---

### Step 2 — `AppFrame` replaces `AppShell`

- **Depends on:** Step 1
- **Skill:** none (client component)
- **Read first:** `client/src/components/layout/AppShell.tsx` in full (you are replacing it — its loading skeleton and its `not-found`/`planned` redirect must survive verbatim) and `client/src/components/layout/PlatformLayout.tsx:45` (the remount key).
- **Files:** `client/src/components/layout/AppFrame.tsx` (new)
- **Contract:**
  ```tsx
  export default function AppFrame(): React.JSX.Element;
  ```
  Body, in this order:
  1. `const active = useActiveApp();` and `const { organization, orgVersion } = useOrg();`
  2. `active.status === 'loading'` → return the **exact** skeleton block from `AppShell.tsx:14-19` unchanged (`<div className="shell" aria-busy="true">` + `skeleton--title` + the `visually-hidden` "Loading app…").
  3. `active.status === 'not-found' || active.app.status === 'planned'` → `return <Navigate to="/" replace />;`
  4. Otherwise:
     ```tsx
     <div className="min-h-screen flex flex-col bg-[var(--bg)]">
       <AppTopBar app={active.app} />
       <main key={`${organization?.id ?? 'none'}-${orgVersion}`} className="flex-1 min-h-0">
         <Outlet />
       </main>
     </div>
     ```
  **The `key` expression must be character-for-character the one in `PlatformLayout.tsx:45`.** It is what remounts the app subtree on an org switch; without it, switching into a not-yet-onboarded organization silently skips the wizard.
  `<main>` carries **no padding and no max-width** — each app pads its own content (Step 7). Do not add `p-6` here.
- **Guardrails:** the `planned`/`not-found` redirect is a real guard, not decoration — an app with `status: 'planned'` in `server/src/config/apps.ts` must never render a frame.
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** do not proceed to Step 3.
- **Owes:** nothing yet.

---

### Step 3 — Rewire `App.tsx`, delete `AppShell.tsx`

- **Depends on:** Step 2
- **Skill:** none (routing)
- **Read first:** `client/src/App.tsx` in full.
- **Files:** `client/src/App.tsx` (edit), `client/src/components/layout/AppShell.tsx` (**delete**)
- **Contract — the `ProtectedRoute` block becomes exactly this:**
  ```tsx
  <Route element={<ProtectedRoute />}>
    <Route element={<PlatformLayout />}>
      <Route path="/" element={<AppChooserPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/dashboard" element={<Navigate to="/account" replace />} />
    </Route>

    {/* Apps are NOT nested under PlatformLayout: inside an app, the app owns
        the chrome and AutoLedger shrinks to a mark in AppTopBar. */}
    <Route path="/app/:appSlug" element={<AppFrame />}>
      <Route path="*" element={<ActiveAppRoutes />} />
      <Route index element={<ActiveAppRoutes />} />
    </Route>
  </Route>
  ```
  Change the `AppShell` import to `import AppFrame from './components/layout/AppFrame';`. Update the file's header comment: `PlatformLayout` is now the shell for **suite pages only** (`/` and `/account`); `AppFrame` is the shell for `/app/:appSlug` and mounts no suite header.
  Then `rm client/src/components/layout/AppShell.tsx`.
- **Guardrails:** the child route order (`path="*"` before `index`) is unchanged — do not reorder it.
- **Proof:** `cd client && npm run typecheck` exits 0, and `grep -r "AppShell" client/src` returns **no matches**.
- **If it fails:** a leftover `AppShell` import → remove it. Do not re-create the file.
- **Owes:** `docs/architecture.md` mentions `AppShell` at lines 68, 211 — paid in Step 16.

---

### Step 4 — CSS: drop the dead app-shell rules, add the two `app-topbar` overrides

- **Depends on:** Step 3
- **Skill:** none (CSS)
- **Read first:** `client/src/index.css` — in particular its header comment on cascade layers. Hand-written rules in this file are **unlayered**, so they beat every Tailwind utility regardless of specificity. That is why the two overrides below are required and why `mt-0` as a utility would not work.
- **Files:** `client/src/index.css` (edit)
- **Contract:**
  1. **Delete** the `.app-main:has(.app-shell) { max-width: 90rem; }` rule and its two-line comment (currently lines 174-179). The selector can no longer match — `.app-shell` is gone and apps no longer render inside `.app-main`.
  2. **Delete** `.app-shell`, `.app-shell__header`, and `.app-shell__title` (currently lines 275-289).
  3. **Add**, at the end of the file, this block verbatim:
     ```css
     /* ------------------------------------------------- the app frame (top bar) */

     /*
       `.btn` and `.muted` are unlayered rules with their own margins, and
       unlayered CSS beats every Tailwind utility — so `mt-0` in the markup would
       do nothing. Scoped resets are the fix, not `!important`.
     */
     .app-topbar .btn {
       margin-top: 0;
     }

     .app-topbar .muted {
       margin: 0;
     }
     ```
- **Guardrails:** do not add `!important` anywhere. Do not touch `.app-header`, `.app-main` or `.app-grid` — `PlatformLayout` still uses them for `/` and `/account`.
- **Proof:** `cd client && npm test` → **8 files, 47 tests, all passing** (this slice is presentational; no test should change yet). Then `grep -c "app-shell" client/src/index.css` returns `0`.
- **If it fails:** a failing test here means a component depended on a deleted rule — fix the component's own classes, do not restore the rule.
- **Owes:** nothing.

---

### Step 5 — Visual check of Slice A

- **Depends on:** Step 4
- **Skill:** `run`
- **Files:** none
- **Contract:** start the stack, log in, and confirm by eye:
  - `/` and `/account` still show the full `AutoLedger` suite header — unchanged.
  - `/app/ledger-core` shows **no** suite header. The top bar reads `⬒ AutoLedger / LedgerCore` on the left and org switcher · org chip · email · Sign out on the right, all vertically centred in a 3.5rem bar.
  - Clicking `AutoLedger` in the top bar navigates to `/`.
  - The Sign-out button is centred (this is the `.app-topbar .btn` override doing its job).
- **Proof:** `cd server && npm run dev` and `cd client && npm run dev`, then the four checks above.
- **If it fails:** a mis-centred button means Step 4's CSS block was not added or was added inside a `@layer`. Do not reach for `!important`.
- **Owes:** nothing.

---

# Slice B — The sidebar becomes a real rail

**Outcome:** LedgerCore's navigation is a full-height, grouped, sticky left rail rather than a 13rem column of six flat links.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| File (kept, rewritten) | `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx`, default export `LedgerCoreSidebar` |
| Constant | `NAV_GROUPS` (replaces `NAV`) |
| Nav labels (**unchanged — tests match on them**) | `Dashboard`, `Chart of Accounts`, `Journal Entries`, `Trial Balance`, `Reports`, `Settings` |
| Group headings (new) | `Overview`, `Bookkeeping`, `Reporting`, `Configure` |
| Layout owner | `AppPages` inside `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` |

---

### Step 6 — `LedgerCoreSidebar` as a grouped sticky rail

- **Depends on:** Step 4
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` in full — **keep its header comment about absolute `${base}/${to}` paths and keep that link-building rule exactly.** Relative `to` values are a known bug here (see `client/src/apps/useAppBasePath.ts`).
- **Files:** `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` (edit)
- **Contract — replace `NAV` with exactly this:**
  ```tsx
  const NAV_GROUPS = [
    { heading: 'Overview', items: [
      { to: '', label: 'Dashboard', icon: LayoutDashboard, end: true },
    ] },
    { heading: 'Bookkeeping', items: [
      { to: 'accounts', label: 'Chart of Accounts', icon: ListTree, end: false },
      { to: 'journals', label: 'Journal Entries', icon: BookOpen, end: false },
    ] },
    { heading: 'Reporting', items: [
      { to: 'trial-balance', label: 'Trial Balance', icon: Scale, end: false },
      { to: 'reports', label: 'Reports', icon: FileBarChart, end: false },
    ] },
    { heading: 'Configure', items: [
      { to: 'settings', label: 'Settings', icon: SettingsIcon, end: false },
    ] },
  ] as const;
  ```
  Markup:
  ```tsx
  <nav aria-label="LedgerCore" className="md:w-60 md:shrink-0 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto border-b md:border-b-0 md:border-r border-[var(--border)] md:pr-3 md:py-5">
    <div className="flex md:flex-col gap-1 md:gap-6 overflow-x-auto md:overflow-visible pb-2 md:pb-0">
      {NAV_GROUPS.map((group) => (
        <div key={group.heading} className="flex md:flex-col gap-1">
          <p className="hidden md:block px-3 mb-1 mt-0 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
            {group.heading}
          </p>
          {group.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={label} to={to === '' ? base : `${base}/${to}`} end={end} className={...}>
              <Icon size={16} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </div>
      ))}
    </div>
  </nav>
  ```
  `NavLink` className function — the base list stays as it is today, only the active branch changes:
  ```tsx
  [
    'flex items-center gap-2.5 px-3 py-2 text-sm no-underline rounded-md whitespace-nowrap transition-colors',
    isActive
      ? 'bg-[var(--panel)] text-[var(--text)] font-medium shadow-[inset_2px_0_0_var(--good)]'
      : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel)]',
  ].join(' ')
  ```
  `md:top-14` and `calc(100vh-3.5rem)` both encode `AppTopBar`'s `h-14`. If that height ever changes, both change with it — say so in the file's header comment.
- **Guardrails:** every `to` is built as an absolute `${base}/${to}` from `useAppBasePath()` — never a bare relative string (rule: see the existing comment). Labels are unchanged; `ledgerCoreNavigation.test.tsx` queries them by regex.
- **Proof:** `cd client && npm test -- ledgerCoreNavigation` → all 6 tests pass unchanged.
- **If it fails:** an `aria-current` assertion failing means `end` was changed on an item — restore the values in the table above. Do not edit the test.
- **Owes:** nothing.

---

### Step 7 — `AppPages` lays out rail + content

- **Depends on:** Step 6
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` in full. **Do not touch `LedgerCoreGate`** — the onboarding gate, its two `<Navigate>` targets, and the `LedgerSettingsProvider` wrapper stay exactly as they are. `OnboardingPage` and the gate's loading branch use `.shell` / `.shell--narrow`, which already centre and pad themselves, so they need no wrapper now that `AppFrame`'s `<main>` has no padding.
- **Files:** `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` (edit — `AppPages` only)
- **Contract — `AppPages`'s wrapper becomes exactly:**
  ```tsx
  <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
    <LedgerCoreSidebar />
    <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
      <Routes>{/* unchanged */}</Routes>
    </div>
  </div>
  ```
  The old `grid grid-cols-1 md:grid-cols-[13rem_1fr] gap-6` is removed — the rail sets its own `md:w-60`. The `<Routes>` block, including the `path="*"` → `<Navigate to={base} replace />` catch-all, is copied over unchanged.
- **Guardrails:** the catch-all's target must stay the absolute `base`, not `""` — a relative target loops forever (the file's own comment records this bug).
- **Proof:** `cd client && npm test` → **8 files, 47 tests, all passing.**
- **If it fails:** a looping-redirect test failing means the `<Routes>` block was retyped rather than copied — copy it verbatim.
- **Owes:** nothing.

---

# Slice C — Give the tiles somewhere to go: trial balance type filter

**Outcome:** `/app/ledger-core/trial-balance?type=Asset` shows only asset rows, with a clearable chip. Client-side only — the server endpoint is untouched.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| File | `client/src/Pages/ledger-core/TrialBalancePage.tsx` |
| Query param | `type` |
| Allowed values | `Asset`, `Liability`, `Equity`, `Revenue`, `Expense` (exactly the five — rule 12) |
| Whitelist constant | `FILTERABLE_TYPES` in `TrialBalancePage.tsx` |
| Filtered footer label | `Totals — all accounts` |
| Unfiltered footer label | `Totals` (unchanged) |

---

### Step 8 — `?type=` filter on the trial balance

- **Depends on:** Step 7
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/TrialBalancePage.tsx` in full — it already has a `hideEmpty` client-side filter over `report.rows`; the type filter composes with it in the same `visible` expression.
- **Files:** `client/src/Pages/ledger-core/TrialBalancePage.tsx` (edit)
- **Contract:**
  ```tsx
  import { useSearchParams } from 'react-router-dom';
  import type { AccountType } from '../../services/fetchServices';

  const FILTERABLE_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

  function readTypeParam(raw: string | null): AccountType | null {
    return raw !== null && (FILTERABLE_TYPES as readonly string[]).includes(raw)
      ? (raw as AccountType)
      : null;
  }
  ```
  In the component:
  ```tsx
  const [params, setParams] = useSearchParams();
  const activeType = readTypeParam(params.get('type'));
  ```
  `visible` becomes:
  ```tsx
  report.rows.filter(
    (row) =>
      (!hideEmpty || row.debitCents !== 0 || row.creditCents !== 0) &&
      (activeType === null || row.type === activeType),
  )
  ```
  When `activeType !== null`, render this immediately below the balance banner and above the table:
  ```tsx
  <div className="flex items-center gap-2 text-sm">
    <span className="chip">Type: {activeType}</span>
    <button
      type="button"
      className="btn btn--ghost"
      style={{ marginTop: 0 }}
      onClick={() => { setParams({}, { replace: true }); }}
    >
      Clear filter
    </button>
  </div>
  ```
  The `<tfoot>` label is `activeType === null ? 'Totals' : 'Totals — all accounts'`. **The totals themselves stay unfiltered** — they are the proof the books balance, and a filtered subtotal would not be. The label change is what makes that honest.
  An unrecognised `?type=` value (`?type=Bogus`) is treated as no filter — `readTypeParam` returns `null` and every row shows. Do not throw and do not redirect.
- **Guardrails:** rule 12 — exactly five account types, never a sixth. `readTypeParam` whitelists rather than casting the raw string. No server change: do not add `type` to `getTrialBalance` in `fetchServices.ts`.
- **Proof:** `cd client && npm run typecheck` exits 0 and `cd client && npm test` → 47 tests passing. Covered by a named test in Step 15.
- **If it fails:** if `useSearchParams` throws outside a router, the component is being rendered without one — that is a test-setup issue, fix the test's wrapper, not the component.
- **Owes:** `docs/api.md` gets **no change** — this is client-only filtering. Note that explicitly in Step 16.

---

# Slice D — Interactive, graphic dashboard

**Outcome:** the four position figures become clickable tiles that drill into a filtered trial balance; a stacked equation bar shows Assets against Liabilities + Equity + earnings; the performance cards get proportion bars and a signed net-income indicator; the trend chart gains a hover readout.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| New component | `MetricTile` — `client/src/Pages/ledger-core/MetricTile.tsx`, default export |
| New component | `EquationBar` — `client/src/Pages/ledger-core/EquationBar.tsx`, default export |
| New component | `ProportionBar` — `client/src/Pages/ledger-core/ProportionBar.tsx`, default export |
| Edited | `TrendChart` — `client/src/Pages/ledger-core/TrendChart.tsx` |
| Edited | `DashboardPage` — `client/src/Pages/ledger-core/DashboardPage.tsx` |
| SVG bar marker | `data-bar` attribute on each of the 12 value bars |
| SVG hover marker | `data-hit` attribute on each of the 6 transparent hit areas |

**Three assertions in `client/src/__tests__/ledgerCoreDashboard.test.tsx` constrain this slice. Read them before writing any of it:**

1. `findByText('1000.00')` — the formatted amount must stay its **own text node**. Render the currency code in a **separate `<span>`**, never concatenated into the same node.
2. `getByText('—')` — the em-dash cash placeholder must appear **exactly once** on the page, and the caption `/no cash account configured/i` must survive verbatim.
3. `getByRole('status')` — there must be **exactly one** `role="status"` element on the dashboard (the integrity banner). No new component in this slice may use `role="status"`.

---

### Step 9 — `MetricTile`

- **Depends on:** Step 8
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/DashboardPage.tsx:73-107` (the four tiles you are replacing) and `client/src/Pages/ledger-core/ReportsPage.tsx` (the `card app-card` link idiom this mirrors).
- **Files:** `client/src/Pages/ledger-core/MetricTile.tsx` (new)
- **Contract — write these literally:**
  ```tsx
  import type { LucideIcon } from 'lucide-react';

  export interface MetricTileProps {
    label: string;
    /** `null` renders the em-dash placeholder instead of an amount. */
    valueCents: number | null;
    /** Base currency code, e.g. "USD". Rendered as its own muted <span>. */
    currency: string;
    icon: LucideIcon;
    tone: 'neutral' | 'good' | 'bad';
    /** Absolute path. `null` renders a non-interactive <div> instead of a <Link>. */
    to: string | null;
    /** Small caption under the value. `null` renders nothing. */
    hint: string | null;
  }

  export default function MetricTile(props: MetricTileProps): React.JSX.Element;
  ```
  Inner content, identical in both the link and non-link cases:
  ```tsx
  <>
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">{label}</p>
      <Icon size={16} aria-hidden="true" className={toneIconClass} />
    </div>
    {valueCents === null ? (
      <p className="text-2xl font-semibold m-0 mt-2">—</p>
    ) : (
      <p className="text-2xl font-semibold m-0 mt-2 tabular-nums">
        <span>{formatCents(valueCents)}</span>{' '}
        <span className="text-xs font-normal text-[var(--muted)]">{currency}</span>
      </p>
    )}
    {hint !== null && <p className="text-xs text-[var(--muted)] m-0 mt-1.5">{hint}</p>}
  </>
  ```
  `toneIconClass` map, exactly:
  ```tsx
  const TONE_ICON: Record<MetricTileProps['tone'], string> = {
    neutral: 'text-[var(--muted)]',
    good: 'text-[var(--good)]',
    bad: 'text-[var(--bad)]',
  };
  ```
  Wrapper when `to !== null`:
  ```tsx
  <Link to={to} className="card no-underline text-inherit block transition-colors hover:border-[var(--good)] focus-visible:border-[var(--good)]">
  ```
  Wrapper when `to === null`: the same element as a `<div className="card">` with no hover classes.
  `formatCents` is imported from `./money`. **Do not** add a currency symbol — `money.ts` documents that it emits none and the caller adds one; here the caller adds the code, in a separate span.
- **Guardrails:** rule 3 — `valueCents` is integer cents, formatted by `formatCents`; never divide by 100 inline. The value and currency stay in separate text nodes (test constraint 1).
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** do not proceed to Step 10.
- **Owes:** nothing.

---

### Step 10 — `ProportionBar` and `EquationBar`

- **Depends on:** Step 9
- **Skill:** none (client components)
- **Read first:** `client/src/Pages/ledger-core/TrendChart.tsx` — copy its "hand-rolled, no charting library" header comment style and its `visually-hidden` table idiom for the accessible fallback.
- **Files:** `client/src/Pages/ledger-core/ProportionBar.tsx` (new), `client/src/Pages/ledger-core/EquationBar.tsx` (new)
- **Contract — `ProportionBar`:**
  ```tsx
  export interface ProportionBarSegment {
    label: string;
    valueCents: number;
    /** A CSS colour, e.g. 'var(--good)'. */
    color: string;
  }

  export default function ProportionBar({
    segments,
    currency,
  }: {
    segments: ProportionBarSegment[];
    currency: string;
  }): React.JSX.Element;
  ```
  Plain divs, no SVG. `const total = segments.reduce((s, x) => s + Math.abs(x.valueCents), 0);`
  When `total === 0`, render a single flat track: `<div className="h-2 rounded-full bg-[var(--border)]" />` and nothing else — **do not divide by zero.**
  Otherwise:
  ```tsx
  <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--border)]" aria-hidden="true">
    {segments.map((s) => (
      <div key={s.label}
           title={`${s.label}: ${formatCents(s.valueCents)} ${currency}`}
           style={{ width: `${String((Math.abs(s.valueCents) / total) * 100)}%`, background: s.color }} />
    ))}
  </div>
  ```
  Below it, a legend row: for each segment a `<span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">` with a `2.5`-square swatch (`style={{ background: s.color }}`) and the label.
  **`aria-hidden="true"` on the bar is deliberate** — every number it encodes is already in the `<dl>` beside it, so exposing the bar would duplicate it for screen readers.
- **Contract — `EquationBar`:**
  ```tsx
  export default function EquationBar({
    assetsCents,
    liabilitiesCents,
    equityCents,
    currentEarningsCents,
    currency,
    holds,
  }: {
    assetsCents: number;
    liabilitiesCents: number;
    equityCents: number;
    currentEarningsCents: number;
    currency: string;
    holds: boolean;
  }): React.JSX.Element;
  ```
  Two stacked tracks of the same full width, scaled against a shared denominator so the two sides are visually comparable:
  ```tsx
  const rightTotal = liabilitiesCents + equityCents + currentEarningsCents;
  const scale = Math.max(1, Math.abs(assetsCents), Math.abs(rightTotal));
  ```
  Track 1, labelled `Assets`: one segment, `width: ${(Math.abs(assetsCents) / scale) * 100}%`, `background: var(--good)`.
  Track 2, labelled `Liabilities + Equity + Earnings`: three segments in that order with widths `Math.abs(x) / scale * 100`% and colours `#f0883e`, `#6e7bff`, `#3fb950` respectively (literal hexes — these three have no token and must not invent one).
  Each track is `h-2.5 rounded-full bg-[var(--border)] overflow-hidden flex`, each segment carries a `title` of `` `${label}: ${formatCents(v)} ${currency}` ``.
  A legend row lists the four labels with swatches.
  When `holds === false`, wrap the whole component in `<div className="ring-1 ring-inset ring-rose-500/40 rounded-lg p-3">`; when `true`, no ring.
  **`EquationBar` must not use `role="status"`** (test constraint 3) and must not render a lone `—` (test constraint 2).
- **Guardrails:** rule 3 — every input is integer cents; the only division is the width percentage, which is presentation, never a money value. `scale` is floored at `1` so a brand-new organization with all zeros renders empty tracks rather than `NaN%`.
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** do not proceed to Step 11.
- **Owes:** nothing.

---

### Step 11 — `TrendChart` gains a hover readout

- **Depends on:** Step 10
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/TrendChart.tsx` in full, and `client/src/__tests__/ledgerCoreDashboard.test.tsx:122-129` (the assertion this step changes).
- **Files:** `client/src/Pages/ledger-core/TrendChart.tsx` (edit)
- **Contract:**
  1. Add `data-bar` to **both** `<rect>` elements inside each group (the 12 value bars keep their existing geometry and fills).
  2. Add, per group, **one** transparent full-height hit area, after the two bars:
     ```tsx
     <rect
       data-hit
       x={x}
       y={CHART_TOP}
       width={groupWidth}
       height={CHART_HEIGHT}
       fill="transparent"
       onMouseEnter={() => { setHovered(index); }}
       onMouseLeave={() => { setHovered(null); }}
     />
     ```
  3. `const [hovered, setHovered] = useState<number | null>(null);`
  4. The readout, rendered between the `<svg>` and the legend — the hovered month, or the **last** point when nothing is hovered:
     ```tsx
     const shown = points[hovered ?? points.length - 1];
     ```
     ```tsx
     {shown !== undefined && (
       <p className="text-xs text-[var(--muted)] m-0 tabular-nums">
         {monthLabel(shown.month)} · Revenue {formatCents(shown.revenueCents)} · Expenses{' '}
         {formatCents(shown.expenseCents)} · Net{' '}
         {formatCents(shown.revenueCents - shown.expenseCents)}
       </p>
     )}
     ```
     `points` can be empty in principle, so the `shown !== undefined` guard is required — do not use a non-null assertion.
  5. **Keep `aria-hidden="true"` on the `<svg>` and keep the `visually-hidden` table unchanged.** The interaction is hover-only and adds nothing focusable, so screen-reader users lose nothing — the table already carries every value. **Do not add `tabIndex` to the hit rects**; a focusable element inside an `aria-hidden` subtree is an accessibility bug.
- **Guardrails:** rule 14 — still no charting library. The readout's "Net" is computed as integer cents subtraction, never a float.
- **Proof:** `cd client && npm test -- ledgerCoreDashboard` fails **only** on the `svg rect` count (12 → 18). That is expected; Step 12 fixes the assertion. Verify no other assertion in that file fails.
- **If it fails on anything else:** the readout text is colliding with another query — adjust the readout wording, not the test.
- **Owes:** the test edit in Step 12.

---

### Step 12 — Update the one dashboard test whose spec changed

- **Depends on:** Step 11
- **Skill:** none (test edit)
- **Files:** `client/src/__tests__/ledgerCoreDashboard.test.tsx` (edit — **one assertion only**)
- **Contract:** in `it('renders exactly 6 bar groups for a 6-point trend')`, replace
  ```ts
  expect(container.querySelectorAll('svg rect')).toHaveLength(12);
  ```
  with
  ```ts
  // Two value bars per month, six months. `[data-bar]` excludes the six
  // transparent hover hit areas, which are interaction surface, not data.
  expect(container.querySelectorAll('svg rect[data-bar]')).toHaveLength(12);
  ```
  Add a second assertion in the same test:
  ```ts
  expect(container.querySelectorAll('svg rect[data-hit]')).toHaveLength(6);
  ```
  **This is the only permitted test edit in Slice D.** Every other assertion in this file stays exactly as it is — they are the spec the new components must satisfy. If another one fails, the component is wrong.
- **Guardrails:** the count `12` is unchanged — the assertion was narrowed to the right elements, not weakened.
- **Proof:** `cd client && npm test -- ledgerCoreDashboard` → all tests in the file pass.
- **If it fails:** a still-failing count means `data-bar` was put on the group `<g>` instead of the `<rect>`s. Fix the component.
- **Owes:** nothing.

---

### Step 13 — Recompose `DashboardPage`

- **Depends on:** Step 12
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/DashboardPage.tsx` in full, and the three test constraints at the head of Slice D.
- **Files:** `client/src/Pages/ledger-core/DashboardPage.tsx` (edit)
- **Contract:**
  - Add `const currency = organization?.baseCurrency ?? '';` beside the existing `const { organization } = useOrg();`.
  - Keep the loading skeleton, the error branch, the `entryTotalCents` helper, the recent-entries table (including the `Link to={`${base}/journals`}` on the date — `ledgerCoreNavigation.test.tsx:275-280` asserts that `href`), and the integrity banner with `role="status"` **exactly as they are**.
  - **Replace** the four `.card` position blocks with four `MetricTile`s in this order, with exactly these props:

    | label | valueCents | icon (`lucide-react`) | tone | to | hint |
    |---|---|---|---|---|---|
    | `Assets` | `position.assetsCents` | `Wallet` | `neutral` | `${base}/trial-balance?type=Asset` | `null` |
    | `Liabilities` | `position.liabilitiesCents` | `CreditCard` | `neutral` | `${base}/trial-balance?type=Liability` | `null` |
    | `Equity` | `position.equityCents` | `PiggyBank` | `neutral` | `${base}/trial-balance?type=Equity` | `null` |
    | `Cash` | `position.cashCents` | `Banknote` | `good` | see below | see below |

    Cash tile: when `position.cashCents === null`, `to` is `` `${base}/settings` `` and `hint` is the exact string `'No cash account configured — set one in Settings.'`; otherwise `to` is `` `${base}/trial-balance?type=Asset` `` and `hint` is `null`. This keeps the single `—` and the caption the existing tests assert on.
  - **Insert** an `EquationBar` in a `.card` directly below the tile grid, headed `<p className="text-sm font-medium m-0 mb-3">Accounting equation</p>`, with props `assetsCents={position.assetsCents} liabilitiesCents={position.liabilitiesCents} equityCents={position.equityCents} currentEarningsCents={position.currentEarningsCents} currency={currency} holds={position.equationHolds}`.
    Keep the existing `!position.equationHolds` warning paragraph above the grid unchanged — the ring on the bar reinforces it, it does not replace it.
  - In **each** performance card (`This fiscal year`, `This month`), after the existing `<dl>`, add:
    ```tsx
    <div className="mt-3">
      <ProportionBar
        segments={[
          { label: 'Revenue', valueCents: p.revenueCents, color: 'var(--good)' },
          { label: 'Expenses', valueCents: p.expenseCents, color: 'var(--bad)' },
        ]}
        currency={currency}
      />
    </div>
    ```
    and put a `TrendingUp`/`TrendingDown` icon (`size={15}`, `aria-hidden="true"`) immediately before the net-income `<dd>` value — `TrendingDown` when `netIncomeCents < 0`, `TrendingUp` otherwise. The existing inline `style={{ color: ... < 0 ? 'var(--bad)' : undefined }}` on the `<dd>` stays.
  - Wrap the tile grid in `<div className="grid">` as today (`index.css`'s `auto-fit / minmax` grid) — do not replace it with bespoke column counts.
- **Guardrails:** exactly one `role="status"` on the page (the integrity banner). Exactly one `—` (the cash placeholder). `formatCents` output and the currency code stay in separate text nodes. Rule 3 — all arithmetic is integer cents.
- **Proof:** `cd client && npm test` → **8 files, 47 tests, all passing** (Step 12's edit is already in). Then `cd client && npm run typecheck` exits 0.
- **If it fails:** `getByText('—')` "found multiple" means a component in Step 10 rendered a dash — remove it there. `getByRole('status')` "found multiple" means a new component used `role="status"` — remove it.
- **Owes:** nothing.

---

### Step 14 — Visual check of Slices B–D

- **Depends on:** Step 13
- **Skill:** `run`
- **Files:** none
- **Contract:** with the stack running and an onboarded organization holding at least one journal entry, confirm:
  - The rail is full height, sticky under the top bar, and shows four group headings on a desktop width; it collapses to a horizontal scrolling strip below `md` with the headings hidden.
  - The active nav item shows the inset green edge.
  - Clicking the **Assets** tile lands on `/app/ledger-core/trial-balance?type=Asset`, the table shows only asset rows, a `Type: Asset` chip and a `Clear filter` button appear, and the footer reads `Totals — all accounts`.
  - `Clear filter` returns to `/app/ledger-core/trial-balance` with every row back.
  - The **Cash** tile with no cash account configured shows `—` and links to Settings.
  - Hovering a month in the trend chart changes the readout line under it.
- **Proof:** the six checks above, by eye.
- **If it fails:** a tile that navigates but does not filter means Step 8's `readTypeParam` whitelist rejected the value — check the capitalisation (`Asset`, not `asset`).
- **Owes:** nothing.

---

# Tail — tests, review, study notes, docs

### Step 15 — New tests

- **Depends on:** Step 14
- **Skill:** none (client tests; `isolation-test` does not apply — no server code changed, and LedgerCore's cross-tenant isolation tests already exist server-side and are untouched)
- **Read first:** `client/src/__tests__/ledgerCoreNavigation.test.tsx` in full — reuse its `session`, `baseSettings`, `onboarded`, `mockRoutes`, `renderAt` and `LocationProbe` helpers rather than writing new ones.
- **Files:** `client/src/__tests__/ledgerCoreNavigation.test.tsx` (edit — **append** tests, change none)
- **Contract — add exactly these four tests:**
  1. `it('the Assets tile links to the trial balance filtered by type')` — `renderAt('/app/ledger-core', onboarded)`; `const tile = await screen.findByRole('link', { name: /assets/i })`; expect `href` to be `'/app/ledger-core/trial-balance?type=Asset'`.
  2. `it('the cash tile links to settings when no cash account is configured')` — the shared `emptyDashboard` fixture already has `cashCents: null`; expect the link named `/cash/i` to have `href` `'/app/ledger-core/settings'`.
  3. `it('a type filter narrows the trial balance and can be cleared')` — `renderAt('/app/ledger-core/trial-balance?type=Liability', onboarded)`. Extend `mockRoutes`'s trial-balance branch to return two rows — one `type: 'Asset'` named `Operating Cash`, one `type: 'Liability'` named `Accounts Payable`, both with non-zero `debitCents`/`creditCents` so `hideEmpty` keeps them. Expect `Accounts Payable` present and `Operating Cash` absent; click `Clear filter`; expect both present and `pathname()` to be `'/app/ledger-core/trial-balance'`.
  4. `it('an unrecognised type parameter shows every row')` — `renderAt('/app/ledger-core/trial-balance?type=Bogus', onboarded)`; expect both rows present and **no** `Clear filter` button.
  Test 3 requires adding the two rows and their `totalDebitCents`/`totalCreditCents` to the existing trial-balance mock. Tests 1, 2 and 4 must not need any new mock branch.
- **Guardrails:** rule 15 — a module ships tests. These four are the proof that the tiles are genuinely interactive rather than decorative.
- **Proof:** `cd client && npm test` → **8 files, 51 tests, all passing** (47 + 4).
- **If it fails:** an ambiguous `findByRole('link', { name: /assets/i })` means the rail or another tile also matches — narrow with `{ name: /^assets/i }`, never by deleting the assertion.
- **Owes:** nothing.

---

### Step 16 — `docs-sync`

- **Depends on:** Step 15
- **Skill:** `docs-sync`
- **Files:** `docs/architecture.md` (edit), `docs/roadmap.md` (edit), `CLAUDE.md` (edit)
- **Contract — the specific drift this change creates:**
  - `docs/architecture.md:68` names `components/layout/AppShell.tsx` as a Phase 2 file — add a note that it was replaced by `AppFrame.tsx` + `AppTopBar.tsx` in this revision.
  - `docs/architecture.md:210-211` — the file tree lists `AppShell.tsx  ← per-app chrome, mounted at /app/:appSlug`. Replace with `AppFrame.tsx` and `AppTopBar.tsx`, and correct the `PlatformLayout.tsx` comment to say it is now suite chrome for `/` and `/account` **only**.
  - `docs/architecture.md:60` names `LedgerCoreSidebar` — still correct; note only that it is now a grouped full-height rail.
  - Add to `docs/architecture.md` a short paragraph on the route tree: apps are siblings of `PlatformLayout` under `ProtectedRoute`, not children, and `AppFrame` reproduces `PlatformLayout`'s org remount key because the onboarding gate depends on it.
  - `docs/roadmap.md` — under **§ Phase 3.5, as delivered** (line 144), append a dated sub-note: *"UX revision, 2026-09-03: the suite header no longer wraps an app; `AppShell` became `AppFrame` + `AppTopBar`, the LedgerCore sidebar became a grouped full-height rail, the dashboard's position figures became links into a client-side `?type=` trial-balance filter, and the trend chart gained a hover readout. **No phase renumbering; Phase 4 remains unstarted.**"*
  - `CLAUDE.md` — in the Phase 3.5 bullet, `client sidebar replacing the tab strip` becomes `client rail plus an app-owned top bar (the suite header does not wrap an app)`.
  - **`docs/api.md` gets no edit.** The `?type=` filter is client-side over already-fetched rows; the server endpoint is unchanged. Do not document a server parameter that does not exist.
  - **`docs/schema.md` gets no edit.** No migration ran.
- **Guardrails:** claiming something works when it does not is worse than saying nothing. Do not describe P&L, balance sheet, or fiscal periods as affected — they were not touched.
- **Proof:** `grep -rn "AppShell" docs/ CLAUDE.md` returns **no matches** except any explicitly historical "was replaced by" sentence. `grep -n "type=" docs/api.md` returns no trial-balance match.
- **If it fails:** a stray `AppShell` reference in a historical Phase 2 paragraph is acceptable **only** if the sentence says it was replaced.
- **Owes:** nothing.

---

### Step 17 — `study-note`

- **Depends on:** Step 16
- **Skill:** `study-note`
- **Read first:** `docs/study-notes.md` for the required sections and accuracy bar; `study/react/routing-nested-and-dynamic-segments.md` and `study/react/utility-first-css-tailwind.md` — both are **extended**, not replaced.
- **Files:** `study/react/routing-nested-and-dynamic-segments.md` (edit), `study/react/utility-first-css-tailwind.md` (edit), `study/README.md` (edit)
- **Contract — add exactly these sections:**
  - To `routing-nested-and-dynamic-segments.md`:
    - **"Where chrome is mounted is a routing decision, not a CSS one."** Mechanism: a layout route contributes an `<Outlet/>` and no path segment; moving `/app/:appSlug` from a child of `PlatformLayout` to a sibling under `ProtectedRoute` removes the suite header by *not mounting it*, rather than hiding it with `useMatch` + a conditional. Cover the alternative rejected (conditional rendering inside one layout) and why it is worse: hidden coupling, and the header still mounts and fetches. Cover the consequence that `AppFrame` must re-declare the org remount `key`, because the remount behaviour lived in the parent that is no longer there — a concrete example of behaviour that a layout route silently owns.
    - **"`useSearchParams`: filter state that survives a link, a reload, and the back button."** Mechanism: `useSearchParams` reads `location.search` and returns a `URLSearchParams` plus a setter that pushes (or with `{ replace: true }` replaces) a history entry; it is `useState` whose store is the URL. Why the trial-balance type filter uses it rather than component state: the dashboard tile has to be able to *link* to a filtered view, and a `useState` filter is unaddressable. Cover the whitelist (`readTypeParam`) and why an unrecognised value degrades to "no filter" rather than throwing. Cover the honesty problem it created — the footer totals stay unfiltered and are relabelled, because a filtered subtotal would not prove the books balance.
  - To `utility-first-css-tailwind.md`:
    - **"Unlayered CSS beat the utility again: the `.app-topbar` overrides."** Mechanism recap: `index.css`'s hand-written `.btn { margin-top: 1rem }` is unlayered and beats every layered Tailwind utility regardless of specificity, so `mt-0` in the markup emits nothing usable. Why the fix was a scoped unlayered rule rather than `!important`. Tie it to the removal of `.app-main:has(.app-shell)` — a `:has()` selector standing in for a routing fact, which the route restructure made unnecessary.
  - Both additions need **4–8 interview questions with full written answers** between them, per `docs/study-notes.md`. State the verified versions: `react-router-dom` 7.18.3, Tailwind 4.3.3, React 19.2.8 (from `client/package.json`).
  - Update the two `study/README.md` **React** table rows so their "Covers" cells name the new sections, and update the coverage tracker.
- **Guardrails:** accuracy outranks completeness — verify each claim against the files in this repo before writing it. Flag anything uncertain rather than asserting it.
- **Proof:** `grep -c "useSearchParams" study/react/routing-nested-and-dynamic-segments.md` ≥ 1, and `study/README.md`'s two React rows mention the new sections.
- **If it fails:** nothing to fail mechanically — re-read `docs/study-notes.md` and check the section list.

---

### Step 18 — `guardrail-review` and close the plan

- **Depends on:** Step 17
- **Skill:** `guardrail-review`
- **Files:** the full diff; then `plans/ledger-core-shell-and-dashboard-ux.md` (edit)
- **Contract:** run `guardrail-review` over `git diff`. This change touches **no server file**, so most of the sixteen rules are trivially satisfied — the review must confirm that fact rather than assume it. The rules that actually bite here:
  - **Rule 3** — every amount on the client stays integer cents through `formatCents`; the only division introduced is a width percentage.
  - **Rule 12** — `FILTERABLE_TYPES` lists exactly five account types.
  - **Rule 14** — no new package. Confirm `client/package.json` is byte-identical: `git diff --stat client/package.json` shows nothing.
  - **Rule 15** — the four new tests in Step 15.
  - **Rule 16** — `LedgerCoreSidebar` still lives under `Pages/ledger-core/`; the platform layer (`AppFrame`, `AppTopBar`) knows only `:appSlug` and the registry, never LedgerCore's pages.
  Then set this file's header to `**Status: DONE — <date>.**` with the final test counts, and add the "historical record, safe to delete" note the Phase 3.5 plan uses.
- **Proof:** `git diff --stat` shows **zero** files under `server/`, and `git status --short` shows no new file outside `client/src/`, `docs/`, `study/`, `plans/`. `cd client && npm test` → 8 files, 51 tests passing. `cd client && npm run build` exits 0.
- **If it fails:** a server file in the diff means the scope was breached — stop and report which file and why.

---

## Risks & open questions

- **The org remount key is the single highest-risk detail.** It moves from `PlatformLayout` to `AppFrame` (Step 2). No test covers it directly — `ledgerCoreOnboarding.test.tsx` renders `LedgerCoreRoutes` without either layout. If it is dropped, switching organizations inside LedgerCore will show the previous org's dashboard and can skip the onboarding wizard, silently. Step 5's visual check with two organizations is the only guard; do it.
- **`h-14` is duplicated as `top-14` and `calc(100vh-3.5rem)`** in the rail. Three places must agree. Step 6 requires a comment saying so. A CSS custom property would be cleaner but adds a token for one consumer; not worth it yet.
- **The trend chart's hover is mouse-only, by design.** Keyboard and screen-reader users get the `visually-hidden` table, which carries every value. If that trade is later judged wrong, the fix is a focusable listbox of months, not `tabIndex` on an `aria-hidden` rect.
- **Assumption made without asking:** the "interactive" tiles drill into the trial balance filtered by account type, because that is the only real destination that exists today. A per-account ledger detail page would be the better destination and does not exist — it is not in this plan and is not Phase 4 either. If the user wanted per-account drilldown, that is a separate plan with a new endpoint.
- **Unknown:** whether the `#f0883e` / `#6e7bff` segment colours read acceptably in the light-mode palette. `index.css` has no token for a third and fourth categorical colour. They are literal hexes here rather than invented tokens; if they read badly in light mode, adding two tokens to `:root` and the `prefers-color-scheme: light` block is the correct fix, not tweaking the hexes in the component.
- **Not verified:** how `AccountsPage`, `JournalEntryPage` and `SettingsPage` look at the new content width (`max-w-[76rem]` instead of the old `90rem` `.app-main`). Step 14 does not check them explicitly; glance at each while the stack is running.

---

## Definition of done

- `cd client && npm test` → **8 files, 51 tests, all passing.**
- `cd client && npm run typecheck` and `cd client && npm run build` both exit 0.
- `git diff --stat` shows **no file under `server/`** and **no change to `client/package.json`**.
- `grep -r "AppShell" client/src` returns nothing.
- Inside `/app/ledger-core` the suite header is gone; a `h-14` top bar carries a small `AutoLedger` link, the app name, and the org/user controls. `/` and `/account` are visually unchanged.
- The four position tiles are links; Assets/Liabilities/Equity reach a filtered trial balance and the unconfigured Cash tile reaches Settings.
- `docs/architecture.md`, `docs/roadmap.md` and `CLAUDE.md` describe the new chrome; `docs/api.md` and `docs/schema.md` are untouched and correct.
- Two React study notes extended with mechanism-level sections and interview Q&A; `study/README.md` updated.
- `guardrail-review` clean; this file marked `Status: DONE`.

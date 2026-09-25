# Modular Monolith: One Deploy, Many Modules — and Merging Apps Into One Product

> AutoLedger runs as one server process over one database, with its domains separated by code folders, routing and table-naming convention rather than by a network boundary — a deliberate trade against microservices. It began as a suite of separately chosen apps (seven at its peak) and in Phase 33 was merged into **one product with three modules**; the second half of this note is how that merge was done without breaking history, URLs already in the wild, or the migration contract.

**Category:** Architecture
**Introduced by:** Phase 2 — the platform/app split, `config/apps.ts`, `/api/v1/<app-slug>/...`; **extended by Phase 33** — the merge into one product (`config/modules.ts`, `/api/v1/*`)
**Verified against:** the codebase as of Phase 2 (2026-08-31); the Phase 33 section against the codebase on 2026-09-25, React Router 7.18.3, React 19.2, PostgreSQL 16

---

## Mechanism

"Modular monolith" describes a specific point on a spectrum, and it's worth being precise about the two axes that actually vary:

1. **Deployment topology** — how many processes does this run as? One (monolith) versus many independently deployable services (microservices).
2. **Code/data organization** — is the code (and, more strongly, the data) partitioned into modules with enforced boundaries, or is everything free to reach into everything else?

A modular monolith is deliberately **one** on axis 1 and **modular** on axis 2 — it borrows microservices' discipline about boundaries without paying microservices' operational cost. AutoLedger's seven apps are modules in this sense: each has its own routes, services, and (mostly) its own tables, but they all run inside the same Express process, share the same database connection pool, and are reachable through the same `apiRouter`.

### What actually enforces the boundary, given there's no network call to stop you

With microservices, the network *is* the enforcement — App A physically cannot query App B's database, because there's no connection to it. In a monolith, nothing stops a service in `services/capture/` from writing `SELECT * FROM journal_entries` directly; the tables are one `pg` Pool connection away. The boundary is therefore a **convention enforced by review and by a stated rule** (guardrail 16: "no app reads another app's tables directly"), not a mechanism the runtime refuses to violate. This is the honest trade-off, and worth stating plainly rather than implying the isolation is stronger than it is: a modular monolith's modularity is a discipline, not a guarantee.

Three things make the discipline enforceable in practice, in ascending order of how deliberately AutoLedger applies them:

- **A single source of truth for the boundary itself.** `server/src/config/apps.ts` is the one place that says which apps exist. A route, a table prefix, or a `source_type` value that isn't in that list is a bug by definition — there's one place to check, not tribal knowledge.
- **A routing convention that makes the boundary visible in every URL.** `/api/v1/<app-slug>/<module>` means you can tell which app owns an endpoint by reading the path, and a code reviewer scanning a diff for `ap-flow` code that touches a `ledger-core` route is looking for a specific, greppable string mismatch.
- **A prescribed integration point for the one thing apps legitimately need to share.** LedgerCore's General Ledger is the exception to "apps don't touch each other's tables" — every other app posts into it through `journalService`, tagging `source_type` (the app slug) and `source_id`, rather than either duplicating money-handling logic per app or reaching into `journal_entries` directly. One narrow, named door, instead of either a locked wall or no wall at all.

### Where the app slug does *not* apply: the security boundary is unchanged

It would be a mistake to treat `/<app-slug>/` as if it were doing the job `org_id` does — it isn't, and conflating the two is exactly the kind of bug the rule anticipates. `org_id`, resolved only from the verified access token, remains the sole predicate that decides *which rows* a query can touch. The app slug decides *which router handles the request* — a routing concern, resolved once, before any query runs. A request to `/api/v1/capture/invoices` and a request to `/api/v1/organizations` are scoped by `org_id` identically; the first just happens to be handled by a router that only AP-Flow's code registers. Nothing about being "inside" `ap-flow`'s router grants any wider data access — see [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md) for the mechanism that boundary actually rests on.

### Table naming as the data-layer half of the same convention

The routing convention has a data-layer counterpart: LedgerCore's tables stay unprefixed (`accounts`, `journal_entries`, `ledger_lines`) because it plays the same "shared system of record" role that `organizations` and `users` play for the platform layer — every other app's tables carry an app prefix (`ap_flow_invoices`, `fpa_scenarios`). This is purely a naming convention with no database-level enforcement (Postgres doesn't know or care that `ap_flow_invoices` "belongs" to a particular router), but it makes cross-app leakage visible at the SQL level the same way the URL convention makes it visible at the routing level: a query against a table with the wrong prefix, inside a service file under the wrong app folder, is a pattern a reviewer — or eventually a lint rule — can catch mechanically.

### A second integration point, materialized: the Drive intake dispatcher

Phase 19.3 gave this pattern its first concrete second instance. Drive folder intake is **platform-level** infrastructure (`server/src/services/integrations/`) that must hand a downloaded file to one of two apps — AP-Flow for a vendor bill, LedgerCore for a bank statement — depending on a folder's configured purpose. The naive approach would have the platform service `SELECT`/`INSERT` directly against `ap_flow_documents` or `bank_transactions`, exactly the violation guardrail 16 exists to prevent, just with the platform layer as the offender instead of one app reaching into another.

`driveIntakeDispatcher.ts` is the "one narrow, named door" for this case, and it is deliberately thin — a `switch` on `purpose` calling exactly one function per branch, each an app's own public service function, never its tables:

```ts
switch (target.purpose) {
  case 'VENDOR_BILL':
    return await dispatchVendorBill(target);      // -> captureDocumentService.captureFile(...)
  case 'BANK_STATEMENT':
    return await dispatchBankStatement(target);   // -> bankImportService.importStatement(...)
  default: {
    const _never: never = target.purpose;         // adding a purpose is a compile error until handled
    throw new Error(`Unhandled Drive folder purpose ${String(_never)}`);
  }
}
```

Grepping the file for `pool.query` or `client.query` returns zero matches — the file is proof-by-construction that it cannot violate the boundary it exists to respect, and that grep is literally the file's own build-verification step.

### When the "no FK into an app's table" trade gets real teeth

The routing decision above raised a schema question the earlier text of this note only described in the abstract: the ingestion log (`integration_drive_files`) has to record *which* document a file became, for an operator to trace history — but that document could live in either `ap_flow_documents` or `bank_transactions`, and a platform table hard-wiring a `REFERENCES` into either one would mean adding a new nullable FK column, into a new app's schema, every time a third purpose is added. The resolution is the same `source_type`/`source_id` shape LedgerCore's own GL posting already uses for the identical reason: a generic `(result_app, result_entity_id)` pair, `result_app` a string CHECK-constrained to the known app slugs, `result_entity_id` a bare `UUID` with no `REFERENCES` at all.

**The cost is concrete, not theoretical, and worth being able to name unprompted:** the 052 migration's original design used a real composite FK from the ingestion log into `ap_flow_documents`, with a PG15+ column-list `ON DELETE SET NULL (ap_flow_document_id)` — deleting the AP-Flow document automatically nulled the reference and nothing else. The generic pair gives that up: deleting a document now leaves a `result_entity_id` that points at nothing, silently. That's accepted here specifically because this is an *append-only ingestion log* — the id is a breadcrumb an operator reads, never a value a later query joins against — but it would be the wrong trade for a table where dangling references actually mattered.

## Phase 33: merging the apps into one product

In Phase 33 the "suite of apps" framing went away: LedgerCore, AP-Flow and StockLedger became the **accounting**, **capture** (UI: *Bill inbox*) and **inventory** modules of one product. The modular-monolith shape above did not change — one process, one database, convention-enforced boundaries — but everything that *named* an app did. Five mechanisms were worth getting right.

### 1. Flattening a URL namespace is a collision analysis, not a find-and-replace

Each app had its own prefix, so each could name its resources freely. Removing the prefixes means their names now share one namespace, and they collided in exactly three places: accounting's `/items` and inventory's `/items`, three `/settings` routers, and capture's `/documents` beside the platform vault's `/documents`. The resolution was asymmetric on purpose: the largest module (accounting, ~19 routers) takes the root, `/api/v1/invoices`; the two small ones keep a short prefix, `/api/v1/inventory/*` and `/api/v1/capture/*`.

Mounting a router at `/` has one specific risk: in Express, a router mounted at the root sees *every* request that earlier mounts didn't claim. If that router — or any sub-router — had router-level middleware such as `router.use(authenticate)`, an unknown path like `/api/v1/nope` would answer `401` instead of `404`. AutoLedger's accounting routers apply `authenticate` per route and mount each sub-router on its own path, so unclaimed requests fall through to `notFoundHandler`. That is now pinned by tests: the unknown path and every retired prefix (`/ledger-core`, `/stock`, `/ap-flow`, `/apps`) must `404`.

### 2. Frozen provenance tags: rename the code, not the history

Several tables record which app produced a row: `audit_logs.app_slug` (written by audit triggers whose argument is a literal: `audit_row_change('ledger-core')`), `outbox_events`, `document_links`, `ai_model_calls`, `onboarding_states`, and `integration_drive_files.result_app`, whose CHECK constraint lists two slugs. "The names go away" does not extend to those values:

- `audit_logs` is **append-only** (Phase 5), so its history cannot be rewritten. New rows under a new spelling would split every "what did accounting change?" query into two spellings of the same thing.
- Rewriting the triggers means one migration re-creating ~36 triggers, for zero behavioural gain.

So the old slugs became **internal provenance tags**, frozen, owned by one file (`server/src/config/modules.ts`, `MODULE_TAGS`). Code reads the constant instead of repeating literals. The API exposes the column as `module`. The client maps tag → label (`ledger-core` → "Accounting") in one place and never shows a tag. This is the same instinct as keeping a public API's field names stable: an identifier that is persisted and referenced elsewhere is a contract, and the display name can change freely on top of it.

### 3. URLs you cannot recall need permanent redirects

Browser bookmarks can be broken with a shrug. **Printed QR labels cannot**: each encodes `https://…/app/stock/scan/<kind>/<uuid>`, is stuck to a shelf, and will be scanned for years. So the client keeps one pure mapping function (`legacyTarget(slug, rest)`, unit-tested row by row) behind a single catch-all route, `/app/:appSlug/*`, forever. It preserves query strings and handles the renames (`items` → `/products`, `settings` → `/settings/general`, `/app/ap-flow/usage` → `/settings/ai-usage`). New labels encode `/inventory/scan/…`, and the lookup page's scan regex accepts both shapes. Of all the migration's back-compat surfaces, this is the one that is truly permanent.

### 4. A redirect race that only appears once two navigations share a render

The setup wizard's final step now hands over to an optional inventory step: `applySettings(settings)` (marks the org onboarded) then `navigate('/inventory/setup?welcome=1')`. The `/onboarding` route renders `onboarded ? <Navigate to="/"/> : <Wizard/>`. The user landed on `/`, not step 4. The mechanism, verified in React Router 7.18.3's source:

- The router wraps its location state update in `React.startTransition` (unless transitions are disabled). A `navigate()` is therefore a **low-priority** update.
- `applySettings` is an ordinary `setState`, an **urgent** update. React renders it first, *with the old location still current*. So `/onboarding` re-renders, sees `onboarded === true`, and mounts `<Navigate to="/"/>`.
- `<Navigate>` calls `navigate()` inside a `useEffect`, after that commit. That navigation happens *after* the wizard's own, and the last navigation wins.

The fix is to make the guard decide **once, on arrival**: a `useRef` records whether the org was already onboarded when the route first rendered, and later renders reuse that answer. The general lesson: a `<Navigate>` inside a route is a *reactive* redirect. It fires on any render where its condition holds, including renders caused by the very action that is navigating away. A guard meant for arrival should not re-decide on every render.

### 5. "Additive migrations only" means some dead columns cannot be dropped

The schema audit found no unused tables, but found six columns nothing reads: `ledger_settings.legal_name`/`industry` (moved to `organization_profiles` in `069`) and four Drive columns superseded in `053`. A migration dropping them looked obviously safe, applied cleanly, and then failed the suite's **replay test**. That test deletes `schema_migrations` and re-runs every file against the current schema, to prove the SQL is idempotent and not just the ledger. `053` and `069` both contain one-time backfills that `SELECT` exactly those columns (`INSERT INTO organization_profiles … SELECT s.legal_name … FROM ledger_settings s`). Once the columns are gone, those historical files cannot run.

Under "never edit an applied migration" and "no squash", the correct outcome is to **keep the columns** and document why. The failure also cascaded: the replay aborted midway, after re-running `031`'s original status CHECK but before `054`–`056` relaxed it, which left that test database in a state a later, unrelated test tripped over. A replayable migration history is a real constraint on schema cleanup: **you cannot drop a column that an earlier migration reads**. The ways out are a baseline squash (a fresh `001_baseline.sql`, which needs every environment reset or re-stamped) or tolerating the dead columns.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| One flat app, no namespacing (Phase 1's shape) | Simplest possible topology | Broke as soon as "seven apps" was the actual scope — no way to express "this route belongs to this app" |
| Modular monolith: one process, app-namespaced routes/tables, convention-enforced boundaries | Cheap to build and deploy (one server, one client, one DB, one test suite, one CI pipeline); boundary correctness depends on discipline, not the runtime | **Chosen** |
| npm workspaces monorepo — a package per app | Real build-tool-enforced separation (a package literally cannot import another's internals without an explicit dependency); real ceremony — a `tsconfig`, `vitest.config`, and `.env` per package, cross-package imports become workspace references | Rejected for this phase — the ceremony multiplies by seven for a suite where every app still shares one login and one deploy target |
| Microservices — a deployable per app behind a gateway | Strongest isolation; independent scaling and deploys; genuinely matches "seven separate products" framing | Rejected — multiplies ports, CORS origins, cookie domains, and test databases by seven, and shared auth becomes a network call instead of a function import, for a portfolio project where nothing needs independent scaling |

The deciding factor is what actually varies across the seven apps here: not their *traffic pattern* or their *deploy cadence* (the reasons microservices genuinely pay off), but their *business domain*. That's a code-organization problem, and a modular monolith solves it at a fraction of the operational cost. The trigger to reconsider is explicit and narrow: if one app someday needs independent scaling, a separate on-call rotation, or a different language runtime, that specific app is the one that peels off into its own service — not a wholesale rewrite of the other six.

## Where it lives in this codebase

- `server/src/config/modules.ts` (Phase 33) — `MODULE_TAGS`, the frozen provenance tags; replaced `config/apps.ts`, the app registry that was the single source of truth until then
- `server/src/routes/index.ts` — platform routes, then `/inventory`, `/capture`, then accounting mounted at `/`
- `server/src/__tests__/app.test.ts` — the root mount and every retired prefix answer `404`
- `client/src/routes/LegacyAppRedirect.tsx` + `client/src/__tests__/legacyAppRedirect.test.tsx` — the permanent old-URL mapping, printed QR labels included
- `client/src/routes/SetupGate.tsx` — `OnboardingRoute`'s decide-once `useRef` guard (the redirect race)
- `client/src/utils/moduleLabels.ts` — tag → label, the only place a tag meets the UI
- `docs/schema.md § Phase 33` — the withdrawn `074` and the replay constraint
- `docs/architecture.md#product-structure` — the platform-layer/app-layer split stated as a rule
- `docs/guardrails.md` rule 16 — "module boundaries are code namespaces, not tenancy" (was "app boundaries…" before Phase 33)
- `docs/schema.md#table-naming-across-modules` — the unprefixed-accounting / prefixed-capture-and-inventory convention, kept after the merge
- `server/src/services/integrations/driveIntakeDispatcher.ts` (Phase 19.3) — the cross-app integration point materialized: a platform service routing to app services by purpose, zero SQL of its own
- `server/src/db/migrations/053_platform_drive_integration.sql` — the generic `(result_app, result_entity_id)` pair and its documented `ON DELETE SET NULL` trade-off

## Gotchas

- **"No network call between them" does not mean "no way to violate the boundary."** A modular monolith's isolation is opt-in — a stray `import` or a stray `SELECT` compiles and runs fine. This has to be caught in review (`guardrail-review`'s app-boundary detector) precisely because nothing else catches it.
- **Shared infrastructure is still shared risk.** One Postgres connection pool, one process, one deploy means a bug or a resource leak in one app's code can degrade every other app's requests — there's no bulkhead. This is the direct cost of choosing "one process" on the deployment axis.
- **The temptation to "just this once" reach across the boundary is strongest under time pressure**, and it's exactly when it happens that it's hardest to catch — a one-line convenience query that "just needs one field from another app's table" is indistinguishable in a diff from a query against your own tables unless the reviewer is specifically checking table-name-against-folder-name.
- **A convention with one enforcement point (a registry file) is only as good as everyone actually consulting it.** `config/apps.ts` being the source of truth is a statement of intent, not a compiler error, until something (a lint rule, a CI check) actually reads it and fails a build that violates it.

- **Persisted identifiers outlive display names.** Renaming a product surface is cheap; renaming a value stored in append-only history is not. Separate the two on purpose (a frozen tag plus a label map) instead of letting the display name leak into storage.
- **Flattening namespaces silently changes 404 behaviour** if a root-mounted router carries router-level middleware. Test the fallthrough explicitly.
- **A replay-idempotency test makes dropping columns much harder than it looks.** Check every earlier migration for reads of the column, backfills included, before writing the drop.

## Interview Q&A

**Q: What's a modular monolith, and how is it different from just "a monolith"?**
A: Both run as one deployable process, which is the axis that distinguishes them from microservices. The difference is internal organization: a plain monolith has no enforced structure — any file can import or query anything — while a modular monolith deliberately partitions the codebase into modules with a stated boundary, even though nothing at the network layer forces that boundary the way it would in microservices. It's borrowing the *discipline* of service boundaries without paying for the *operational cost* of actual services.

**Q: If there's no network boundary, what actually stops one module from reaching into another's data?**
A: Nothing at runtime — that's the honest answer, and worth saying plainly rather than overselling the isolation. It's enforced by convention: a single source-of-truth registry for what modules exist, a routing and table-naming pattern that makes a violation visible in a diff, a stated rule reviewers check for, and — critically — one explicit, narrow integration point for the one thing that legitimately needs to cross the boundary, so there's no pressure to reach around it informally. It's a weaker guarantee than microservices give you, and the trade is worth making only when the operational savings outweigh that weaker guarantee — which they do here, where nothing needs independent scaling or a separate deploy cadence.

**Q: When would you actually reach for microservices instead?**
A: When something genuinely needs to vary independently of the rest of the system — traffic pattern, scaling needs, deploy cadence, team ownership, or even runtime/language. None of that is true yet for AutoLedger's seven apps; they share one login, one deploy, and roughly the same traffic shape. The trigger I'd watch for is one specific app outgrowing that shared shape — needing to scale independently, say — at which point *that one app* is a candidate to peel off, not a reason to have started with microservices for all seven.

**Q: How do you decide whether a piece of shared functionality belongs in the platform layer or gets duplicated per app?**
A: Ask whether it's identity/tenancy-shaped (true for every app, doesn't vary by domain) or domain-shaped (specific to what one app does). Auth, organizations, and the app registry itself are platform — every app needs exactly the same thing, so it lives once, unprefixed, at the root of each layer. LedgerCore's General Ledger is a middle case: it's domain logic, but it's also the one thing every *other* app needs to use, so instead of either duplicating money-handling per app or promoting it to the platform layer, it stays LedgerCore's own module with one narrow, named entry point (`source_type`/`source_id`) that other apps call through.

**Q: Tell me about a boundary you had to design without the runtime enforcing it for you.**
A: The app-to-app boundary here. Seven portfolio apps share one server process and one database — nothing at the network layer stops AP-Flow's code from querying LedgerCore's `journal_entries` table directly. So the boundary had to be made *legible* instead of *impossible*: one registry file is the single source of truth for which apps exist, the URL and table-naming conventions both encode which app owns what so a violation is visible in a diff, and the guardrail review process has an explicit detector for a service in one app's folder querying another app's tables. It's a weaker guarantee than a network boundary gives you, and I'd say that plainly if asked — the trade only makes sense because none of the seven apps need independent scaling or deployment yet, and the moment one does, it's a specific, well-scoped extraction rather than a rewrite.

**Q: You said apps integrate through one narrow door, not by reaching into each other's tables. Give a concrete example, and what did it cost you?**
A: Phase 19.3's Drive folder intake — a platform-level service that has to route a downloaded file to either AP-Flow or LedgerCore depending on what a folder is configured for. The dispatcher that does this calls exactly one function per case, always an app's own public service (`captureDocumentService.captureFile`, `bankImportService.importStatement`), and contains no SQL of its own at all — I can grep the file for `pool.query` and get zero matches, which is the actual proof rather than a comment claiming it. The real cost showed up in the schema: the ingestion log needs to record which document a file became, but that document can live in either app's table, and a real foreign key would mean adding a new nullable column for every future destination app. I used the same generic `(result_app, result_entity_id)` pattern the GL's own `source_type`/`source_id` posting already uses instead — and that gave up a `PG15+` `ON DELETE SET NULL` trick the original single-destination design had, so deleting a document now leaves a dangling id in the log rather than an automatically-nulled one. I accepted that because the log is append-only and the id is an operator breadcrumb, never a join key — but I'd say plainly in an interview that it's a real trade-off, not a free win.

**Q: You merged three apps with their own URL prefixes into one product. How did you decide the new API shape?**
A: I treated it as a collision analysis, not a rename. Removing the prefixes puts every resource name in one namespace, and three collided: two `/items`, three `/settings`, and capture's `/documents` next to the platform vault's. The biggest module, accounting with about nineteen routers, took the root, so `/api/v1/invoices` reads naturally. The two small modules kept a short prefix, `/inventory` and `/capture`, which dissolves every collision without inventing awkward names. Mounting at the root has one Express-specific risk: a root router sees every unclaimed request, so any router-level `authenticate` would turn an unknown path's `404` into a `401`. I pinned that with tests: an unknown path and all four retired prefixes must `404`.

**Q: Why didn't you rename the stored app slugs when the app names went away?**
A: Because some of those values live in an append-only audit log, and the audit triggers store them as literals. Rewriting history isn't allowed, and writing new rows under a new name would split every audit query across two spellings of one module. So the old slugs became frozen internal provenance tags, owned by one constants file that code reads instead of repeating literals. The API calls the field `module`, and the client maps tag to label in one place, so users never see `ledger-core`. It's the same principle as not renaming a persisted enum value: the display name is free to change, the stored identifier is a contract.

**Q: Tell me about a subtle bug you found during that refactor.**
A: The setup wizard's last step marked the organization onboarded and then navigated to a new optional inventory step, but the user always ended up on the dashboard. The onboarding route rendered "if onboarded, `<Navigate to="/">`". In React Router 7 a `navigate()` updates location inside `startTransition`, so it's low priority, while the settings `setState` is urgent. React rendered the settings change first with the old location still current, the route saw "onboarded", mounted `<Navigate>`, and `<Navigate>` fires in a `useEffect`, after the wizard's own navigation, so it won. The fix was to make the guard decide once, on arrival, with a `useRef`. The lesson is that a `<Navigate>` in a route is reactive: it re-fires on any render where its condition holds, including renders caused by the action that's navigating away. A new test caught it; the old one only asserted the POST happened.

**Q: A column is dead — nothing reads or writes it. Can you always drop it?**
A: Not if your migration history is replayable. Our suite has a test that clears the migrations ledger and re-runs every file against the live schema, to prove the SQL itself is idempotent. When I dropped six dead columns, two historical migrations failed on replay because they contain one-time backfills that `SELECT` exactly those columns. With "never edit an applied migration" as a hard rule and a squash explicitly declined, the right call was to withdraw the drop and document the columns as intentionally retained. The real options are a baseline squash, which resets or re-stamps every environment, or living with dead columns. The general rule I took from it: before dropping anything, grep the migration history for reads of it, not just the application code.

## Follow-ups they'll dig into

- "What would extracting one app into its own service actually involve, given this structure?" (The app-prefixed tables and the app-namespaced routes are already close to a service boundary — the real work is replacing the in-process `journalService` call with a network call or an event, and standing up separate auth validation since the extracted service can no longer trust an in-process `req.user`.)
- "How do you keep the convention from rotting as more people touch the code?" (Automate what you can — a lint rule or CI check that greps for cross-app table access is stronger than a reviewer's memory; the registry file being the single source machines can check is exactly what makes that automatable later.)
- "Doesn't sharing one database defeat the point of having separate apps at all?" (No — the separation being modeled here is *domain/code organization*, not infrastructure isolation; sharing infrastructure while keeping domain boundaries clean is precisely what "modular monolith" names, as distinct from either a plain monolith with no boundaries or microservices with infrastructure boundaries too.)

## See also

- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md) — the boundary that *does* run on every query (`org_id`), and why the app slug is deliberately not that
- `docs/architecture.md#product-structure` — the platform/app split as implemented
- `docs/guardrails.md` rule 16
- `docs/roadmap.md#module-map` — the three modules and what each owns
- `docs/roadmap.md#phase-33-as-delivered` — the merge, stage by stage
- [migrations-and-schema-evolution.md](../postgresql/migrations-and-schema-evolution.md) — the replay-idempotency contract the withdrawn drop ran into
- [routing-nested-and-dynamic-segments.md](../react/routing-nested-and-dynamic-segments.md) — why links became absolute, and the `<Navigate>` mechanics

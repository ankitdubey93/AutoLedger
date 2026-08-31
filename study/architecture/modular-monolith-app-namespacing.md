# Modular Monolith: One Deploy, Many Apps

> AutoLedger hosts seven portfolio applications behind one login, one server process, and one database — the apps are separated by routing and table-naming convention, not by network boundary, which is a deliberate trade against microservices and one worth being able to defend in an interview.

**Category:** Architecture
**Introduced by:** Phase 2 — the platform/app split, `config/apps.ts`, `/api/v1/<app-slug>/...`
**Verified against:** the codebase as of Phase 2 (2026-08-31)

---

## Mechanism

"Modular monolith" describes a specific point on a spectrum, and it's worth being precise about the two axes that actually vary:

1. **Deployment topology** — how many processes does this run as? One (monolith) versus many independently deployable services (microservices).
2. **Code/data organization** — is the code (and, more strongly, the data) partitioned into modules with enforced boundaries, or is everything free to reach into everything else?

A modular monolith is deliberately **one** on axis 1 and **modular** on axis 2 — it borrows microservices' discipline about boundaries without paying microservices' operational cost. AutoLedger's seven apps are modules in this sense: each has its own routes, services, and (mostly) its own tables, but they all run inside the same Express process, share the same database connection pool, and are reachable through the same `apiRouter`.

### What actually enforces the boundary, given there's no network call to stop you

With microservices, the network *is* the enforcement — App A physically cannot query App B's database, because there's no connection to it. In a monolith, nothing stops a service in `services/ap-flow/` from writing `SELECT * FROM journal_entries` directly; the tables are one `pg` Pool connection away. The boundary is therefore a **convention enforced by review and by a stated rule** (guardrail 16: "no app reads another app's tables directly"), not a mechanism the runtime refuses to violate. This is the honest trade-off, and worth stating plainly rather than implying the isolation is stronger than it is: a modular monolith's modularity is a discipline, not a guarantee.

Three things make the discipline enforceable in practice, in ascending order of how deliberately AutoLedger applies them:

- **A single source of truth for the boundary itself.** `server/src/config/apps.ts` is the one place that says which apps exist. A route, a table prefix, or a `source_type` value that isn't in that list is a bug by definition — there's one place to check, not tribal knowledge.
- **A routing convention that makes the boundary visible in every URL.** `/api/v1/<app-slug>/<module>` means you can tell which app owns an endpoint by reading the path, and a code reviewer scanning a diff for `ap-flow` code that touches a `ledger-core` route is looking for a specific, greppable string mismatch.
- **A prescribed integration point for the one thing apps legitimately need to share.** LedgerCore's General Ledger is the exception to "apps don't touch each other's tables" — every other app posts into it through `journalService`, tagging `source_type` (the app slug) and `source_id`, rather than either duplicating money-handling logic per app or reaching into `journal_entries` directly. One narrow, named door, instead of either a locked wall or no wall at all.

### Where the app slug does *not* apply: the security boundary is unchanged

It would be a mistake to treat `/<app-slug>/` as if it were doing the job `org_id` does — it isn't, and conflating the two is exactly the kind of bug the rule anticipates. `org_id`, resolved only from the verified access token, remains the sole predicate that decides *which rows* a query can touch. The app slug decides *which router handles the request* — a routing concern, resolved once, before any query runs. A request to `/api/v1/ap-flow/invoices` and a request to `/api/v1/organizations` are scoped by `org_id` identically; the first just happens to be handled by a router that only AP-Flow's code registers. Nothing about being "inside" `ap-flow`'s router grants any wider data access — see [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md) for the mechanism that boundary actually rests on.

### Table naming as the data-layer half of the same convention

The routing convention has a data-layer counterpart: LedgerCore's tables stay unprefixed (`accounts`, `journal_entries`, `ledger_lines`) because it plays the same "shared system of record" role that `organizations` and `users` play for the platform layer — every other app's tables carry an app prefix (`ap_flow_invoices`, `fpa_scenarios`). This is purely a naming convention with no database-level enforcement (Postgres doesn't know or care that `ap_flow_invoices` "belongs" to a particular router), but it makes cross-app leakage visible at the SQL level the same way the URL convention makes it visible at the routing level: a query against a table with the wrong prefix, inside a service file under the wrong app folder, is a pattern a reviewer — or eventually a lint rule — can catch mechanically.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| One flat app, no namespacing (Phase 1's shape) | Simplest possible topology | Broke as soon as "seven apps" was the actual scope — no way to express "this route belongs to this app" |
| Modular monolith: one process, app-namespaced routes/tables, convention-enforced boundaries | Cheap to build and deploy (one server, one client, one DB, one test suite, one CI pipeline); boundary correctness depends on discipline, not the runtime | **Chosen** |
| npm workspaces monorepo — a package per app | Real build-tool-enforced separation (a package literally cannot import another's internals without an explicit dependency); real ceremony — a `tsconfig`, `vitest.config`, and `.env` per package, cross-package imports become workspace references | Rejected for this phase — the ceremony multiplies by seven for a suite where every app still shares one login and one deploy target |
| Microservices — a deployable per app behind a gateway | Strongest isolation; independent scaling and deploys; genuinely matches "seven separate products" framing | Rejected — multiplies ports, CORS origins, cookie domains, and test databases by seven, and shared auth becomes a network call instead of a function import, for a portfolio project where nothing needs independent scaling |

The deciding factor is what actually varies across the seven apps here: not their *traffic pattern* or their *deploy cadence* (the reasons microservices genuinely pay off), but their *business domain*. That's a code-organization problem, and a modular monolith solves it at a fraction of the operational cost. The trigger to reconsider is explicit and narrow: if one app someday needs independent scaling, a separate on-call rotation, or a different language runtime, that specific app is the one that peels off into its own service — not a wholesale rewrite of the other six.

## Where it lives in this codebase

- `server/src/config/apps.ts` — the single source of truth for which apps exist and their slugs
- `server/src/routes/index.ts` — the *App routers* block; every app mounts one line here, never on `app` directly
- `docs/architecture.md#suite-structure` — the platform-layer/app-layer split stated as a rule
- `docs/guardrails.md` rule 16 — "app boundaries are namespaces, not tenancy," the concrete enforcement rule
- `docs/schema.md#table-naming-across-apps` — the unprefixed-LedgerCore / prefixed-everyone-else convention
- Nothing yet demonstrates the cross-app integration point in code — LedgerCore's `journalService` and the first app that posts into it via `source_type`/`source_id` land together in a later phase

## Gotchas

- **"No network call between them" does not mean "no way to violate the boundary."** A modular monolith's isolation is opt-in — a stray `import` or a stray `SELECT` compiles and runs fine. This has to be caught in review (`guardrail-review`'s app-boundary detector) precisely because nothing else catches it.
- **Shared infrastructure is still shared risk.** One Postgres connection pool, one process, one deploy means a bug or a resource leak in one app's code can degrade every other app's requests — there's no bulkhead. This is the direct cost of choosing "one process" on the deployment axis.
- **The temptation to "just this once" reach across the boundary is strongest under time pressure**, and it's exactly when it happens that it's hardest to catch — a one-line convenience query that "just needs one field from another app's table" is indistinguishable in a diff from a query against your own tables unless the reviewer is specifically checking table-name-against-folder-name.
- **A convention with one enforcement point (a registry file) is only as good as everyone actually consulting it.** `config/apps.ts` being the source of truth is a statement of intent, not a compiler error, until something (a lint rule, a CI check) actually reads it and fails a build that violates it.

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

## Follow-ups they'll dig into

- "What would extracting one app into its own service actually involve, given this structure?" (The app-prefixed tables and the app-namespaced routes are already close to a service boundary — the real work is replacing the in-process `journalService` call with a network call or an event, and standing up separate auth validation since the extracted service can no longer trust an in-process `req.user`.)
- "How do you keep the convention from rotting as more people touch the code?" (Automate what you can — a lint rule or CI check that greps for cross-app table access is stronger than a reviewer's memory; the registry file being the single source machines can check is exactly what makes that automatable later.)
- "Doesn't sharing one database defeat the point of having separate apps at all?" (No — the separation being modeled here is *domain/code organization*, not infrastructure isolation; sharing infrastructure while keeping domain boundaries clean is precisely what "modular monolith" names, as distinct from either a plain monolith with no boundaries or microservices with infrastructure boundaries too.)

## See also

- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md) — the boundary that *does* run on every query (`org_id`), and why the app slug is deliberately not that
- `docs/architecture.md#suite-structure` — the platform/app split as implemented
- `docs/guardrails.md` rule 16
- `docs/roadmap.md#app-map` — why these seven domains, specifically, are the modules

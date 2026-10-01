# From Fixed Roles to Permission-Based Access Control

> Replacing `requireRole('OWNER','ADMIN')` with a catalogue of `area.action` permissions, built-in roles derived from it, customer-defined roles on top, and the guards that stop the feature from becoming a privilege-escalation hole.

**Category:** Security · Architecture
**Introduced by:** Phase 38c — "a user with customizable access, e.g. a person who can only issue and see invoices"
**Verified against:** Node 24, Express 5.2.1, PostgreSQL 16.15, TypeScript 7

---

## Mechanism

### Roles vs permissions: what actually changes

With **RBAC as role names**, a route asks "is the caller one of these roles?" (`requireRole('OWNER','ADMIN','ACCOUNTANT')`). That works while roles are a fixed, small, ordered set. It breaks the moment someone wants a role that isn't a superset or subset of the existing ones. An "Invoice clerk" can issue invoices (an ACCOUNTANT thing) but cannot see journals (which every VIEWER can). No position in the OWNER > ADMIN > ACCOUNTANT > VIEWER ladder expresses that.

With **permission-based access**, a route asks "does the caller hold `invoices.issue`?". A role becomes just a named **set of permissions**. Built-in roles and customer-defined roles are the same kind of thing, and every route depends on a capability rather than a job title.

### The catalogue and tiers

`server/src/config/permissions.ts` declares ~60 keys, each with an area (for the UI), a label, a **tier** and optional `requires`. The tier is what made the migration safe:

| Tier | Built-in roles that get it | Replaces |
|---|---|---|
| V | OWNER, ADMIN, ACCOUNTANT, VIEWER | an un-gated read |
| A | OWNER, ADMIN, ACCOUNTANT | `requireRole('OWNER','ADMIN','ACCOUNTANT')` |
| M | OWNER, ADMIN | `requireRole('OWNER','ADMIN')` |
| O | OWNER | `requireRole('OWNER')` |

The built-in roles are **computed** from tiers (`BUILTIN_ROLE_PERMISSIONS`) and never stored. So they can't drift between organizations, and adding a key automatically extends the right built-ins.

**The migration was proven, not eyeballed.** A script mapped each of 225 authenticated routes to a key by (file, method, path), then **asserted** that the tier of the new key admits exactly the role list of the old `requireRole` (or all four roles for an un-gated read). It refused to write anything if a single route differed. Then the ~44 pre-existing test files asserting 403s for VIEWER/ACCOUNTANT ran unchanged and passed. That combination is the honest answer to "how do you refactor authorization without breaking it?": an equivalence check at the moment of change, plus behavioural tests written before it.

### `requires`: keeping a custom role usable

"Issue invoices" without "view invoices" is a role that can't find the button. Keys declare dependencies (`invoices.issue → invoices.view → customers.view`), and `withRequiredPermissions` takes the transitive closure. The closure is applied **when a role is saved**, so the stored set is exactly what the editor showed. There is no hidden expansion at check time, which would make "what can this role do?" unanswerable from the data. The client editor applies the same rule both ways: ticking adds dependencies, and unticking removes dependants.

### Resolving permissions: per request, from the database

The JWT carries `{ sub, orgId, role }` and lives 15 minutes. The pre-38c design checked the role **in the token**, with no DB read, and accepted that a demotion took up to 15 minutes to bite. Editable roles change that calculus. If an owner removes "void invoices" from a role, it has to stop working *now*, not after every holder's token rotates. So `requirePermission` calls `resolveMemberAccess(orgId, userId)`: one query joining `organization_members` (by its `(org_id, user_id)` unique index) to `org_roles` and `org_role_permissions`, aggregating keys with `array_agg … FILTER (WHERE … IS NOT NULL)`. The result is memoised on `req.access`, so a route with several checks pays once. Built-in roles map to the code presets; a custom role maps to its stored keys, filtered through the catalogue so unknown or owner-only keys are ignored.

There are two side effects worth naming in an interview:
- **Removal is immediate.** A removed member's next request gets 403, because there is no membership row. Phase 37's "removed members keep access for up to 15 minutes" no longer holds for organization routes. A test asserts it.
- **The token's role is now display-only.** It still matters for the client's first paint, but no route trusts it.

### Making a forgotten route impossible: a router-walking test

A permission system fails open when someone adds `router.get('/x', authenticate, handler)` and forgets the gate. `requirePermission` and `allowAnyMember` both return handlers tagged with an `accessDecision` property. `routePermissions.test.ts` walks Express's router tree (`router.stack` → `layer.route.stack` / nested `layer.handle.stack`) and fails for any route whose stack contains `authenticate` but no tagged handler. The `/auth` router (identity routes) is exempt by object identity. The test was **mutation-checked**: deleting one route's gate made it fail with `GET / → list()`, and restoring the gate made it pass. Express's router internals aren't a public API, so the test also asserts it found more than 200 routes. An upgrade that changes the internals fails loudly instead of passing vacuously.

### Privilege escalation: the part that makes or breaks the feature

Giving customers a role editor creates a new attack path. A user who can manage roles could create a role with every permission and assign it to themselves. The guards, all evaluated under `SELECT … FROM organizations WHERE id = $1 FOR NO KEY UPDATE` so they can't interleave:

1. **Owner-tier keys** (`periods.lock`, `webhooks.secrets`) can never be in a custom role.
2. **Create/edit a role:** a non-owner's requested set (after `requires` closure) must be a subset of their own permissions. They also can't edit a role that already exceeds them.
3. **Assign or invite into a role:** the role's permissions must be a subset of the actor's.
4. **Change or remove a member:** the member's *current* permissions must be a subset of the actor's. A "Team lead" can't demote an ADMIN.
5. **OWNER** is still special-cased: only an owner grants, changes or removes it, and the last owner can't be demoted (Phase 37).

The subset rule means `members.manage` plus `roles.manage` never adds up to more than you already have.

### Tenancy in the schema: composite foreign keys

`custom_role_id` alone could point at any organization's role. The FK is composite, `(org_id, custom_role_id) REFERENCES org_roles(org_id, id)`, backed by `UNIQUE (org_id, id)` on `org_roles`, so the database refuses a cross-tenant role (a test asserts `23503`). With MATCH SIMPLE (the default), a NULL `custom_role_id` skips the check, which is exactly right for built-in roles. A CHECK ties the two columns together: `(role = 'CUSTOM') = (custom_role_id IS NOT NULL)`.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Keep four fixed roles, add more fixed ones | Each new need is a migration plus code; can't express "invoices only" without exploding the role list | Rejected: the request was customisable access |
| Permissions in the JWT (claims) | No DB read per request, but a 60-key array bloats every request and staleness lasts the token's life | Rejected: edits must apply immediately |
| Per-request DB resolution (chosen) | One indexed query per request; immediate effect; removal is immediate too | Chosen |
| Cache permissions in Redis with a version bump on edit | Saves the query but adds invalidation logic and a second source of truth | Deferred: the query is a PK lookup, not a bottleneck |
| ABAC / policy engine (OPA, Casbin) | Expressive (record-level rules) but a dependency, a policy language and a learning curve for a need the catalogue covers | Rejected (rule 14); record-level "only their own invoices" was explicitly not chosen |
| Built-in roles stored as rows per org | Uniform with custom roles, but presets could drift and need backfills when keys are added | Rejected: derived from tiers in code |

Related: [docs/architecture.md § Roles and permissions](../../docs/architecture.md), guardrails rule 1 (tenancy) and rule 16 (module boundaries are not tenancy).

## Where it lives in this codebase

- `server/src/config/permissions.ts`: the catalogue, tiers, `BUILTIN_ROLE_PERMISSIONS`, `withRequiredPermissions`.
- `server/src/services/permissionService.ts`: `resolveMemberAccess`, `permissionsOfRole`, `isSubset`.
- `server/src/middleware/rbac.ts`: `requirePermission`, `allowAnyMember`, `loadAccess` (`requireRole` is kept, but no route uses it).
- `server/src/services/roleService.ts`: role CRUD with the escalation guards.
- `server/src/services/organizationService.ts`: `assertMayManage` (owner rule plus subset rules), used by member updates and invitations.
- `server/src/db/migrations/083_platform_custom_roles.sql`: tables, composite FKs, the CHECK re-statement.
- `server/src/__tests__/platform/routePermissions.test.ts`: the router-walking coverage test and catalogue invariants.
- `server/src/__tests__/platform/customRoles.test.ts`: the invoice clerk, edit-takes-effect, escalation, cross-tenant.
- `client/src/context/AuthContext.tsx` (`useCan`), `components/layout/nav.ts` (`visibleNavGroups`), `Pages/settings/RolesSettingsPage.tsx`.

## Gotchas

- **Hiding a button is not authorization.** The client's `useCan` only decides what to show; the server re-checks every route. A test can call the API directly and must still get 403.
- **Un-gated reads were the silent majority.** 94 authenticated routes had no role check at all, so they were readable by every member. Moving to permissions meant giving each a `.view` key. Otherwise a "clerk" could still list journals. The coverage test is what keeps that true.
- **Some reads must stay open to everyone.** The app shell needs the current organization, its ledger settings and onboarding state. Gating them behind a permission would break the whole UI for a narrow role. `allowAnyMember` makes that an explicit, test-visible decision rather than an omission.
- **A cross-package import in tests.** Client fixtures import the server's catalogue to build session permissions, so they can't drift. That works only because `permissions.ts` has no imports of its own. Keep it that way.
- **Dropping and re-adding a CHECK** is how `'CUSTOM'` joined the role list. Done idempotently (`DROP CONSTRAINT IF EXISTS` then `ADD`) because the migration replay test re-runs every file.
- **A running test suite shares databases.** Two vitest runs at once on the same per-worker databases truncate each other's tables. That produced nonsense failures during this phase until the overlapping run finished.

## Interview Q&A

**Q: What's the difference between RBAC and permission-based access control, and when do you move from one to the other?**
A: In role-name RBAC, code checks "is the user an ADMIN?". In permission-based access, code checks "does the user hold `invoices.issue`?", and a role is just a named set of permissions. You move when the roles stop being a simple ladder: when someone needs a combination no existing role expresses, like "can issue invoices but can't see journals". Before that, permissions are over-engineering. We ran four fixed roles for 37 phases and moved when a real request needed a custom role.

**Q: How do you refactor authorization on 225 routes without breaking anything?**
A: I didn't edit them by hand. A script mapped every route to a permission key by file, method and path. Each key has a tier that defines which built-in roles get it, and the script asserted, route by route, that the new key admits exactly the roles the old `requireRole` list admitted. It refused to write if any differed. Then the existing test suite, which already asserted 403s for viewers and accountants across about 44 files, ran unchanged and passed. On top of that, a test walks the Express router and fails if any authenticated route lacks a permission gate. I mutation-checked it by removing one gate and confirming it failed.

**Q: Do you put permissions in the JWT?**
A: Not here. The token carries the user, the active organization and the role name, but permissions are resolved from the database on each request, with one indexed query memoised on the request. With editable roles, staleness is a correctness bug: if an owner removes "void invoices" from a role, it must stop working immediately, not when tokens expire. Claims in the token also bloat every request. If the query ever showed up in profiles, the next step would be a cache with explicit invalidation on role edits, not putting the list in the JWT.

**Q: A user can manage roles. What stops them from giving themselves every permission?**
A: Subset rules, checked under a row lock on the organization. A non-owner can only create or edit a role whose permissions they already hold. They can only assign or invite someone into a role that's a subset of their own permissions. And they can only change a member whose current permissions are a subset of theirs, so a team lead can't demote an admin. Owner-only permissions can't go into a custom role at all, and only an owner grants or removes the owner role. Combined, managing roles never gives anyone more than they already have.

**Q: How do you stop a custom role from one tenant being assigned in another?**
A: In the service, every lookup is scoped by the organization id from the verified token, so another org's role id simply isn't found and you get a 404. In the schema, the foreign key is composite, `(org_id, custom_role_id)` referencing `org_roles(org_id, id)`. The database therefore refuses a role from a different organization even if a service forgot the scope. A test writes the row directly with SQL and expects a foreign-key violation.

**Q: Tell me about a time a permission feature nearly shipped with a gap.**
A: Converting 134 role-gated routes was the obvious part. The less obvious part was 94 authenticated routes with no role check at all: every member could read them. A custom "invoice clerk" would still have been able to list journals and bills. So every one of those reads got a `.view` key, a handful the app shell genuinely needs got an explicit `allowAnyMember`, and the router-walking test now fails if a new route ships with only `authenticate`. The clerk test asserts 403 on journals, bills and the dashboard, and 200 on invoices.

## Follow-ups they'll dig into

- *"What about record-level rules, like only invoices they created?"* That is attribute-based, and every list and detail query would need an extra predicate. It was offered and not chosen. The clean way is a query-scoping helper per resource, not a check after loading.
- *"How expensive is the per-request query, and how would you cache it?"* It is one PK-indexed join, sub-millisecond on a warm cache. A cache would be keyed by `(orgId, userId)` and invalidated on member and role edits, with a short TTL as a backstop.
- *"What happens to a user whose custom role is edited mid-session?"* The next request uses the new set. The client's view of permissions updates on the next `/auth/check` or refresh, so a hidden button can briefly be visible but is refused server-side.
- *"Why keep the role name in the token at all?"* For the first render, before `/auth/check` returns, and for logs. Nothing authorizes from it.

## See also

- [jwt-and-refresh-rotation.md](jwt-and-refresh-rotation.md): what the token carries and why it's short-lived
- [multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md): RBAC vs ABAC vs ReBAC at survey level
- [composite-foreign-keys-for-tenancy.md](../postgresql/composite-foreign-keys-for-tenancy.md): the FK technique used for `custom_role_id`
- [transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md): `FOR NO KEY UPDATE` on the parent row

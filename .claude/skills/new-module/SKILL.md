---
name: new-module
description: Build a complete AutoLedger backend module or endpoint as a vertical slice in the required delivery order — migration, types, service, controller, routes, mount, tests, docs. Use when adding any new module to an app (accounts, journals, invoices, forecasts…), a new resource, or a new endpoint on an existing app.
---

# Building a module

A module lands as one vertical slice in a fixed order. Skipping a layer or reordering it is how SQL ends up in controllers.

**migration(s) → types → service(s) → controller(s) → routes → mount in `routes/index.ts` → tests → docs → client pages**

AutoLedger is one product (Phase 33). Every new resource belongs to exactly one **module** — `accounting`, `capture` or `inventory` — and `<module>` below is that folder name. Platform code (auth, organizations, onboarding, the vault) does not use the `<module>` templates; it stays unprefixed at the layer root. A module's provenance tag (for `app_slug` columns and audit triggers) comes from `server/src/config/modules.ts`, never a literal.

## 0. Gate check — before writing anything

Read [docs/roadmap.md](../../../docs/roadmap.md).

- Which phase does this module belong to, and which app owns it?
- Are its prerequisite phases actually **built** — verified on the filesystem, not claimed in a doc?
- Does it depend on a gated phase (Phase 7 background jobs gates 10, 15, 16, 17; Phase 9.5 Document Vault gates 10)?

If a prerequisite is missing, **stop and say so** before writing code. Do not build ahead of a gate without asking.

Then read the app's entry in the roadmap's app map — it names the DB pattern the app is supposed to use. Build that pattern, not a generic CRUD substitute.

## 1. Migration

Use the `new-migration` skill. Do not proceed until it applies cleanly twice.

## 2. Types — `server/src/types/<module>.ts`

Domain types plus the FSM transition table if the module has a lifecycle:

```ts
export type PoStatus = 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT:     ['APPROVED', 'CANCELLED'],
  APPROVED:  ['RECEIVED', 'CANCELLED'],
  RECEIVED:  ['CLOSED'],
  CLOSED:    [],
  CANCELLED: [],
};
```

One transition table, exported, validated in one helper. Money fields are `*Cents: number` (integer) end to end.

## 3. Service — `server/src/services/<module>/<name>Service.ts`

Every DB call in the module lives here. Rules that apply to every function:

- **`orgId` is the first parameter**, always, and appears in the `WHERE` of every statement.
- Plain data in, plain objects out. Never touch `req` / `res`.
- Multi-statement writes run in an explicit transaction on a checked-out client:

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // every query below uses `client`, never `pool`
  await client.query('INSERT ... WHERE org_id = ${1}', [orgId]);
  await client.query('COMMIT');
  return result;
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
```

- Validate the invariant **before** touching the DB, and rely on the CHECK constraint as the second line.
- If the module posts to the GL and it is not accounting itself, it does so inside the same transaction via accounting's `journalService`, tagging `source_type` / `source_id`. A document and its journal entry commit together or not at all. Never write directly into another app's tables — see guardrail 16.
- Anything that must happen after commit is a queued job (Phase 7), never a fire-and-forget query.

## 4. Controller — `server/src/controllers/<module>/<name>Controller.ts`

Extract input, validate shape, call the service, format the response. **Zero SQL, zero business logic.**

```ts
export const createX = async (req, res, next) => {
  const { ... } = req.body;
  const x = await xService.create(req.user.orgId, req.user.id, { ... });
  res.status(201).json({ success: true, x });
};
```

`req.user.orgId` comes from the auth middleware's token verification — never from a header, param, body, or anything in the URL. Errors go through `next(new ApiError(status, message))`; never hand-roll an error response.

## 5. Routes — `server/src/routes/<module>/<name>Routes.ts`

- `auth` middleware on everything except `/auth/*` and `/health`.
- `requireRole(...)` per route — decide the roles deliberately, don't default everything to ADMIN.
- Posted documents get `POST /:id/reverse`. No `PUT`, no `PATCH`, no `DELETE`.
- Financial mutations carry the idempotency middleware from Phase 17 onward.

## 6. Mount — `server/src/routes/<module>/index.ts`

Add one line to the module's combined router:

```ts
router.use('/<resource>', <name>Routes);
```

Accounting's router is mounted at the root of `/api/v1`, inventory's at `/inventory`, capture's at `/capture` (`server/src/routes/index.ts`). **Before adding an accounting resource, check the name against the platform routes and the other modules** — the root namespace is shared, and a collision is why inventory and capture keep a prefix. Never mount on `app` directly — `app.ts` knows only about the single versioned `apiRouter`.

## 7. Tests — `server/src/__tests__/<module>/`

Not optional, not a follow-up PR. Minimum three, per [docs/testing.md](../../../docs/testing.md):

1. **The invariant** — balance, non-negativity, legal FSM transitions, cycle rejection.
2. **The ROLLBACK path** — force a mid-transaction failure, assert nothing persisted.
3. **Cross-tenant isolation** — see the `isolation-test` skill. **Without it the module is not done.** Each app needs its own instance of the fixture — one app's isolation test does not cover another's tables.

Unit tests mock the pool; integration tests run against real PostgreSQL with migrations applied. Both tiers.

## 8. Docs — same pass, not later

- [docs/api.md](../../../docs/api.md) — every route, with its method, full `/api/v1/...` path, and description
- [docs/schema.md](../../../docs/schema.md) — every table and constraint (new capture tables take `ap_flow_`, inventory `stock_`; accounting tables are unprefixed)
- [docs/roadmap.md](../../../docs/roadmap.md) — phase status if this completes one

Then the `study-note` skill for any mechanism, PostgreSQL feature, TypeScript feature, or pattern used here for the first time.

## 9. Client pages — `client/src/Pages/<section>/`

Only after the API works. Calls go through `services/fetchServices.ts` with `fetchWithAutoRefresh`. Put the page in the folder of the sidebar section it appears under (`sales`, `purchases`, `inbox`, `products`, `inventory`, `banking`, `accounting`, `reports`, `settings`), add its absolute route to `client/src/routes/ProductRoutes.tsx`, and — if it is navigable — an entry in `client/src/components/layout/nav.ts` (the sidebar and ⌘K palette both read it). Every link is absolute.

## Finish

Run the `guardrail-review` skill over the diff before reporting the module complete. Report what is tested and passing versus what is written but unverified — do not blur the two.

> **Note:** `${1}`, `${2}` in this file mean the literal SQL placeholders `$1`, `$2`. Skill arguments are substituted into this file as plain text, so a bare `$1` would be overwritten by the first word of the invocation.

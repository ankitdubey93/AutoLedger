---
name: new-module
description: Build a complete AutoLedger backend module or endpoint as a vertical slice in the required delivery order — migration, types, service, controller, routes, mount, tests, docs. Use when adding any new module (inventory, procurement, sales, payroll, CRM…), a new resource, or a new endpoint on an existing module.
---

# Building a module

A module lands as one vertical slice in a fixed order. Skipping a layer or reordering it is how SQL ends up in controllers.

**migration(s) → types → service(s) → controller(s) → routes → mount in `index.ts` → tests → docs → client pages**

## 0. Gate check — before writing anything

Read [docs/roadmap.md](../../../docs/roadmap.md).

- Which phase does this module belong to?
- Are its prerequisite phases actually **built** — verified on the filesystem, not claimed in a doc?
- Does it depend on a gated phase (Phase 5 background jobs gates 9, 11, 12, 13)?

If a prerequisite is missing, **stop and say so** before writing code. Do not build ahead of a gate without asking.

Then read the module's entry in the roadmap's module map — it names the DB pattern the module is supposed to use (`SELECT ... FOR UPDATE` for stock, `WITH RECURSIVE` for BOMs, `EXCLUDE USING GIST` for leave, idempotency keys for invoicing). Build that pattern, not a generic CRUD substitute.

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
  await client.query('INSERT ... WHERE org_id = $1', [orgId]);
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
- If the module posts to the GL, it does so inside the same transaction via `journalService`, tagging `source_type` / `source_id`. A document and its journal entry commit together or not at all.
- Anything that must happen after commit is a queued job (Phase 5), never a fire-and-forget query.

## 4. Controller — `server/src/controllers/<module>/<name>Controller.ts`

Extract input, validate shape, call the service, format the response. **Zero SQL, zero business logic.**

```ts
export const createX = async (req, res, next) => {
  const { ... } = req.body;
  const x = await xService.create(req.user.orgId, req.user.id, { ... });
  res.status(201).json({ success: true, x });
};
```

`req.user.orgId` comes from the auth middleware's token verification — never from a header, param, or body. Errors go through `next(new ApiError(status, message))`; never hand-roll an error response.

## 5. Routes — `server/src/routes/<module>/<name>Routes.ts`

- `auth` middleware on everything except `/auth/*`.
- `requireRole(...)` per route — decide the roles deliberately, don't default everything to ADMIN.
- Posted documents get `POST /:id/reverse`. No `PUT`, no `PATCH`, no `DELETE`.
- Financial mutations carry the idempotency middleware from Phase 9 onward.

## 6. Mount — `server/src/index.ts`

`app.use('/api/v1/<module>', <module>Routes)`.

## 7. Tests — `server/src/__tests__/<module>/`

Not optional, not a follow-up PR. Minimum three, per [docs/testing.md](../../../docs/testing.md):

1. **The invariant** — balance, stock non-negativity, legal FSM transitions, cycle rejection.
2. **The ROLLBACK path** — force a mid-transaction failure, assert nothing persisted.
3. **Cross-tenant isolation** — see the `isolation-test` skill. **Without it the module is not done.**

Unit tests mock the pool; integration tests run against real PostgreSQL with migrations applied. Both tiers.

## 8. Docs — same pass, not later

- [docs/api.md](../../../docs/api.md) — every route, with its method and description
- [docs/schema.md](../../../docs/schema.md) — every table and constraint
- [docs/roadmap.md](../../../docs/roadmap.md) — phase status if this completes one

Then the `study-note` skill for any mechanism, PostgreSQL feature, TypeScript feature, or pattern used here for the first time.

## 9. Client pages — `client/src/Pages/<module>/`

Only after the API works. Calls go through `services/fetchServices.ts` with `fetchWithAutoRefresh`.

## Finish

Run the `guardrail-review` skill over the diff before reporting the module complete. Report what is tested and passing versus what is written but unverified — do not blur the two.

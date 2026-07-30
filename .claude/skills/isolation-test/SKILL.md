---
name: isolation-test
description: Write AutoLedger's required integration tests against real PostgreSQL — cross-tenant isolation, DB constraint enforcement, trigger firing, migration idempotency, and transaction rollback. Use when finishing a module, when a module lacks its mandatory isolation test, or when asked to verify tenant separation.
---

# Integration tests that actually prove something

The prior build mocked the pool in every test, so its migrations, CHECK constraints and triggers were never executed by CI — and the bugs that killed it lived exactly there. These tests run against a **real** PostgreSQL instance with migrations applied.

**A module without a cross-tenant isolation test is not done.** Treat a missing one as a blocking gap, not a TODO.

## Fixture: two orgs, one shared user, one foreign user

Every isolation test needs this shape. Build it once per module suite in `beforeAll`, inside a transaction you roll back — or with a per-run schema.

```ts
// org A: the caller. org B: the victim. userB must NOT be a member of org A.
const orgA = await createOrg('Org A');
const orgB = await createOrg('Org B');
const userA = await createUser('a@example.com');
const userB = await createUser('b@example.com');
await addMember(orgA.id, userA.id, 'ADMIN');
await addMember(orgB.id, userB.id, 'ADMIN');

// a real row owned by org B — this is what must stay invisible
const secret = await createResource(orgB.id, userB.id, { ... });
```

Use lowercase emails. Seed through the same services the app uses, so the fixture exercises real code paths.

## The four assertions, per endpoint

For **every** route the module exposes, with a token scoped to org A:

| Attempt | Required result |
|---|---|
| `GET /:id` for a row owned by org B | `404` — not `403`, and never the row. A 403 confirms the id exists |
| `GET /` list | Contains only org A rows. Assert the count *and* that no org B id appears |
| `PUT`/`POST /:id/...` mutating an org B row | `404`, and re-read the row to prove it is **byte-identical** afterward |
| `POST /` with `org_id` or `orgId` forged in the body/header/query | Row is created under org A anyway, or rejected. The token is the only authority |

That last one catches the forged-tenant class of bug directly — include it even when the body has no org field today, because someone will add one.

```ts
it('does not leak org B rows to an org A caller', async () => {
  const res = await request(app)
    .get(`/api/v1/journals/${secret.id}`)
    .set('Cookie', tokenFor(userA, orgA));
  expect(res.status).toBe(404);
  expect(JSON.stringify(res.body)).not.toContain(secret.id);
});

it('ignores a forged org id in the body', async () => {
  const res = await request(app)
    .post('/api/v1/journals')
    .set('Cookie', tokenFor(userA, orgA))
    .send({ ...validPayload, org_id: orgB.id });
  const row = await db.query('SELECT org_id FROM journal_entries WHERE id = $1', [res.body.entry.id]);
  expect(row.rows[0].org_id).toBe(orgA.id);
});
```

## Constraints must be tested at the DB, not the service

Bypass the service and insert directly, so the constraint itself is what rejects:

```ts
it('rejects a line with both sides populated', async () => {
  await expect(
    db.query(`INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents)
              VALUES ($1,$2,$3, 100, 100)`, [orgA.id, entry.id, account.id])
  ).rejects.toThrow(/chk_exclusive_debit_credit/);
});
```

Cover, per module: every CHECK constraint by name, every partial/composite UNIQUE (`(org_id, code)`, `UNIQUE (LOWER(email))`), and every FK's `ON DELETE` behaviour (delete the parent, assert cascade or restriction).

Assert on the **constraint name** in the error, not just "it threw" — otherwise a NOT NULL violation passes a test written for a CHECK.

## Triggers

```ts
it('bumps updated_at on update', async () => { /* read, update, assert strictly greater */ });
```

From Phase 4 on, also assert the `audit_logs` row: correct `org_id`, actor, table, operation, and that `OLD`/`NEW` JSONB snapshots hold the real values.

## Migrations

Once per suite:

- Apply from an empty database — succeeds.
- Apply a second time — no error, no duplicate objects.

## Rollback

Force a failure mid-transaction (a constraint violation on the last statement, or a mocked throw) and assert that **every** table the operation touched is unchanged. If a document and its journal entry are supposed to commit together, assert neither exists.

## Money

Assert on integer cents. `expect(total).toBe(150000)` — never a float, never `toBeCloseTo`. `isBalanced` is exact equality.

## Running

```bash
cd server && npm test
cd server && npm run test:coverage   # target ≥ 80% on services/ and utils/
```

These need a live PostgreSQL — `docker compose up postgres`, or the full stack. If the DB is unavailable, say the tests were not run. Never report a suite as passing on the basis of having written it.

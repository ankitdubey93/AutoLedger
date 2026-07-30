---
name: docs-sync
description: Verify AutoLedger's docs against the actual filesystem and correct any drift — api.md vs routes, schema.md vs migrations, roadmap phase status, architecture.md layout, CLAUDE.md claims. Use after landing a change, before a commit or PR, when a doc's accuracy is in doubt, or when asked what is actually built.
---

# Docs-vs-reality check

The prior build was deleted because its documentation drifted from the code, and the drift hid a structural problem until a rewrite was cheaper than a repair. **A doc line claiming something works when it does not is worse than no line at all.**

Direction of truth is one-way: **the filesystem is right, the doc is wrong.** Never "fix" code to match a doc without saying so explicitly.

## 1. Routes vs [docs/api.md](../../../docs/api.md)

```bash
grep -rn "router\.\(get\|post\|put\|patch\|delete\)" server/src/routes/ 2>/dev/null
grep -rn "app.use('/api/v1" server/src/index.ts 2>/dev/null
```

Compare against the tables in `api.md`. Report and fix:

- Route exists in code, missing from the doc → add it.
- Route documented, absent from code → it is **planned**, not built. Move it out of any "built" section or mark it clearly.
- Method/path mismatch (documented `PUT`, actual `POST`) → the code wins; also check whether the `PUT` violates the immutability rule.
- A mounted router not reachable because `index.ts` never mounts it → that is a bug, not a doc issue. Report it as such.

## 2. Migrations vs [docs/schema.md](../../../docs/schema.md)

```bash
ls server/src/db/migrations/ 2>/dev/null
grep -rn "CREATE TABLE\|ALTER TABLE\|CREATE INDEX\|CONSTRAINT\|CHECK (" server/src/db/migrations/ 2>/dev/null
```

For every table in the doc, confirm the real column list, types, constraint names and indexes. Common drift: a column added by a later migration that never reached the doc; a constraint renamed; a money column documented as `BIGINT` cents but written as `NUMERIC`. The last one is a guardrail violation — escalate it, don't just edit the doc.

Also confirm sequential prefixes with no gaps, and that `server/src/db/migrations/` is the only migration directory:

```bash
find . -name "*.sql" -not -path "./node_modules/*" -not -path "./server/src/db/migrations/*"
```

## 3. Phase status vs [docs/roadmap.md](../../../docs/roadmap.md)

A phase is done only when its code, its migrations **and** its tests exist and pass. Verify each claim:

```bash
ls server/src client/src 2>/dev/null
ls server/src/__tests__/ 2>/dev/null
git log --oneline -15
```

Downgrade any phase marked complete whose tests are missing — including the cross-tenant isolation test, which is the completion gate.

## 4. Layout vs [docs/architecture.md](../../../docs/architecture.md)

```bash
find server/src client/src -maxdepth 2 -type d 2>/dev/null
```

The "Current (verified <date>)" tree must match reality, and the date must be updated when it is re-verified. Watch for a parallel `src/modules/` tree appearing — the layout is layer-first with module subfolders inside each layer.

## 5. Environment vs [docs/development.md](../../../docs/development.md)

```bash
grep -rn "process.env" server/src/ 2>/dev/null | grep -o "process.env.[A-Z_]*" | sort -u
grep -n "environment\|=" docker-compose.yml .env.example
```

Every variable the code reads must be in the table, in `.env.example`, and in `docker-compose.yml` where applicable. Flag any variable that is set but never read, and any read but never documented. `JWT_SECRET` must appear **nowhere** — if it survives in `docker-compose.yml` or `.env.example`, remove it.

## 6. [CLAUDE.md](../../../CLAUDE.md)

The "State" section and any status board must be true today. Check specifically: does `server/` exist, does `client/` exist, do migrations exist, do tests exist? Update the section and its date.

Keep CLAUDE.md concise — always-in-context rules and the doc map only. Reference detail belongs in `docs/`, not here.

## 7. `study/`

```bash
ls -R study/
```

`study/README.md` is the index and coverage tracker required by [docs/study-notes.md](../../../docs/study-notes.md) — if notes exist without it, create it. Every note listed in the index must exist, and every note file must be listed.

## Report

List each drift as: file, what it claims, what is actually true, what you changed. If everything is consistent, say so in one line — do not invent corrections.

Fix the docs in the same pass, then re-verify the specific lines you touched.

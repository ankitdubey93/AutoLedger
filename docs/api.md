# API Reference

**One endpoint exists: `GET /api/v1/health`.** Everything below the *Built* section is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. The prefix is declared once, in `server/src/config/constants.ts`, and applied in `app.ts`; module routers mount on the shared `apiRouter` in `server/src/routes/index.ts`.
- From Phase 1, every route except `/auth/*` and `/health` requires the `auth` middleware.
- Mount modules at `/api/v1/<module>`.
- Success: `{ success: true, ... }`. List endpoints add `count`, `totalCount`, `currentPage`, `totalPages`.
- Pagination defaults to `page=1&limit=20`, `limit` capped at 100.
- Errors: throw or `next(new ApiError(status, message))` and let `errorHandler.ts` format them. Never hand-roll an error response.
- Financial mutations require an `Idempotency-Key` header from Phase 9 onward.
- Posted documents expose `POST /:id/reverse`, never `PUT` or `DELETE`.

### Error response shape

Every error, including 404s, is formatted by `server/src/middleware/errorHandler.ts`:

```json
{ "success": false, "error": "Route not found: GET /api/v1/nope" }
```

An `ApiError` supplies its own status and message. Any other thrown value becomes a `500` with the generic message `"Internal server error"` — internal detail is logged server-side, never returned. Outside production only, a `detail` field carries the original message to make debugging bearable.

---

## Built

### Health — `/api/v1/health`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness + database reachability |

Public by design: a probe that needs a valid token cannot report on a system whose auth is broken.

`200` when the database answers a `SELECT 1` round trip:

```json
{
  "success": true,
  "status": "ok",
  "service": "autoledger-server",
  "apiVersion": "v1",
  "environment": "development",
  "uptimeSeconds": 12,
  "db": { "connected": true, "latencyMs": 2 }
}
```

`503` when it does not — `success: false`, `status: "degraded"`, and the driver's message in `db.error`:

```json
{
  "success": false,
  "error": "Database unreachable",
  "status": "degraded",
  "service": "autoledger-server",
  "apiVersion": "v1",
  "environment": "development",
  "uptimeSeconds": 2,
  "db": { "connected": false, "latencyMs": null, "error": "connect ECONNREFUSED 127.0.0.1:5432" }
}
```

The check runs a real query rather than a TCP connect, so a reachable port with bad credentials fails as it should. No `org_id` scoping applies — it touches no tenant data.

---

## Planned surface — Phases 1–2

### Auth — `/api/v1/auth`

| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create user + organization + owner membership + seed chart of accounts, in one transaction |
| POST | `/login` | Sets access + refresh tokens as httpOnly cookies |
| GET | `/check` | Verify session; return user, active org, role |
| GET | `/refresh` | New access token from the refresh cookie |
| POST | `/switch-org` | Re-issue access token scoped to another org the user belongs to |
| POST | `/logout` | Clear cookies + delete the refresh token row |

### Accounts — `/api/v1/accounts`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List the org's accounts, ordered by code |
| POST | `/` | Create an account |

### Journals — `/api/v1/journals`

| Method | Path | Description |
|---|---|---|
| GET | `/` | Paginated entries with nested lines |
| POST | `/` | Create a balanced entry (min 2 lines, debits == credits in cents) |
| POST | `/:id/reverse` | Post the reversing entry for a posted journal |

### Reports — `/api/v1/reports`

| Method | Path | Description |
|---|---|---|
| GET | `/trial-balance` | Per-account debit/credit totals, type-aware `net_balance`, `isBalanced` |

# API Reference

**Built: `/health`, `/auth`, `/organizations`, `/apps`.** Everything below the *Built* section is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. The prefix is declared once, in `server/src/config/constants.ts`, and applied in `app.ts`; every router mounts on the shared `apiRouter` in `server/src/routes/index.ts`.
- **Platform routes are app-less:** `/auth`, `/organizations`, `/apps`, `/health`. **App routes are namespaced:** `/api/v1/<app-slug>/<module>`, e.g. `/api/v1/ledger-core/journals`. The slugs are the single source of truth in `server/src/config/apps.ts` — see [architecture.md](architecture.md#suite-structure).
- From Phase 1, every route except `/auth/*` and `/health` requires the `auth` middleware.
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

### Auth — `/api/v1/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | none | Create user + organization + OWNER membership, in one transaction |
| POST | `/login` | none | Sets access + refresh tokens as httpOnly cookies |
| POST | `/refresh` | refresh cookie | Rotate both tokens |
| POST | `/logout` | none | Clear cookies + delete the refresh token row |
| GET | `/check` | access cookie | Verify session; return user, active org, role, memberships |
| POST | `/switch-org` | access cookie | Re-issue the session scoped to another org the user belongs to |

**`/refresh` is a `POST`, not a `GET`.** It rotates the refresh token, so it is state-changing — and `SameSite=Lax` deliberately still sends cookies on a top-level cross-site *navigation*, which would let a plain link from any site silently rotate a visitor's session and log them out.

**`/register` does not seed a chart of accounts.** `accounts` is a Phase 2 table; see [schema.md](schema.md). It also does not log you in — it returns `201` and the client calls `/login` next.

`/logout` is public on purpose: clearing cookies must work even when the access token has already expired.

#### Session body

Returned by `/login`, `/check`, `/refresh` and `/switch-org`:

```json
{
  "success": true,
  "user": { "id": "…", "name": "Ada", "email": "ada@example.com",
            "emailVerified": false, "createdAt": "2026-08-30T14:38:35.587Z" },
  "organization": { "id": "…", "name": "Acme Traders", "slug": "acme-traders",
                    "baseCurrency": "USD", "createdAt": "…" },
  "role": "OWNER",
  "memberships": [ { "orgId": "…", "orgName": "Acme Traders", "orgSlug": "acme-traders",
                     "role": "OWNER", "joinedAt": "…" } ],
  "accessTokenExpiresAt": "2026-08-30T14:53:36.166Z"
}
```

`accessTokenExpiresAt` exists because the token lives in an httpOnly cookie the browser cannot read — the client needs the server to state the expiry.

#### Cookies

| Cookie | Path | Lifetime | Flags |
|---|---|---|---|
| `autoledger_at` | `/` | 15m | `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| `autoledger_rt` | `/api/v1/auth` | 7d | `HttpOnly`, `SameSite=Lax`, `Secure` in production |

Names are prefixed because cookies ignore ports — every app on `localhost` shares one jar. The refresh cookie is path-scoped so it is not attached to ordinary API calls.

#### Refresh rotation and reuse detection

Each refresh consumes its token and issues a new one, claimed atomically with `DELETE … RETURNING`. Presenting a token that was already rotated — a valid signature with no matching row — is treated as replay: the user's entire token family is deleted and the request 401s. Membership is re-validated on every refresh, so a revoked member does not keep refreshing indefinitely.

#### CSRF posture

Mitigated by three things together: `SameSite=Lax` (blocks cross-site POSTs), a single-origin CORS allow-list, and JSON-only bodies (an HTML form cannot send `Content-Type: application/json`, so it cannot reach a handler without a preflight it will fail). No `csurf` — it is deprecated, and rule 14 defers new dependencies anyway. Double-submit tokens are deferred until there is a reason for them.

**Not yet mitigated: login brute-force.** There is no rate limiting. `express-rate-limit` is a scheduled decision in [development.md](development.md), not an oversight.

---

### Organizations — `/api/v1/organizations`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The caller's active organization |
| GET | `/members` | `OWNER`, `ADMIN` | Everyone in the active organization |

The active organization comes **only** from the verified access token. `orgId` in a query string, an `X-Org-Id` header, or a request body is ignored — there is a test that sends all three pointing at another tenant and asserts the response is unchanged.

`/members` is `OWNER`/`ADMIN` only because it exposes every colleague's email address. Other roles get `403`, which the client renders as an explanatory notice rather than an error.

---

### Apps — `/api/v1/apps`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The suite's app registry |

```json
{
  "success": true,
  "count": 7,
  "apps": [
    {
      "slug": "ledger-core",
      "name": "LedgerCore",
      "domain": "Core Accounting & Systems",
      "tagline": "Double-entry ledger, multi-currency, QuickBooks sync.",
      "skills": ["Double-entry integrity", "DB constraints", "Multi-currency", "QuickBooks API sync"],
      "status": "building"
    }
  ]
}
```

Not role-gated — every member of an organization may see which apps exist. `status` is `"building"` (has real routes) or `"planned"` (roadmap only); the client uses it to decide whether a card is a link or a disabled placeholder. This is a static list today, not a per-org entitlement — every organization sees the same seven apps. See [roadmap.md](roadmap.md#app-map).

---

## Planned surface — by app

### LedgerCore — `/api/v1/ledger-core` — Phase 3+

#### Accounts — `/api/v1/ledger-core/accounts`

| Method | Path | Description |
|---|---|---|
| GET | `/` | List the org's accounts, ordered by code |
| POST | `/` | Create an account |

#### Journals — `/api/v1/ledger-core/journals`

| Method | Path | Description |
|---|---|---|
| GET | `/` | Paginated entries with nested lines |
| POST | `/` | Create a balanced entry (min 2 lines, debits == credits in cents) |
| POST | `/:id/reverse` | Post the reversing entry for a posted journal |

#### Reports — `/api/v1/ledger-core/reports`

| Method | Path | Description |
|---|---|---|
| GET | `/trial-balance` | Per-account debit/credit totals, type-aware `net_balance`, `isBalanced` |

### The other six apps

TaxGuard AI, AP-Flow, FP&A Engine, UnitEcon, BoardDeck Automator, and ForecasterPro have no routes yet — their surfaces get documented here, under `/api/v1/<app-slug>/…`, when each one's first module lands. See [roadmap.md](roadmap.md) for phase order.

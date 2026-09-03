# API Reference

**Built: `/health`, `/auth`, `/organizations`, `/apps`, `/ledger-core`.** Everything below the *Built* section is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. The prefix is declared once, in `server/src/config/constants.ts`, and applied in `app.ts`; every router mounts on the shared `apiRouter` in `server/src/routes/index.ts`.
- **Platform routes are app-less:** `/auth`, `/organizations`, `/apps`, `/health`. **App routes are namespaced:** `/api/v1/<app-slug>/<module>`, e.g. `/api/v1/ledger-core/journals`. The slugs are the single source of truth in `server/src/config/apps.ts` — see [architecture.md](architecture.md#suite-structure).
- From Phase 1, every route except `/auth/*` and `/health` requires the `auth` middleware.
- Success: `{ success: true, ... }`. List endpoints add `count`, `totalCount`, `currentPage`, `totalPages`.
- Pagination defaults to `page=1&limit=20`, `limit` capped at 100.
- Errors: throw or `next(new ApiError(status, message))` and let `errorHandler.ts` format them. Never hand-roll an error response.
- **`400` vs `422`:** `400` means the request is malformed — a missing field, a wrong type, an unparseable date. `422` means it parsed fine and is still wrong for a domain reason: an entry whose debits do not equal its credits, a posting into a closed period, a parent account of the wrong type. The client shows the two differently, so the distinction is load-bearing rather than stylistic.
- `404`, never `403`, for a resource that exists in another organization. A `403` confirms the id is real.
- Financial mutations require an `Idempotency-Key` header from Phase 9 (QuickBooks sync) onward, where a retried request must not double-post.
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

**`/register` seeds the chart of accounts** from Phase 3 onward — 44 accounts, inside the same transaction that creates the organization, so a rollback takes them with it ([schema.md](schema.md#default-chart-of-accounts)). It does not log you in: it returns `201` and the client calls `/login` next.

**`/register` and `/login` are rate limited** — 10 failed attempts per 15 minutes per IP, returning `429` in the standard error envelope. Successful logins are not counted, so a shared office NAT cannot lock colleagues out. `/refresh` and `/logout` are deliberately **not** limited: a legitimate client refreshes on a schedule, and the one moment you most want to clear cookies is the moment you must be able to.

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

**Login brute-force is mitigated from Phase 3** by `express-rate-limit` on `/register` and `/login` — see the note above. Its honest limit is that it is per-IP: a distributed attacker with many addresses is unaffected, and defending against that needs per-account tracking in a shared store, which arrives with Redis in Phase 7.

---

### Organizations — `/api/v1/organizations`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The caller's active organization |
| GET | `/members` | `OWNER`, `ADMIN` | Everyone in the active organization |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit the organization's name and/or base currency |

The active organization comes **only** from the verified access token. `orgId` in a query string, an `X-Org-Id` header, or a request body is ignored — there is a test that sends all three pointing at another tenant and asserts the response is unchanged.

`/members` is `OWNER`/`ADMIN` only because it exposes every colleague's email address. Other roles get `403`, which the client renders as an explanatory notice rather than an error.

`PATCH /` (Phase 3.5) is the platform half of LedgerCore's onboarding — organization name and `base_currency` are platform fields, not LedgerCore ones, so they are edited here rather than under `/ledger-core/settings`. Both fields optional, at least one required (`400 No fields to update`).

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

---

### LedgerCore — `/api/v1/ledger-core` — Phase 3 ✅, Phase 3.5 ✅

Full feature spec and the remaining phases: [ledger-core.md](ledger-core.md).

#### Accounts — `/api/v1/ledger-core/accounts`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's chart, ordered by code. `?tree=true` nests by `parentId`; `?includeInactive=true` includes retired accounts |
| GET | `/:id` | any member | One account |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create an account |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Rename, re-describe, retire, or re-parent |

Reading the chart is open to any member because a `VIEWER` looking at a report needs to know what the codes mean; changing it is bookkeeping.

**There is no DELETE.** An account is retired with `isActive: false`. Deleting one that carries postings is refused by the FK (`ON DELETE RESTRICT`) anyway, and deleting one that does not would still break the audit trail's references.

`code` and `type` are **not** updatable. Reports derive meaning from the code ranges, and re-typing an account that already has postings would silently restate every prior period.

Failure paths: `409 Account code already exists` · `422 Parent account not found` (also returned when the parent belongs to another organization — "wrong tenant" and "does not exist" must be indistinguishable) · `422 Parent account must have the same type` · `422 Re-parenting would create a cycle`.

Every new organization is seeded with the [44-account default chart](schema.md#default-chart-of-accounts) — 34 postable leaves and 10 header rollups.

#### Journals — `/api/v1/ledger-core/journals`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated entries with nested lines |
| GET | `/:id` | any member | One entry with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post a balanced entry (min 2 lines, debits == credits in integer cents) |
| POST | `/:id/reverse` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post the reversing entry for a posted journal |

**No `PUT`, no `DELETE`, at any phase** — rule 6. A database trigger rejects the write with SQLSTATE `0A000` even if such a route were added by mistake.

`sourceType` and `sourceId` are **not accepted from the request body**; a client-posted entry is always `'manual'`. Another app posting into the GL passes them service-to-service, so no caller can forge an entry claiming to have come from AP-Flow.

Failure paths: `400` from the schema (fewer than two lines, a line with both sides set, a fractional amount) · `422 Entry is unbalanced: debits N, credits M` · `422 Account <code> is a header account and cannot be posted to` · `422 Account not found` · `409 Entry has already been reversed` · `422 A reversing entry cannot itself be reversed`.

#### Reports — `/api/v1/ledger-core/reports`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/trial-balance` | any member | Per-account debit/credit totals, type-aware `netBalanceCents`, and `isBalanced`. Optional `?asOf=YYYY-MM-DD` |
| GET | `/dashboard` | any member | Position, year-to-date and month-to-date performance, a 6-point trend, recent entries, and the integrity check. Optional `?asOf=YYYY-MM-DD` |

Aggregated from raw `ledger_lines` on every request over the `base_*` columns. There is no summary table and none will be added. Only postable, active accounts appear. `isBalanced` is integer equality, never an epsilon.

`/dashboard` (Phase 3.5) is not the Phase 4 balance sheet — it exposes `currentEarningsCents` (Revenue − Expenses, all time) alongside `assetsCents`/`liabilitiesCents`/`equityCents` and an `equationHolds` flag, because Assets = Liabilities + Equity only holds once current-period earnings are folded in. `position.cashCents` is `null` when no cash account is configured in settings; when configured, it sums the account's whole subtree via a recursive walk. `trend` is always exactly 6 points, oldest first, gap-filled so a month with no postings still appears at zero.

Failure paths: `400 asOf must be a date in YYYY-MM-DD format`.

#### Settings — `/api/v1/ledger-core/settings` — Phase 3.5

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | LedgerCore's onboarding/settings state for the active organization |
| POST | `/onboarding` | `OWNER`, `ADMIN` | Complete (or re-complete) onboarding: workspace name, currency, fiscal year, cash account |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit settings after onboarding |

A missing `ledger_settings` row is **not** a 404 — `GET /` returns `200` with `settings.onboardedAt: null` and sensible defaults, which is the signal the client's onboarding gate redirects on. `POST /onboarding` is idempotent: submitting it twice overwrites rather than erroring, so a double-submit from the wizard is harmless. `PATCH /` before onboarding has ever completed returns `409`.

`organizationName` and `baseCurrency` are accepted by `POST /onboarding` but are written through `PATCH /organizations`, not this table — see the Organizations section above. `PATCH /settings` does **not** accept either field.

**The base-currency lock.** Once any `ledger_lines` row exists for the organization, submitting a *different* `baseCurrency` to `POST /onboarding` returns `422` (`Base currency cannot be changed once journal entries exist`) — `ledger_lines.currency_code` is stamped at write time on rows that are immutable by trigger, so a retroactive change would silently invalidate every posted line. Re-submitting the *same* currency is always accepted. `settings.baseCurrencyLocked` tells the client when to disable the field.

Failure paths: `400` from the schema (missing/invalid field, unsupported currency) · `422 Base currency cannot be changed once journal entries exist` · `422 Cash account does not exist in this organization` (also returned for a cash account belonging to another organization) · `409 Complete LedgerCore onboarding before changing settings` (PATCH only).

Deliberately **not** built here: `fiscal_periods`, period close/lock, and any posting guard tied to a closed period — all Phase 4. This module only stores a fiscal-year *setting*; it creates no period rows.

---

## Planned surface — by app

### LedgerCore — remaining phases

Phase 3's routes are **built** and documented in the section above. Still to come:

#### Fiscal periods — `/api/v1/ledger-core/periods` — Phase 4

| Method | Path | Description |
|---|---|---|
| GET | `/` | The org's periods and their status |
| POST | `/:id/close` | Close a period; later postings into it are rejected |
| POST | `/:id/reopen` | Reopen a closed period. `OWNER` only; refused once `locked` |

#### Reports — Phase 4 additions

| Method | Path | Description |
|---|---|---|
| GET | `/reports/profit-and-loss` | Revenue − Expenses over `?from=&to=`, gross profit split via the `5xxx` range |
| GET | `/reports/balance-sheet` | Assets = Liabilities + Equity as at `?asOf=` |

#### Reconciliation — `/api/v1/ledger-core/reconciliation` — Phase 6

| Method | Path | Description |
|---|---|---|
| POST | `/imports` | Upload a bank statement CSV. Idempotent by `dedupe_hash` |
| GET | `/transactions` | Bank lines, filterable by `status` |
| GET | `/transactions/:id/suggestions` | Scored candidate matches with their `score_breakdown` |
| POST | `/matches` | Accept a match and reconcile |
| POST | `/matches/:id/reject` | Reject a suggestion, returning the line to the queue |

#### FX and QuickBooks — Phases 8–9

`/fx-rates` (list and upsert rates), and `/quickbooks/{connect,callback,status,sync}` for the OAuth 2.0 flow and journal push. Documented properly when they land.

### AP-Flow — `/api/v1/ap-flow` — Phases 10–11

Full spec: [ap-flow.md](ap-flow.md).

| Method | Path | Description |
|---|---|---|
| POST | `/documents` | Upload a PDF/PNG/JPEG. Returns `202` with a job handle — extraction is queued, not synchronous |
| GET | `/documents` | The org's documents with extraction status |
| GET | `/documents/:id` | One document with its extraction, per-field confidence, and line items |
| GET | `/documents/:id/file` | The stored original, for side-by-side review |
| GET | `/review-queue` | Documents awaiting human approval, lowest confidence first |
| PATCH | `/documents/:id/line-items/:lineId` | Override a suggested account before posting |
| POST | `/documents/:id/post` | Approve and post into LedgerCore. `ACCOUNTANT` and above |

`POST /documents/:id/post` is the app boundary in practice: it calls LedgerCore's `journalService` with `source_type = 'ap_flow'`, and never writes `journal_entries` or `ledger_lines` itself (rule 16).

### The other five apps

TaxGuard AI, FP&A Engine, UnitEcon, BoardDeck Automator, and ForecasterPro have no routes yet — their surfaces get documented here, under `/api/v1/<app-slug>/…`, when each one's first module lands. See [roadmap.md](roadmap.md) for phase order.

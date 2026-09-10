# API Reference

**Built: `/health`, `/auth`, `/organizations`, `/apps`, `/audit-logs`, `/webhooks`, `/webhook-deliveries`, `/onboarding`, `/documents`, `/ledger-core`, `/ap-flow`.** Everything below the *Built* section is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. The prefix is declared once, in `server/src/config/constants.ts`, and applied in `app.ts`; every router mounts on the shared `apiRouter` in `server/src/routes/index.ts`.
- **Platform routes are app-less:** `/auth`, `/organizations`, `/apps`, `/health`. **App routes are namespaced:** `/api/v1/<app-slug>/<module>`, e.g. `/api/v1/ledger-core/journals`. The slugs are the single source of truth in `server/src/config/apps.ts` — see [architecture.md](architecture.md#suite-structure).
- From Phase 1, every route except `/auth/*` and `/health` requires the `auth` middleware.
- Success: `{ success: true, ... }`. List endpoints add `count`, `totalCount`, `currentPage`, `totalPages`.
- Pagination defaults to `page=1&limit=20`, `limit` capped at 100.
- Errors: throw or `next(new ApiError(status, message))` and let `errorHandler.ts` format them. Never hand-roll an error response.
- **`400` vs `422`:** `400` means the request is malformed — a missing field, a wrong type, an unparseable date. `422` means it parsed fine and is still wrong for a domain reason: an entry whose debits do not equal its credits, a posting into a closed period, a parent account of the wrong type. The client shows the two differently, so the distinction is load-bearing rather than stylistic.
- `404`, never `403`, for a resource that exists in another organization. A `403` confirms the id is real.
- Financial mutations require an `Idempotency-Key` header from Phase 17 (QuickBooks sync) onward, where a retried request must not double-post.
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

`200` when the database answers a `SELECT 1` round trip. From Phase 7 the body also reports Redis, checked in parallel:

```json
{
  "success": true,
  "status": "ok",
  "service": "autoledger-server",
  "apiVersion": "v1",
  "environment": "development",
  "uptimeSeconds": 12,
  "db": { "connected": true, "latencyMs": 2 },
  "redis": { "connected": true, "latencyMs": 1 }
}
```

`503` when the **database** is unreachable — `success: false`, `status: "degraded"`, and the driver's message in `db.error`:

```json
{
  "success": false,
  "error": "Database unreachable",
  "status": "degraded",
  "service": "autoledger-server",
  "apiVersion": "v1",
  "environment": "development",
  "uptimeSeconds": 2,
  "db": { "connected": false, "latencyMs": null, "error": "connect ECONNREFUSED 127.0.0.1:5432" },
  "redis": { "connected": true, "latencyMs": 1 }
}
```

Redis being down is deliberately **not** a `503` — every read endpoint still works with the queue offline; only background job processing stops. That case is `200` with `status: "degraded"` and `error: "Redis unreachable — background jobs are not running"` in the body, `db` unaffected.

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

**Login brute-force is mitigated from Phase 3** by `express-rate-limit` on `/register` and `/login` — see the note above. Its honest limit is that it is per-IP: a distributed attacker with many addresses is unaffected, and defending against that needs per-account tracking in a shared store. Redis has been available since Phase 7, but the limiter has not been rewired to use it — that needs `rate-limit-redis`, which is not an approved dependency (see [development.md](development.md#dependency-policy)).

---

### Organizations — `/api/v1/organizations`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The caller's active organization |
| GET | `/members` | `OWNER`, `ADMIN` | Everyone in the active organization |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit the organization's name, base currency, and/or tax identifiers |

The active organization comes **only** from the verified access token. `orgId` in a query string, an `X-Org-Id` header, or a request body is ignored — there is a test that sends all three pointing at another tenant and asserts the response is unchanged.

`/members` is `OWNER`/`ADMIN` only because it exposes every colleague's email address. Other roles get `403`, which the client renders as an explanatory notice rather than an error.

`PATCH /` (Phase 3.5) is the platform half of LedgerCore's onboarding — organization name and `base_currency` are platform fields, not LedgerCore ones, so they are edited here rather than under `/ledger-core/settings`. Phase 3.8 adds `taxNumber` and `businessNumber` (each `string | null`, max 64 chars) — a business's tax and legal-entity registration numbers, also platform fields since they identify the legal entity rather than any one app. Whether they print on a LedgerCore invoice is a separate, app-owned choice — see `/ledger-core/settings/invoicing`'s `showTaxNumber`/`showBusinessNumber`. All fields optional, at least one required (`400 No fields to update`).

**The base-currency lock (Phase 9a).** Once any `ledger_lines` row exists for the organization, submitting a *different* `baseCurrency` here returns `422 Base currency cannot be changed once journal entries exist` — the identical message and status `POST /ledger-core/settings/onboarding` has always returned (see the LedgerCore Settings section below). Before Phase 9a this route had no such check, leaving a gap where a base-currency change could bypass the lock entirely; the guard and the write now run inside one transaction here too. Re-submitting the *same* currency is always accepted.

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

### Audit trail — `/api/v1/audit-logs` — Phase 5

Platform-level, not namespaced under any app slug — the trail spans every app, and `appSlug` on each row carries the namespace instead (guardrails rule 16). Rows are written only by database triggers (migrations 017/018); there is no `POST`, `PATCH`, `PUT` or `DELETE` on this resource, and there never will be.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `OWNER`, `ADMIN` | The org's audit trail, newest first, without row images |
| GET | `/:id` | `OWNER`, `ADMIN` | One entry, including `oldRow`/`newRow` |

Deliberately narrower than every other read endpoint in this codebase (`/reports`, `/fiscal-periods` are open to any member): the trail records who did what, including an `ACCOUNTANT`'s own actions, so it is a control surface rather than a report.

`GET /` query parameters, all optional: `page`, `limit` (caps at 100, same as every other list endpoint) · `appSlug` (`platform` or an app slug from `config/apps.ts`) · `tableName` (exact match) · `rowId` (UUID) · `operation` (`INSERT`/`UPDATE`/`DELETE`) · `actorUserId` (UUID) · `from` / `to` — inclusive `created_at` date bounds, `YYYY-MM-DD`.

```json
{
  "success": true,
  "count": 20,
  "totalCount": 143,
  "currentPage": 1,
  "totalPages": 8,
  "logs": [
    {
      "id": "412",
      "txid": "918273",
      "appSlug": "ledger-core",
      "tableName": "invoices",
      "rowId": "b6b6...",
      "operation": "UPDATE",
      "changedKeys": ["status", "updated_at"],
      "actorUserId": "a1a1...",
      "actorName": "Alice",
      "actorEmail": "alice@example.com",
      "clientIp": "203.0.113.7",
      "createdAt": "2026-09-04T10:00:00.000Z"
    }
  ]
}
```

`GET /:id` adds `oldRow`/`newRow` — full JSONB snapshots of the row before and after, `null` on the side that doesn't apply (`oldRow` for an INSERT, `newRow` for a DELETE). `id` is a `BIGINT` identity, not a UUID; a non-numeric `:id` and a UUID from another organization both return `404`, never `400` or `403` — a `403` would confirm the id exists elsewhere (guardrails rule 1).

Failure paths: `400 operation must be one of INSERT, UPDATE, DELETE` · `403` for any role other than `OWNER`/`ADMIN` · `404 Audit log entry not found`.

`npm run verify:integrity` (not an HTTP route — a CLI script) independently re-derives three ledger-wide invariants — total debits equal total credits, every entry balances individually, no orphaned ledger line — and exits non-zero if any fails. See [study/postgresql/integrity-checking-a-ledger.md](../study/postgresql/integrity-checking-a-ledger.md). From Phase 7 this also runs on a daily schedule via the background worker, not only on demand.

---

### Webhooks — `/api/v1/webhooks` — Phase 7

Platform-level, not namespaced under any app slug — any app may emit into the outbox, and `app_slug` on the underlying event row carries the namespace (guardrails rule 16), the same convention `/audit-logs` uses.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `OWNER`, `ADMIN` | List the org's webhook endpoints. Never includes `secret` |
| POST | `/` | `OWNER`, `ADMIN` | Register an endpoint. `201`, includes `secret` — shown exactly once |
| GET | `/:id` | `OWNER`, `ADMIN` | One endpoint. Never includes `secret` |
| PATCH | `/:id` | `OWNER`, `ADMIN` | Update `url`, `label`, `eventTypes`, or `isActive` |
| DELETE | `/:id` | `OWNER` only | Removes the endpoint and, by cascade, its delivery history. `204`, no body |
| POST | `/:id/rotate-secret` | `OWNER` only | Issues a new signing secret, invalidating the old one. `200`, includes the new `secret` |

`OWNER`/`ADMIN` can configure endpoints; `DELETE` and `rotate-secret` are `OWNER`-only because both are irreversible and neither is a bookkeeping action.

`POST /` body:

```json
{
  "url": "https://hooks.example.com/autoledger",
  "label": "Ops Slack channel",
  "eventTypes": ["invoice.issued", "bill.approved"]
}
```

`eventTypes` — one to twenty of: `invoice.issued`, `bill.approved`, `payment.recorded`, `fiscal_period.closed`, `bank.large_unmatched`, `fx.revaluation_posted`.

`201` response:

```json
{
  "success": true,
  "endpoint": {
    "id": "...",
    "url": "https://hooks.example.com/autoledger",
    "label": "Ops Slack channel",
    "eventTypes": ["invoice.issued", "bill.approved"],
    "isActive": true,
    "createdBy": "...",
    "createdByName": "Alice",
    "createdAt": "2026-09-08T10:00:00.000Z",
    "updatedAt": "2026-09-08T10:00:00.000Z",
    "secret": "5061ece8...cc0650"
  },
  "secretNotice": "Store this secret now — it is shown once and cannot be retrieved again."
}
```

`secret` is 64 lowercase hex characters (32 random bytes), used to HMAC-SHA256-sign every delivery to this endpoint. It is present **only** in the `create` and `rotate-secret` responses — never in `GET /`, `GET /:id`, or `PATCH /:id`. See [study/security-auth/webhook-signing-and-ssrf.md](../study/security-auth/webhook-signing-and-ssrf.md).

The URL is validated at write time against SSRF: it must be `https`, or `http` outside production; no embedded credentials; and no `localhost`, `*.internal`, or private/reserved IPv4 range (including the cloud metadata address `169.254.169.254`). A rejected URL is `400 Webhook URL must not target a private host` (or the matching message for the other rules).

Failure paths: `400` for a malformed body or an unsafe URL · `409 A webhook endpoint with this URL already exists` on a duplicate URL in the same org · `403` for any role below the route's requirement · `404` for another org's endpoint id.

---

### Webhook deliveries — `/api/v1/webhook-deliveries` — Phase 7

Every attempt to deliver an event to a subscribed endpoint. `OWNER`/`ADMIN` only, mirroring `/webhooks`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `OWNER`, `ADMIN` | Paginated, filterable delivery list |
| GET | `/:id` | `OWNER`, `ADMIN` | One delivery, including its full JSON `payload` |
| POST | `/:id/retry` | `OWNER`, `ADMIN` | Re-queue a `FAILED` delivery. `202`, `409` from any other status |

`GET /` query parameters, all optional: `page`, `limit` (caps at 100) · `endpointId` (UUID) · `status` (`PENDING`/`DELIVERED`/`FAILED`) · `eventType` · `from` / `to` — inclusive `created_at` date bounds, `YYYY-MM-DD`.

```json
{
  "success": true,
  "count": 20,
  "totalCount": 3,
  "currentPage": 1,
  "totalPages": 1,
  "deliveries": [
    {
      "id": "...",
      "endpointId": "...",
      "endpointLabel": "Ops Slack channel",
      "endpointUrl": "https://hooks.example.com/autoledger",
      "eventId": "418",
      "eventType": "invoice.issued",
      "status": "DELIVERED",
      "attemptCount": 1,
      "lastStatusCode": 200,
      "lastError": null,
      "deliveredAt": "2026-09-08T10:00:05.000Z",
      "createdAt": "2026-09-08T10:00:00.000Z",
      "updatedAt": "2026-09-08T10:00:05.000Z"
    }
  ]
}
```

`GET /:id` adds `payload` — the full event body sent to the endpoint.

`POST /:id/retry` is legal **only** from `FAILED` (the one reverse edge in the delivery FSM); `PENDING` or `DELIVERED` both `409 A delivery in status <STATUS> cannot be retried`. There is no `PUT`/`DELETE` — a delivery is an outbound record of fact; correction is a new attempt via retry, never a mutation.

Failure paths: `400 status must be one of PENDING, DELIVERED, FAILED` for an unknown `status` filter · `403` for any role below `OWNER`/`ADMIN` · `404` for another org's delivery id · `409` for a retry on a non-`FAILED` delivery.

---

### Onboarding — `/api/v1/onboarding` — Phase 9a

Resumable, skippable setup-wizard state, one row per `(org, app)` plus a `'platform'` sentinel. Platform-level, not namespaced under any app — every app that acquires a wizard gets skip-and-resume for free (guardrails rule 16), mirroring `/audit-logs` and `/webhooks`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The checklist — one item per app in the registry plus `'platform'`, a missing row reads as `NOT_STARTED` |
| GET | `/:appSlug` | any member | One app's onboarding state |
| PUT | `/:appSlug/draft` | `OWNER`, `ADMIN` | Upsert the current step and draft; moves to `IN_PROGRESS` |
| POST | `/:appSlug/skip` | `OWNER`, `ADMIN` | Upsert to `SKIPPED`; the draft is preserved |
| POST | `/:appSlug/resume` | `OWNER`, `ADMIN` | Upsert to `IN_PROGRESS`; legal from `SKIPPED` or `COMPLETED` |

`:appSlug` is a routing target validated against `config/apps.ts` (plus `'platform'`), never a tenancy boundary — `orgId` from the verified access token is still the only scope predicate. Every write is an upsert; there is no 409 for "you already started." `draft` is untrusted JSON — bound as one JSONB parameter, never spread into a query, and re-parsed through the target app's own schema when that app's own completion route (e.g. `POST /ledger-core/settings/onboarding`) runs. Completion is not a route here — each app's own wizard-completer calls `markCompletedOnClient` on its own transaction, so the app's data and its onboarding row commit together.

Failure paths: `400` from the schema · `403` for anything below `OWNER`/`ADMIN` on a write · `404 Unknown app` for a slug not in the registry · `409 Cannot move onboarding from <FROM> to <TO>` for an illegal transition (e.g. skip after already `COMPLETED` — completion only ever moves back to `IN_PROGRESS`, never to `SKIPPED`).

---

### LedgerCore — `/api/v1/ledger-core` — Phase 3 ✅, Phase 3.5 ✅, Phase 3.8 ✅, Phase 6 ✅, Phase 8 ✅, Phase 9b ✅

Full feature spec and the remaining phases: [ledger-core.md](ledger-core.md).

#### Accounts — `/api/v1/ledger-core/accounts`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's chart, ordered by code. `?tree=true` nests by `parentId`; `?includeInactive=true` includes retired accounts |
| GET | `/balances` | any member | Own and subtree-rollup balance for every account, including headers and inactive accounts. Optional `?asOf=YYYY-MM-DD` |
| GET | `/:id` | any member | One account |
| GET | `/:id/ledger` | any member | One postable account's ledger: opening balance, every line with a running balance, period totals, closing balance. `?from=`, `?to=`, `?page=`, `?limit=` |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create an account |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Rename, re-describe, retire, or re-parent |

**`GET /balances`** (Phase 3.6) is registered before `/:id` so `balances` is never matched as an account id. `ownBalanceCents` is `0` for a header account, which has no postings of its own; `rollupBalanceCents` sums the whole subtree and equals `ownBalanceCents` for a leaf. Both are type-aware, matching the trial balance. Inactive accounts are included so a retired child's history stays in its parent's rollup. Failure paths: `400 asOf must be a date in YYYY-MM-DD format`.

Reading the chart is open to any member because a `VIEWER` looking at a report needs to know what the codes mean; changing it is bookkeeping.

**There is no DELETE.** An account is retired with `isActive: false`. Deleting one that carries postings is refused by the FK (`ON DELETE RESTRICT`) anyway, and deleting one that does not would still break the audit trail's references.

`code` and `type` are **not** updatable. Reports derive meaning from the code ranges, and re-typing an account that already has postings would silently restate every prior period.

Failure paths: `409 Account code already exists` · `422 Parent account not found` (also returned when the parent belongs to another organization — "wrong tenant" and "does not exist" must be indistinguishable) · `422 Parent account must have the same type` · `422 Re-parenting would create a cycle`.

Every new organization is seeded with the [44-account default chart](schema.md#default-chart-of-accounts) — 34 postable leaves and 10 header rollups.

**`GET /:id/ledger`** (Phase 3.6) — the standard "account detail" view. Balances are type-aware, matching the trial balance's `netBalanceCents`: debit-positive for Asset and Expense, credit-positive otherwise. Rows are oldest-first; `runningBalanceCents` is a window function over the full filtered set, so it continues correctly across pages rather than restarting per page. Every figure is aggregated from raw `ledger_lines` on every request — no summary table. Header accounts are refused: `422 Account <code> is a header account and has no ledger of its own`. Other failure paths: `404 Account not found` · `400 <name> must be a date in YYYY-MM-DD format`.

#### Journals — `/api/v1/ledger-core/journals`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable entries with nested lines — the journal register |
| GET | `/:id` | any member | One entry with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post a balanced entry (min 2 lines, debits == credits in integer cents) |
| POST | `/:id/reverse` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post the reversing entry for a posted journal |

**No `PUT`, no `DELETE`, at any phase** — rule 6. A database trigger rejects the write with SQLSTATE `0A000` even if such a route were added by mistake.

`sourceType` and `sourceId` are **not accepted from the request body**; a client-posted entry is always `'manual'`. Another app posting into the GL passes them service-to-service, so no caller can forge an entry claiming to have come from AP-Flow.

**`GET /` query parameters** (Phase 3.6), all optional: `page`, `limit` (caps at 100, same as every other list endpoint) · `from` / `to` — inclusive `entry_date` bounds, `YYYY-MM-DD` · `accountId` — only entries with at least one line on this account · `sourceType` — exact match · `q` — case-insensitive substring match on `description`. `totalCount` and `totalPages` reflect the applied filters, not the whole table.

Every entry also carries `createdByName` / `createdByEmail` (the posting user, denormalised for display), `reversedByEntryId` (set on an original once it has been reversed — the inverse of `reversesEntryId`, `null` while uncorrected), and `totalDebitCents` / `totalCreditCents` (summed from `lines`).

Failure paths: `400` from the schema (fewer than two lines, a line with both sides set, a fractional amount) · `400 <name> must be a date in YYYY-MM-DD format` (`from`/`to`) · `400 accountId must be a UUID` · `422 Entry is unbalanced: debits N, credits M` · `422 Account <code> is a header account and cannot be posted to` · `422 Account not found` · `409 Entry has already been reversed` · `422 A reversing entry cannot itself be reversed`.

#### Reports — `/api/v1/ledger-core/reports`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/trial-balance` | any member | Per-account debit/credit totals, type-aware `netBalanceCents`, and `isBalanced`. Optional `?asOf=YYYY-MM-DD` |
| GET | `/profit-and-loss` | any member | Phase 4 — Revenue − Expenses over `?from=&to=` (both optional, defaulting to the current fiscal year to date), gross profit split via the `5xxx` range |
| GET | `/balance-sheet` | any member | Phase 4 — Assets = Liabilities + Equity as at `?asOf=` (optional, defaults to today), with `equity.retainedEarningsCents`/`equity.currentEarningsCents` derived on every read |
| GET | `/dashboard` | any member | Position, year-to-date and month-to-date performance, a 6-point trend, recent entries, the integrity check, and (Phase 3.9) `receivables`/`payables` AR/AP summaries. Optional `?asOf=YYYY-MM-DD` |
| GET | `/ar-aging` | any member | Phase 3.9 — accounts-receivable aging: 5 buckets (`CURRENT`/`D1_30`/`D31_60`/`D61_90`/`D90_PLUS`), per-customer rows, and reconciliation against the receivable control account. Optional `?asOf=YYYY-MM-DD` |
| GET | `/ap-aging` | any member | Phase 3.9 — accounts-payable aging, same shape as `/ar-aging`, per-vendor rows, reconciled against the payable control account. Optional `?asOf=YYYY-MM-DD` |
| GET | `/bank-reconciliation` | any member | Phase 6 — reconciles one bank account's GL balance against its imported statement lines. **Required** `?accountId=<uuid>`; optional `?asOf=YYYY-MM-DD` (defaults to today) |

Aggregated from raw `ledger_lines` (and, for `/ar-aging`/`/ap-aging`, from `invoices`/`bills`/`payment_allocations`) on every request. There is no summary table and none will be added. Only postable, active accounts appear in the trial balance. `isBalanced` is integer equality, never an epsilon.

**`/profit-and-loss`** returns `{ from, to, revenue, costOfSales, grossProfitCents, operatingExpenses, netIncomeCents }`, each of `revenue`/`costOfSales`/`operatingExpenses` a `{ rows, totalCents }` section. Only accounts with activity in the window appear (an `INNER JOIN`, unlike the trial balance's `LEFT JOIN`, which lists every account including zero-activity ones). COGS is the `5xxx` code range — not a sixth account type. `422 from must not be after to`.

**`/balance-sheet`** returns `{ asOf, fiscalYearStartDate, assets, liabilities, equity, totalLiabilitiesAndEquityCents, balances }`. `equity` extends the `{ rows, totalCents }` shape with `retainedEarningsCents` (every prior fiscal year's net income) and `currentEarningsCents` (this fiscal year's, up to `asOf`) — both **derived on every read**, never stored, because LedgerCore posts no year-end closing entry. `equity.totalCents` already includes both derived figures on top of the posted equity rows. `balances` is `assets.totalCents === totalLiabilitiesAndEquityCents`, integer equality.

`/dashboard` (Phase 3.5) is not the Phase 4 balance sheet — it exposes `currentEarningsCents` (Revenue − Expenses, all time) alongside `assetsCents`/`liabilitiesCents`/`equityCents` and an `equationHolds` flag, because Assets = Liabilities + Equity only holds once current-period earnings are folded in. `position.cashCents` is `null` when no cash account is configured in settings; when configured, it sums the account's whole subtree via a recursive walk. `trend` is always exactly 6 points, oldest first, gap-filled so a month with no postings still appears at zero. Phase 3.9 adds `receivables`/`payables`, each carrying `outstandingCents`, `overdueCents`, `draftCount`/`draftCents`, and a 5-bucket aging series identical in shape to `/ar-aging`/`/ap-aging`'s `buckets`; `payables` additionally carries `awaitingReviewCount`/`awaitingReviewCents` — bills entered but not yet approved, **not** an employee expense-claim inbox (AutoLedger has no such document).

`/ar-aging` and `/ap-aging` (Phase 3.9) bucket every open (`ISSUED`/`POSTED`) document's outstanding amount by days past due relative to `asOf`. `controlAccount` names the receivable/payable account each report is checked against (`null` if none is configured and no fallback code exists); `reconciles` is `totalOutstandingCents === controlAccount.balanceCents`, integer equality, `null` when there is no control account to compare against. A `false` value means a document was posted without a matching journal entry, or vice versa — a data-integrity signal, not a UI glitch to hide.

**Phase 8: every figure in both reports is base currency**, not native — `outstanding = base_total − base_allocated` (`base_allocated` summing `payment_allocations.base_amount_cents`, filtered the same way). For an organization with no foreign-currency documents this is numerically identical to the pre-Phase-8 native figures (base equals native at rate 1), so nothing changes observably; a foreign-currency invoice or bill now contributes its base-currency value to every bucket, every counterparty row, and the `reconciles` check against the base-currency GL control balance — the same "reporting is base currency" rule `/trial-balance`, `/profit-and-loss`, and `/balance-sheet` already followed. There is no separate native-currency total exposed by these two reports.

**`/bank-reconciliation`** (Phase 6) compares the named account's posted GL balance (`SUM(base_debit_cents − base_credit_cents)` up to `asOf`) against the sum of every imported, non-`IGNORED` bank line for the same account and date range. `reconciles = differenceCents === 0`, integer equality — but unlike `/ar-aging`/`/ap-aging`, a `false` here is a **completeness** claim about the imported statement history, not a **correctness** claim about the books: the GL and the statement describe two genuinely different sources (this system's own postings vs. a CSV a human chose to upload), so the far more common cause of disagreement is a month that was never imported, not a bug. See [study/postgresql/subledger-reconciliation-and-aging.md](../study/postgresql/subledger-reconciliation-and-aging.md). Also returns `matchedCount`/`matchedCents`, `unmatchedCount`/`unmatchedCents`, `ignoredCount`, and — when the most recent import for the account carried one — `statedClosingBalanceCents`/`statedClosingBalanceOn`/`statedClosingDifferenceCents`. Failure paths: `400 accountId is required` · `404 Account not found`.

Failure paths: `400 asOf must be a date in YYYY-MM-DD format` · `400 from/to must be a date in YYYY-MM-DD format` · `422 from must not be after to` (`/profit-and-loss` only).

#### Settings — `/api/v1/ledger-core/settings` — Phase 3.5

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | LedgerCore's onboarding/settings state for the active organization |
| POST | `/onboarding` | `OWNER`, `ADMIN` | Complete (or re-complete) onboarding: workspace name, currency, fiscal year, cash account |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit settings after onboarding |

A missing `ledger_settings` row is **not** a 404 — `GET /` returns `200` with `settings.onboardedAt: null` and sensible defaults, which is the signal the client's onboarding gate redirects on. `POST /onboarding` is idempotent: submitting it twice overwrites rather than erroring, so a double-submit from the wizard is harmless. `PATCH /` before onboarding has ever completed returns `409`.

`organizationName` and `baseCurrency` are accepted by `POST /onboarding` but are written through `PATCH /organizations`, not this table — see the Organizations section above. `PATCH /settings` does **not** accept either field.

**The base-currency lock.** Once any `ledger_lines` row exists for the organization, submitting a *different* `baseCurrency` to `POST /onboarding` returns `422` (`Base currency cannot be changed once journal entries exist`) — `ledger_lines.currency_code` is stamped at write time on rows that are immutable by trigger, so a retroactive change would silently invalidate every posted line. Re-submitting the *same* currency is always accepted. `settings.baseCurrencyLocked` tells the client when to disable the field. **As of Phase 9a, `PATCH /organizations` enforces the identical lock** (see the Organizations section above) — the two doors can no longer disagree.

Failure paths: `400` from the schema (missing/invalid field, unsupported currency) · `422 Base currency cannot be changed once journal entries exist` · `422 Cash account does not exist in this organization` (also returned for a cash account belonging to another organization) · `409 Complete LedgerCore onboarding before changing settings` (PATCH only).

Phase 7 adds `unmatchedAlertThresholdCents` (integer cents, `PATCH` only, `≥ 0`) — the minimum absolute value of an unmatched bank line's `amountCents` that fires a `bank.large_unmatched` webhook event on import. Defaults to `0`, which means **disabled**: every organization starts with no alerting, and existing organizations are unaffected by the migration that added the column. See [ledger-core.md#webhooks-for-financial-events--phase-7](ledger-core.md#webhooks-for-financial-events--phase-7--delivered).

Phase 8 adds `realizedFxGainAccountId`/`realizedFxLossAccountId`/`unrealizedFxAccountId` (each `PATCH`-only, a UUID or `null`) — the posting accounts `paymentService`'s realized-FX plug and (once it lands) period-end revaluation use. `null` (the default) falls back to chart codes `4910`/`6810`/`6820`.

This module only stores a fiscal-year *setting*; period rows themselves — `fiscal_periods`, close/lock, and the posting guard — are a separate module, `/api/v1/ledger-core/fiscal-periods` (Phase 4, below).

#### Fiscal periods — `/api/v1/ledger-core/fiscal-periods` — Phase 4

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's periods, optionally filtered by `?fiscalYear=` / `?status=` |
| GET | `/:id` | any member | One period, with `closedByName`/`lockedByName` and `entryCount` (journal entries dated inside it) |
| POST | `/generate` | `OWNER`, `ADMIN` | Generate the 12 monthly periods for the fiscal year containing `containingDate`. Idempotent — a second call for the same fiscal year creates nothing and returns `200` instead of `201` |
| POST | `/:id/close` | `OWNER`, `ADMIN` | `OPEN -> CLOSED`. New postings dated inside the period are rejected from this point on |
| POST | `/:id/reopen` | `OWNER`, `ADMIN` | `CLOSED -> OPEN`, clearing the close stamp. Refused on a `LOCKED` period — locking is terminal |
| POST | `/:id/lock` | `OWNER` only | `CLOSED -> LOCKED`. Irreversible — there is no route back from `LOCKED` to any other state |

`GET /` query parameters, both optional: `fiscalYear` (exact match on `fiscalYearLabel`, e.g. `FY 2026`) · `status` (`OPEN`/`CLOSED`/`LOCKED`).

The close/lock lifecycle is a three-state FSM (`OPEN -> CLOSED -> LOCKED`, plus `CLOSED -> OPEN`) — `LOCKED` has no outbound transition at all, so locking must pass through `CLOSED` first and can never be undone. See [study/architecture/document-lifecycle-fsm.md § A genuinely terminal state](../study/architecture/document-lifecycle-fsm.md). A date covered by no period at all is treated as open — an organization that has never generated periods keeps posting freely.

Posting a journal entry (manual, or via invoice issuance, bill approval, or a payment) dated inside a `CLOSED` or `LOCKED` period is rejected with `422` by `journalService`, and independently by a database trigger (migration 016) that fires regardless of what wrote the row. See [study/postgresql/exclusion-constraints-and-gist.md](../study/postgresql/exclusion-constraints-and-gist.md) for the `EXCLUDE USING GIST` constraint that makes two overlapping periods in one organization physically impossible.

Failure paths: `400 status must be one of OPEN, CLOSED, LOCKED` · `404 Fiscal period not found` · `409 Complete LedgerCore onboarding before generating fiscal periods` · `409 A fiscal period already overlaps this fiscal year` · `409 Cannot close/reopen/lock a <status> period` (the FSM rejection, naming the actual blocking state) · `422 The fiscal period covering <date> is closed/locked; reopen it or post to an open period` (from any endpoint that posts a journal entry).

#### Invoice settings — `/api/v1/ledger-core/settings/invoicing` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Invoice numbering, defaults, and branding for the active organization |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit invoice settings; creates the row on first write |

A missing `ledger_invoice_settings` row is **not** a 404 — `GET /` returns `200` with sensible defaults (`numberPrefix: 'INV-'`, `numberPadding: 6`, `nextNumber: 1`, `defaultDueDays: 30`, `defaultTaxRateBp: 0`, `taxLabel: 'Tax'`, `showTaxNumber: true`, `showBusinessNumber: false`, `showLegalName: true`, `accentColor: '#2563eb'`, every account id and text field `null`) and `configured: false`. `PATCH /` upserts the row and returns `configured: true`.

`receivableAccountId`, `defaultRevenueAccountId`, and `taxPayableAccountId` are optional overrides — when unset, issuing an invoice falls back to the default chart's `1120`/`4100`-per-line/`2140`. Each is validated against the org's own chart (composite FK): `422 Account does not exist in this organization` if it points at a foreign or missing account.

Failure paths: `400` from the schema (invalid `accentColor` — must be `#rrggbb`, invalid basis points, invalid padding) · `400 No fields to update` · `422 Account does not exist in this organization`.

#### Customers — `/api/v1/ledger-core/customers` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's customers, ordered by name. `?q=` filters by name (case-insensitive substring); `?includeInactive=true` includes retired customers (excluded by default) |
| GET | `/:id` | any member | One customer |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a customer |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit a customer, including retiring it (`isActive: false`) |

Email is lowercased on write. **There is no DELETE** — a customer is retired with `isActive: false`, matching `accounts`, since an invoice may reference one.

Failure paths: `400` from the schema (blank name, invalid email) · `400 No fields to update` (PATCH) · `404 Customer not found`.

#### Invoices — `/api/v1/ledger-core/invoices` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable invoices with nested lines — the invoice register |
| GET | `/:id` | any member | One invoice with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a draft invoice (never posted directly) |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Replace a **draft** invoice's fields and lines wholesale |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a **draft** invoice |
| POST | `/:id/issue` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Allocate a number and post a balanced journal entry |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the invoice; posts a reversing entry if it was issued |

An invoice is a sales (accounts-receivable) document. Through Phase 3.8 it was always in the organization's base currency; **Phase 8 lets it carry any currency with a resolvable exchange rate.** `PATCH`/`DELETE` are legal despite rule 6 because they operate only on `DRAFT` rows, which have posted nothing — refused with `409` by the service and with SQLSTATE `0A000` by a database trigger the instant an invoice leaves `DRAFT`. The only correction path once issued is `POST /:id/void`, which posts a reversing journal entry through the same mechanism `POST /journals/:id/reverse` uses.

**`POST /`** — `customerId`, `issueDate`, `dueDate` (`YYYY-MM-DD`, `>= issueDate`), `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `notes`, `paymentTerms`, and `lines` (min 1): each line is `description`, `quantityMilli` (thousandths of a unit — `2500` means `2.5`), `unitPriceCents`, `revenueAccountId` (must be a postable `Revenue` account), `taxRateBp` (basis points, default `0`). The server computes `netCents`/`taxCents` per line and `subtotalCents`/`taxCents`/`totalCents` on the header — the client may not supply totals, a number, a status, or a rate.

**Phase 8 fields on every invoice:** `fxRate` (`NUMERIC(18,8)` as a string — `"1.00000000"` for a base-currency invoice), `baseSubtotalCents`/`baseTaxCents`/`baseTotalCents` (the same totals converted to the organization's base currency). Re-resolved from `fx_rates` on every draft save against `issueDate` — a draft's base total is always honest — and **frozen** again at `issue`, re-resolved for the actual posting date (`entryDate ?? issueDate`), since that is the date that determines the rate a real-world settlement will be compared against. Once issued, `fxRate` never changes again.

**`POST /:id/issue`** — optional `entryDate` (defaults to the invoice's `issueDate`). Allocates the next number from invoice settings, posts one journal entry (`sourceType: 'invoice'`, `sourceId: <invoice id>`) debiting the receivable account for the total and crediting each distinct revenue account for its net plus the tax account for the tax total (only if > 0), then flips the invoice to `ISSUED`. Every posted line carries the invoice's own `currencyCode` and frozen `fxRate` — a foreign-currency invoice posts native foreign-currency amounts, converted to base currency on the line itself (`ledger_lines.base_debit_cents`/`base_credit_cents`).

**`POST /:id/void`** — optional `entryDate`. On an `ISSUED` invoice, posts the reversing entry and records `voidJournalEntryId`. On a `DRAFT` invoice, no GL posting occurs at all — nothing was ever posted. Either way the invoice becomes `VOID`, which is terminal.

`GET /` query parameters, all optional: `page`, `limit` · `status` (`DRAFT`/`ISSUED`/`VOID`) · `customerId` · `from`/`to` — inclusive `issueDate` bounds · `q` — matches invoice number or the customer name snapshot.

Failure paths: `400` from the schema · `400 status must be one of DRAFT, ISSUED, VOID` · `422 An invoice needs at least one line` · `422 Due date cannot be before the issue date` · `422 Customer not found` (also another org's customer) · `422 Revenue account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not a Revenue account` · `409 Only a draft invoice can be edited` / `409 Only a draft invoice can be deleted` · `422 No receivable account is configured. Set one in invoice settings.` / `422 No tax account is configured. Set one in invoice settings.` (issue only) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8, draft save and issue) · `409 An invoice that is <status> cannot be issued` · `409 This invoice has already been voided`.

**Not built (as of Phase 3.8):** payment recording, a `PAID` status, AR aging, an AR subledger report, PDF generation, multi-currency invoices. Payment recording, AR aging, and the AR/AP subledger reconciliation **landed in Phase 3.9**; multi-currency invoicing **landed in Phase 8** — see the Payments, Reports, and Exchange rates sections. PDF generation remains unbuilt.

#### Vendors — `/api/v1/ledger-core/vendors` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's vendors, ordered by name. `?q=` filters by name (case-insensitive substring); `?includeInactive=true` includes retired vendors (excluded by default) |
| GET | `/:id` | any member | One vendor |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a vendor |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit a vendor, including retiring it (`isActive: false`) |

Email is lowercased on write. **There is no DELETE** — a vendor is retired with `isActive: false`, matching `customers`, since a bill may reference one.

Failure paths: `400` from the schema (blank name, invalid email) · `400 No fields to update` (PATCH) · `404 Vendor not found`.

#### Bills — `/api/v1/ledger-core/bills` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable bills with nested lines — the bill register |
| GET | `/:id` | any member | One bill with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a draft bill (never posted directly) |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Replace a **draft or in-review** bill's fields and lines wholesale |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a **draft or in-review** bill |
| POST | `/:id/submit` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Send a draft bill for approval (`DRAFT -> AWAITING_APPROVAL`) |
| POST | `/:id/approve` | **`OWNER`, `ADMIN` only** | Post a balanced journal entry (`AWAITING_APPROVAL -> POSTED`) |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the bill; posts a reversing entry if it was posted |

A bill is a purchase (accounts-payable) document. Through Phase 3.9 it was always in the organization's base currency; **Phase 8 lets it carry any currency with a resolvable exchange rate**, mirroring invoices exactly. Its lifecycle has **four** states, not three like an invoice — `DRAFT -> AWAITING_APPROVAL -> POSTED -> VOID`, plus a recall edge `AWAITING_APPROVAL -> DRAFT` — because entering a bill and approving it for posting are deliberately separate acts of trust: an `ACCOUNTANT` can create and submit a bill but cannot approve it, only `OWNER`/`ADMIN` can. `PATCH`/`DELETE` are legal on `DRAFT` and `AWAITING_APPROVAL` (both pre-posting), refused with `409` by the service and SQLSTATE `0A000` by a database trigger the instant a bill reaches `POSTED`. The only correction path once posted is `POST /:id/void`.

**`POST /`** — `vendorId`, `vendorReference` (the **vendor's own** invoice number, required, unique per `(vendor, reference)` — the duplicate-payment control), `billDate`, `dueDate` (`>= billDate`), `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `notes`, `paymentTerms`, and `lines` (min 1): each line is `description`, `quantityMilli`, `unitPriceCents`, `expenseAccountId` (a postable `Expense` **or** `Asset` account — a bill may legitimately buy a fixed asset or a prepaid), `taxRateBp`. The server computes all totals — the client may not supply them, a status, or a rate.

**Phase 8 fields on every bill:** `fxRate`, `baseSubtotalCents`/`baseTaxCents`/`baseTotalCents` — resolved on every draft save against `billDate`, frozen at `approve` against the posting date, exactly like an invoice's `issueDate`/`issue`.

**`POST /:id/approve`** — optional `entryDate`. Posts one journal entry (`sourceType: 'bill'`, `sourceId: <bill id>`) debiting each distinct expense account for its net and the tax-input account for the tax total (only if > 0), crediting the payable account for the total, then flips the bill to `POSTED`. Every posted line carries the bill's own `currencyCode` and frozen `fxRate`.

**`POST /:id/void`** — optional `entryDate`. On a `POSTED` bill, posts the reversing entry. On `DRAFT`/`AWAITING_APPROVAL`, no GL posting occurs — nothing was ever posted. Refused with `409` if the bill has any `POSTED` payment allocated to it — void the payment first.

`GET /` query parameters, all optional: `page`, `limit` · `status` (`DRAFT`/`AWAITING_APPROVAL`/`POSTED`/`VOID`) · `vendorId` · `from`/`to` — inclusive `billDate` bounds · `q` — matches vendor reference or the vendor name snapshot · `settlement` (`OUTSTANDING`/`OVERDUE`/`PAID`) — implies `status=POSTED`.

Every bill also carries `allocatedCents`, `amountDueCents`, and `settlementStatus` (`NOT_APPLICABLE`/`UNPAID`/`PARTIALLY_PAID`/`PAID`/`OVERDUE`) — all **derived** on every read from `POSTED` payment allocations, never stored; `0`/`NOT_APPLICABLE` unless the bill is `POSTED`.

Failure paths: `400` from the schema · `400 status must be one of DRAFT, AWAITING_APPROVAL, POSTED, VOID` · `422 A bill needs at least one line` · `422 Due date cannot be before the bill date` · `422 Vendor not found` (also another org's vendor) · `422 Expense account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> must be an Expense or Asset account` · `409 This vendor reference has already been entered for this vendor` · `409 Only a draft or in-review bill can be edited` / `409 Only a draft or in-review bill can be deleted` · `403` approving as anything below `OWNER`/`ADMIN` · `422 No payable account is configured. Set one in settings.` / `422 No tax account is configured. Set one in settings.` (approve only) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8, draft save and approve) · `409 A bill that is <status> cannot be approved` · `409 This bill has already been voided` · `409 This document has payments applied. Void the payments first.` (void only).

**Not built:** an expense-claim / employee-reimbursement document (there is none, by design — see [roadmap.md § Phase 3.9](roadmap.md#phase-39-as-delivered)), credit notes, vendor credits, partial void.

#### Payments — `/api/v1/ledger-core/payments` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable payments (both directions) with nested allocations |
| GET | `/:id` | any member | One payment with its allocations |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Record a payment — born **posted**; posts a balanced journal entry in the same transaction |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the payment; posts a reversing entry and un-settles the documents it paid |

A payment settles one or more invoices (`direction: 'RECEIVE'`) or one or more bills (`direction: 'PAY'`) — never both directions in one payment, never invoices and bills mixed in one payment's allocations. **There is no draft and no `PATCH`** — a payment is created already posted, matching `journal_entries`; the only correction is `POST /:id/void`. **A payment may only allocate to documents in its own currency** (Phase 8) — enforced by the service and independently by `trg_allocations_currency` (migration 025).

**`POST /`** — `direction` (`RECEIVE`/`PAY`), `paymentDate`, `amountCents`, `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `cashAccountId` (a postable `Asset` account), `customerId` (RECEIVE) or `vendorId` (PAY, the other must be `null`), `method`, `reference`, `notes`, `allocations` (min 1, each `{ invoiceId | billId, amountCents }`, exactly one of `invoiceId`/`billId` per allocation), optional `entryDate`. `allocations[].amountCents` must sum to exactly `amountCents`. Posts one journal entry (`sourceType: 'payment'`, `sourceId: <payment id>`): `RECEIVE` debits the cash account and credits the receivable account; `PAY` debits the payable account and credits the cash account.

**Phase 8 fields on every payment:** `fxRate`, `baseAmountCents`; each allocation also carries `baseAmountCents`. For a base-currency payment these are unchanged from Phase 3.9 (`fxRate: "1.00000000"`, `baseAmountCents === amountCents`) — the GL shape is byte-identical to before. For a foreign-currency payment, the cash line posts at the settlement-date rate and each control line posts at *its own document's frozen rate*; the difference — the imbalance those two rates create in base currency — is posted automatically to `4910 Realized FX Gain` (credit) or `6810 Realized FX Loss` (debit), or omitted entirely when the rates match. See the worked example: [ledger-core.md § 3](ledger-core.md#3-realized-fx--the-worked-example).

**`POST /:id/void`** — optional `entryDate`. Posts the reversing entry and flips the payment to `VOID`. The payment's allocation rows are **never modified or deleted** (immutable, insert-only by trigger) — they simply stop counting toward any document's `allocatedCents`, because every settlement read filters on `status = 'POSTED'`. This is what un-settles the paid documents without a second write. Voiding a foreign-currency payment reverses its realized gain/loss line along with everything else, since the reversal copies every line's `currency_code`/`fx_rate` verbatim.

`GET /` query parameters, all optional: `page`, `limit` · `direction` (`RECEIVE`/`PAY`) · `status` (`POSTED`/`VOID`) · `customerId` · `vendorId` · `from`/`to` — inclusive `paymentDate` bounds.

Failure paths: `400` from the schema (including an allocation naming both `invoiceId` and `billId`, or neither) · `400 direction must be RECEIVE or PAY` · `400 status must be POSTED or VOID` · `422 Allocations must sum to the payment amount` · `422 Cash account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not an Asset account` · `422 Customer not found` / `422 Vendor not found` · `422 A RECEIVE payment cannot allocate to a bill` / `422 A PAY payment cannot allocate to an invoice` · `422 That document belongs to a different counterparty` · `422 Only an issued invoice can be paid` / `422 Only an approved bill can be paid` · `422 Allocation exceeds the amount still due on this document` · `422 A <currency> payment cannot settle a document in <currency>` (Phase 8) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8) · `422 No realized FX gain/loss account is configured. Set one in settings.` (Phase 8, only when a settlement actually realizes one) · `404 Payment not found` · `409 This payment has already been voided`.

#### Bank statement imports — `/api/v1/ledger-core/bank-imports` — Phase 6

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's imports, newest first. Optional `?accountId=` |
| GET | `/:id` | any member | One import's summary |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Import a bank statement CSV |

**The CSV arrives as a JSON string field, not a multipart upload** — `content` is the raw file text, capped by `MAX_CSV_CHARS` (900,000 characters) well under the 1MB JSON body limit; file storage is Phase 10's concern, not this one. **`POST /`** body: `accountId` (a postable `Asset` account), `fileName`, `content`, `dateFormat` (`ISO`/`DMY`/`MDY`, default `ISO`), optional `columnMap` (`{ date, description, amount | (debit + credit), reference }` — omit to auto-detect columns by header synonym), optional `closingBalanceCents`/`closingBalanceOn` (must be supplied together). Returns `201` with `{ import, importedCount, duplicateCount, suggestedCount, autoMatchableCount }`.

**Idempotent by content-addressed hash.** Each row's `dedupe_hash` folds in the org, account, date, amount, normalized description, reference, and an occurrence ordinal (so two genuinely identical lines in one file both survive), enforced by `UNIQUE (org_id, dedupe_hash)`. Re-importing the same statement returns `201` again with `importedCount: 0` and `duplicateCount` equal to the row count — the same set of rows, never doubled. See [study/postgresql/idempotent-ingestion-and-dedupe-hashes.md](../study/postgresql/idempotent-ingestion-and-dedupe-hashes.md).

**The whole file fails together.** Any unparseable date or amount rejects the entire import with `422`, naming up to the first three offending rows by number (header counted) — nothing is written. On success, every newly-inserted line is immediately scored against open invoices (positive amounts) or bills (negative amounts) within a ±30 days window; see the bank-transactions section below.

Failure paths: `400` from the schema · `422 Bank account not found` (also another org's account) · `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not an Asset account` · `422 The file is empty` / `422 Malformed CSV: ...` (from the CSV parser) · `422 Could not find a date/description column in the file` / `422 Could not find an amount column, or a debit/credit pair, in the file` · `422 Column "<name>" is not in the file` (explicit `columnMap` only) · `422 Import failed: N row(s) could not be parsed (...)` · `422 The file contains no transaction rows` · `409 That statement is already being imported` · `404 Bank statement import not found`.

#### Bank transactions — `/api/v1/ledger-core/bank-transactions` — Phase 6

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable bank lines with their scored suggestions |
| GET | `/:id` | any member | One bank line with its suggestions |
| POST | `/:id/rescore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete and regenerate one **unmatched** line's suggestions |
| POST | `/:id/match` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Accept a suggestion (or name a document explicitly) and post a payment |
| POST | `/:id/unmatch` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the payment the match created, returning the line to `UNMATCHED` |
| POST | `/:id/ignore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Mark a line as not needing reconciliation (e.g. a bank fee) |
| POST | `/:id/unignore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Return an ignored line to `UNMATCHED` and regenerate its suggestions |

**There is no `PATCH` and no `DELETE`.** A bank line's match state changes only through the five verbs above; correcting a match voids the payment it posted rather than editing the line (rule 6). Every mutation requires `ACCOUNTANT` or above, matching `/payments`, since matching and unmatching each post or void a real journal entry.

Each `BankTransaction` carries `amountCents` **signed** — positive is money in, negative is money out — and up to 5 `suggestions`, each with a `score` (0–100), a `scoreBreakdown` (`{ amount, date, counterparty }`, each `{ points, maxPoints, reason }`, e.g. `"exact match"` / `"0 day(s) apart"` / `"reference found in memo"`), and `autoMatchable` (`score >= 85`). See [study/architecture/fuzzy-matching-and-confidence-scoring.md](../study/architecture/fuzzy-matching-and-confidence-scoring.md).

`GET /` query parameters, all optional: `page`, `limit` · `accountId` · `importId` · `status` (`UNMATCHED`/`MATCHED`/`IGNORED`) · `from`/`to` — inclusive `txnDate` bounds · `q` — matches description or reference · `minScore` (0–100) — only lines carrying a suggestion at or above this score.

**`POST /:id/match`** body: exactly one of `suggestionId`, `invoiceId`, `billId`. A positive (deposit) line only matches an invoice; a negative (withdrawal) line only matches a bill. Locks the target document, validates its status (`ISSUED`/`POSTED`) and remaining amount due, then posts a payment through the same `paymentService` path `POST /payments` uses — never a direct write to `journal_entries`/`ledger_lines`. **A bank line settles at most one document, in full or in part — never a batch of several documents in one line.** Bank statements remain base-currency-only (Phase 6's stated limit, unchanged by Phase 8): a foreign-currency invoice or bill is never offered as a match candidate, and a manually-chosen one is refused with `422`.

**`POST /:id/unmatch`** takes no body. Voids the linked payment (if still `POSTED`) via a reversing journal entry, clears the match, and regenerates suggestions for the line.

Failure paths: `400 status must be UNMATCHED, MATCHED or IGNORED` · `400 minScore must be a whole number between 0 and 100` · `400` from the schema (`match` naming zero or two of `suggestionId`/`invoiceId`/`billId`) · `404 Bank transaction not found` · `404 Suggestion not found` · `422 A deposit can only be matched to an invoice` / `422 A withdrawal can only be matched to a bill` · `422 Invoice not found` / `422 Bill not found` (also another org's) · `422 Only an issued invoice can be paid` / `422 Only an approved bill can be paid` · `422 That document is already settled` · `422 The bank line exceeds the amount still due on that document` · `422 A base-currency bank line cannot settle a foreign-currency document` (Phase 8) · `422 Only an unmatched bank line can be rescored` · `422 The fiscal period covering <date> is closed/locked; ...` (from the underlying payment post) · `409 This bank line is already matched` / `409 This bank line is ignored — un-ignore it first` · `409 This bank line is not matched` · `409 This bank line is matched — unmatch it first`.

#### Exchange rates — `/api/v1/ledger-core/fx-rates` — Phase 8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable rates — `?fromCode=`, `?from=`/`?to=` (`rate_date` bounds, inclusive), `?page=`/`?limit=` |
| GET | `/latest` | any member | The latest rate for `?from=<currency>` against the org's base currency, on or before `?on=YYYY-MM-DD` (defaults to today) |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Record (or overwrite) a rate for a `(fromCode, toCode, rateDate)` triple |
| DELETE | `/:id` | `OWNER`, `ADMIN` | Remove a rate |

`/latest` is registered before `/:id` — there is no `GET /:id`, since a rate is looked up by pair and date, never by its id. `rate` is a **string** everywhere it crosses the wire (request and response) — `NUMERIC(18,8)` cannot round-trip through a JSON number without risking float drift, so it never does.

**`POST /`** re-posting the same `(fromCode, toCode, rateDate)` **overwrites** the existing row rather than conflicting — a corrected rate is normal operation, not a posted financial document (guardrails rule 6 does not apply to reference data). `fromCode`/`toCode` are restricted to the same `SUPPORTED_CURRENCIES` whitelist `PATCH /organizations` uses, and must differ from each other.

**`GET /latest`** resolves *the latest rate on or before* the requested date, never an exact match — a rate feed (manual or imported) has weekend/holiday gaps. When `from` equals the organization's own base currency, it returns an **identity** rate (`"1.00000000"`, `identity: true`) without consulting the table. Every document service (invoices, bills, payments — Phase 8, below) that needs a rate calls the same lookup internally.

Failure paths: `400` from the schema (missing/invalid `fromCode`/`toCode`/`rateDate`/`rate`) · `400 from must be a supported 3-letter ISO currency code` (`/latest`) · `422 A currency cannot have a rate against itself` · `422 Rate must be a positive number no greater than 1,000,000` · `422 No exchange rate for <from> to <to> on or before <date>` (`/latest`) · `404 Exchange rate not found` (`DELETE`, also another org's rate).

#### FX revaluation — `/api/v1/ledger-core/fx-revaluations` — Phase 8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, newest-first list of past revaluations, each with its lines |
| GET | `/:id` | any member | One revaluation, with its per-document lines |
| POST | `/` | **`OWNER`, `ADMIN` only** | Post a revaluation for `asOfDate` |

Also **`GET /ledger-core/reports/fx-exposure?asOf=YYYY-MM-DD`** (any member, defaults to today) — the identical computation, read-only: `{ asOfDate, baseCurrency, documents, byCurrency, totalDeltaCents, alreadyRevalued }`. Writes nothing and posts nothing — the preview `POST /fx-revaluations` re-computes and commits.

Narrower than every other LedgerCore write route except `POST /fiscal-periods/:id/lock` — a revaluation posts to the GL on someone's behalf, closer to a period close than to an ordinary document post, so the `ACCOUNTANT` tier that can post invoices/bills/payments cannot run one.

**`POST /`** — `{ asOfDate }` only. Re-computes the exposure **on its own transaction**, never trusting a figure the client might have cached from an earlier `GET /reports/fx-exposure` call. Posts one journal entry dated `asOfDate` restating every open foreign-currency invoice/bill at the as-of rate through `6820 Unrealized FX Gain/Loss`, then immediately posts a second entry reversing it, dated the calendar day after `asOfDate` — so a later real settlement's realized gain/loss always compares against a document's original frozen rate, never a revalued one. **There is no `PATCH`/`DELETE`** — a revaluation has no status and no lifecycle; a wrong one is corrected by the next period's revaluation, not by editing this one.

Failure paths: `400` from the schema (`asOfDate` missing/malformed) · `403` for anything below `OWNER`/`ADMIN` · `422 There is no open foreign-currency balance to revalue on this date` · `422 No exchange rate for <currency> to <base> on or before <date>` · `422 The fiscal period covering <date> is closed/locked; ...` (from the entry or its next-day reversal — the whole attempt rolls back, writing nothing) · `409 A revaluation already exists for this date` · `404 FX revaluation not found`.

#### Migration imports — `/api/v1/ledger-core/migration-imports` — Phase 9b

A business moving off another system's way in: stage a chart-of-accounts or opening-balance CSV, fix per-row errors, then commit once. Deliberately the inverse of `/bank-imports` (Phase 6) — every row stages, good and bad, instead of the whole file aborting on the first bad one.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Stage a new import — `{ kind, fileName, content }`, `content` is CSV text, not multipart |
| GET | `/` | any member | Paginated list, optional `?kind=` |
| GET | `/:id` | any member | One import's summary |
| GET | `/:id/rows` | any member | Paginated staged rows, optional `?status=VALID\|INVALID\|EXCLUDED` |
| PATCH | `/:id/rows/:rowId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Fix one row's fields; re-validates the whole import |
| POST | `/:id/validate` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Re-run validation without changing a row |
| GET | `/:id/preview` | `OWNER`, `ADMIN`, `ACCOUNTANT` | What commit will do if run now — never applies anything |
| POST | `/:id/commit` | **`OWNER`, `ADMIN` only** | Commit a `VALIDATED` import. Irreversible |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a non-committed import (rows cascade) |

There is no `dateFormat` and no `columnMap`, unlike `/bank-imports` — neither importer has a date column; columns resolve by header synonym only (`code`/`account code`/`account`/…, `debit`/`dr`/…, and so on).

**Kind `CHART_OF_ACCOUNTS`.** Matches on `code`: an unknown code is created (parent resolved by parent *code*, depth-first, the same technique `seedDefaultChart` uses), a known code merges `name`/`description` only — never `code` or `type`. `preview` reports `accountsToCreate`/`accountsToMerge`; `commit`'s `result` is `{ kind: 'CHART_OF_ACCOUNTS', createdCount, mergedCount }`. A chart import may be committed any number of times as **separate** uploads — nothing here limits it to one, unlike the opening-balance kind below.

**Kind `OPENING_BALANCES`.** Every `VALID` row becomes one line in **one** journal entry, posted through `journalService.createEntryOnClient` at `ledger_settings.books_start_date`, `sourceType: 'opening_balance'` — never a direct `ledger_lines` write, so the period-lock guard and the balance triggers apply unchanged. Any imbalance is plugged to `3400 Opening Balance Equity`, shown in `preview.plugCents` (signed: positive is a credit plug, negative a debit plug) before commit, never applied silently. `3200 Retained Earnings` and the AR/AP control accounts (`ledger_invoice_settings.receivableAccountId`/`ledger_settings.payableAccountId`, falling back to codes `1120`/`2100`) are refused per row — see the failure paths. `commit`'s `result` is `{ kind: 'OPENING_BALANCES', journalEntryId, plugCents }`. **A second committed opening-balance import for the same organization is refused, enforced by a partial unique index, not just the service** — see [schema.md](schema.md).

Row-level `errors: string[]` accumulate rather than abort; an import's `status` is `DRAFT` while any row is `INVALID`, `VALIDATED` once every non-excluded row is `VALID`, `COMMITTED` once posted (terminal). `PATCH .../rows/:rowId` accepts `accountCode`, `accountName`, `accountType`, `parentCode`, `description`, `debitCents`, `creditCents`, `status` (`VALID`/`EXCLUDED` only) — whichever fields are sent — then re-validates the whole import, so fixing one row can change another row's errors (e.g. resolving a duplicate code).

Failure paths: `400` from the schema · `403` for a write below its role tier · `404` for another org's import or row, or an unknown `id`/`rowId` · `409 Fix N invalid row(s) before committing` (commit attempted before `VALIDATED`) · `409 This import has already been committed` (any write to a `COMMITTED` import) · `409 A committed import cannot be deleted` · `409 This organization already has a committed opening-balance import` · `422 Could not find a(n) <field> column in the file` (a required header missing — the one whole-file failure) · `422 Complete LedgerCore onboarding before importing opening balances` · `422 Account 3400 Opening Balance Equity is missing — run migrations` · `422` from the period-lock guard if `books_start_date` falls inside a closed/locked period.

### Documents — `/api/v1/documents` — Phase 9.5

Platform-level, not namespaced under `/ledger-core` (rule 16): LedgerCore attaching a PDF to an invoice and AP-Flow attaching a source image (Phase 10) are both apps talking to the platform, never to each other. Full spec: [ledger-core.md](ledger-core.md) is silent on this — see [roadmap.md](roadmap.md#phase-95-as-delivered) instead.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Upload a file — multipart, field name `file`. `201` for new bytes, `200` when identical bytes already exist for this org (upload is idempotent by content hash) |
| GET | `/` | any member | Paginated documents, optional `?appSlug=&entityType=&entityId=` (an `EXISTS` filter against `document_links`) |
| GET | `/:id` | any member | One document's metadata plus every `document_links` row attached to it |
| GET | `/:id/file` | any member | Streams the stored original. Sets `Content-Disposition: attachment`, `Content-Type` (the sniffed MIME type), and `X-Content-Type-Options: nosniff` |
| POST | `/:id/links` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Attach a document to `{ appSlug, entityType, entityId }` |
| DELETE | `/:id/links/:linkId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Detach one link |
| DELETE | `/:id` | `OWNER`, `ADMIN` | Delete a document. Refused while any link exists |

Upload takes `multer` in **memory** storage, capped at `MAX_UPLOAD_BYTES` (10 MB). The MIME type is decided by **magic bytes**, never the client's `Content-Type` header — PDF/PNG/JPEG by signature, CSV by a UTF-8-round-trip text check plus a `.csv` filename — and restricted to that four-type allowlist (`server/src/utils/mimeSniff.ts`). A document's metadata row is update-immutable by trigger once written; there is no `PUT`/`PATCH` — the file itself is content-addressed, so an edit would mean the row no longer describes the bytes it names.

`entityType` is validated against a per-app registry (`server/src/types/documents.ts`'s `DOCUMENT_ENTITY_TYPES_BY_APP`) — currently `ledger-core`: `invoice`, `bill`, `journal_entry`, `payment`, `customer`, `vendor`. `entity_id` carries **no foreign key**: checking one would mean the platform querying an app's own tables, which rule 16 forbids, so a link can in principle outlive the entity it points at — accepted and tested, not prevented.

Failure paths: `400 Send exactly one file in a field named "file"` (no file, or wrong field) · `400 Uploaded file is empty` · `400 Invalid request body` (schema — `links`) · `403` for a write below its role tier · `404 Document not found` (also another org's) · `404 Attachment not found` · `409 This document is already attached to that record` · `409 Detach this document from every record before deleting it` · `413 File exceeds the 10 MB limit` · `415 Unsupported file type. Allowed: PDF, PNG, JPEG, CSV` · `422 Unknown app slug: <slug>` · `422 <app> documents cannot be attached to "<type>"`.

Storage is org-keyed and content-addressed (`server/storage/<org_id>/<ab>/<cd>/<sha256>`, gitignored, not committed) — two organizations uploading byte-identical files get two independent blobs, deliberately: a shared global namespace would let one tenant detect that another holds the same file. See [study/architecture/file-storage-and-streaming.md](../study/architecture/file-storage-and-streaming.md) and [study/security-auth/file-upload-threat-model.md](../study/security-auth/file-upload-threat-model.md).

---

### AP-Flow — `/api/v1/ap-flow` — Phase 10

Full spec: [ap-flow.md](ap-flow.md). Consumes the Document Vault above — a document is uploaded to `/api/v1/documents` first, then registered here by id. **Produces a draft; posts nothing to the ledger** (that's Phase 11).

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/documents` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Registers an already-vaulted PDF/PNG/JPEG document for extraction. `201`, status `PENDING`. Enqueues a background job — the response returns before extraction runs |
| GET | `/documents` | any member | Paginated, optional `?status=PENDING\|PROCESSING\|EXTRACTED\|FAILED` |
| GET | `/documents/:id` | any member | One document plus its pages (redacted metadata, never `ocrText`) and its extraction, if any |
| GET | `/documents/:id/pages/:pageNumber/image` | any member | The **redacted** page image — PII pixels painted over, this is what was sent to the vision model, never the original |
| POST | `/documents/:id/reextract` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Resets to `PENDING` and re-enqueues. `409` unless the document is `EXTRACTED` or `FAILED` |

Failure paths: `400 documentId must be a UUID` · `400 Invalid page number` · `400 Unknown status filter` · `403` for a write below its role tier · `404 Document not found` (the vault document, also another org's) · `404 AP-Flow document not found` (also another org's) · `404 Page not found` / `404 Redacted page image not found` · `409 This document is already registered with AP-Flow` · `409 Cannot re-extract a document in status <status>` · `422 AP-Flow can only process PDF, PNG and JPEG documents`.

The pipeline (rasterize → local OCR → PII-mask → vision extraction → persist) runs entirely inside the background job, never inside the request. Extraction runs against Claude (`claude-sonnet-5`); a server with no `ANTHROPIC_API_KEY` configured processes every step through masking and then fails that one document with `FAILED` / `"Vision extraction is not configured (ANTHROPIC_API_KEY is unset)"` — nothing else in the app degrades. See [study/architecture/document-capture-pipeline.md](../study/architecture/document-capture-pipeline.md), [study/security-auth/pii-detection-and-redaction.md](../study/security-auth/pii-detection-and-redaction.md), and [study/architecture/llm-structured-extraction.md](../study/architecture/llm-structured-extraction.md).

---

## Planned surface — by app

### LedgerCore — remaining phases

Phase 3, Phase 4, Phase 6, Phase 8, and Phase 9b are **built** and documented in the section above — the FX engine's `fx_rates`, foreign-currency invoices/bills/payments with realized settlement gain/loss, period-end unrealized revaluation, and the staged chart-of-accounts/opening-balance importer are all complete. Still to come:

#### QuickBooks Online sync — Phase 17

`/quickbooks/{connect,callback,status,sync}` for the OAuth 2.0 authorization-code flow and journal push. Documented properly when it lands.

### AP-Flow — `/api/v1/ap-flow` — Phase 11

Phase 10 (capture & extraction) is **built** and documented in the section above. Still to come, per [ap-flow.md](ap-flow.md):

| Method | Path | Description |
|---|---|---|
| GET | `/review-queue` | Documents awaiting human approval, lowest confidence first |
| PATCH | `/documents/:id/line-items/:lineId` | Override a suggested account before posting |
| POST | `/documents/:id/post` | Approve and post into LedgerCore. `ACCOUNTANT` and above |

`POST /documents/:id/post` will be the app boundary in practice: it calls LedgerCore's `journalService` with `source_type = 'ap_flow'`, and never writes `journal_entries` or `ledger_lines` itself (rule 16).

### The other five apps

TaxGuard AI, FP&A Engine, UnitEcon, BoardDeck Automator, and ForecasterPro have no routes yet — their surfaces get documented here, under `/api/v1/<app-slug>/…`, when each one's first module lands. See [roadmap.md](roadmap.md) for phase order.

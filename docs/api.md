# API Reference

**Built: `/health`, `/auth`, `/organizations`, `/audit-logs`, `/ai-usage`, `/webhooks`, `/webhook-deliveries`, `/onboarding`, `/documents`, `/integrations`, the accounting resources at the root (`/accounts`, `/journals`, `/invoices`, `/bills`, …), `/inventory`, `/capture`.** Everything below the *Built* section is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. The prefix is declared once, in `server/src/config/constants.ts`, and applied in `app.ts`; every router mounts on the shared `apiRouter` in `server/src/routes/index.ts`.
- **One product, one namespace (Phase 33).** Platform routes (`/auth`, `/organizations`, `/health`, `/onboarding`, `/documents`, …) and the accounting module's resources (`/accounts`, `/journals`, `/invoices`, `/bills`, `/items`, `/settings`, `/reports`, …) sit directly under `/api/v1`. Two modules keep a prefix because their resource names would otherwise collide: **inventory** at `/api/v1/inventory/*` (its own `/items`, `/settings`) and **capture** (the bill inbox) at `/api/v1/capture/*` (its `/documents` sits beside the vault's). Until Phase 33 every app had its own prefix (`/ledger-core`, `/stock`, `/ap-flow`); those prefixes, `/apps` and `/organizations/apps` now answer `404`. See [architecture.md](architecture.md).
- From Phase 1, every route except `/auth/*` and `/health` requires the `auth` middleware.
- Success: `{ success: true, ... }`. List endpoints add `count`, `totalCount`, `currentPage`, `totalPages`.
- Pagination defaults to `page=1&limit=20`, `limit` capped at 100.
- Errors: throw or `next(new ApiError(status, message))` and let `errorHandler.ts` format them. Never hand-roll an error response.
- **`400` vs `422`:** `400` means the request is malformed — a missing field, a wrong type, an unparseable date. `422` means it parsed fine and is still wrong for a domain reason: an entry whose debits do not equal its credits, a posting into a closed period, a parent account of the wrong type. The client shows the two differently, so the distinction is load-bearing rather than stylistic.
- `404`, never `403`, for a resource that exists in another organization. A `403` confirms the id is real.
- Financial mutations require an `Idempotency-Key` header from Phase 17 (QuickBooks sync) onward, where a retried request must not double-post.
- Posted documents expose `POST /:id/reverse`, never `PUT` or `DELETE`.
- **Every response carries `X-Request-Id`** (2026-09-29) — a UUID generated per request, or a well-formed incoming `X-Request-Id` (8–64 of `A-Z a-z 0-9 . _ -`) kept as-is. It is exposed through CORS and stamped on every server log line for that request; quote it when reporting a problem.
- **A state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) from a foreign origin is refused with `403 Cross-origin request refused`** (2026-09-29, `middleware/originCheck.ts`) before it reaches any route — a present `Origin` header must equal `FRONTEND_URL`'s origin (`Origin: null` is refused). A request with no `Origin` (a non-browser client) is allowed. Responses also carry `helmet`'s security headers (`nosniff`, `Referrer-Policy: no-referrer`, HSTS, a restrictive CSP, frame denial).

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
| POST | `/register` | none | Create user + organization + OWNER membership, in one transaction. Phase 37: `{ inviteToken }` in place of `organizationName` creates the user inside the inviting organization instead (no organization of their own) |
| POST | `/login` | none | Sets access + refresh tokens as httpOnly cookies |
| POST | `/refresh` | refresh cookie | Rotate both tokens |
| POST | `/logout` | none | Clear cookies + delete the refresh token row |
| GET | `/check` | access cookie | Verify session; return user, active org, role, memberships |
| POST | `/switch-org` | access cookie | Re-issue the session scoped to another org the user belongs to |
| POST | `/forgot-password` | none | 2026-09-29. `{ email }` → always `202 { success, message }`, whether or not the account exists. Issues a single-use reset token (30 minutes, newest only) — see below |
| POST | `/reset-password` | none | 2026-09-29. `{ token, password }` → `200`. Sets the password and signs the user out everywhere. `400` for an invalid, used or expired token, or a password failing the registration rules |
| POST | `/organizations` | access cookie | Phase 37. `{ name }` (2–120 chars) → `201` session body. Creates an organization the caller owns (chart of accounts and payment terms seeded, no settings — the client's setup gate opens its wizard) and moves the session into it. `422` past 25 owned organizations |
| POST | `/leave-org` | access cookie | Phase 37. Leave the **active** organization → session body in the oldest remaining one. `422` for the last `OWNER`, or for the user's only organization |
| GET | `/invitations/:token` | none | Phase 37. Invite-link preview: `{ invitation: { organizationName, invitedByName, email, role, status, expiresAt } }`. `404` for an unknown token. Rate limited |
| POST | `/invitations/:token/accept` | access cookie | Phase 37. Join the inviting organization → session body in it. `403` when the signed-in email is not the invited one, `409` already a member, `410` used/revoked/expired. Rate limited |
| PATCH | `/me` | access cookie | Phase 38a. `{ name }` → `{ user }`. Your own display name; empty clears it |
| POST | `/change-password` | access cookie | Phase 38a. `{ currentPassword, newPassword }` → `{ signedOutSessions }`. A wrong current password is **`400`, not `401`** (a 401 on an authenticated route reads as an expired token to the client's auto-refresh). The new password obeys the registration rules. Revokes every **other** session and any outstanding reset link; this one stays signed in. Rate limited |
| GET | `/sessions` | access cookie | Phase 38a. `{ sessions: [{ id, startedAt, lastActiveAt, userAgent, ip, organizationName, current }] }` — your live, unrevoked sessions, newest activity first. `id` is the session id carried across token rotation |
| DELETE | `/sessions/:id` | access cookie | Phase 38a. Sign one other browser out. Another user's or an unknown id is `404`; the current session is `422` (use `/logout`) |
| POST | `/sessions/revoke-others` | access cookie | Phase 38a. Sign out everywhere except here → `{ signedOutSessions }` |
| POST | `/verify-email` | none | Phase 38b. `{ token }` → `200`. Marks the address verified if it is still the account's address (a link minted before an email change cannot verify the new one). `400` invalid, used, expired or stale. Rate limited |
| POST | `/verify-email/resend` | access cookie | Phase 38b. → `202`; a fresh link, the old one stops working. `409` already verified, `429` within a minute of the last one. Rate limited |
| POST | `/me/email` | access cookie | Phase 38b. `{ newEmail, currentPassword }` → `202`. Emails a confirmation link to the **new** address; nothing changes until it is opened. `400` wrong password or same address; `409` the address has an account (a stated trade-off: a signed-in, rate-limited caller learns that an address is registered). Rate limited |
| POST | `/confirm-email-change` | none | Phase 38b. `{ token }` → `200`. Swaps the sign-in email, marks it verified, and emails a notice to the **old** address. `409` if the address was taken in between. Rate limited |
| GET | `/me/notifications` | access cookie | Phase 38b. `{ preferences: [{ event, enabled }] }` for `bill_awaiting_approval` and `invitation_accepted`. Per user, across every organization; no row = enabled |
| PUT | `/me/notifications` | access cookie | Phase 38b. `{ preferences: [{ event, enabled }] }` — upserts each given event |

**`/refresh` is a `POST`, not a `GET`.** It rotates the refresh token, so it is state-changing — and `SameSite=Lax` deliberately still sends cookies on a top-level cross-site *navigation*, which would let a plain link from any site silently rotate a visitor's session and log them out.

**`/register` seeds the chart of accounts** from Phase 3 onward — 44 accounts, inside the same transaction that creates the organization, so a rollback takes them with it ([schema.md](schema.md#default-chart-of-accounts)). It does not log you in: it returns `201` and the client calls `/login` next.

**`/register` and `/login` are rate limited** — 10 failed attempts per 15 minutes per IP, returning `429` in the standard error envelope. Successful logins are not counted, so a shared office NAT cannot lock colleagues out. `/refresh` and `/logout` are deliberately **not** limited: a legitimate client refreshes on a schedule, and the one moment you most want to clear cookies is the moment you must be able to.

`/logout` is public on purpose: clearing cookies must work even when the access token has already expired.

**Email (Phase 38b).** Invitations, password reset, verification, change-of-email and notifications are emailed. Every message is an `email_outbox` row written on the transaction of the change it describes, and the worker's `email-drain` sends it (see [architecture.md](architecture.md#email--phase-38b)). `POST /organizations/invitations` still returns `acceptUrl` once, as a fallback if the email does not arrive. Register now also sends a verification email.

**Sessions and revocation (Phase 38a).** A browser's session id is minted at login and carried through every rotation, switch-org, create, accept and leave, so it stays one entry in `GET /sessions`. Revoking a session (one, all others, or by changing your password) marks its refresh row `revoked_at` instead of deleting it. A deleted row would make that browser's next refresh look like a replayed token, and reuse detection would sign out **every** session, the revoker's included. A revoked row is refused quietly on refresh (`401`, cookies cleared, other sessions untouched), and the session-moving routes refuse it too, so a revoked browser cannot use its still-valid access token to mint a new session. Its access token itself lasts up to 15 minutes, the same trade-off as logout.

**Session-moving organization routes live under `/auth` (Phase 37).** Creating, leaving and accepting all re-issue the session in another organization, exactly as `/switch-org` does — and the refresh cookie is path-scoped to `/api/v1/auth`, so only here can the presented refresh row be retired. Under `/organizations` the old row would linger until it expired. **Login opens the last-used organization** (`users.last_active_org_id`, written on every session issue), falling back to the oldest membership if the user has since left it.

**Password reset (2026-09-29).** `/forgot-password` never reveals whether an email has an account: the status and body are identical either way, and the email's format is not validated (a format error would be a different answer). The token is 256 random bits; only its SHA-256 is stored (`password_reset_tokens`, migration `077`). `/reset-password` consumes it with an atomic `DELETE ... RETURNING` — so a link works once — then sets the new bcrypt hash and deletes every one of the user's reset and refresh tokens in the same transaction. **Delivery is a log line, not an email:** there is no mail transport. Outside production the link (`<FRONTEND_URL origin>/reset-password?token=…`) is logged at `info`; in production only a warning that a reset was requested. Both endpoints are rate limited like `/login`.

#### Session body

Returned by `/login`, `/check`, `/refresh`, `/switch-org` and (Phase 37) `/organizations`, `/leave-org` and `/invitations/:token/accept`:

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

**Phase 38c — the Auth column below names permissions.** Since Phase 38c every route is gated by a permission key (`config/permissions.ts`), not a role list. For the built-in roles nothing changed: each key's tier admits exactly the roles the old list did. `OWNER`, `ADMIN` in an older row means a tier-`M` key such as `settings.manage` or `members.manage`. A 403 now reads *This action needs the "…" permission.* `PATCH /members/:userId` and `POST /invitations` take `{ role }` (built-in) **or** `{ customRoleId }`, and refuse handing out permissions the caller lacks (`403`). The session body gains `roleName` and `permissions`. Member, membership and invitation objects gain `roleName` (and `customRoleId`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The caller's active organization |
| GET | `/members` | `OWNER`, `ADMIN` | Everyone in the active organization |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit the organization's name, base currency, and/or tax identifiers |
| GET | `/profile` | any member | The organization's postal identity — address, contact details, logo — Phase 30 |
| PATCH | `/profile` | `OWNER`, `ADMIN` | Edit the organization's postal identity; creates the row on first write — Phase 30 |
| PATCH | `/members/:userId` | `OWNER`, `ADMIN` | Phase 37. `{ role }` → `{ member }`. Only an `OWNER` may grant, change or remove `OWNER` (`403`); demoting the last `OWNER` is `422`. Another organization's member is `404` |
| DELETE | `/members/:userId` | `OWNER`, `ADMIN` | Phase 37. Remove someone else (yourself: `422`, use `POST /auth/leave-org`). Same `OWNER` rules. Takes effect at the member's next refresh — up to 15 minutes ([architecture.md](architecture.md#the-15-minute-revocation-window--a-deliberate-trade)) |
| GET | `/invitations` | `OWNER`, `ADMIN` | Phase 37. Open invitations (pending, or expired and not yet closed out), newest first |
| POST | `/invitations` | `OWNER`, `ADMIN` | Phase 37. `{ email, role }` → `201 { invitation, acceptUrl }`. **The link is returned this once** — only the token's SHA-256 is stored, and there is no mail transport (outside production it is also logged). `409` if the address is already a member or has a pending invitation; `403` for an `ADMIN` inviting an `OWNER`. Expires after 7 days |
| DELETE | `/invitations/:id` | `OWNER`, `ADMIN` | Phase 37. Revoke. Another organization's invitation is `404`; an accepted one is `409` |
| GET | `/email-settings` | `OWNER`, `ADMIN` | Phase 38b. `{ settings: { senderName, replyTo, fromEmail, transport } }` — how email sent for this organization presents itself. `fromEmail` is the platform's verified sender and is read-only |
| PATCH | `/email-settings` | `OWNER`, `ADMIN` | Phase 38b. `{ senderName?, replyTo? }`; `null` resets a field to the default |
| GET | `/roles` | `members.view` | Phase 38c. `{ builtin: [{ role, permissions }], custom: [{ id, name, description, permissions, memberCount }], catalogue: [{ key, area, label, tier, requires? }] }` |
| POST | `/roles` | `roles.manage` | Phase 38c. `{ name, description?, permissions[] }` → `201 { role }`. The set is closed over `requires`. `400` unknown key or empty, `422` an owner-only key, `403` a key you do not hold (non-owners), `409` duplicate name (case-insensitive) |
| PATCH | `/roles/:id` | `roles.manage` | Phase 38c. Same body; replaces name, description and permissions. Takes effect for every holder on their next request. `403` if the role already exceeds your permissions; another organization's role is `404` |
| DELETE | `/roles/:id` | `roles.manage` | Phase 38c. `409` while any member holds it; its open invitations go with it |

The active organization comes **only** from the verified access token. `orgId` in a query string, an `X-Org-Id` header, or a request body is ignored — there is a test that sends all three pointing at another tenant and asserts the response is unchanged.

`/members` is `OWNER`/`ADMIN` only because it exposes every colleague's email address. Other roles get `403`, which the client renders as an explanatory notice rather than an error.

`PATCH /` (Phase 3.5) is the platform half of accounting's onboarding — organization name and `base_currency` are platform fields, not accounting ones, so they are edited here rather than under `/settings`. Phase 3.8 adds `taxNumber` and `businessNumber` (each `string | null`, max 64 chars) — a business's tax and legal-entity registration numbers, also platform fields since they identify the legal entity rather than any one app. Whether they print on a accounting invoice is a separate, app-owned choice — see `/settings/invoicing`'s `showTaxNumber`/`showBusinessNumber`. All fields optional, at least one required (`400 No fields to update`).

**The base-currency lock (Phase 9a).** Once any `ledger_lines` row exists for the organization, submitting a *different* `baseCurrency` here returns `422 Base currency cannot be changed once journal entries exist` — the identical message and status `POST /settings/onboarding` has always returned (see the accounting Settings section below). Before Phase 9a this route had no such check, leaving a gap where a base-currency change could bypass the lock entirely; the guard and the write now run inside one transaction here too. Re-submitting the *same* currency is always accepted.

**Organization profile (Phase 30).** `GET /profile` is open to any member — the invoice document renders it, and a `VIEWER` can open an invoice. A missing `organization_profiles` row is **not** a `404`: it returns `200` with every field `null` (`postalSameAsStreet: true`) and `configured: false`. `PATCH /profile`, `OWNER`/`ADMIN` only, upserts the row and returns `configured: true`. Body (all optional, at least one required — `400 No fields to update`): `legalName`, `industry` (free text, no fixed list), `streetAddress1`/`streetAddress2`, `city`, `region`, `postalCode`, `countryCode` (2-letter, case-insensitive on write, stored upper-case), `postalSameAsStreet` (boolean — when `true`, the six `postal*` fields are ignored by the renderer, not cleared), `postalAddress1`/`postalAddress2`/`postalCity`/`postalRegion`/`postalPostalCode`/`postalCountryCode`, `phone`, `contactEmail` (lowercased on write, rule 9), `website`, `logoDocumentId` (a `documents.id` — must belong to the caller's organization).

Failure paths: `400` from the schema (e.g. a `countryCode` that isn't 2 letters) · `400 No fields to update` · `401` no session · `403` non-`OWNER`/`ADMIN` on `PATCH` · `422 Logo document does not exist in this organization` (`logoDocumentId` missing or belongs to another tenant — the composite FK `fk_organization_profiles_logo_document` rejects it) · `422` any other CHECK violation (e.g. a blank `legalName`).

`legalName` and `industry` are **also** readable/writable through `GET`/`PATCH /settings` (they round-trip as part of `LedgerSettings`, unchanged in shape) — `settingsService` delegates those two fields to `organizationProfileService` under the hood as of Phase 30; see [schema.md § Phase 30](schema.md#phase-30--organization-profile--invoice-templates-platform--ledgercore--applied). A `PATCH /settings` body containing only `legalName`/`industry` (no `ledger_settings` column) still returns the same `409 Complete setup before changing settings` as every other settings write until onboarding has completed once — the profile itself stays editable before onboarding through `PATCH /organizations/profile` directly.

---

### Audit trail — `/api/v1/audit-logs` — Phase 5

Platform-level — the trail spans every module, and `module` on each row names the one that wrote it (a frozen provenance tag from `server/src/config/modules.ts`: `ledger-core` = accounting, `ap-flow` = capture, `stock` = inventory, or `platform`; guardrails rule 16). Rows are written only by database triggers (migrations 017/018); there is no `POST`, `PATCH`, `PUT` or `DELETE` on this resource, and there never will be.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `OWNER`, `ADMIN` | The org's audit trail, newest first, without row images |
| GET | `/:id` | `OWNER`, `ADMIN` | One entry, including `oldRow`/`newRow` |

Deliberately narrower than every other read endpoint in this codebase (`/reports`, `/fiscal-periods` are open to any member): the trail records who did what, including an `ACCOUNTANT`'s own actions, so it is a control surface rather than a report.

`GET /` query parameters, all optional: `page`, `limit` (caps at 100, same as every other list endpoint) · `module` (`platform` or a module tag from `config/modules.ts`) · `tableName` (exact match) · `rowId` (UUID) · `operation` (`INSERT`/`UPDATE`/`DELETE`) · `actorUserId` (UUID) · `from` / `to` — inclusive `created_at` date bounds, `YYYY-MM-DD`.

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
      "module": "ledger-core",
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

### AI usage — `/api/v1/ai-usage` — Phase 19.1

Platform-level — every module that calls a model records here (`app_slug` on the row, exposed as `module`, carries the provenance tag; guardrails rule 16), the same convention `/audit-logs` uses. Unlike the audit trail, this is **open to every member**, `VIEWER` included: token spend is operational telemetry about the organization's own processing, the same class of thing `/reports` is, not a control surface. There is no write route on this resource, now or ever — rows are written only by `aiUsageService.recordCall`, called from inside a service (currently capture's extraction/classification pipeline).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Aggregate token/cost usage — totals, and grouped by model, by app, by purpose, and by day |

`GET /` query parameters, all optional: `from` / `to` — inclusive `created_at` date bounds, `YYYY-MM-DD` · `module` (a module tag from `config/modules.ts`).

```json
{
  "success": true,
  "usage": {
    "totals": {
      "callCount": 42,
      "okCount": 40,
      "errorCount": 2,
      "inputTokens": 51000,
      "outputTokens": 9800,
      "totalTokens": 60800,
      "costMicroUsd": 200400,
      "unpricedCallCount": 3
    },
    "byModel": [{ "key": "claude-sonnet-5", "provider": "anthropic", "callCount": 39, "...": "..." }],
    "byModule": [{ "key": "ap-flow", "provider": null, "callCount": 42, "...": "..." }],
    "byPurpose": [{ "key": "EXTRACT", "provider": null, "callCount": 30, "...": "..." }],
    "byDay": [{ "date": "2026-09-17", "callCount": 12, "...": "..." }],
    "pricingVersion": "2026-06-24"
  }
}
```

`costMicroUsd` is millionths of one US dollar (see `utils/microUsd.ts`) — operational AI spend, never ledger money, and never in `utils/money.ts`'s `Cents`. `totals.costMicroUsd` sums only rows whose model carried a verified price in `config/aiPricing.ts` at the time of the call; `unpricedCallCount` is how many rows were excluded from that sum, so a client can say plainly that some spend is not represented in the total rather than silently understating it. A model with no verified price still contributes its real token counts to `inputTokens`/`outputTokens`/`totalTokens`.

Failure paths: `400 from must be a date in YYYY-MM-DD format` · `400 to must be a date in YYYY-MM-DD format` · `400 module must be at most 50 characters` · `401`.

`GET /capture/documents/:id` (below) also carries `modelCalls: AiModelCall[]` — every metered call attributed to that one document, via `aiUsageService.listCallsForEntity`, never a direct join into `ai_model_calls` from capture's own query (rule 16).

See [study/architecture/metering-and-cost-attribution.md](../study/architecture/metering-and-cost-attribution.md).

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

`eventTypes` — one to twenty of: `invoice.issued`, `bill.approved`, `payment.recorded`, `fiscal_period.closed`, `bank.large_unmatched`, `fx.revaluation_posted`, `quote.sent`, `quote.accepted`, `quote.declined`, `quote.converted` (Phase 41).

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
| GET | `/:module` | any member | One setup task's onboarding state |
| PUT | `/:module/draft` | `OWNER`, `ADMIN` | Upsert the current step and draft; moves to `IN_PROGRESS` |
| POST | `/:module/skip` | `OWNER`, `ADMIN` | Upsert to `SKIPPED`; the draft is preserved |
| POST | `/:module/resume` | `OWNER`, `ADMIN` | Upsert to `IN_PROGRESS`; legal from `SKIPPED` or `COMPLETED` |

`:module` is a setup task's module tag (`ledger-core` for accounting, `stock` for the optional inventory step; anything else, including the retired `platform`, is `404`), never a tenancy boundary — `orgId` from the verified access token is still the only scope predicate. Every write is an upsert; there is no 409 for "you already started." `draft` is untrusted JSON — bound as one JSONB parameter, never spread into a query, and re-parsed through the target app's own schema when that app's own completion route (e.g. `POST /settings/onboarding`) runs. Completion is not a route here — each app's own wizard-completer calls `markCompletedOnClient` on its own transaction, so the app's data and its onboarding row commit together.

Failure paths: `400` from the schema · `403` for anything below `OWNER`/`ADMIN` on a write · `404 Unknown app` for a slug not in the registry · `409 Cannot move onboarding from <FROM> to <TO>` for an illegal transition (e.g. skip after already `COMPLETED` — completion only ever moves back to `IN_PROGRESS`, never to `SKIPPED`).

---

### Accounting — `/api/v1` — Phases 3–4, 6, 8, 9b, 24–26, 34 and 35a ✅

Full feature spec and the remaining phases: [accounting.md](accounting.md).

#### Accounts — `/api/v1/accounts`

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

#### Journals — `/api/v1/journals`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable entries with nested lines — the journal register |
| GET | `/:id` | any member | One entry with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post a balanced entry (min 2 lines, debits == credits in integer cents) |
| POST | `/:id/reverse` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Post the reversing entry for a posted journal |

**No `PUT`, no `DELETE`, at any phase** — rule 6. A database trigger rejects the write with SQLSTATE `0A000` even if such a route were added by mistake.

`sourceType` and `sourceId` are **not accepted from the request body**; a client-posted entry is always `'manual'`. Another app posting into the GL passes them service-to-service, so no caller can forge an entry claiming to have come from capture. Phase 36c adds one more source: an entry posted by a `JOURNALS` CSV import has `sourceType: 'migration_import'` and `sourceId` = the import id (the journal detail page shows it as "Imported (CSV)" with a link to the import). Like every posted entry it is reversed, never edited, and it cannot become a recurring template (`'manual'` only).

**`GET /` query parameters** (Phase 3.6), all optional: `page`, `limit` (caps at 100, same as every other list endpoint) · `from` / `to` — inclusive `entry_date` bounds, `YYYY-MM-DD` · `accountId` — only entries with at least one line on this account · `sourceType` — exact match · `q` — case-insensitive substring match on `description`. `totalCount` and `totalPages` reflect the applied filters, not the whole table.

Every entry also carries `createdByName` / `createdByEmail` (the posting user, denormalised for display), `reversedByEntryId` (set on an original once it has been reversed — the inverse of `reversesEntryId`, `null` while uncorrected), and `totalDebitCents` / `totalCreditCents` (summed from `lines`).

Failure paths: `400` from the schema (fewer than two lines, a line with both sides set, a fractional amount) · `400 <name> must be a date in YYYY-MM-DD format` (`from`/`to`) · `400 accountId must be a UUID` · `422 Entry is unbalanced: debits N, credits M` · `422 Account <code> is a header account and cannot be posted to` · `422 Account not found` · `422 Account <code> is the receivable control account — post to it through an invoice or a payment, not a journal entry` / `422 Account <code> is the payable control account — post to it through a bill or a payment, not a journal entry` (Phase 25, see below) · `409 Entry has already been reversed` · `422 A reversing entry cannot itself be reversed`.

**Control accounts refuse manual journals (Phase 25).** `POST /` rejects any line on the receivable control account (`ledger_invoice_settings.receivableAccountId`, falling back to the postable default-chart `1120`) or the payable control account (`ledger_settings.payableAccountId`, falling back to `2100`). A journal line names no customer or vendor, so it could only ever break the tie between a party's subledger and the control account (`/reports/ar-aging`'s `reconciles`). Documents (invoice issue/void, bill approve/void, payments, FX revaluation) still post there through the service-to-service path, which this check does not apply to. `POST /:id/reverse` is **not** refused: reversing a pre-Phase-25 manual entry on a control account can only restore agreement.

#### Reports — `/api/v1/reports`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/trial-balance` | any member | Per-account debit/credit totals, type-aware `netBalanceCents`, and `isBalanced`. Optional `?asOf=YYYY-MM-DD` |
| GET | `/profit-and-loss` | any member | Phase 4 — Revenue − Expenses over `?from=&to=` (both optional, defaulting to the current fiscal year to date), gross profit split via the `5xxx` range |
| GET | `/balance-sheet` | any member | Phase 4 — Assets = Liabilities + Equity as at `?asOf=` (optional, defaults to today), with `equity.retainedEarningsCents`/`equity.currentEarningsCents` derived on every read |
| GET | `/dashboard` | any member | Position, year-to-date and month-to-date performance, a 6-point trend, recent entries, the integrity check, and (Phase 3.9) `receivables`/`payables` AR/AP summaries. Optional `?asOf=YYYY-MM-DD` |
| GET | `/ar-aging` | any member | Phase 3.9 — accounts-receivable aging: 5 buckets (`CURRENT`/`D1_30`/`D31_60`/`D61_90`/`D90_PLUS`), per-customer rows, and reconciliation against the receivable control account. Optional `?asOf=YYYY-MM-DD` |
| GET | `/ap-aging` | any member | Phase 3.9 — accounts-payable aging, same shape as `/ar-aging`, per-vendor rows, reconciled against the payable control account. Optional `?asOf=YYYY-MM-DD` |
| GET | `/bank-reconciliation` | any member | Phase 6 — reconciles one bank account's GL balance against its imported statement lines. **Required** `?accountId=<uuid>`; optional `?asOf=YYYY-MM-DD` (defaults to today) |
| GET | `/fx-exposure` | any member | Phase 8 — read-only preview of a period-end revaluation: every open foreign-currency invoice/bill restated at the `?asOf=` rate (defaults to today). Posts nothing; see FX revaluation below |

Aggregated from raw `ledger_lines` (and, for `/ar-aging`/`/ap-aging`, from `invoices`/`bills`/`payment_allocations`) on every request. There is no summary table and none will be added. Only postable, active accounts appear in the trial balance. `isBalanced` is integer equality, never an epsilon.

**`/profit-and-loss`** returns `{ from, to, revenue, costOfSales, grossProfitCents, operatingExpenses, netIncomeCents }`, each of `revenue`/`costOfSales`/`operatingExpenses` a `{ rows, totalCents }` section. Only accounts with activity in the window appear (an `INNER JOIN`, unlike the trial balance's `LEFT JOIN`, which lists every account including zero-activity ones). COGS is the `5xxx` code range — not a sixth account type. `422 from must not be after to`.

**`/balance-sheet`** returns `{ asOf, fiscalYearStartDate, assets, liabilities, equity, totalLiabilitiesAndEquityCents, balances }`. `equity` extends the `{ rows, totalCents }` shape with `retainedEarningsCents` (every prior fiscal year's net income) and `currentEarningsCents` (this fiscal year's, up to `asOf`) — both **derived on every read**, never stored, because accounting posts no year-end closing entry. `equity.totalCents` already includes both derived figures on top of the posted equity rows. `balances` is `assets.totalCents === totalLiabilitiesAndEquityCents`, integer equality.

`/dashboard` (Phase 3.5) is not the Phase 4 balance sheet — it exposes `currentEarningsCents` (Revenue − Expenses, all time) alongside `assetsCents`/`liabilitiesCents`/`equityCents` and an `equationHolds` flag, because Assets = Liabilities + Equity only holds once current-period earnings are folded in. `position.cashCents` is `null` when no cash account is configured in settings; when configured, it sums the account's whole subtree via a recursive walk. `trend` is always exactly 6 points, oldest first, gap-filled so a month with no postings still appears at zero. Phase 3.9 adds `receivables`/`payables`, each carrying `outstandingCents`, `overdueCents`, `draftCount`/`draftCents`, and a 5-bucket aging series identical in shape to `/ar-aging`/`/ap-aging`'s `buckets`; `payables` additionally carries `awaitingReviewCount`/`awaitingReviewCents` — bills entered but not yet approved, **not** an employee expense-claim inbox (AutoLedger has no such document).

`/ar-aging` and `/ap-aging` (Phase 3.9) bucket every open (`ISSUED`/`POSTED`) document's outstanding amount by days past due relative to `asOf`. `controlAccount` names the receivable/payable account each report is checked against (`null` if none is configured and no fallback code exists); `reconciles` is `totalOutstandingCents === controlAccount.balanceCents`, integer equality, `null` when there is no control account to compare against. A `false` value means a document was posted without a matching journal entry, or vice versa — a data-integrity signal, not a UI glitch to hide.

**Phase 8: every figure in both reports is base currency**, not native — `outstanding = base_total − base_allocated` (`base_allocated` summing `payment_allocations.base_amount_cents`, filtered the same way). For an organization with no foreign-currency documents this is numerically identical to the pre-Phase-8 native figures (base equals native at rate 1), so nothing changes observably; a foreign-currency invoice or bill now contributes its base-currency value to every bucket, every counterparty row, and the `reconciles` check against the base-currency GL control balance — the same "reporting is base currency" rule `/trial-balance`, `/profit-and-loss`, and `/balance-sheet` already followed. There is no separate native-currency total exposed by these two reports.

**`/bank-reconciliation`** (Phase 6) compares the named account's posted GL balance (`SUM(base_debit_cents − base_credit_cents)` up to `asOf`) against the sum of every imported, non-`IGNORED` bank line for the same account and date range. `reconciles = differenceCents === 0`, integer equality — but unlike `/ar-aging`/`/ap-aging`, a `false` here is a **completeness** claim about the imported statement history, not a **correctness** claim about the books: the GL and the statement describe two genuinely different sources (this system's own postings vs. a CSV a human chose to upload), so the far more common cause of disagreement is a month that was never imported, not a bug. See [study/postgresql/subledger-reconciliation-and-aging.md](../study/postgresql/subledger-reconciliation-and-aging.md). Also returns `matchedCount`/`matchedCents`, `unmatchedCount`/`unmatchedCents`, `ignoredCount`, and — when the most recent import for the account carried one — `statedClosingBalanceCents`/`statedClosingBalanceOn`/`statedClosingDifferenceCents`. Failure paths: `400 accountId is required` · `404 Account not found`.

Failure paths: `400 asOf must be a date in YYYY-MM-DD format` · `400 from/to must be a date in YYYY-MM-DD format` · `422 from must not be after to` (`/profit-and-loss` only).

#### Settings — `/api/v1/settings` — Phase 3.5

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | accounting's onboarding/settings state for the active organization |
| POST | `/onboarding` | `OWNER`, `ADMIN` | Complete (or re-complete) onboarding: workspace name, currency, fiscal year, cash account |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit settings after onboarding |

A missing `ledger_settings` row is **not** a 404 — `GET /` returns `200` with `settings.onboardedAt: null` and sensible defaults, which is the signal the client's onboarding gate redirects on. `POST /onboarding` is idempotent: submitting it twice overwrites rather than erroring, so a double-submit from the wizard is harmless. `PATCH /` before onboarding has ever completed returns `409`.

`organizationName` and `baseCurrency` are accepted by `POST /onboarding` but are written through `PATCH /organizations`, not this table — see the Organizations section above. `PATCH /settings` does **not** accept either field.

**The base-currency lock.** Once any `ledger_lines` row exists for the organization, submitting a *different* `baseCurrency` to `POST /onboarding` returns `422` (`Base currency cannot be changed once journal entries exist`) — `ledger_lines.currency_code` is stamped at write time on rows that are immutable by trigger, so a retroactive change would silently invalidate every posted line. Re-submitting the *same* currency is always accepted. `settings.baseCurrencyLocked` tells the client when to disable the field. **As of Phase 9a, `PATCH /organizations` enforces the identical lock** (see the Organizations section above) — the two doors can no longer disagree.

Failure paths: `400` from the schema (missing/invalid field, unsupported currency) · `422 Base currency cannot be changed once journal entries exist` · `422 Cash account does not exist in this organization` (also returned for a cash account belonging to another organization) · `409 Complete setup before changing settings` (PATCH only).

Phase 7 adds `unmatchedAlertThresholdCents` (integer cents, `PATCH` only, `≥ 0`) — the minimum absolute value of an unmatched bank line's `amountCents` that fires a `bank.large_unmatched` webhook event on import. Defaults to `0`, which means **disabled**: every organization starts with no alerting, and existing organizations are unaffected by the migration that added the column. See [ledger-core.md#webhooks-for-financial-events--phase-7](accounting.md#webhooks-for-financial-events--phase-7--delivered).

Phase 8 adds `realizedFxGainAccountId`/`realizedFxLossAccountId`/`unrealizedFxAccountId` (each `PATCH`-only, a UUID or `null`) — the posting accounts `paymentService`'s realized-FX plug and (once it lands) period-end revaluation use. `null` (the default) falls back to chart codes `4910`/`6810`/`6820`.

Phase 35a adds `inventoryAccountId`/`cogsAccountId`/`inventoryAdjustmentAccountId`/`stockOpeningAccountId` (each `PATCH`-only, a UUID or `null`, `GET`-readable). `null` falls back to chart codes `1140`/`5050`/`5400`/`3400`. Each, when set, is validated inside the same transaction as the write: `422 <label> does not exist in this organization` · `422 <label> must be an Asset/Expense/Expense/Equity account` · `422 <label> must be postable` (labels: "Inventory account", "Cost of sales account", "Inventory adjustment account", "Opening stock account"). Changing `inventoryAccountId` reclasses every `INVENTORY` product that has no account override of its own (`asset_account_id IS NULL`) — a journal dated today moves their on-hand stock value from the old account to the new one, in the same transaction as the settings write. `PATCH /items/:id` on a single product's own `assetAccountId` does the identical reclass for that one product only. See [Inventory as a control account, Phase 35a](#inventory-as-a-control-account--phase-35a) below.

This module only stores a fiscal-year *setting*; period rows themselves — `fiscal_periods`, close/lock, and the posting guard — are a separate module, `/api/v1/fiscal-periods` (Phase 4, below).

#### Fiscal periods — `/api/v1/fiscal-periods` — Phase 4

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

Failure paths: `400 status must be one of OPEN, CLOSED, LOCKED` · `404 Fiscal period not found` · `409 Complete setup before generating fiscal periods` · `409 A fiscal period already overlaps this fiscal year` · `409 Cannot close/reopen/lock a <status> period` (the FSM rejection, naming the actual blocking state) · `422 The fiscal period covering <date> is closed/locked; reopen it or post to an open period` (from any endpoint that posts a journal entry).

#### Invoice settings — `/api/v1/settings/invoicing` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Invoice numbering, defaults, and branding for the active organization |
| PATCH | `/` | `OWNER`, `ADMIN` | Edit invoice settings; creates the row on first write |

A missing `ledger_invoice_settings` row is **not** a 404 — `GET /` returns `200` with sensible defaults (`numberPrefix: 'INV-'`, `numberPadding: 6`, `nextNumber: 1`, `defaultDueDays: 30`, `defaultTaxRateBp: 0`, `taxLabel: 'Tax'`, `showTaxNumber: true`, `showBusinessNumber: false`, `showLegalName: true`, `accentColor: '#2563eb'`, `templateId: 'classic'`, `documentTitle: 'INVOICE'`, `fontFamily: 'sans'`, `density: 'comfortable'`, `showLogo: true`, `showOrgAddress: true`, `showPaymentTerms: true`, `showDueDate: true`, `bankDetails: null`, every account id and other text field `null`) and `configured: false`. `PATCH /` upserts the row and returns `configured: true`.

`receivableAccountId`, `defaultRevenueAccountId`, and `taxPayableAccountId` are optional overrides — when unset, issuing an invoice falls back to the default chart's `1120`/`4100`-per-line/`2140`. Each is validated against the org's own chart (composite FK): `422 Account does not exist in this organization` if it points at a foreign or missing account.

**Invoice template fields — Phase 30.** Nine more optional fields on the same `PATCH /`: `templateId` — one of `'classic'`/`'modern'`/`'compact'`, a **closed set of code-defined layouts**, not user-authored markup (`400` for any other value; zod rejects it before it reaches SQL, and the DB CHECK `ck_invoice_settings_template_id` rejects it a second time if the schema is ever bypassed) · `documentTitle` — non-blank, `<= 24` chars, the label printed above the invoice number (default `'INVOICE'`) · `fontFamily` — `'sans'`/`'serif'` · `density` — `'comfortable'`/`'compact'` · `showLogo`/`showOrgAddress`/`showPaymentTerms`/`showDueDate` — booleans, each gating one disclosure block on the rendered document · `bankDetails` — free text, `<= 500` chars, nullable, rendered as its own footer block when set. These render through one shared component, `InvoiceDocument.tsx`, used identically by the real invoice page and the template editor's live preview — see [ledger-core.md § Phase 30](accounting.md#phase-30--invoice-templates-organization-profile--settings-tabs--shipped).

**Default payment terms — Phase 43a.** `defaultSalesPaymentTermId` and `defaultPurchasePaymentTermId` (uuid or `null`) on `GET /` and `PATCH /`. Each must be an active payment term of this organization (`422 Payment term not found or inactive`). Onboarding sets both to the organization's `NET_30`; existing organizations had the sales default backfilled from `default_due_days` and the purchase default left `null`.

**Quote and order fields — Phase 42.** Eleven more optional fields on the same `PATCH /` (and returned by `GET /`): `quotePrefix` (default `QU-`, ≤ 12), `quoteNextNumber` (default 1, 1–9 999 999), `purchaseQuotePrefix` (`PQ-`), `purchaseQuoteNextNumber`, `defaultQuoteValidityDays` (default 30, 1–365), `defaultQuoteTerms` (≤ 5000, nullable), `quoteAcceptanceRequiresCode` (boolean, default `false` — see verified-email acceptance under Quotes), `customerDepositAccountId` and `supplierPrepaymentAccountId` (nullable account ids; unset falls back to the default chart's `2130` / `1150`; a foreign or missing account is `422`). The order counters (`order_prefix` `SO-`, `purchase_order_prefix` `PO-` and their next numbers) exist in the table and are consumed by order confirmation but are **not** exposed here. Quote numbers are freely settable like invoice numbers; sending a quote whose number is already used is `409 That quote number is already in use — raise the next quote number in Settings → Invoices`.

Failure paths: `400` from the schema (invalid `accentColor` — must be `#rrggbb`, invalid basis points, invalid padding, invalid `templateId`/`fontFamily`/`density`, blank `documentTitle`) · `400 No fields to update` · `422 Account does not exist in this organization`.

#### Customers — `/api/v1/customers` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's customers, ordered by name. `?q=` filters by name (case-insensitive substring); `?includeInactive=true` includes retired customers (excluded by default) |
| GET | `/:id` | any member | One customer |
| GET | `/:id/ledger` | any member | Phase 25 — the customer's account: every receivable-control-account posting attributed to this customer, with running balance. `?from=&to=&page=&limit=` |
| GET | `/:id/open-items` | any member | Phase 25 — the customer's open (issued, not fully paid) invoices with days overdue and aging bucket. Optional `?asOf=YYYY-MM-DD` |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a customer |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit a customer, including retiring it (`isActive: false`) |

Email is lowercased on write. **There is no DELETE** — a customer is retired with `isActive: false`, matching `accounts`, since an invoice may reference one.

Phase 43a: `POST`/`PATCH` accept `defaultPaymentTermId` (uuid or `null` = organization default); it must be an active term of the same organization (`422 Payment term not found or inactive`, also another org's term). Returned as `defaultPaymentTermId`.

Failure paths: `400` from the schema (blank name, invalid email) · `400 No fields to update` (PATCH) · `404 Customer not found` · `422 Payment term not found or inactive`.

**Party accounts (Phase 25) — `GET /:id/ledger` and `GET /:id/open-items`**, identical under `/vendors`. There is **no GL account per customer or vendor**: the chart keeps one receivable and one payable control account, and each party's account is a subsidiary ledger underneath it, derived on read. A control-account `ledger_lines` row belongs to a party when its journal entry is the `journalEntryId` or `voidJournalEntryId` of one of that party's invoices/bills/payments. No migration; lines no document owns (a pre-Phase-25 manual journal, the FX revaluation's aggregate line) belong to no party.

`/ledger` → `{ success, party: { kind: 'CUSTOMER'|'VENDOR', id, name }, controlAccount: { id, code, name } | null, from, to, openingBalanceCents, periodDebitCents, periodCreditCents, closingBalanceCents, totalCount, rows, count, currentPage, totalPages }`. One row per (journal entry, document): `{ journalEntryId, entryDate, kind, documentId, documentNumber, debitCents, creditCents, runningBalanceCents, allocations }`. `kind` is `INVOICE`/`INVOICE_VOID`/`PAYMENT`/`PAYMENT_VOID` (+ `CREDIT_NOTE`/`CREDIT_NOTE_VOID`, Phase 26) for a customer and `BILL`/`BILL_VOID`/`PAYMENT`/`PAYMENT_VOID` (+ `DEBIT_NOTE`/`DEBIT_NOTE_VOID`) for a vendor. `documentNumber` is the invoice number, the bill's `vendorReference`, or the payment's `reference`. A payment settling several documents is **one** row, with the split in `allocations: [{ documentId, documentNumber, baseAmountCents }]` (empty for non-payment rows). All amounts are base-currency cents. The balance is positive when the customer owes us (AR, debit-normal) or we owe the vendor (AP, credit-normal). `openingBalanceCents` is everything before `from` (`0` when `from` is omitted), and the running balance is a window over the whole filtered set, so it continues across pages. `controlAccount: null` (and empty rows) when the org has no resolvable control account.

`/open-items` → `{ success, party, asOf, outstandingCents, overdueCents, items: [{ documentKind, documentId, documentNumber, documentDate, dueDate, currencyCode, totalCents, baseTotalCents, baseOutstandingCents, daysOverdue, bucket }] }`: every document with a non-zero outstanding balance, due date first. **Phase 26:** `documentKind` is `INVOICE`/`BILL` or `CREDIT_NOTE`/`DEBIT_NOTE` — an issued note's **unapplied** remainder is an open item with a **negative** `baseOutstandingCents`, always in the `CURRENT` bucket (the AR/AP aging report includes it the same way, so a customer can show a credit balance and the report still reconciles). The same arithmetic and buckets as `/reports/ar-aging`. **For every party, `/ledger`'s `closingBalanceCents` (to `asOf`) equals `/open-items`' `outstandingCents`, and the sum over parties equals the aging report's total and control balance.** `partyLedger.test.ts` asserts all three.

Failure paths: `404 Customer not found` / `404 Vendor not found` (also another org's id) · `400 <name> must be a date in YYYY-MM-DD format` (`from`/`to`/`asOf`).

#### Invoices — `/api/v1/invoices` — Phase 3.8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable invoices with nested lines — the invoice register. 2026-09-30: `?sort=issueDate\|dueDate\|number\|customer\|total\|status&dir=asc\|desc` (default newest issue date first); an unknown key or direction is `400` |
| GET | `/:id` | any member | One invoice with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a draft invoice (never posted directly) |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Replace a **draft** invoice's fields and lines wholesale |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a **draft** invoice |
| POST | `/:id/issue` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Allocate a number and post a balanced journal entry |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the invoice; posts a reversing entry if it was issued |

An invoice is a sales (accounts-receivable) document. Through Phase 3.8 it was always in the organization's base currency; **Phase 8 lets it carry any currency with a resolvable exchange rate.** `PATCH`/`DELETE` are legal despite rule 6 because they operate only on `DRAFT` rows, which have posted nothing — refused with `409` by the service and with SQLSTATE `0A000` by a database trigger the instant an invoice leaves `DRAFT`. The only correction path once issued is `POST /:id/void`, which posts a reversing journal entry through the same mechanism `POST /journals/:id/reverse` uses.

**`POST /`** — `customerId`, `issueDate`, `dueDate` (`YYYY-MM-DD`, `>= issueDate`, **optional since Phase 24** — required only when `paymentTermsCode` is omitted), `paymentTermsCode` (Phase 24, optional, a `payment_terms.code` — when present and `dueDate` is omitted, the server derives `dueDate = issueDate + term.netDays`; an explicit `dueDate` always wins over the term), `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `notes`, `paymentTerms` (a free-text label; when `paymentTermsCode` resolves a term and `paymentTerms` is omitted, the term's own name is stored here), and `lines` (min 1): each line is `description`, `quantityMilli` (thousandths of a unit — `2500` means `2.5`), `unitPriceCents`, `revenueAccountId` (must be a postable `Revenue` account), `taxRateBp` (basis points, default `0`), `itemId` (Phase 24, optional — a `items.id`; recorded on the line but never read by the server to fill any other field, since the client already copies the item's defaults into the line before sending — **except** that from Phase 32 an `itemId` pointing at an `INVENTORY` product makes the line move stock at issue, see below), `stockLocationId` (Phase 32, optional — the inventory location an `INVENTORY` line issues stock from; omitted means `stock_settings.default_location_id`; a location on a line that is not an `INVENTORY` item is `422`). The server computes `netCents`/`taxCents` per line and `subtotalCents`/`taxCents`/`totalCents` on the header — the client may not supply totals, a number, a status, or a rate.

**Phase 43b:** `POST`/`PATCH` also accept `attachmentDocumentIds` and `salesOrderId` and return `salesOrderId`/`salesOrderNumber` — semantics and errors are documented under Bills below.

**Phase 8 fields on every invoice:** `fxRate` (`NUMERIC(18,8)` as a string — `"1.00000000"` for a base-currency invoice), `baseSubtotalCents`/`baseTaxCents`/`baseTotalCents` (the same totals converted to the organization's base currency). Re-resolved from `fx_rates` on every draft save against `issueDate` — a draft's base total is always honest — and **frozen** again at `issue`, re-resolved for the actual posting date (`entryDate ?? issueDate`), since that is the date that determines the rate a real-world settlement will be compared against. Once issued, `fxRate` never changes again.

**`POST /:id/issue`** — optional `entryDate` (defaults to the invoice's `issueDate`). Allocates the next number from invoice settings (Phase 36d: unless the draft already carries a number reserved by a CSV import, which it keeps — see [Migration imports](#migration-imports--apiv1migration-imports--phase-9b-phase-24-phase-36a-phase-36b-phase-36c-phase-36d)), posts one journal entry (`sourceType: 'invoice'`, `sourceId: <invoice id>`) debiting the receivable account for the total and crediting each distinct revenue account for its net plus the tax account for the tax total (only if > 0), then flips the invoice to `ISSUED`. Every posted line carries the invoice's own `currencyCode` and frozen `fxRate` — a foreign-currency invoice posts native foreign-currency amounts, converted to base currency on the line itself (`ledger_lines.base_debit_cents`/`base_credit_cents`).

**Phase 43c — `GET /invoices/:id/available-credits`** (`invoices.issue`) → `{ success, credits: [{ kind: 'NOTE'|'DEPOSIT', id, number, date, currencyCode, availableCents }] }`: the customer's `ISSUED` credit notes with unapplied balance and received-and-unapplied deposits raised for an order this draft draws on (base-currency drafts only; `[]` for a non-`DRAFT` or non-standard invoice). `404 Invoice not found`.

**Phase 43c — `applyCredits` on `POST /:id/issue`** — optional array (default `[]`, max 20) of `{ kind: 'NOTE'|'DEPOSIT', id, amountCents }` applied in the **same transaction** as the issue; any refusal rolls the issue back (the draft stays a draft, no number consumed). Errors: `400` for a malformed entry or `Each credit can be listed once`; `403 Applying a credit note needs the "Issue and apply credit notes" permission.` when any entry is a `NOTE` and the caller lacks `credit_notes.issue` (deposits need nothing beyond `invoices.issue`); the apply cores' own `404`/`409`/`422` (credit not found, different customer, different currency, exceeds the amount still due, exceeds the credit available, deposit for a different order); `409 Another change to these documents was in progress — try again` on a deadlock (`40P01`).

**`POST /:id/void`** — optional `entryDate`. On an `ISSUED` invoice, posts the reversing entry and records `voidJournalEntryId`. On a `DRAFT` invoice, no GL posting occurs at all — nothing was ever posted. Either way the invoice becomes `VOID`, which is terminal. Refused with `409 This invoice has credit notes. Void the credit notes first.` while any `ISSUED` credit note is raised against it or applied to it (Phase 26).

**Phase 26 — `creditedCents`** on every invoice: the sum of `ISSUED` credit-note allocations against it, derived on read like `allocatedCents` (`0` unless `ISSUED`). `amountDueCents = totalCents − allocatedCents − creditedCents`, and `settlementStatus` treats credits exactly like payments (a fully credited invoice reads `PAID`). The `settlement` list filter uses the same combined figure.

`GET /` query parameters, all optional: `page`, `limit` · `status` (`DRAFT`/`ISSUED`/`VOID`) · `customerId` · `from`/`to` — inclusive `issueDate` bounds · `q` — matches invoice number or the customer name snapshot.

Failure paths: `400` from the schema · `400 status must be one of DRAFT, ISSUED, VOID` · `422 Provide a due date or a payment term` (Phase 43a — neither `dueDate` nor `paymentTermsCode` sent **and** no default term resolves: the customer's/vendor's `defaultPaymentTermId`, else the organization's sales/purchase default; an inactive default is skipped) · `422 An invoice needs at least one line` · `422 Due date cannot be before the issue date` · `422 Payment term "<code>" does not exist in this organization` · `422 Payment term "<code>" is inactive` · `422 Customer not found` (also another org's customer) · `422 Revenue account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not a Revenue account` / `422 A referenced account or item does not exist in this organization` (an `itemId` from another organization) · `409 Only a draft invoice can be edited` / `409 Only a draft invoice can be deleted` · `422 No receivable account is configured. Set one in invoice settings.` / `422 No tax account is configured. Set one in invoice settings.` (issue only) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8, draft save and issue) · `409 An invoice that is <status> cannot be issued` · `409 This invoice has already been voided` · **Phase 32 stock paths:** the same `422` line messages as bills · `409 Insufficient stock for item <code> at location <loc>` (issue — the invoice stays `DRAFT` and no number is consumed).

**Not built (as of Phase 3.8):** payment recording, a `PAID` status, AR aging, an AR subledger report, PDF generation, multi-currency invoices. Payment recording, AR aging, and the AR/AP subledger reconciliation **landed in Phase 3.9**; multi-currency invoicing **landed in Phase 8** — see the Payments, Reports, and Exchange rates sections. PDF generation remains unbuilt.

#### Payment terms — `/api/v1/payment-terms` — Phase 24

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's payment terms, ordered by `netDays` then `code`. `?includeInactive=true` includes retired terms (excluded by default) |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a custom term |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Rename, re-date, or retire a term |

Every organization starts with seven standard terms — `DUE_ON_RECEIPT`, `NET_7`, `NET_15`, `NET_30`, `NET_45`, `NET_60`, `NET_90` — seeded at registration and backfilled for every organization that existed before Phase 24. **A standard term's `code`, `name` and `netDays` are frozen** — `PATCH` refuses to change them (`409`); only `isActive` can move on a standard term, and a custom replacement is added instead. `code` is uppercased on write and is never updatable once created. There is no GET `/:id` and **no DELETE** — a term is retired with `isActive: false`, matching `accounts`/`customers`/`vendors`.

**`POST /`** — `code` (2–30 chars, `A–Z`/`0–9`/`_`, uppercased on write), `name` (1–60 chars), `netDays` (`0`–`365`), and (Phase 43a) `rule` — `DAYS_AFTER_DATE` (default), `DAYS_AFTER_MONTH_END`, `DAY_OF_NEXT_MONTH` or `DAY_OF_CURRENT_MONTH`. For the two `DAY_OF_*` rules `netDays` is a day of month and must be `1`–`31` (`400 Day of month must be between 1 and 31`; the DB check `ck_payment_terms_rule_day` maps to `422` with the same text). Due date: `DAYS_AFTER_DATE` n → date + n; `DAYS_AFTER_MONTH_END` n → last day of the document's month + n; `DAY_OF_NEXT_MONTH` n → day n of the following month, clamped to its last day; `DAY_OF_CURRENT_MONTH` n → day n of the document's month (clamped), or of the next month if that is before the document date. `PATCH` accepts `rule` too; a standard term's `rule` is frozen like its `netDays` (`409`). Every term in a response carries `rule`.

Failure paths: `400` from the schema · `400 No fields to update` (PATCH) · `404 Payment term not found` · `409 Payment term code already exists` · `409 A standard payment term cannot be renamed or re-dated — deactivate it and add your own`.

#### Vendors — `/api/v1/vendors` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's vendors, ordered by name. `?q=` filters by name (case-insensitive substring); `?includeInactive=true` includes retired vendors (excluded by default) |
| GET | `/:id` | any member | One vendor |
| GET | `/:id/ledger` | any member | Phase 25 — the vendor's account under the payable control account, same shape as customers' |
| GET | `/:id/open-items` | any member | Phase 25 — the vendor's approved, unpaid bills. Optional `?asOf=YYYY-MM-DD` |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a vendor |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit a vendor, including retiring it (`isActive: false`) |

Email is lowercased on write. **There is no DELETE** — a vendor is retired with `isActive: false`, matching `customers`, since a bill may reference one.

Phase 43a: `POST`/`PATCH` accept `defaultPaymentTermId` exactly as customers do (`422 Payment term not found or inactive`); the free-text `paymentTerms` field is kept and is shown as "Payment notes" — it is no longer used for derivation.

Failure paths: `400` from the schema (blank name, invalid email) · `400 No fields to update` (PATCH) · `404 Vendor not found` · `422 Payment term not found or inactive`. `/:id/ledger` and `/:id/open-items`: see the customers section's Phase 25 note.

#### Bills — `/api/v1/bills` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable bills with nested lines — the bill register. 2026-09-30: `?sort=billDate\|dueDate\|reference\|vendor\|total\|status&dir=asc\|desc` (default newest bill date first); an unknown key or direction is `400` |
| GET | `/:id` | any member | One bill with its lines |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a draft bill (never posted directly) |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Replace a **draft or in-review** bill's fields and lines wholesale |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a **draft or in-review** bill |
| POST | `/:id/submit` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Send a draft bill for approval (`DRAFT -> AWAITING_APPROVAL`) |
| POST | `/:id/approve` | **`OWNER`, `ADMIN` only** | Post a balanced journal entry (`AWAITING_APPROVAL -> POSTED`) |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the bill; posts a reversing entry if it was posted |

A bill is a purchase (accounts-payable) document. Through Phase 3.9 it was always in the organization's base currency; **Phase 8 lets it carry any currency with a resolvable exchange rate**, mirroring invoices exactly. Its lifecycle has **four** states, not three like an invoice — `DRAFT -> AWAITING_APPROVAL -> POSTED -> VOID`, plus a recall edge `AWAITING_APPROVAL -> DRAFT` — because entering a bill and approving it for posting are deliberately separate acts of trust: an `ACCOUNTANT` can create and submit a bill but cannot approve it, only `OWNER`/`ADMIN` can. `PATCH`/`DELETE` are legal on `DRAFT` and `AWAITING_APPROVAL` (both pre-posting), refused with `409` by the service and SQLSTATE `0A000` by a database trigger the instant a bill reaches `POSTED`. The only correction path once posted is `POST /:id/void`.

**`POST /`** — `vendorId`, `vendorReference` (the **vendor's own** invoice number, required, unique per `(vendor, reference)` — the duplicate-payment control), `billDate`, `dueDate` (`>= billDate`, **optional since Phase 24** — required only when `paymentTermsCode` is omitted), `paymentTermsCode` (Phase 24, optional, a `payment_terms.code` — when present and `dueDate` is omitted, the server derives `dueDate = billDate + term.netDays`; an explicit `dueDate` always wins over the term), `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `notes`, `paymentTerms` (a free-text label; when `paymentTermsCode` resolves a term and `paymentTerms` is omitted, the term's own name is stored here), and `lines` (min 1): each line is `description`, `quantityMilli`, `unitPriceCents`, `expenseAccountId` (a postable `Expense` **or** `Asset` account — a bill may legitimately buy a fixed asset or a prepaid), `taxRateBp`, `itemId` (Phase 24, optional — a `items.id`; recorded on the line but not used to fill any other field — **except** that from Phase 32 an `INVENTORY` product makes the line receive stock at approval and stamps the line's account with the item's inventory account whatever the client sent), `stockLocationId` (Phase 32, optional — where an `INVENTORY` line receives stock; omitted means the default location). The server computes all totals — the client may not supply them, a status, or a rate.

**Phase 43b — `attachmentDocumentIds` and `purchaseOrderId` (bills) / `salesOrderId` (invoices).** `attachmentDocumentIds` (optional, `uuid[]`, max 20 — vault documents) are linked to the document **inside its create/update transaction**; an id that is not in this organization is `404 Document not found` and the whole save rolls back. `purchaseOrderId` / `salesOrderId` (optional, nullable uuid) references an order: on create, omitted means none; **on update, omitted leaves the link unchanged and `null` clears it**. Errors (`422`): `Purchase order not found` / `Sales order not found` (also another org's or wrong direction), `That purchase order belongs to a different vendor` / `That sales order belongs to a different customer`, `Only a confirmed or closed purchase order can be referenced` / `Only a confirmed or closed sales order can be referenced`. Responses carry `purchaseOrderId`/`purchaseOrderNumber` (bill) and `salesOrderId`/`salesOrderNumber` (invoice). Documents raised from an order set the link automatically. The link is editable only while the document is editable (draft states).

**Phase 8 fields on every bill:** `fxRate`, `baseSubtotalCents`/`baseTaxCents`/`baseTotalCents` — resolved on every draft save against `billDate`, frozen at `approve` against the posting date, exactly like an invoice's `issueDate`/`issue`.

**`POST /:id/approve`** — optional `entryDate`. Posts one journal entry (`sourceType: 'bill'`, `sourceId: <bill id>`) debiting each distinct expense account for its net and the tax-input account for the tax total (only if > 0), crediting the payable account for the total, then flips the bill to `POSTED`. Every posted line carries the bill's own `currencyCode` and frozen `fxRate`.

**Phase 43c — `GET /bills/:id/available-credits`** (`bills.approve`) → `{ success, credits: [...] }` (same shape as invoices): the vendor's `ISSUED` debit notes with unapplied balance and received-and-unapplied prepayments for an order this draft draws on; `[]` unless the bill is a standard `DRAFT`/`AWAITING_APPROVAL` bill in base currency. `404 Bill not found`.

**Phase 43c — `applyCredits` on `POST /:id/approve`** — as for invoices: optional, max 20, applied atomically with the approval (a refusal rolls the approval back). `403 Applying a debit note needs the "Issue and apply debit notes" permission.` when any entry is a `NOTE` and the caller lacks `debit_notes.issue`. Same `400`/`404`/`409`/`422` set as the invoice side; an application larger than a note's balance reports `422 Amount exceeds the credit still available on this debit note` (the note-balance check fires before the amount-due check `Amount exceeds the amount still due on this bill`).

**`POST /:id/void`** — optional `entryDate`. On a `POSTED` bill, posts the reversing entry. On `DRAFT`/`AWAITING_APPROVAL`, no GL posting occurs — nothing was ever posted. Refused with `409` if the bill has any `POSTED` payment allocated to it — void the payment first.

`GET /` query parameters, all optional: `page`, `limit` · `status` (`DRAFT`/`AWAITING_APPROVAL`/`POSTED`/`VOID`) · `vendorId` · `from`/`to` — inclusive `billDate` bounds · `q` — matches vendor reference or the vendor name snapshot · `settlement` (`OUTSTANDING`/`OVERDUE`/`PAID`) — implies `status=POSTED`.

Every bill also carries `allocatedCents`, `amountDueCents`, and `settlementStatus` (`NOT_APPLICABLE`/`UNPAID`/`PARTIALLY_PAID`/`PAID`/`OVERDUE`) — all **derived** on every read from `POSTED` payment allocations, never stored; `0`/`NOT_APPLICABLE` unless the bill is `POSTED`. **Phase 26** adds `debitedCents` (applied `ISSUED` debit notes); `amountDueCents = totalCents − allocatedCents − debitedCents`, and a bill cannot be voided while an issued debit note is raised against or applied to it (`409 This bill has debit notes. Void the debit notes first.`).

Failure paths: `400` from the schema · `400 status must be one of DRAFT, AWAITING_APPROVAL, POSTED, VOID` · `422 Provide a due date or a payment term` (Phase 43a — neither `dueDate` nor `paymentTermsCode` sent **and** no default term resolves: the customer's/vendor's `defaultPaymentTermId`, else the organization's sales/purchase default; an inactive default is skipped) · `422 A bill needs at least one line` · `422 Due date cannot be before the bill date` · `422 Payment term "<code>" does not exist in this organization` · `422 Payment term "<code>" is inactive` · `422 Vendor not found` (also another org's vendor) · `422 Expense account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> must be an Expense or Asset account` / `422 A referenced account or item does not exist in this organization` (an `itemId` from another organization) · `409 This vendor reference has already been entered for this vendor` · `409 Only a draft or in-review bill can be edited` / `409 Only a draft or in-review bill can be deleted` · `403` approving as anything below `OWNER`/`ADMIN` · `422 No payable account is configured. Set one in settings.` / `422 No tax account is configured. Set one in settings.` (approve only) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8, draft save and approve) · `409 A bill that is <status> cannot be approved` · `409 This bill has already been voided` · **Phase 32 stock paths:** `422 Line N: item <code> is lot-tracked — lot/serial selection on invoice and bill lines is not supported yet; record it in inventory` (also `serial-tracked`; at draft save and again at approve) · `422 Line N: item <code> is a fixed asset — capitalising fixed assets on bills is not supported yet` · `422 Line N: a stock location applies only to inventory items` · `422 Choose a stock location for line N` (no line location and no default) · `422 Line N posts to an inventory account that only inventory items may use on a bill` · `422 No inventory account is configured for item <code>. Set one in settings.` / `422 No cost-of-sales account is configured …` · `409 Stock received on this bill has since been issued: only X of item <code> remain at location <loc>` (void only) · `409 This document has payments applied. Void the payments first.` (void only).

**Not built:** an expense-claim / employee-reimbursement document (there is none, by design — see [roadmap.md § Phase 3.9](roadmap.md#phase-39-as-delivered)), partial void. Credit notes and vendor credits (debit notes) landed in Phase 26 — see the next section.

#### Credit notes — `/api/v1/credit-notes` · Debit notes — `/api/v1/debit-notes` — Phase 26

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated notes with nested `lines` and `allocations` — `{ success, count, totalCount, currentPage, totalPages, creditNotes \| debitNotes }` |
| GET | `/:id` | any member | One note — `{ success, creditNote \| debitNote }` |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a **draft** note against an issued invoice / approved bill — `201` |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Replace a **draft** note's fields and lines |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a **draft** note — `204` |
| POST | `/:id/issue` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Number it, post its journal entry, auto-apply it to its original |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void it; posts a reversal if it was issued |
| POST | `/:id/allocations` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Apply unapplied credit to another open document of the same party — `201` |

A **credit note** is issued by us to a customer and reduces what they owe on an `ISSUED` invoice (a return, a price allowance, a discount, damaged goods). A **debit note** is issued by us to a vendor and reduces what we owe on a `POSTED` bill (a purchase return, an overcharge, a short delivery) — QuickBooks' "vendor credit". The seller-issued GST-sense debit note that *increases* an invoice is not built; issue a new invoice instead.

**`POST /`** — credit note: `invoiceId`, `issueDate` (`>= ` the invoice's `issueDate`), `reasonCode` (`RETURN`/`PRICE_ADJUSTMENT`/`DISCOUNT`/`DAMAGED`/`OTHER`), `reason` (≤ 500, optional), `notes`, `lines` (min 1; each `description`, `quantityMilli`, `unitPriceCents`, `revenueAccountId` — a postable `Revenue` account, usually `4800 Sales Returns & Allowances` — and `taxRateBp`). Debit note: `billId`, `issueDate` (`>=` the bill's `billDate`), `reasonCode`, `reason`, `vendorCreditReference` (the vendor's own credit-note number, ≤ 100, optional), `notes`, `lines` with `expenseAccountId` (postable `Expense` or `Asset`). The party, `currencyCode` and `fxRate` are **copied from the original**, never accepted from the client; totals are computed server-side.

**Caps.** All `ISSUED` notes against one original may never total more than it (checked in the service under a row lock and by a deferred DB trigger). A note in a non-base currency may not exceed the original's amount still due, so it is always fully applied to its own original.

**`POST /:id/issue`** — optional `entryDate`. Allocates `CN-000001` / `DN-000001` from a per-org series, posts one journal entry at the original's frozen rate — credit note (`sourceType: 'credit_note'`): DR each distinct revenue account for its net, DR the sales-tax account for the tax, CR receivable for the total; debit note (`sourceType: 'debit_note'`): DR payable for the total, CR each expense account for its net, CR input tax for the tax — then, in the same transaction, applies the note to its original up to the amount still due. If the original is already fully paid nothing is applied and the whole note is **unapplied credit**.

**`POST /:id/allocations`** — `invoiceId` / `billId`, `amountCents` (> 0), `allocationDate` (not before the note or the target). The target must be the same party's `ISSUED` invoice / `POSTED` bill in the same currency; a foreign-currency note may only be applied to its own original. **Posts no journal entry** — both the note and the target already sit in the control account; applying only matches them in the subledger.

**`POST /:id/void`** — optional `entryDate`. An `ISSUED` note gets a reversing entry; its allocations stay (insert-only) and stop counting, which re-opens every document it was applied to. A `DRAFT` note is voided with no GL posting.

Every note carries `lines`, `allocations: [{ id, invoiceId|billId, invoiceNumber|billVendorReference, amountCents, baseAmountCents, allocationDate, createdAt }]`, `appliedCents` and `unappliedCents` (both `0` unless `ISSUED`). `GET /` filters: `page`, `limit`, `status` (`DRAFT`/`ISSUED`/`VOID`), `customerId`+`invoiceId` / `vendorId`+`billId`, `from`/`to` (inclusive `issueDate`).

Failure paths (credit-note wording; the debit-note messages say *debit note*, *bill*, *vendor*, "approved bill" and "debited"): `400` from the schema · `400 status must be one of DRAFT, ISSUED, VOID` · `404 Credit note not found` (also another org's) · `422 Invoice not found` (also another org's) · `422 Only an issued invoice can be credited` · `422 A credit note cannot be dated before its invoice` · `422 A credit note total must be greater than zero` · `422 Credit notes against this invoice would exceed the invoice total` · `422 A foreign-currency credit note cannot exceed the amount still due on its invoice` · `422 A draft credit note cannot be moved to a different invoice` · `409 Only a draft credit note can be edited` / `…deleted` · `409 A credit note that is <status> cannot be issued` · `422 A credit note needs at least one line before it can be issued` · `409 This credit note has already been voided` · `409 Only an issued credit note can be applied` · `422 A foreign-currency credit note can only be applied to its original invoice` · `422 That invoice belongs to a different customer` · `422 Only an issued invoice can have credit applied` · `422 A credit note can only be applied to an invoice in the same currency` · `422 A credit cannot be applied before the credit note or the invoice is dated` · `422 Amount exceeds the credit still available on this credit note` · `422 Amount exceeds the amount still due on this invoice` · `422 … is locked` / `… is closed` (the fiscal-period guard, issue/void) · `403` for a `VIEWER` write.

**Not built:** cash refunds of unapplied credit, bad-debt write-offs, outbox events/webhooks for notes, PDF/email of notes, a settings UI for the `CN-`/`DN-` prefixes.

#### Quotes — `/api/v1/quotes` (sales) · `/api/v1/purchase-quotes` (purchase) — Phase 41

The same resource in two directions, built by one router factory. The direction comes from the path, never the body: a sales quote id is a `404` on `/purchase-quotes` and vice versa.

| Method | Path | Permission (sales · purchase) | Description |
|---|---|---|---|
| GET | `/` | `quotes.view` · `purchase_quotes.view` | Paginated summaries — `{ success, count, totalCount, currentPage, totalPages, quotes }` |
| GET | `/:id` | `…view` | One quote with `lines`, `revisions`, `links`, `response`, `convertedDocument` — `{ success, quote }` |
| POST | `/` | `…edit` | Create a **DRAFT** — `201` |
| PATCH | `/:id` | `…edit` | Replace a **draft**'s fields and lines |
| DELETE | `/:id` | `…edit` | Delete a **draft** — `204` |
| POST | `/:id/revise` | `…edit` | New DRAFT revision of a SENT/DECLINED/EXPIRED quote (same number, `revision + 1`) — `201` |
| POST | `/:id/send` | `…send` | Finalize a DRAFT (number, snapshot, content hash, freeze) and/or email the review link |
| POST | `/:id/accept` | `…send` | Record an acceptance received another way (`channel: INTERNAL`); finalizes a DRAFT first |
| POST | `/:id/decline` | `…send` | Record a decline received another way |
| POST | `/:id/void` | `…send` | Withdraw a SENT or ACCEPTED quote; revokes its live link |
| POST | `/:id/links/:linkId/revoke` | `…send` | Revoke a live review link |
| POST | `/:id/convert` | `quotes.convert` (needs `invoices.edit`) · `purchase_quotes.convert` (needs `bills.edit`) | ACCEPTED → a **DRAFT** invoice / bill, or (`target: 'ORDER'`, Phase 42) a CONFIRMED sales / purchase order — `201 { document: { kind: 'INVOICE' \| 'BILL' \| 'ORDER', id } }` |
| POST | `/:id/email-preview` | `…send` | Phase 42 — body `{ templateId: uuid \| null }`; renders the quote email's `subject` and `body` exactly as send would, without sending — `200 { success, subject, body }` |
| GET | `/:id/pdf` | `…view` | Phase 42 — the quote as an A4 PDF (`application/pdf`, `Content-Disposition: attachment; filename="QU-000001.pdf"` — `-rev2` suffix from revision 2; `quote-draft.pdf` for a draft; `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`). `404` for another org's quote |

**Nothing here posts to the ledger.** A quote is an offer; under IFRS 15 / ASC 606 a contract exists only on acceptance, and revenue/expense is recognised by the invoice/bill it becomes, when that is issued/approved. Conversion creates a draft through `invoiceService.createInvoiceOnClient` / `billService.createBillOnClient` on the same transaction.

**`POST /`** — `partyId` (customer for sales, vendor for purchase; active, same org), `quoteDate`, `validUntil` (optional; default `quoteDate` + `default_quote_validity_days`, 30), `currencyCode` (optional; base), `partyReference` (≤ 100 — the customer's RFQ/PO number or the vendor's own quote number), `title` (≤ 200), `notes` (≤ 1000), `terms` (≤ 5000; omitted = `default_quote_terms`), `paymentTerms`, `paymentTermsCode` (must exist and be active), `lines` (1–200; each `description`, `quantityMilli`, `unitPriceCents`, `accountId` — a postable **Revenue** account on a sales quote, **Expense/Asset** on a purchase quote — `taxRateBp`, `itemId`). Totals use the shared per-line rounding (`utils/documentTotals.ts`), so a quote's total equals the invoice it becomes. A foreign-currency quote stores `indicativeFxRate` / `indicativeBaseTotalCents` when a rate exists on the quote date — **indicative only**, never frozen.

**`POST /:id/send`** — `{ delivery: 'EMAIL' | 'MANUAL', toEmail, message }`. On a DRAFT: refuses (`422`) a quote already past `validUntil`; allocates `QU-000001` / `PQ-000001` (a revision inherits its predecessor's number, so drafts never burn a number); re-snapshots the party; stores `contentSha256` (SHA-256 of the canonical content); supersedes a SENT predecessor and revokes its links; emits `quote.sent`. `EMAIL` also revokes any live link, stores a new token **as its hash only** in `quote_links` (valid through `validUntil` + 30 days, read-only after expiry) and enqueues `quote_sent` with the `/quote/:token` link. On a SENT quote only `EMAIL` is allowed (re-send).

**`POST /:id/convert`** — `{ documentDate?, dueDate?, vendorReference? }`. Due date: the explicit date, else the quote's payment term, else `default_due_days`. Purchase: `vendorReference` defaults to the quote's `partyReference`, else its number. The new document carries `sourceQuote: { id, quoteNumber, revision }`. Once only (`ux_invoices_source_quote` / `ux_bills_source_quote`, even after a void). **Deleting** that draft returns the quote to ACCEPTED; voiding an issued one does not.

**Phase 42 changes to quotes.** `POST /:id/send` also accepts `templateId` (uuid or `null` = the org's default template for the direction, else the built-in; another org's id is `422 Email template not found`). `POST /` and `PATCH /:id` accept `depositPercentBp` (integer 1–10000, nullable): the share asked as a deposit on acceptance; shown on the quote, in its content hash, and on the PDF; refused (`422`) on a non-base-currency quote. `POST /:id/convert` accepts `target` (`'INVOICE'` default, or `'ORDER'`); a quote with a deposit percentage refuses `target: 'INVOICE'` (`422 This quote asks for a deposit — convert it to an order`) and, converted to an order, also creates the DRAFT deposit invoice/bill in the same transaction. Cancelling the resulting order does not revert the quote. **Quote dates use the organization's timezone** (`ledger_settings.timezone`): validity, expiry, the revision date, the conversion default date and the sweep; every other document keeps UTC "today". `PATCH /settings` now rejects an unknown zone with `400 Unknown time zone`.

**Verified-email acceptance (Phase 42).** When `quoteAcceptanceRequiresCode` is on, the public view reports `requiresEmailCode: true`; the signer asks for a 6-digit code (below), and `accept` must carry `signerEmail` and `code`. The code is stored only as a hash, expires in 10 minutes, allows 5 attempts and at most 5 codes per link per hour (`429 Too many codes requested — try again later`). Failures are `422`: `Enter your email to receive a verification code`, `Enter the verification code we emailed you`, `Request a new verification code` (none live, expired, or issued to a different email), `That code is not correct`, `Too many attempts — request a new code`. A wrong guess is counted even though the request fails. The evidence row records `signerEmailVerified` (also returned on the internal `response`). **This is email-possession evidence, not a qualified electronic signature.**

Status filter on `GET /`: `status` is the **effective** status — `SENT` excludes, and `EXPIRED` includes, sent quotes past `validUntil`. With no filter, SUPERSEDED versions are omitted. Also `partyId`, `from`/`to` (quote date), `q` (number, party, title, reference), `sort` (`quoteDate`, `validUntil`, `number`, `party`, `total`, `status`) and `dir`.

Failure paths: `400` from the schema · `404 Quote not found` (also another org's, or the other direction) · `422 Customer not found` / `Vendor not found` · `422 Account … is not a Revenue account` / `must be an Expense or Asset account` · `422 A revision keeps the party of the quote it revises` · `409 Only a draft quote can be edited — create a revision instead` · `409 Only a draft quote can be deleted — void it instead` · `422 This quote’s validity date has passed — change it before sending` · `409 This quote has already been sent` (MANUAL on a SENT quote) · `409 This quote has expired — create a revision to send it again` · `409 A draft revision of this quote already exists` · `409 An accepted quote cannot be revised — void it and create a new quote` · `409 Revision n was accepted while this revision was drafted …` · `409 This quote is no longer open for a response` · `409 This quote has expired and can no longer be accepted or declined` · `409 Only an accepted quote can be converted` · `409 This quote has already been converted` · `409 A bill with this vendor reference already exists …` · `403` without the permission.

**Public review link — `/api/v1/public/quotes/:token`** (no `authenticate`; `publicLinkLimiter`; `Cache-Control: no-store`). An unknown, revoked or expired token is one `404 This quote link is not valid or has expired`.

| Method | Path | Description |
|---|---|---|
| GET | `/public/quotes/:token` | `{ quote: { merchant: {name, addressLines, hasLogo}, direction, quoteNumber, revision, effectiveStatus, canRespond, partyName, partyAddress, partyTaxNumber, partyReference, quoteDate, validUntil, currencyCode, title, notes, terms, paymentTerms, lines[{lineNumber, description, quantityMilli, unitPriceCents, taxRateBp, netCents, taxCents}], subtotalCents, taxCents, totalCents, contentSha256, response: {response, signerName, respondedAt} \| null } }`. No ids, accounts or evidence detail. Stamps `last_viewed_at` |
| GET | `/public/quotes/:token/logo` | The org logo (PNG/JPEG/GIF/WebP only), or 404 |
| GET | `/public/quotes/:token/pdf` | Phase 42 — the same PDF as the staff route, no session; an unknown/revoked token is the uniform `404` |
| POST | `/public/quotes/:token/verify-email` | Phase 42 — `{ signerEmail }` (lowercased); emails a fresh 6-digit code to it — `202 { success, expiresAt }`, `Cache-Control: no-store`; `409 This quote is no longer open for a response`, `429` past 5 codes per link per hour |
| POST | `/public/quotes/:token/accept` | `{ signerName (1–200), signerEmail?, code? (6 digits), acceptTerms: true, contentSha256 }`. Writes insert-only evidence (name, email, terms, IP, user agent, the hash) and moves SENT → ACCEPTED; emits `quote.accepted`; emails the sender (`quote_responded`). `400` without `acceptTerms: true` or a name · `409` if the hash no longer matches, the quote expired, or it was already answered |
| POST | `/public/quotes/:token/decline` | `{ reason? (≤ 1000) }`. SENT → DECLINED; emits `quote.declined` |

Webhook events: `quote.sent`, `quote.accepted`, `quote.declined`, `quote.converted` (payload: `quoteId`, `direction`, `quoteNumber`, and per event `revision`/`totalCents`/`currencyCode`, `channel`, or `documentKind`/`documentId`).

**Not built:** a qualified electronic signature (QES — acceptance is a typed name, ticked terms, optional verified-email code and evidence), auto-conversion on acceptance, non-Latin text in the PDF (built-in Helvetica is WinAnsi), PDF attached to emails. (Orders, partial billing, deposits, the settings fields, templates, verified email, PDF and the org timezone were delivered in Phase 42.)

#### Quote email templates — `/api/v1/settings/quote-email-templates` — Phase 42

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/?direction=SALES\|PURCHASE` | `quotes.view` | The org's templates for that direction, or the built-in one (`builtIn: true`, `id: null`) when none is stored — `{ success, templates }`; no/invalid `direction` is `400 direction must be SALES or PURCHASE` |
| POST | `/` | `settings.manage` | `{ direction, name (≤100), subject (≤200), body (≤5000), isDefault }` — `201 { success, template }`. Making a template default un-defaults the previous one |
| PATCH | `/:id` | `settings.manage` | Any of `name`, `subject`, `body`, `isDefault` — `200 { success, template }` |
| DELETE | `/:id` | `settings.manage` | `204` |

Placeholders (surface `QUOTE`): `[Quote Number]`, `[Quote Total]`, `[Valid Until]`, `[Quote Title]`, plus the contact, organisation and date families. Only `{{double-brace}}` tokens are refused (`422`); `[Bracket text]` is plain prose. `404 Email template not found` for a missing or other org's id.

#### Orders — `/api/v1/orders` (sales order, `SO-`) · `/api/v1/purchase-orders` (purchase order, `PO-`) — Phase 42

One router per direction; a sales order id is a `404` on the purchase path. Lifecycle `DRAFT → CONFIRMED → CLOSED | CANCELLED`, `CLOSED → CONFIRMED` (reopen). **No order action writes a journal entry.** Permissions `sales_orders.view|edit|convert` and `purchase_orders.view|edit|convert`.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/` | `…view` | Paginated `{ success, count, totalCount, currentPage, totalPages, orders }`; filters `status`, `partyId`, `from`, `to`, `q`, `sort` ∈ `orderDate,number,party,total,status`, `dir` |
| GET | `/:id` | `…view` | `{ success, order }` — lines carry derived `billedQuantityMilli` and `remainingQuantityMilli`; `billingStatus` is `NOT_BILLED` / `PARTIALLY_BILLED` / `FULLY_BILLED`; `documents` lists linked invoices/bills (deposit documents included) |
| POST | `/` | `…edit` | Create a DRAFT — `201`. Body as a quote with `orderDate` and optional `expectedDate` |
| PATCH | `/:id` | `…edit` | Replace a draft (`409 Only a draft order can be edited`) |
| DELETE | `/:id` | `…edit` | Delete a draft — `204` (`409 Only a draft order can be deleted — cancel it instead`) |
| POST | `/:id/confirm` | `…edit` | Allocates the number, re-snapshots the party; emits `order.confirmed` |
| POST | `/:id/close` · `/:id/reopen` | `…edit` | CONFIRMED ↔ CLOSED |
| POST | `/:id/cancel` | `…edit` | `{ reason }`; refused `409 Void the invoices raised against this order first` while a non-void invoice/bill line links to it; emits `order.cancelled` |
| POST | `/:id/convert` | `…convert` | `{ documentDate?, dueDate?, vendorReference?, lines?: [{ orderLineId, quantityMilli }] }` — raises a **DRAFT** invoice (sales) or bill (purchase) for the given quantities (`lines: null` = everything remaining) — `201 { success, document: { kind, id } }`. `409 Only a confirmed order can be invoiced`, `409 Everything on this order has been billed`, `422 Line <n> has only <x> left to bill`. Purchase `vendorReference` defaults to `<orderNumber>-<n>` |
| POST | `/:id/deposit` | `…convert` | See Deposits |

Invoice and bill lines accept `orderLineId` (uuid or `null`). The link is validated when a draft is saved: the order must be CONFIRMED and belong to the same party and currency (`422 Order line not found` — also another org's —, `Only a confirmed order can be invoiced`, `That order belongs to a different customer|vendor`, `An order can only be billed in its own currency`). Total linked quantity can never exceed the ordered quantity: checked under a row lock, and again by a deferred database trigger at commit (`422` with the order-line message). Voiding the invoice/bill or deleting the draft frees the quantity.

#### Deposits and prepayments — Phase 42

A deposit is an invoice (`kind: 'DEPOSIT'`) or bill raised against a CONFIRMED order in the **base currency**, 0% tax, one line on `2130 Customer Deposits` (sales, a Liability) or `1150 Supplier Prepayments` (purchase, an Asset). Issuing/approving it posts DR AR / CR 2130 (sales) or DR 1150 / CR AP (purchase). `Invoice`/`Bill` responses gain `kind`, `depositForOrderId`, `depositAppliedCents` and (single read) `depositApplications`; `amountDueCents` subtracts applied deposits.

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/orders/:id/deposit` · `/purchase-orders/:id/deposit` | `sales_orders.convert` · `purchase_orders.convert` | `{ percentBp \| amountCents (exactly one), documentDate?, dueDate?, vendorReference? }` — creates the DRAFT deposit document — `201 { success, document: { kind, id } }`. `409 Only a confirmed order can take a deposit`, `422 Deposits are available on base-currency orders only`, `422 Deposits on this order would exceed its total`, `422 Give a percentage or an amount` |
| POST | `/invoices/:id/apply-deposit` | `invoices.issue` | `{ depositDocumentId, amountCents, applicationDate }` — applies a paid deposit to this ISSUED, standard invoice; posts DR 2130 / CR AR — `201 { success, application }` |
| POST | `/bills/:id/apply-prepayment` | `bills.approve` | Same body on a POSTED, standard bill; posts DR AP / CR 1150 |
| POST | `/deposit-applications/sales/:id/void` | `invoices.void` | `{ entryDate? }` — voids an application with a reversing journal (the reversal keeps `source_type 'deposit_application'`); `409 This deposit application has already been voided` — `200 { success, application }` |
| POST | `/deposit-applications/purchase/:id/void` | `bills.void` | Same, purchase direction; an application of the other direction is `404` |

Rules and failures: the target must have at least one line linked to the deposit's order (`422 This deposit belongs to a different order`); `amount ≤ paid on the deposit − already applied` (`422 Only <x> of this deposit has been received and not yet applied`) and `≤ the target's amount due`; the application date may not precede either document; `409 Only an issued invoice can take a deposit` / `…approved bill…`. A deposit document is locked against draft edits (`409`). A deposit document or target with a POSTED application cannot be voided (`409 Void the deposit applications on this invoice first` / `…bill first`), and a payment that funds an applied deposit cannot be voided (`409`, same message) until the applications are voided. Webhook events added: `order.confirmed`, `order.cancelled`.

**Not built:** foreign-currency deposits, GST/VAT on advances, cash refund of an unapplied deposit (a cancelled order with a paid deposit leaves a 2130 balance for a manual journal), a goods-receipt / delivery-note document.


#### Products & Services (items) — `/api/v1/items` — Phase 24, extended in Phase 32

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's item catalogue, ordered by code. `?q=` filters by code or name (case-insensitive substring); `?kind=SERVICE\|GOODS` filters by kind; `?itemType=SERVICE\|NON_INVENTORY\|INVENTORY\|FIXED_ASSET` filters by type (Phase 32); `?includeInactive=true` includes retired items (excluded by default) |
| GET | `/:id` | any member | One item |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create an item |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit an item, including retiring it (`isActive: false`) |

**Phase 32 — one product master.** Every item has an `itemType`: `SERVICE` and `NON_INVENTORY` (goods bought or sold but not quantity-tracked, e.g. office supplies) are created here; `INVENTORY` (and, reserved for a later step, `FIXED_ASSET`) are created in inventory (`POST /inventory/items` — which is what the Products & Services form calls when "Track inventory" is ticked; an existing `NON_INVENTORY` product starts tracking via `POST /inventory/items/from-product/:productId`), which creates the linked product in the same transaction — `POST /` with either returns `422 Create inventory and asset items in inventory — they appear here automatically`. `kind` is derived (`SERVICE` ↔ `SERVICE`, everything else `GOODS`); a create body sends `itemType`, or the Phase 24 `kind` (`GOODS` → `NON_INVENTORY`), and if both are sent they must agree (`400`). Responses carry `itemType`, `kind`, `stockManaged` (`true` for `INVENTORY`/`FIXED_ASSET`), `assetAccountId` and `cogsAccountId`. For a stock-managed item `PATCH` refuses `name`/`isActive` (`422 Edit the name and status of inventory and asset items in inventory`) and accepts `assetAccountId` (an `Asset` account) and `cogsAccountId` (an `Expense` account); on any other type those two are refused (`422`). On-hand quantities are **not** on this route — the client reads them from `GET /inventory/product-balances`. The description below is otherwise unchanged: picking an item on an invoice or bill line copies its defaults into that line once; the line never reads through to the item afterward, so editing an item after the fact never changes an already-saved line. `code`, `kind` and `itemType` are **not** updatable, matching `accounts` refusing `code`/`type` on a live account. **There is no DELETE** — an item is retired with `isActive: false`.

**`POST /`** — `code` (1–40 chars), `name` (1–200 chars), `description` (optional, ≤500 chars), `kind` (`SERVICE` or `GOODS`), `salePriceCents`/`purchasePriceCents` (optional, integer cents), `revenueAccountId`/`expenseAccountId` (optional — must be a postable `Revenue`/`Expense` account respectively when present), `saleTaxRateBp`/`purchaseTaxRateBp` (basis points, default `0`).

Failure paths: `400` from the schema · `400 No fields to update` (PATCH) · `404 Item not found` · `409 Item code already exists` · `422 Revenue account does not exist in this organization` / `422 Item revenue account must be a Revenue account` / `422 Item revenue account must be postable` (and the `expense` mirrors of each).

#### Payments — `/api/v1/payments` — Phase 3.9

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable payments (both directions) with nested allocations |
| GET | `/:id` | any member | One payment with its allocations |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Record a payment — born **posted**; posts a balanced journal entry in the same transaction |
| POST | `/:id/void` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the payment; posts a reversing entry and un-settles the documents it paid |

A payment settles one or more invoices (`direction: 'RECEIVE'`) or one or more bills (`direction: 'PAY'`) — never both directions in one payment, never invoices and bills mixed in one payment's allocations. **There is no draft and no `PATCH`** — a payment is created already posted, matching `journal_entries`; the only correction is `POST /:id/void`. **A payment may only allocate to documents in its own currency** (Phase 8) — enforced by the service and independently by `trg_allocations_currency` (migration 025).

**`POST /`** — `direction` (`RECEIVE`/`PAY`), `paymentDate`, `amountCents`, `currencyCode` (Phase 8, optional — a `SUPPORTED_CURRENCIES` code; omitted means the organization's base currency), `cashAccountId` (a postable `Asset` account), `customerId` (RECEIVE) or `vendorId` (PAY, the other must be `null`), `method`, `reference`, `notes`, `allocations` (min 1, each `{ invoiceId | billId, amountCents }`, exactly one of `invoiceId`/`billId` per allocation), optional `entryDate`. `allocations[].amountCents` must sum to exactly `amountCents`. Posts one journal entry (`sourceType: 'payment'`, `sourceId: <payment id>`): `RECEIVE` debits the cash account and credits the receivable account; `PAY` debits the payable account and credits the cash account.

**Phase 8 fields on every payment:** `fxRate`, `baseAmountCents`; each allocation also carries `baseAmountCents`. For a base-currency payment these are unchanged from Phase 3.9 (`fxRate: "1.00000000"`, `baseAmountCents === amountCents`) — the GL shape is byte-identical to before. For a foreign-currency payment, the cash line posts at the settlement-date rate and each control line posts at *its own document's frozen rate*; the difference — the imbalance those two rates create in base currency — is posted automatically to `4910 Realized FX Gain` (credit) or `6810 Realized FX Loss` (debit), or omitted entirely when the rates match. See the worked example: [ledger-core.md § 3](accounting.md#3-realized-fx--the-worked-example).

**`POST /:id/void`** — optional `entryDate`. Posts the reversing entry and flips the payment to `VOID`. The payment's allocation rows are **never modified or deleted** (immutable, insert-only by trigger) — they simply stop counting toward any document's `allocatedCents`, because every settlement read filters on `status = 'POSTED'`. This is what un-settles the paid documents without a second write. Voiding a foreign-currency payment reverses its realized gain/loss line along with everything else, since the reversal copies every line's `currency_code`/`fx_rate` verbatim.

`GET /` query parameters, all optional: `page`, `limit` · `direction` (`RECEIVE`/`PAY`) · `status` (`POSTED`/`VOID`) · `customerId` · `vendorId` · `from`/`to` — inclusive `paymentDate` bounds.

Failure paths: `400` from the schema (including an allocation naming both `invoiceId` and `billId`, or neither) · `400 direction must be RECEIVE or PAY` · `400 status must be POSTED or VOID` · `422 Allocations must sum to the payment amount` · `422 Cash account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not an Asset account` · `422 Customer not found` / `422 Vendor not found` · `422 A RECEIVE payment cannot allocate to a bill` / `422 A PAY payment cannot allocate to an invoice` · `422 That document belongs to a different counterparty` · `422 Only an issued invoice can be paid` / `422 Only an approved bill can be paid` · `422 Allocation exceeds the amount still due on this document` · `422 A <currency> payment cannot settle a document in <currency>` (Phase 8) · `422 No exchange rate for <currency> to <base> on or before <date>` (Phase 8) · `422 No realized FX gain/loss account is configured. Set one in settings.` (Phase 8, only when a settlement actually realizes one) · `404 Payment not found` · `409 This payment has already been voided`.

#### Bank statement imports — `/api/v1/bank-imports` — Phase 6

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's imports, newest first. Optional `?accountId=` |
| GET | `/:id` | any member | One import's summary |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Import a bank statement CSV |

**The CSV arrives as a JSON string field, not a multipart upload** — `content` is the raw file text, capped by `MAX_CSV_CHARS` (900,000 characters) well under the 1MB JSON body limit; file storage is Phase 10's concern, not this one. **`POST /`** body: `accountId` (a postable `Asset` account), `fileName`, `content`, `dateFormat` (`ISO`/`DMY`/`MDY`, default `ISO`), optional `columnMap` (`{ date, description, amount | (debit + credit), reference }` — omit to auto-detect columns by header synonym), optional `closingBalanceCents`/`closingBalanceOn` (must be supplied together). Returns `201` with `{ import, importedCount, duplicateCount, suggestedCount, autoMatchableCount, ruleMatchedCount }`.

**Idempotent by content-addressed hash.** Each row's `dedupe_hash` folds in the org, account, date, amount, normalized description, reference, and an occurrence ordinal (so two genuinely identical lines in one file both survive), enforced by `UNIQUE (org_id, dedupe_hash)`. Re-importing the same statement returns `201` again with `importedCount: 0` and `duplicateCount` equal to the row count — the same set of rows, never doubled. See [study/postgresql/idempotent-ingestion-and-dedupe-hashes.md](../study/postgresql/idempotent-ingestion-and-dedupe-hashes.md).

**The whole file fails together.** Any unparseable date or amount rejects the entire import with `422`, naming up to the first three offending rows by number (header counted) — nothing is written. On success, every newly-inserted line is immediately scored against open invoices (positive amounts) or bills (negative amounts) within a ±30 days window; see the bank-transactions section below. **Phase 34a — bank rules.** After scoring, every line still `UNMATCHED` (no document suggestion scoring at or above `AUTO_MATCH_THRESHOLD`, 85 — a strong document suggestion always wins over a rule) is checked against the org's active bank rules, oldest-priority first, and settled by posting a journal entry through the same path `POST /bank-transactions/:id/post-journal` uses, in the same import transaction. `ruleMatchedCount` is how many lines a rule settled; those lines are excluded from the `bank.large_unmatched` webhook event. See the bank rules section below.

Failure paths: `400` from the schema · `422 Bank account not found` (also another org's account) · `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is not an Asset account` · `422 The file is empty` / `422 Malformed CSV: ...` (from the CSV parser) · `422 Could not find a date/description column in the file` / `422 Could not find an amount column, or a debit/credit pair, in the file` · `422 Column "<name>" is not in the file` (explicit `columnMap` only) · `422 Import failed: N row(s) could not be parsed (...)` · `422 The file contains no transaction rows` · `409 That statement is already being imported` · `404 Bank statement import not found`.

#### Bank transactions — `/api/v1/bank-transactions` — Phase 6

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, filterable bank lines with their scored suggestions |
| GET | `/:id` | any member | One bank line with its suggestions |
| POST | `/:id/rescore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete and regenerate one **unmatched** line's suggestions |
| POST | `/:id/match` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Accept a suggestion (or name a document explicitly) and post a payment |
| POST | `/:id/post-journal` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Phase 6.1 — settle a line with no counterpart document by posting a journal entry directly |
| POST | `/:id/unmatch` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Void the payment or reverse the journal entry the match created, returning the line to `UNMATCHED` |
| POST | `/:id/ignore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Mark a line as not needing reconciliation (e.g. a bank transfer) |
| POST | `/:id/unignore` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Return an ignored line to `UNMATCHED` and regenerate its suggestions |

**There is no `PATCH` and no `DELETE`.** A bank line's match state changes only through the six verbs above; correcting a match voids the payment or reverses the journal entry it posted rather than editing the line (rule 6). Every mutation requires `ACCOUNTANT` or above, matching `/payments`, since matching, posting a journal and unmatching each post, or void/reverse, a real journal entry.

Each `BankTransaction` carries `amountCents` **signed** — positive is money in, negative is money out — and up to 5 `suggestions`, each with a `score` (0–100), a `scoreBreakdown` (`{ amount, date, counterparty }`, each `{ points, maxPoints, reason }`, e.g. `"exact match"` / `"0 day(s) apart"` / `"reference found in memo"`), and `autoMatchable` (`score >= 85`). See [study/architecture/fuzzy-matching-and-confidence-scoring.md](../study/architecture/fuzzy-matching-and-confidence-scoring.md). A `MATCHED` line carries exactly one of `matchedPaymentId` or `matchedJournalEntryId`, never both and never neither (Phase 6.1). **Phase 34a** adds `matchedRuleId`/`matchedRuleName`, both `null` unless a bank rule (rather than a human, through `post-journal`) posted the journal entry that settled this line; `matchedRuleId` is always `null` when `matchedJournalEntryId` is `null`.

`GET /` query parameters, all optional: `page`, `limit` · `accountId` · `importId` · `status` (`UNMATCHED`/`MATCHED`/`IGNORED`) · `from`/`to` — inclusive `txnDate` bounds · `q` — matches description or reference · `minScore` (0–100) — only lines carrying a suggestion at or above this score.

**`POST /:id/match`** body: exactly one of `suggestionId`, `invoiceId`, `billId`. A positive (deposit) line only matches an invoice; a negative (withdrawal) line only matches a bill. Locks the target document, validates its status (`ISSUED`/`POSTED`) and remaining amount due, then posts a payment through the same `paymentService` path `POST /payments` uses — never a direct write to `journal_entries`/`ledger_lines`. **A bank line settles at most one document, in full or in part — never a batch of several documents in one line.** Bank statements remain base-currency-only (Phase 6's stated limit, unchanged by Phase 8): a foreign-currency invoice or bill is never offered as a match candidate, and a manually-chosen one is refused with `422`.

**`POST /:id/post-journal`** (Phase 6.1) body: `{ accountId, description }` — `description` optional, defaults to the line's own description. For a bank line with no counterpart document — a fee, interest, an opening capital deposit — rather than force it through `IGNORE` (which drops it from the reconciliation report's statement side entirely) or a manufactured invoice/bill. The amount and the date are **never** taken from the request, only from the immutable bank line itself. A deposit (positive) debits the bank account and credits `accountId`; a withdrawal (negative) is the reverse — one side per line, balanced by construction (rule 7). Posts through `journalService.createEntryOnClient` with `sourceType: 'bank_line'`, `sourceId` = the bank transaction id — never a direct `ledger_lines` write (rule 16). Refuses `accountId` equal to the line's own bank account.

**`POST /:id/unmatch`** takes no body. Voids the linked payment (if still `POSTED`) via a reversing journal entry, or reverses the linked journal entry directly (Phase 6.1) — never deletes either — clears the match, and regenerates suggestions for the line.

Failure paths: `400 status must be UNMATCHED, MATCHED or IGNORED` · `400 minScore must be a whole number between 0 and 100` · `400` from the schema (`match` naming zero or two of `suggestionId`/`invoiceId`/`billId`) · `404 Bank transaction not found` · `404 Suggestion not found` · `422 A deposit can only be matched to an invoice` / `422 A withdrawal can only be matched to a bill` · `422 Invoice not found` / `422 Bill not found` (also another org's) · `422 Only an issued invoice can be paid` / `422 Only an approved bill can be paid` · `422 That document is already settled` · `422 The bank line exceeds the amount still due on that document` · `422 A base-currency bank line cannot settle a foreign-currency document` (Phase 8) · `422 The journal entry cannot post back to the same bank account` (Phase 6.1) · `422 Account <code> is the receivable control account — …` / `422 Account <code> is the payable control account — …` (Phase 25, `post-journal` to AR/AP; settle a customer or vendor line through `match` instead) · `422 Only an unmatched bank line can be rescored` · `422 The fiscal period covering <date> is closed/locked; ...` (from the underlying payment or journal post) · `409 This bank line is already matched` / `409 This bank line is ignored — un-ignore it first` · `409 This bank line is not matched` · `409 This bank line is matched — unmatch it first`.

#### Bank rules — `/api/v1/bank-rules` — Phase 34a

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's rules, ordered by `priority` then `createdAt`. `?includeInactive=true` includes retired rules (excluded by default) |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Create a rule |
| POST | `/apply` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Apply every active rule to every `UNMATCHED` line in the org (oldest first, at most 1000), one transaction |
| PATCH | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Edit a rule, including retiring it (`isActive: false`) |

A saved pattern — "memo contains STRIPE FEE, post to 6600 Bank Fees" — that settles a matching bank line the same way `POST /bank-transactions/:id/post-journal` does, without a human doing it by hand every time the same recurring line lands: on every `POST /bank-imports` (above) and on demand via `POST /bank-rules/apply`. **There is no GET `/:id` and no DELETE** — a rule is read only as part of the list, and retired with `isActive: false`, never deleted (a settled line's `matched_rule_id` FK is `ON DELETE RESTRICT`, so a rule with history cannot be removed).

**`POST /`** — `name` (1–80 chars), `priority` (0–10000, default 100, lower runs first; ties break on the older rule), `direction` (`IN`/`OUT`/`ANY`, default `ANY` — `IN` only matches money in, `OUT` only money out), `memoContains` (1–100 chars, case-insensitive substring of the line's description after whitespace normalisation), `amountMinCents`/`amountMaxCents` (optional, compared against the line's *absolute* amount, inclusive; `null` is unbounded), `bankAccountId` (optional — restricts the rule to one bank account; `null` applies to every account), `targetAccountId` (the account the journal entry posts to — must be postable, active, not a control account, and not the rule's own `bankAccountId`), `description` (optional — the journal entry's description; `null` uses the bank line's own description).

**Matching, deterministically, no learning.** `findMatchingRule` (`server/src/utils/bankRuleMatch.ts`) picks the first active rule, sorted by `priority` ascending then `createdAt` ascending, whose `bankAccountId`/`direction`/`memoContains`/amount-range conditions all hold; a zero-amount line never matches. **A document suggestion scoring at or above `AUTO_MATCH_THRESHOLD` (85) always wins over a rule** — rules only settle lines a document match did not already claim. See [study/architecture/fuzzy-matching-and-confidence-scoring.md](../study/architecture/fuzzy-matching-and-confidence-scoring.md) for why deterministic rules and scored suggestions are kept as two separate mechanisms rather than merged into one. A rule whose posting is refused (a closed period, the account guard) leaves the line `UNMATCHED` and does not fail the import — each candidate line runs inside its own `SAVEPOINT`, rolled back to on failure so the rest of the import still commits; see [study/postgresql/transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md).

**`POST /apply`** returns `{ success: true, appliedCount }` — how many previously-imported `UNMATCHED` lines a rule just settled.

Failure paths: `400` from the schema · `400 No fields to update` (PATCH) · `404 Bank rule not found` · `422 Target account not found` / `422 Account <code> is a header account and cannot be posted to` / `422 Account <code> is inactive` · `422 Account <code> is the receivable control account — …` / `422 Account <code> is the payable control account — …` (Phase 25, checked at save and again at posting) · `422 Bank account not found` (a `bankAccountId` naming an account that is not an Asset account in the org) · `422 A rule cannot post back to its own bank account` · `422 amountMinCents must not exceed amountMaxCents`.

**Not built:** rules that match a party or split across several accounts, rules learned automatically from history.

#### Exchange rates — `/api/v1/fx-rates` — Phase 8

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

#### FX revaluation — `/api/v1/fx-revaluations` — Phase 8

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | Paginated, newest-first list of past revaluations, each with its lines |
| GET | `/:id` | any member | One revaluation, with its per-document lines |
| POST | `/` | **`OWNER`, `ADMIN` only** | Post a revaluation for `asOfDate` |

Also **`GET /reports/fx-exposure?asOf=YYYY-MM-DD`** (any member, defaults to today) — the identical computation, read-only: `{ asOfDate, baseCurrency, documents, byCurrency, totalDeltaCents, alreadyRevalued }`. Writes nothing and posts nothing — the preview `POST /fx-revaluations` re-computes and commits.

Narrower than every other accounting write route except `POST /fiscal-periods/:id/lock` — a revaluation posts to the GL on someone's behalf, closer to a period close than to an ordinary document post, so the `ACCOUNTANT` tier that can post invoices/bills/payments cannot run one.

**`POST /`** — `{ asOfDate }` only. Re-computes the exposure **on its own transaction**, never trusting a figure the client might have cached from an earlier `GET /reports/fx-exposure` call. Posts one journal entry dated `asOfDate` restating every open foreign-currency invoice/bill at the as-of rate through `6820 Unrealized FX Gain/Loss`, then immediately posts a second entry reversing it, dated the calendar day after `asOfDate` — so a later real settlement's realized gain/loss always compares against a document's original frozen rate, never a revalued one. **There is no `PATCH`/`DELETE`** — a revaluation has no status and no lifecycle; a wrong one is corrected by the next period's revaluation, not by editing this one.

Failure paths: `400` from the schema (`asOfDate` missing/malformed) · `403` for anything below `OWNER`/`ADMIN` · `422 There is no open foreign-currency balance to revalue on this date` · `422 No exchange rate for <currency> to <base> on or before <date>` · `422 The fiscal period covering <date> is closed/locked; ...` (from the entry or its next-day reversal — the whole attempt rolls back, writing nothing) · `409 A revaluation already exists for this date` · `404 FX revaluation not found`.

#### Migration imports — `/api/v1/migration-imports` — Phase 9b, Phase 24, Phase 36a, Phase 36b, Phase 36c, Phase 36d

A business moving off another system's way in: stage a chart-of-accounts, opening-balance, customer or vendor CSV, fix per-row errors, then commit once. `CUSTOMERS`/`VENDORS` (Phase 24) **extend** this same staged importer rather than a second pipeline. Deliberately the inverse of `/bank-imports` (Phase 6) — every row stages, good and bad, instead of the whole file aborting on the first bad one.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/kinds` | any member | Phase 36a — every kind's template metadata: `{ success, kinds: ImportKindMeta[] }` (`kind`, `label`, `noun`, `columns[]` with `key`/`header`/`label`/`required`/`synonyms`/`note`/`example`/`inTemplate`, `requiredOneOf`, `missingMessages`, `editFields[]`; Phase 36b adds `storage: 'typed' | 'data'`, per-column `type` (`text`/`money`/`signedMoney`/`percent`/`quantity`/`date`/`enum`; `signedMoney`, Phase 36c, is `money` that allows a negative), `maxLength`, `enumAliases`, `enumLabels`, and per-edit-field `input: 'text' | 'money' | 'accountType' | 'enum'` with `options`; Phase 36c adds `groupHeaderFields: string[]` — column keys the review table shows in a group header, `[]` for a kind whose rows are not grouped). The client renders templates, the mapper and the row editor from this — there is no client-side copy |
| POST | `/inspect` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Phase 36a — `{ kind, content }`; parses the file and reports `{ success, inspection }` (`headers`, `delimiter`, `rowCount`, first 5 `sampleRows`, `suggestedMap` column key → file header or `null`, `missingRequired`, `exactMatch`, and (Phase 36b) `suggestedDateFormat`). **Persists nothing and touches no table.** A missing required column is reported, not rejected |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Stage a new import — `{ kind, fileName, content, columnMap?, dateFormat?, conversionMode? }`, `kind` is `CHART_OF_ACCOUNTS`/`OPENING_BALANCES`/`CUSTOMERS`/`VENDORS`/`ITEMS`/`INVENTORY_ITEMS` (Phase 36b)/`JOURNALS` (Phase 36c)/`INVOICES`/`BILLS` (Phase 36d), `content` is CSV text, not multipart. Phase 36d adds `conversionMode` (boolean, default `false`; see below). `columnMap` (Phase 36a, default `null`) is `{ <column key>: <file header> \| null }`; see below |
| GET | `/` | any member | Paginated list, optional `?kind=` and (Phase 36a) `?status=DRAFT\|VALIDATED\|COMMITTED` |
| GET | `/:id` | any member | One import's summary |
| GET | `/:id/rows` | any member | Paginated staged rows, optional `?status=VALID\|INVALID\|EXCLUDED`. Ordered by `row_number`, except a grouped kind (Phase 36c), which is ordered group by group — see below |
| PATCH | `/:id/rows/:rowId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Fix one row's fields; re-validates the whole import. A `storage: 'data'` kind is edited with `{ values: { <column key>: <text or null> } }` (Phase 36b); see below |
| POST | `/:id/rows/status` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Phase 36c — bulk include/exclude: `{ rowIds: uuid[] (1–5000), status: 'VALID' \| 'EXCLUDED' }` → `{ success, import }`; see below |
| POST | `/:id/validate` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Re-run validation without changing a row |
| GET | `/:id/preview` | `OWNER`, `ADMIN`, `ACCOUNTANT` | What commit will do if run now — never applies anything. Phase 36d: optional `?mode=DRAFT\|POST` (anything else `400 mode must be DRAFT or POST`) and `?postingDate=YYYY-MM-DD`, which a document kind uses to check the period it would post into |
| POST | `/:id/commit` | **`OWNER`, `ADMIN` only** | Commit a `VALIDATED` import. Irreversible. Serialized per import by `SELECT ... FOR UPDATE` (Phase 36a). Phase 36d: an optional body `{ mode?: 'DRAFT' \| 'POST', postingDate?: 'YYYY-MM-DD' \| null }`, honoured only by `INVOICES`/`BILLS`; an absent body is `{}` |
| DELETE | `/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Delete a non-committed import (rows cascade) |

**Column mapping (Phase 36a).** `columnMap` is optional; with `null`/omitted, each column resolves automatically — the kind's own template header first (`*ContactName`), then its synonyms, both compared with punctuation, spaces and case stripped (`compactHeader`), a file header claimed by at most one field. A supplied `columnMap` is applied first and wins; `null` for a key un-maps it (it is then **not** auto-resolved). The applied map is stored as `migration_imports.column_map` and returned as `columnMap` on the import. `dateFormat` arrived in Phase 36b (below). Templates and field metadata are served by `GET /kinds`; `client/src/Pages/accounting/importTemplates.ts` only turns that metadata into a downloadable CSV.

**Import object (Phase 36a additions).** `columnMap: Record<string, string | null> | null` and `result: MigrationCommitResult | null` — the commit's outcome, persisted in the same transaction as the commit (`{ kind: 'CHART_OF_ACCOUNTS' | 'CUSTOMERS' | 'VENDORS', createdCount, mergedCount }` or `{ kind: 'OPENING_BALANCES', journalEntryId, plugCents }`, or (Phase 36b) `{ kind: 'ITEMS', createdCount, mergedCount }` / `{ kind: 'INVENTORY_ITEMS', createdCount, openingStockCount }`, or (Phase 36c) `{ kind: 'JOURNALS', entryCount, lineCount }`, or (Phase 36d) `{ kind: 'INVOICES' \| 'BILLS', documentCount, lineCount, mode: 'DRAFT' \| 'POST' }`); `null` until `COMMITTED`. Phase 36d adds `conversionMode: boolean` (the flag chosen at staging, stored in `options.conversionMode`) and `commitOptions: { mode, postingDate } \| null` (what the commit actually used, written in the same `UPDATE` as `result`; `null` for a kind with no commit modes and until `COMMITTED`). `GET /kinds` gains per kind `commitModes: ('DRAFT'\|'POST')[]` (`[]` for every kind but `INVOICES`/`BILLS`) and `supportsConversionMode: boolean`.

**Commit serialization (Phase 36a).** `POST /:id/commit` opens its transaction, then locks the import row with `SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2 FOR UPDATE` and checks status **under that lock**. Two concurrent commits of one import therefore yield exactly one `200` and one `409 This import has already been committed` (the old check ran before `BEGIN`, unlocked, so both could pass it). A `DRAFT` import answers `409 Fix N invalid row(s) before committing`; an unknown or other-org id is `404`.


**Kind `CHART_OF_ACCOUNTS`.** Matches on `code`: an unknown code is created (parent resolved by parent *code*, depth-first, the same technique `seedDefaultChart` uses), a known code merges `name`/`description` only — never `code` or `type`. `preview` reports `accountsToCreate`/`accountsToMerge`; `commit`'s `result` is `{ kind: 'CHART_OF_ACCOUNTS', createdCount, mergedCount }`. A chart import may be committed any number of times as **separate** uploads — nothing here limits it to one, unlike the opening-balance kind below.

**Kind `OPENING_BALANCES`.** Every `VALID` row becomes one line in **one** journal entry, posted through `journalService.createEntryOnClient` at `ledger_settings.books_start_date`, `sourceType: 'opening_balance'` — never a direct `ledger_lines` write, so the period-lock guard and the balance triggers apply unchanged. Any imbalance is plugged to `3400 Opening Balance Equity`, shown in `preview.plugCents` (signed: positive is a credit plug, negative a debit plug) before commit, never applied silently. `3200 Retained Earnings` and the AR/AP control accounts (`ledger_invoice_settings.receivableAccountId`/`ledger_settings.payableAccountId`, falling back to codes `1120`/`2100`) are refused per row — see the failure paths. `commit`'s `result` is `{ kind: 'OPENING_BALANCES', journalEntryId, plugCents }`. **A second committed opening-balance import for the same organization is refused, enforced by a partial unique index, not just the service** — see [schema.md](schema.md).

**Kinds `CUSTOMERS`/`VENDORS` (Phase 24).** Column headers resolve exactly like the other two kinds — `Name`/`Customer`/`Company`/…, `Email`, `Phone`, `Billing Address`, `Tax Number`, `Payment Terms` (`VENDORS` only), `Notes`. `commit` matches a staged row to an existing `customers`/`vendors` row by lowercased email first, then by lowercased name; a match **merges**, filling only the columns that are currently `NULL` on the existing row — an import never overwrites data already in the system — no match **creates** a new row. `customers` has no `payment_terms` column, so an imported customer's terms text is appended to `notes` on its own line instead of dropped; a vendor's maps onto `vendors.payment_terms` directly. `preview` reports `partiesToCreate`/`partiesToMerge`; `commit`'s `result` is `{ kind: 'CUSTOMERS' | 'VENDORS', createdCount, mergedCount }`. A customer/vendor import may be committed any number of times as separate uploads, matching the chart-of-accounts kind. Templates (required/optional columns, a worked example row) come from `GET /kinds` (Phase 36a). Customer files also resolve `Contact Name`/`Contact` and `PO/SA Address Line 1` as synonyms, so a Xero contacts export maps without a column map.

**Data-storage kinds and `dateFormat` (Phase 36b).** `ITEMS` and `INVENTORY_ITEMS` are the first kinds with `storage: 'data'`: each cell is parsed by its column `type` (`parseImportCell`, `utils/importValues.ts`) into `migration_import_rows.data` (JSONB) while the trimmed cell text is kept in `raw`; the row object gains `values: Record<string, string | number | null>` (`data ?? {}`) and `groupKey`. Money cells become integer cents, percentages integer basis points (`10`, `12.5%`, `GST on Income (15%)` → 1000/1250/1500; exempt words → 0; max two decimals, 0–100%), quantities integer milli-units (max three decimals; `1,250.125` → 1250125), all by digit-string arithmetic, never floats. A cell that does not parse is stored `null` and surfaces as a row error naming the column (`Sale price "abc" is not an amount`, `Type "x" must be one of: Service, Non-inventory`). `dateFormat` (`ISO` default, `DMY`, `MDY`) is sent on `POST /`, stored in `migration_imports.options`, and returned as `dateFormat` on the import; `POST /inspect` returns `suggestedDateFormat` (`ISO` when every sampled date is `YYYY-MM-DD` or none are given, `DMY`/`MDY` when a day-first/month-first value above 12 proves it, `null` when ambiguous — only computed for kinds with a date column, otherwise `null`). `PATCH .../rows/:rowId` on a data kind takes `{ values }` (and optionally `status`) and re-parses each edited cell, merging into `data` and `raw` with `COALESCE(data,'{}'::jsonb) || $1::jsonb`; legacy keys on a data kind are `400 Edit this import with "values"`, `values` on a typed kind is `400 This import kind does not take "values"`, and a key that is not a column is `400 Unknown field "<key>"`.

**Preview (Phase 36b).** `MigrationCommitPreview` gains `summary: { label, value, format: 'count' | 'money' }[]` and `warnings: string[]` (both `[]` for the four legacy kinds, whose own fields are unchanged; the legacy numeric fields are `0` for the data kinds). `ITEMS`: `Products to create`, `Existing products to fill in`. `INVENTORY_ITEMS`: `Tracked items to create`, `Items with opening stock`, `Opening stock value` (`money`; `round(qtyMilli × unitCostCents / 1000)` summed — a preview only, the posted value comes from the movement engine), and one warning when inventory is not set up yet.

**Revalidate at commit (Phase 36b).** For a data kind `POST /:id/commit` re-runs the kind's `validateRows` inside the transaction, under the `FOR UPDATE` lock, before writing anything — the world can change between validation and commit (an account deactivated, a product created elsewhere). If any non-excluded row now has errors: `409 N row(s) became invalid since validation — re-validate to see them`, nothing written, import still `VALIDATED`. The kind's `prepareCommit` hook (used by `INVENTORY_ITEMS` for its one pool read, the suggested industry profile) runs **before** `BEGIN` (rule 5).

**Kind `ITEMS` — Products & Services (Phase 36b).** Columns `*ItemCode`, `*ItemName`, `Type` (`Service`/`Non-inventory`), `Description`, `SalesUnitPrice`, `SalesAccount`, `SalesTaxRate`, `PurchasesUnitPrice`, `PurchasesAccount`, `PurchasesTaxRate` (the Xero item export maps by synonym). Matches on the exact `code`: an unknown code is **created** (type = the explicit `Type`, else `NON_INVENTORY` when a purchase price or purchases account is given, else `SERVICE`; tax rates default to 0); a known code is **filled** — only currently-`NULL` description, sale price, purchase price, revenue account and expense account are set; name, type and tax rates are never touched. Row errors: `Item code is required` · `Name is required` · `Item code "X" appears more than once in this file (rows 2, 5)` · `"X" is a tracked inventory item — import it under Inventory → Import` (explicit `Inventory` type, or an existing `INVENTORY`/`FIXED_ASSET` item) · `"X" already exists as a Service|Non-inventory — its type cannot change` · `SalesAccount "c" was not found | must be a Revenue account | is a header account and cannot be posted to | is inactive` (and `PurchasesAccount` / Expense). `result` is `{ kind: 'ITEMS', createdCount, mergedCount }`. Commit-time failures are prefixed `Row N (CODE): …`.

**Kind `INVENTORY_ITEMS` — tracked items with opening stock (Phase 36b).** Create-only. Columns `ItemCode` (optional; uppercased, `A–Z 0–9 - _ / .`, max 40; blank = generated from the item-code scheme), `*ItemName`, `Description`, `Category`, `Unit`, `Barcode`, `ReorderPoint`, `SalesUnitPrice`, `SalesAccount`, `SalesTaxRate`, `PurchasesUnitPrice`, `PurchasesTaxRate`, `InventoryAssetAccount`, `CostOfGoodsSoldAccount`, `OpeningQuantity`, `OpeningUnitCost`, `OpeningLocation`, `OpeningDate`. Each row creates the stock item, its linked `INVENTORY` product and, when `OpeningQuantity` is present, an `OPENING` receipt that posts to the GL through the movement engine (Dr the item's inventory account) — the same code path as the One-product form. `Category`/`Unit`/`OpeningLocation` accept a code or a name (blank = the org's default); inventory is set up silently at commit if needed (the suggested profile is read in `prepareCommit`). Opening cost is `OpeningUnitCost`, else `PurchasesUnitPrice`; opening date is `OpeningDate`, else `books_start_date`. Row errors (beyond the shared ones): `Item code "X" may use only A–Z, 0–9 and - _ / . (max 40)` · `"X" already exists — to track stock for an existing product, open it in Products & Services and tick Track inventory` · `Category|Unit|Opening location "t" was not found. Leave it blank to use your default[, or set up inventory first (Inventory → Setup)]` · `… is inactive` · `Barcode "b" is not a valid 8, 12, 13 or 14-digit barcode` · account errors as above (`InventoryAssetAccount` must be Asset, `CostOfGoodsSoldAccount` Expense) · `Opening quantity must be more than zero` · `Enter an OpeningUnitCost or a PurchasesUnitPrice for the opening stock` · `Enter an OpeningDate, or set your conversion date (Settings → Conversion balances)` · `Opening date cannot be in the future` · `Opening stock for lot- or serial-tracked items goes in under Stock movements → Receive` (only when `Category` is explicit and lot/serial-default). Checked only at commit, all-or-nothing: a barcode that collides with an existing stock item (`409`, every row rolled back, import stays `VALIDATED`), and a lot/serial default category reached through a blank `Category` (inventory's own `422`). `result` is `{ kind: 'INVENTORY_ITEMS', createdCount, openingStockCount }`. Do not also import inventory through `OPENING_BALANCES`; the opening-balance importer refuses inventory accounts.


Row-level `errors: string[]` accumulate rather than abort; an import's `status` is `DRAFT` while any row is `INVALID`, `VALIDATED` once every non-excluded row is `VALID`, `COMMITTED` once posted (terminal). `PATCH .../rows/:rowId` (whose editable keys are each kind's `editFields` from `GET /kinds`) accepts `accountCode`, `accountName`, `accountType`, `parentCode`, `description`, `debitCents`, `creditCents` (account/opening-balance kinds) or `partyName`, `partyEmail`, `partyPhone`, `partyAddress`, `partyTaxNumber`, `partyPaymentTerms`, `partyNotes` (Phase 24, party kinds), plus `status` (`VALID`/`EXCLUDED` only) — whichever fields are sent — then re-validates the whole import, so fixing one row can change another row's errors (e.g. resolving a duplicate code or a duplicate name).

**Grouped kinds and bulk status (Phase 36c).** A kind may declare a group key (`groupKeyOf` in `importKinds.ts`); `JOURNALS` is the first, and `groupHeaderFields` in `GET /kinds` is non-empty only for such a kind. `POST /` computes each row's `groupKey` (stored in `migration_import_rows.group_key`, already present since migration `078`) and counts the distinct keys: more than `MAX_IMPORT_DOCUMENTS = 1000` is `422 This file has N journals; one import takes at most 1000 — split it into smaller files` (the noun is the kind's `groupNoun`; the 5000-row cap still applies too). `PATCH .../rows/:rowId` with `values` recomputes that row's `group_key` from its merged `data`/`raw` before re-validating, so editing a `JournalNumber` moves the row into another entry (a patch that sends only `status` leaves the key alone). `GET /:id/rows` on a grouped kind orders by `MIN(row_number) OVER (PARTITION BY COALESCE(group_key, id::text)), row_number` — each group contiguous, groups in first-row order, a row with a null key alone — instead of plain `row_number`; the two `ORDER BY` texts are constants chosen by a boolean. Because a page can cut a group in two, a group header may repeat across a page boundary. `POST /:id/rows/status` sets every listed row to `VALID` or `EXCLUDED` in one statement (an excluded row's errors are cleared), then re-validates the whole import and returns it, all in one transaction under the import's `FOR UPDATE` lock. `VALID` only re-enters validation; the re-validate assigns the real status, so an invalid row comes back `INVALID`. Failures: `404 Migration import not found` (unknown or other-org id) · `409 This import has already been committed` · `404 Some rows were not found in this import` (an id not in this import for this org — nothing is changed) · `400` from the schema (empty list, more than 5000 ids, a non-UUID, a status other than `VALID`/`EXCLUDED`) · `403` below `ACCOUNTANT`.

**Kind `JOURNALS` — manual journal entries (Phase 36c).** Many CSV rows are one journal entry. Columns `JournalNumber`, `*Date`, `*Narration`, `*AccountCode`, `Debit`, `Credit`, `Amount` (`Amount` is not in the template; it is a signed alternative — positive is a debit, negative a credit — and wins over Debit/Credit when present). **Grouping:** rows with the same `JournalNumber` (case-insensitive) form one entry; with no number, rows with the same date and narration (narration case-insensitive, first 200 characters) form one entry, as a Xero manual-journal export does. **Risk:** two different entries that share a date and a narration are merged into one — use a `JournalNumber` when that can happen. The number only groups rows; the posted entry gets its own reference. Row errors: parse errors per cell (`Date "x" is not a date in <format> format`, `Debit "abc" is not an amount`) · `Date is required` · `Narration is required` · `Account code is required` · `A line needs a debit or a credit amount` · `A line has either a debit or a credit, not both` · `A line needs a non-zero amount` · `AccountCode "c" was not found | must be an Asset or Liability or Equity or Revenue or Expense account | is a header account and cannot be posted to | is inactive` · the receivable, payable or inventory control-account refusal, byte-identical to the manual-journal message (`listControlAccountsOnClient` is the one shared source). **Group errors**, appended to every row of the group: `The journal J-2 has only one line — an entry needs at least two` · `The journal J-2 does not balance: debits 1,000.00, credits 900.00` (integer-cent sums, only when every row of the group has one valid side) · `The fiscal period covering 2026-06-30 is closed|locked; reopen it or change the date`. In a numbered group only, the row whose date or narration differs from the first row's gets `Date|Narration differs from row N (<first row's text>) — every line of journal J-1 must match` (that row only). A group with no number is labelled `journal dated 2026-06-30 "June accruals"`. **Preview** `summary`: `Journal entries to post`, `Lines`, `Total debits` (`money`); one warning when entries are dated before `ledger_settings.books_start_date`. **Commit** re-validates (Phase 36b), then posts one entry per group, in first-row order, through `journalService.createEntryOnClient` on the transaction client with `sourceType: 'migration_import'` and `sourceId` = the import id, so the entry is checked again for postable accounts, an open period and balance, and the deferred DB trigger checks it a third time. An entry's failure is prefixed `The journal J-1 (rows 2–4): …` and rolls back every entry. `result` is `{ kind: 'JOURNALS', entryCount, lineCount }`. The import can be committed any number of times as separate uploads. An imported entry is **posted and immutable** like any other: correct it by reversing it. It is **not** a recurring template, because `recurringService` accepts only `sourceType: 'manual'`.

**Commit modes and conversion mode (Phase 36d).** `INVOICES` and `BILLS` are the only kinds with `commitModes: ['DRAFT','POST']` and `supportsConversionMode: true`. *Commit body:* `DRAFT` (the default) creates every document as a draft; `POST` also issues each invoice (`issueInvoiceOnClient`) or approves each bill (`approveBillOnClient`) in the same transaction, on `postingDate` or, when that is `null`/absent, on each document's own date. The checks are pure and run before `BEGIN`: `400 This import kind has no commit options` (any other kind sent a `mode` or a non-null `postingDate`) · `400 A posting date applies only when posting` (`DRAFT` with a `postingDate`) · for a conversion-mode import `400 Conversion-mode imports are always posted` (`mode: 'DRAFT'`) and `400 Conversion-mode imports post on your conversion date` (a non-null `postingDate`); an empty body then means `POST` on `ledger_settings.books_start_date`. `400` from the schema for a non-enum `mode` or a malformed `postingDate`. *Conversion mode* is chosen when staging (`conversionMode: true`, accepted only by these two kinds: `400 conversionMode applies only to invoice and bill imports`). It is for open items dated on or before the conversion date: each line is forced onto account **3400 Opening Balance Equity** (invoice lines through `assertRevenueAccounts`, bill lines through `assertExpenseAccounts`, each given that one account id as an allowance — nothing else about type checking changes), tax must be 0, `ItemCode` and `AccountCode` are not used, and the document posts on the conversion date while keeping its own `issueDate`/`dueDate`, so ageing is unchanged. The opening-balance import's AR/AP plug then nets against the 3400 credit, so year-to-date revenue and expense are not counted twice. Preview with `mode=POST` (or in conversion mode) adds a warning and sets `canCommit: false` for any document whose posting date falls in a `CLOSED`/`LOCKED` period.

**Kinds `INVOICES` and `BILLS` — open and historical documents (Phase 36d).** Grouped kinds (many rows are one document); `BILLS` is "Expenses" in the UI. Both are `storage: 'data'`, resolve every row through one function (`documentImportCore.resolveDocumentsOnClient`) used by validate, preview and commit, and create nothing but through the document services. Columns (shared unless stated): `*ContactName`, `EmailAddress`, `InvoiceNumber` (invoices; optional) / `*InvoiceNumber` (bills; the vendor's own number), `*InvoiceDate`, `DueDate`, `PaymentTerms`, `Currency`, `Reference` (stored as `notes`), `ItemCode`, `*Description`, `Quantity`, `UnitAmount`, `AccountCode`, `TaxRate`, `Location`. **Grouping:** invoices group by `InvoiceNumber` (case-insensitive; a blank number makes each row its own invoice, labelled `invoice on row N`); bills group by vendor name + `InvoiceNumber` (the same reference from two vendors stays two expenses). `maxLength` 40 for an invoice number, 100 for a vendor reference. **Contacts** are matched by name among *active* customers/vendors only and are never created (`Customer "x" not found — import customers first (Customers → Import)`; with two same-name contacts `EmailAddress` chooses, else `"x" matches 2 customers — add EmailAddress to choose one`; vendor wording for bills). **Line defaults** from `ItemCode`: description, unit price (sale price for invoices, purchase price for bills), tax rate and account (revenue account; for a bill the expense account, or the asset account of an `INVENTORY` product via `resolveStockAccountsOnClient`); a blank `Quantity` is 1. Line arithmetic is the same as the document services (`scaleCents`, tax per line, integer cents). Invoice lines take a `Revenue` account; bill lines take `Expense` or `Asset`. Row errors, in order: parse errors per cell · `Customer|Vendor name is required` · `Date is required` · `Vendor's invoice number is required` (bills) · the contact messages above · `Conversion mode imports balances, not products — leave ItemCode blank` · `Item "c" was not found | is inactive | is a fixed asset and cannot go on an invoice|an expense` · `Description is required (or an ItemCode)` · `Unit price is required (or an ItemCode with a sale|purchase price)` · `Quantity must be more than zero` · `AccountCode "c" was not found | must be a Revenue account | must be an Expense or Asset account | is a header account and cannot be posted to | is inactive` · `Account is required (or an ItemCode with a default account)` · `Account 3400 Opening Balance Equity is missing` · `Tax must be 0 in conversion mode — import the amount outstanding including tax` · `Location applies only to inventory products` · `Stock location "x" was not found` · `Currency "x" is not supported`. **Group errors**, appended to every row of the document: a row whose contact, email, date, due date, terms, currency or reference differs from the first row's gets `<Column> differs from row N ("<first>") — every line of the invoice INV-1 must match` (that row only) · `Due date cannot be before the invoice date` · `Payment term "x" was not found` (a code, case-insensitive, or a name) · `Enter a DueDate or PaymentTerms` · `Invoice number INV-1 already exists` / `Expense SUP-1 from <vendor> already exists` · conversion mode: `Set your conversion date first (Settings → Conversion balances)` and `In conversion mode the date must be on or before your conversion date (<date>)` · `No <CUR> exchange rate on or before <date> — add one under Settings → Exchange rates`. A document with any row error is not created. **Preview** `summary`: `Invoices|Expenses`, `Lines`, `Total (base-currency documents)` (`money`); a warning for documents dated before the conversion date when conversion mode is off (re-stage with it on, or revenue/expense is counted twice), a conversion-mode note, and the closed-period warning above. **Commit** re-validates (Phase 36b), then creates documents in first-row order; invoices first advance the numbering sequence past every imported number (see below). Any document failure rolls back the whole import and is prefixed `Invoice INV-1 (rows 2–4): …` (an `ApiError` keeps its status); a unique-constraint race is `409 Invoice INV-1 (rows …): that invoice number already exists` or `409 Expense SUP-1 (rows …): that expense already exists`. Anything the document services refuse at create/issue/approve (a lot- or serial-tracked product, a short stock issue, a closed period, a missing FX rate at the posting date) surfaces here, at commit, as one wrapped error. A bill line for an `INVENTORY` product receives stock on approval, exactly as a manual bill does. An imported document is an ordinary one: posted documents are immutable and are corrected by a credit/debit note or a void.

**Invoices — reserved numbers (Phase 36d).** A draft created by an import may carry an `invoice_number` (only the importer can set it; `invoiceSchema` does not accept one). `POST /invoices/:id/issue` keeps a draft's existing number and allocates from the sequence only when the draft has none, so a normal draft behaves exactly as before. `ledger_invoice_settings.next_number` is advanced to one past the largest imported number of the form `<number_prefix><digits>` (digits only, at most 2,000,000,000; the only way it ever moves is up) before the import creates anything, so a later allocation cannot collide with an imported number. A number that does not start with the prefix (`2026/77`) is kept but does not move the sequence. No migration.

Failure paths: `400` from the schema · `403` for a write below its role tier · `404` for another org's import or row, or an unknown `id`/`rowId` · `409 Fix N invalid row(s) before committing` (commit attempted before `VALIDATED`) · `409 This import has already been committed` (any write to a `COMMITTED` import) · `409 A committed import cannot be deleted` · `409 This organization already has a committed opening-balance import` · (Phase 36d) `409 Another user was posting at the same time — nothing was imported. Commit again.` (a posting import of inventory documents can deadlock with a concurrent issue — Postgres `40P01`, or `40001` — and rolls back whole; commit again) · `422 Could not find a(n) <field> column in the file` (a required column unresolved after mapping — the one whole-file failure; the text is the kind's own `missingMessages`: `CUSTOMERS`/`VENDORS` `Could not find a name column in the file`, `CHART_OF_ACCOUNTS` `… an account code / account name / account type column …`, `OPENING_BALANCES` `… an amount column, or a debit/credit pair, in the file`. **Phase 36a behaviour change:** a chart file with no name column is now this `422`; previously every row staged `INVALID`) · `422 This file has N data rows; one import takes at most 5000 — split it into smaller files` (`MAX_IMPORT_ROWS`; also on `/inspect`) · `422 This file has N journals; one import takes at most 1000 — split it into smaller files` (Phase 36c, `MAX_IMPORT_DOCUMENTS`) (Phase 36d: the same with `invoices` or `expenses`) · `400` on a bad `columnMap`: `Unknown column "<key>" for a <Kind label> import` · `The file has no column named "<header>"` · `Column "<header>" is mapped to more than one field` · `400 status must be DRAFT, VALIDATED or COMMITTED` (list filter) · `422 Complete setup before importing opening balances` · `422 Account 3400 Opening Balance Equity is missing — run migrations` · `422` from the period-lock guard if `books_start_date` falls inside a closed/locked period · (Phase 24, staged-row errors, never a whole-file failure) `name is required` · `duplicate name "<name>" in this file` · `"<email>" is not a valid email address` · `duplicate email "<email>" in this file`.

#### Placeholders — Phase 40

No new route. Xero-style placeholders (`[Month]`, `[Year+1]`, `[Contact Name]`, `[Invoice Number]` …; the full list and rules are in [accounting.md § Phase 40](accounting.md#phase-40--placeholders--shipped)) are filled by the existing write routes:

| Route | Fills |
|---|---|
| `POST /invoices/:id/issue` | `notes` and each line's `description`, against `issueDate`, the customer, `dueDate`, the organization and the allocated number |
| `POST /bills/:id/approve` | `vendorReference`, `notes` and each line's `description`, against `billDate` |
| `POST /credit-notes/:id/issue` · `POST /debit-notes/:id/issue` | `notes` and each line's `description` (`[Invoice Number]` on a credit note is the original invoice's) |
| `POST /journals` | `description`, against `entryDate` |
| `POST /bank-transactions/:id/post-journal` and bank rules | the written `description` only, against the line's date — never the bank's own text |
| `POST /recurring-schedules/:id/run` and the sweep | every generated document, against `runDate` and the occurrence number |

`POST /invoices` / `PATCH /invoices/:id` and their bill equivalents store text **as typed**; a draft's placeholders are filled only at issue/approve.

**New response fields** (read-only, never accepted in a body): `Invoice.notesTemplate`, `InvoiceLine.descriptionTemplate`, `Bill.notesTemplate`, `Bill.vendorReferenceTemplate`, `BillLine.descriptionTemplate`, `JournalEntry.descriptionTemplate` — the text as written, before its placeholders were filled, or `null` when it had none. Editing a draft resets them to `null`.

**New failures:**
- `422 <Field> is longer than <n> characters once placeholders are filled` — e.g. `Line 2's description …` (500), `Notes …` (1000), `Vendor reference …` (100), `Description …` (500). The whole issue/approve rolls back, the invoice number included.
- `422 <Field> is empty once placeholders are filled` — a line description or vendor reference consisting only of a placeholder with no value.
- `409 Vendor reference "<filled>" has already been entered for this vendor` — on `POST /bills/:id/approve` when the filled reference is taken (a manual approval never changes it silently).

**Duplicate references.** `POST /bills` / `PATCH /bills/:id` no longer refuse a second draft (or in-review) bill whose reference still contains placeholders — two `RENT-[Month]` drafts for one vendor are fine. Every other reference is unique per vendor exactly as before, and every bill is checked once approval fills its reference.

`[[Name]]` escapes a placeholder: it is written out as a literal `[Name]` at issue/approve/post (a recurring DRAFT keeps it escaped until then).

Text from an import's POST mode and from the Bill inbox's auto-post is never filled.

#### Recurring schedules — `/api/v1/recurring-schedules` — Phase 34b

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | The org's schedules. Optional `?kind=INVOICE\|BILL\|JOURNAL`, `?status=ACTIVE\|PAUSED\|ENDED` |
| GET | `/:id` | any member | One schedule with its most recent 50 `runs`, newest first |
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Turn an existing invoice, bill or manual journal entry into a schedule |
| POST | `/:id/pause` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `ACTIVE -> PAUSED` |
| POST | `/:id/resume` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `PAUSED -> ACTIVE`, skipping any occurrence that fell due while paused |
| POST | `/:id/end` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `ACTIVE\|PAUSED -> ENDED` (terminal) |
| POST | `/:id/run` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Generate every occurrence currently due (on-demand — the same path the background sweep calls) |

An invoice, bill or manual journal entry acts as a template; a background sweep (queue `recurring-sweep`, every 15 minutes, see [architecture.md](architecture.md)) generates the next occurrence on schedule, as a draft or posted document, **exactly once** per due date — belt and braces: a row lock (`FOR UPDATE SKIP LOCKED`) taken before generating, plus `UNIQUE (schedule_id, run_date)` even if that lock discipline were ever bypassed by a bug. **There is no `PATCH` and no `DELETE`** — to change a schedule, end it and create a new one; a schedule with any `recurring_runs` history cannot be deleted (`ON DELETE RESTRICT`). See [study/architecture/recurring-schedules-and-exactly-once-jobs.md](../study/architecture/recurring-schedules-and-exactly-once-jobs.md).

**`GET /`'s `?kind=`/`?status=` are validated through the same `parseBody` bridge (`utils/parseBody.ts`) every body does** — `listRecurringSchedulesQuerySchema.parse` is not called directly, so a bad value is a `400`, not an uncaught exception: `{ success: false, error: 'Invalid request body: kind: Invalid option: expected one of "INVOICE"|"BILL"|"JOURNAL"' }` (verified against the live schema and error handler; `status` mirrors it with `"ACTIVE"|"PAUSED"|"ENDED"`). Covered by `recurringSchedules.test.ts`'s `'an invalid kind filter is a 400'`. This was found to answer an uncaught `500` instead during this same docs review, and fixed in the same phase (`recurringScheduleController.list` now routes through `parseBody`, per Step 23's follow-up).

**`POST /`** — `kind` (`INVOICE`/`BILL`/`JOURNAL` — the template's own document type, never mixed), `sourceId` (the template invoice/bill/journal entry's id, matching `kind`), `name` (1–80 chars), `frequency` (`WEEKLY`/`MONTHLY`/`QUARTERLY`/`YEARLY`), `intervalCount` (1–12, default 1, e.g. `frequency: MONTHLY, intervalCount: 2` = every two months), `startDate`, `endDate` (optional, `>= startDate`; omitted runs indefinitely), `mode` (`DRAFT`/`POST`, default `DRAFT` — **a `JOURNAL` schedule is always `POST`**, since an unposted journal entry is meaningless), `autoReverse` (boolean, default `false`, **`JOURNAL` only** — when set, each generated entry immediately posts its own reversal dated the first day of the following month, e.g. a monthly accrual). Every occurrence date is computed from the schedule's **anchor** `startDate`, never from the previous occurrence, so a 31st-of-the-month schedule never drifts to the 28th; see the study note.

A `JOURNAL` template must be `sourceType: 'manual'` (not itself generated by capture, a bank rule, or another recurring schedule), must not itself be a reversing entry (`reversesEntryId IS NOT NULL`), and every line's `currencyCode` must be the org's base currency — a recurring journal never carries FX. Every recurring schedule is also checked against the Phase 25 control-account guard on every account it would post to, both at creation and again at each generation.

**`POST /:id/run`** returns `{ success: true, generated, lastError, schedule }` — `generated` is how many occurrences this call produced (`0`/`1` outside a catch-up scenario; up to `RECURRING_MAX_CATCHUP_PER_RUN`, 12, if the schedule fell behind). `lastError` is the message from the most recent failed occurrence (e.g. a closed fiscal period) — that occurrence is **not** retried automatically; fix the underlying blocker and call `run` again. A generated `INVOICE`/`BILL` copies the template's lines, party, currency and payment-terms code field-for-field, dated to the occurrence's `runDate`; a generated `BILL`'s `vendorReference` gets `-<runDate>` appended (capped at 100 characters) so the duplicate-reference control (`/bills` above) never collides across occurrences — **unless it contains placeholders** (Phase 40, `RENT-[Month]`): then it is filled instead, falling back to `<filled>-<runDate>` only if the filled text is already taken for that vendor, and recording `lastError: 'Vendor reference "…" has already been entered for this vendor'` if that is taken too. Every occurrence copies the template's text **as written** (`notesTemplate ?? notes`, `descriptionTemplate ?? description`) and fills its placeholders against `runDate` and `occurrenceNumber` — see [Placeholders](#placeholders--phase-40) below. A `POST`-mode occurrence issues the invoice / approves the bill in the same transaction as creating it, so a generated document is never left half-drafted.

Each `RecurringRun` in `schedule.runs` carries `runDate`, `occurrenceNumber`, and exactly one of `invoiceId`/`billId`/`journalEntryId` plus, for an auto-reversing journal, `reversalEntryId`. Runs are append-only — a database trigger rejects any `UPDATE`.

Failure paths: `400` from the schema (`POST` body and `GET /`'s `?kind=`/`?status=`, both via `parseBody`) · `404 Recurring schedule not found` · `422 Source invoice not found` / `422 Source bill not found` / `422 Source journal entry not found` (also another org's) · `422 Only a manual journal entry can recur` · `422 A reversing entry cannot be a recurring template` · `422 Only a base-currency journal entry can recur` · `422 A recurring journal always posts` (`kind: JOURNAL` with `mode: DRAFT`) · `422 Only a journal can auto-reverse` · `422 Account <code> is the receivable control account — …` / `422 Account <code> is the payable control account — …` (Phase 25) · `409 This schedule cannot move from <FROM> to <TO>` (an illegal FSM transition, e.g. resuming an `ENDED` schedule) · `403` for a `VIEWER` write.

**Not built:** recurring credit/debit notes, editing a schedule in place, emailing a generated invoice, catch-up beyond 12 occurrences in one `run` call.

#### Statements — `/api/v1/statements`, `/api/v1/statement-sends`, `/api/v1/online-payments`, public `/api/v1/public/*` — Phase 39

Customer and vendor statements are a **read** over the Phase 25 subledger, with nothing stored to produce one. Every amount is in base currency.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/statements/customers` · `/statements/vendors` | `customers.view` · `vendors.view` | Every party's `outstandingCents` and `overdueCents` **as at** `?asOf=` (default today), with `lastSentAt`. `?q=` filters names; `?includeZero=true` adds active parties with nothing open. Parties in net credit are kept (aging drops them) |
| GET | `/statements/customers/:id` · `/statements/vendors/:id` | `customers.view` · `vendors.view` | One statement. `?type=OUTSTANDING&asOf=` (default) or `?type=ACTIVITY&from=&to=` (from required; at most 3660 days). Returns `{ statement: PartyStatement }` |
| POST | `/statements/customers/send` · `/statements/vendors/send` | `statements.send` | Body `{ partyIds[1..200], type?, asOf?, from?, to?, templateId?, toEmail? }`. Each party gets a `statement_sends` row and one `party_statement` outbox email in **one transaction**. `toEmail` only with one party. 201 `{ sent: [{partyId, sendId, toEmail}], skipped: [{partyId, name, reason: 'NO_EMAIL'}] }` |
| POST | `/statements/customers/preview-email` · `/statements/vendors/preview-email` | `statements.send` | Body `{ partyId, type?, …, templateId? }` → `{ preview: { toEmail, subject, body } }`: exactly what that party would receive |
| GET | `/statements/customers/:id/sends` · `/statements/vendors/:id/sends` | `customers.view` · `vendors.view` | The last 50 sends, newest first. Never includes a token |
| POST | `/statement-sends/:id/revoke` | `statements.send` | The link stops working. Idempotent |
| GET | `/settings/statements` | any member | Statement template settings (defaults until saved, `configured: false`) |
| PATCH | `/settings/statements` | `settings.manage` | `templateId`, `documentTitle`, `defaultType`, `showLogo`, `showOrgAddress`, `showAgingSummary`, `showRemittance`, `footerNotes`, `accentColor` |
| GET | `/settings/statement-email-templates?kind=` | `statements.send` | The org's templates, plus a `builtIn: true` default for any kind with none |
| POST · PATCH /:id · DELETE /:id | `/settings/statement-email-templates` | `settings.manage` | `{ partyKind, name, subject, body, isDefault }`. The first of a kind becomes the default; making one default clears the other; deleting the default promotes the most recent; `isDefault: false` returns 422 |
| GET · PATCH | `/settings/online-payments` | any member · `settings.manage` | `{ enabled, depositAccountId, providerConfigured }`. Enabling needs a postable, active Asset account |
| GET | `/online-payments?status=` | `payments.view` | Card payments from statement links (at most 200), with their invoices. `NEEDS_REVIEW` rows are the ones to apply by hand |

**OUTSTANDING is true as-at.**
- A document counts if its journal entry is dated on or before the date and it had not been voided by then.
- Payment allocations count by their payment's entry date and void date; note allocations by `allocation_date`.
- The total equals `/customers/:id/ledger?to=<date>`'s `closingBalanceCents`.
- **`/customers/:id/open-items` and `/reports/ar-aging` are unchanged**: they still use current settlement.

**Placeholders** in `subject`/`body` (Phase 40 syntax; [accounting.md § Phase 40](accounting.md#phase-40--placeholders--shipped)):
- `[Contact Name]`, `[Organisation Name]`, `[Balance Due]`, `[Overdue Amount]`, `[Statement Date]`, `[Period From]`, `[Period To]`, `[Open Invoice Count]`, plus the date family (`[Date]`, `[Month]`, `[Year]` … anchored on the statement date). The built-in templates use these.
- The Phase 39b names still work in a saved template: `{{contact_name}}`, `{{organization_name}}`, `{{balance_due}}`, `{{overdue_amount}}`, `{{statement_date}}`, `{{period_from}}`, `{{period_to}}`, `{{open_invoice_count}}`. Any other `{{x}}` returns `422 Unknown placeholder: {{x}}` on save; unknown bracket text is never refused (it is prose).
- Dates read `30 Sept 2026`, as before. `[[Name]]` is an escape, sent as a literal `[Name]`.
- Substitution is a single pass, so a value containing `{{…}}` or `[…]` is inserted literally. The HTML part escapes everything.

**The emailed link** is `FRONTEND_URL/statement/<token>`. The token is 32 random bytes; only its SHA-256 is stored. It expires after 60 days and can be revoked.

**Public routes** have no `authenticate`. Each is rate-limited by `publicLinkLimiter`, which counts successes too:

| Method | Path | Description |
|---|---|---|
| GET | `/public/statements/:token` | `{ merchant: {name, addressLines, hasLogo, baseCurrency}, partyKind, partyName, statement (as sent, recomputed), current (open items today), settings, bankDetails, payment: {enabled, publishableKey}, expiresAt }`. Stamps `last_viewed_at`. `Cache-Control: no-store` |
| GET | `/public/statements/:token/logo` | The org logo bytes (PNG/JPEG/GIF/WebP only), or 404 |
| POST | `/public/statements/:token/payments` | Body `{ invoiceIds[1..100] }`. The **server** computes each invoice's outstanding amount under `FOR UPDATE`, commits a PENDING `online_payments` row, then creates a Stripe PaymentIntent (`Idempotency-Key`). 201 `{ payment: { onlinePaymentId, clientSecret, publishableKey, amountCents, currencyCode } }` |
| POST | `/public/statements/:token/payments/:intentId/confirm` | The browser reports success. The server re-reads the intent from Stripe and settles idempotently. `{ status, paymentId }` |
| POST | `/public/stripe/webhook` | Raw body (`express.raw`, mounted before `express.json`). Verified by `Stripe-Signature` (HMAC-SHA256, 300 s tolerance). Handles `payment_intent.succeeded`/`.canceled`/`.payment_failed` through the same settlement; unknown intents are ignored. Not rate-limited |

**Settlement.** A succeeded intent becomes one ordinary `payments` row (`method: 'CARD'`, `reference: <intent id>`) into the configured deposit account. It is attributed to the user who sent the statement and dated today. If it can't be applied (an invoice paid or voided meanwhile, a closed period, a missing FX rate, an amount mismatch), the row goes to `NEEDS_REVIEW` with the reason.

**Failure paths:**
- `400` — schema; `from` after `to`; ACTIVITY without `from`; unknown `type`; a bad, stale or missing `Stripe-Signature`.
- `403` — missing permission.
- `404`:
  - another org's party, template, send, invoice or intent;
  - `This statement link is not valid or has expired` (unknown, expired or revoked, all the same).
- `409`:
  - `Online payment is not available for this statement` (vendor link, disabled, or Stripe not configured);
  - a racing default-template change.
- `422`:
  - unknown placeholder;
  - a template for the other kind;
  - `toEmail` with several parties;
  - a paid or non-issued invoice;
  - mixed currencies;
  - a non-2-decimal currency (JPY, KRW, BHD…);
  - an invalid deposit account.
- `502` — Stripe refused or was unreachable; the online payment goes to `FAILED`.
- `503` — Stripe is not configured (webhook).

### Documents — `/api/v1/documents` — Phase 9.5

Platform-level (rule 16): accounting attaching a PDF to an invoice and capture attaching a source image (Phase 10) are both modules talking to the platform, never to each other. Full spec: [accounting.md](accounting.md) is silent on this — see [roadmap.md](roadmap.md#phase-95-as-delivered) instead.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Upload a file — multipart, field name `file`. `201` for new bytes, `200` when identical bytes already exist for this org (upload is idempotent by content hash) |
| GET | `/` | any member | Paginated documents, optional `?module=&entityType=&entityId=` (an `EXISTS` filter against `document_links`), `?q=` (Phase 43b — case-insensitive filename substring, max 100, `%`/`_`/`\` escaped) and `?unattached=true` (Phase 43b — only documents with no link at all) |
| GET | `/:id` | any member | One document's metadata plus every `document_links` row attached to it |
| GET | `/:id/file` | any member | Streams the stored original. Sets `Content-Disposition: attachment`, `Content-Type` (the sniffed MIME type), and `X-Content-Type-Options: nosniff` |
| POST | `/:id/links` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Attach a document to `{ module, entityType, entityId }` |
| DELETE | `/:id/links/:linkId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Detach one link |
| DELETE | `/:id` | `OWNER`, `ADMIN` | Delete a document. Refused while any link exists |

Upload takes `multer` in **memory** storage, capped at `MAX_UPLOAD_BYTES` (10 MB). The MIME type is decided by **magic bytes**, never the client's `Content-Type` header — PDF/PNG/JPEG by signature, CSV by a UTF-8-round-trip text check plus a `.csv` filename — and restricted to that four-type allowlist (`server/src/utils/mimeSniff.ts`). A document's metadata row is update-immutable by trigger once written; there is no `PUT`/`PATCH` — the file itself is content-addressed, so an edit would mean the row no longer describes the bytes it names.

`entityType` is validated against a per-module registry (`server/src/types/documents.ts`'s `DOCUMENT_ENTITY_TYPES_BY_MODULE`) — currently `ledger-core` (accounting): `invoice`, `bill`, `journal_entry`, `payment`, `customer`, `vendor`, `quote`, and (Phase 43b) `credit_note`, `debit_note`, `order`. Phase 43b also adds `documentService.attachDocumentsOnClient`, which bills and invoices use to link vault documents on their own transaction. `entity_id` carries **no foreign key**: checking one would mean the platform querying an app's own tables, which rule 16 forbids, so a link can in principle outlive the entity it points at — accepted and tested, not prevented.

Failure paths: `400 Send exactly one file in a field named "file"` (no file, or wrong field) · `400 Uploaded file is empty` · `400 Invalid request body` (schema — `links`) · `403` for a write below its role tier · `404 Document not found` (also another org's) · `404 Attachment not found` · `409 This document is already attached to that record` · `409 Detach this document from every record before deleting it` · `413 File exceeds the 10 MB limit` · `415 Unsupported file type. Allowed: PDF, PNG, JPEG, CSV` · `422 Unknown app slug: <slug>` · `422 <app> documents cannot be attached to "<type>"`.

Storage is org-keyed and content-addressed (`server/storage/<org_id>/<ab>/<cd>/<sha256>`, gitignored, not committed) — two organizations uploading byte-identical files get two independent blobs, deliberately: a shared global namespace would let one tenant detect that another holds the same file. See [study/architecture/file-storage-and-streaming.md](../study/architecture/file-storage-and-streaming.md) and [study/security-auth/file-upload-threat-model.md](../study/security-auth/file-upload-threat-model.md).

---

### Integrations — `/api/v1/integrations/drive` — Phase 19.3

Platform-level (rule 16): a folder's `purpose` routes its files to whichever module owns that purpose — `VENDOR_BILL` to capture (the bill inbox), `BANK_STATEMENT` to accounting's bank import — through that app's own service function, never its tables. Promoted here from `/api/v1/capture/drive` (Phase 19.2), which watched exactly one folder per org and only ever fed capture. See [study/security-auth/oauth2-pkce-and-secrets-at-rest.md](../study/security-auth/oauth2-pkce-and-secrets-at-rest.md) and [study/security-auth/service-accounts-and-jwt-bearer.md](../study/security-auth/service-accounts-and-jwt-bearer.md).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | any member | This org's connection (`null` if none), its folders, and `{ modes: { oauth, serviceAccount, serviceAccountEmail } }` |
| POST | `/connect` | `OWNER`, `ADMIN` | Starts (or restarts) the OAuth 2.0 + PKCE flow. Returns `{ authorizationUrl }`. `503` when the server has no Google OAuth credentials configured |
| POST | `/connect/service-account` | `OWNER`, `ADMIN` | Connects using the server's service account — no redirect, no consent, `CONNECTED` immediately. `503` when unconfigured; `409` when an OAuth connection already exists (disconnect it first) |
| GET | `/oauth/callback` | none (no session) | Google's OAuth redirect target. The `state` value alone is the credential. Always `302`s to `<FRONTEND_URL>/integrations?drive=connected` or `...?drive=error`; never returns JSON. The pre-19.3 path, `/api/v1/capture/drive/oauth/callback`, is kept as a one-route alias — see [roadmap.md](roadmap.md#phase-193-as-delivered) |
| DELETE | `/` | `OWNER`, `ADMIN` | Disconnects — deletes the connection and its folders, best-effort revokes the OAuth refresh token at Google (no-op for a service-account connection). Documents already imported are untouched. `204` |
| GET | `/folders` | any member | Every folder this org watches |
| POST | `/folders` | `OWNER`, `ADMIN` | Adds a folder: `{ purpose, folder, ledgerAccountId, dateFormat, columnMap }`. `ledgerAccountId`/`dateFormat` required for `BANK_STATEMENT`, forbidden for `VENDOR_BILL` |
| PATCH | `/folders/:id` | `OWNER`, `ADMIN` | Edits a folder's settings or `isActive` |
| DELETE | `/folders/:id` | `OWNER`, `ADMIN` | Removes a folder. Files already imported are untouched |
| POST | `/folders/:id/sync` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Queues an immediate sync outside the normal ~60-second poll. `202 { queued: true }` |

**Connecting.** Two independent auth modes, mutually exclusive on one connection row. **Service account (recommended):** the tenant shares a Drive folder with the server's own service-account address (`GET /` returns it as `modes.serviceAccountEmail`) — no consent screen, no Google app verification, and no refresh token to expire (RFC 7523's JWT-bearer grant, `node:crypto`-signed, no SDK — rule 14). **OAuth 2.0 + PKCE** (retained from Phase 19.2, `drive.readonly` scope): a per-org consent flow storing an AES-256-GCM-encrypted refresh token; some Workspace admins block external sharing to a `gserviceaccount.com` address, which is why this path stays available. A refresh that fails with Google's `invalid_grant` (the user revoked access) moves an OAuth connection to `NEEDS_REAUTH` — a service-account connection cannot reach that state, since there is no user grant to revoke.

**Folders and purpose.** Many folders per org, each tagged `VENDOR_BILL` or `BANK_STATEMENT`. A sweep polls every ~60 seconds (`INTEGRATION_DRIVE_POLL_INTERVAL_MS`), listing only files modified since each folder's own stored cursor and skipping any Drive file id already seen (`integration_drive_files`, unique per org — one file is imported at most once, even across a reconnect). Up to `INTEGRATION_DRIVE_MAX_FILES_PER_SYNC` (25) new files import per run. `VENDOR_BILL` files (PDF/PNG/JPEG) go through the identical `captureFile` path direct upload uses, so they are metered, extracted, classified and (if enabled) auto-posted like any other capture document. `BANK_STATEMENT` files (CSV) go through accounting's `bankImportService.importStatement`, using the folder's stored account, date format and column map — a parse failure surfaces the same row-naming message the manual import form would show, on the folder itself. Google Sheets are out of scope (no `alt=media` export); a Sheet in a watched folder is simply never listed.

No token, verifier, state, key, or ciphertext ever appears in a log line, error message, or API response — `GET /` returns only status, auth mode, email, folder metadata, and counts.

Failure paths: `503 Google Drive is not configured on this server` · `503 Google Drive service account is not configured on this server` · `400 Invalid or expired authorization state` · `502 Google rejected the authorization` · `409 Disconnect the existing Google account first` · `400 Enter a Google Drive folder link or ID` · `404 Drive folder not found or not shared with <address>` · `422 That Drive item is not a folder` · `409 Connect Google Drive before adding a folder` · `409 That folder is already connected for this purpose` · `422 A bank statement folder needs a ledger account and a date format` · `422 A vendor bill folder takes no bank settings` · `422 Bank account not found` / `is a header account and cannot be posted to` / `is not an Asset account` · `409 Google Drive access was revoked — reconnect` · `404 Folder not found` (also another org's) · `404 Google Drive is not connected`.

---

### Integrations — `/api/v1/integrations/inbound-mail` — Phase 43d

Each organization has an email-in address for the bill inbox: `<token>@<INBOUND_MAIL_DOMAIN>`. A PDF, PNG or JPEG attachment on a message sent to it is captured exactly like a direct upload. Every route here is `404 Email-in is not enabled` unless the server has `INBOUND_MAIL=brevo`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `capture.view` | `{ success, address, rotatedAt }` — the active address, created on first read. `rotatedAt` is `null` until the first rotation |
| POST | `/rotate` | `capture.process` | Retires the current address (it never routes again) and issues a new one, in one transaction. Same response shape |
| GET | `/messages` | `capture.view` | `{ success, messages: [{ id, fromAddress, subject, receivedAt, status, attachmentCount, importedCount, error }], totalCount, currentPage, totalPages }`, newest first, `?page=&limit=`. `status` is `RECEIVED`, `IMPORTED`, `PARTIAL`, `REJECTED` or `FAILED` |
| POST | `/api/v1/public/inbound-mail/brevo/:secret` | none — the path secret is the credential | Brevo's inbound-parsing webhook (`{ items: [{ MessageId, From: { Address }, Recipients, Subject?, Attachments?: [{ Name, ContentType, ContentLength, DownloadToken }] }] }`, unknown keys ignored). `404 Not found` for a disabled feature **or** a wrong secret (same response, no oracle). After a valid secret: `200 { success: true }` even if no recipient matched an address, so the provider does not retry; `400 Unrecognised inbound mail payload` for a malformed body. Recording is idempotent on `(org, provider, MessageId)`; processing runs in the `inbound-mail-process` job (3 attempts). Not rate-limited (mirrors the Stripe webhook) |

Message outcomes: all eligible attachments captured → `IMPORTED`; some → `PARTIAL`; none eligible (`No PDF, PNG or JPEG attachment`) or none readable (`No attachment could be read as a bill`) → `REJECTED`; a download or database failure → `FAILED` (the job retries). The secret in the webhook path is replaced by `[redacted]` in the request log.

---

### Capture (bill inbox) — `/api/v1/capture` — Phases 10–11, 19, 19.1

Full spec: [capture.md](capture.md). A document reaches capture by uploading to `/api/v1/documents` first and registering it here by id, via `/documents/upload` (both in one call, Phase 19), or via a Drive folder connected at `/api/v1/integrations/drive` (Phase 19.2, promoted to the platform in Phase 19.3 — see the Integrations section above). Phase 10 produces a draft extraction; Phase 11 adds account classification, the review queue, and one-click posting into accounting; Phase 19 adds a second extraction provider (Gemini), rewrites posting onto a real accounting bill, and adds a confidence-gated auto-post; Phase 19.1 adds AI token/cost visibility per document (see `/api/v1/ai-usage` above); a 2026-09-18 fix (below) adds a `DUPLICATE` status so a repeat capture of identical bytes is a visible, reviewable row instead of a silent no-op.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/documents` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Registers an already-vaulted PDF/PNG/JPEG document for extraction. `201`. Status `PENDING`, or `DUPLICATE` when this org already has a non-`DUPLICATE` registration for the same vault document — see below. Enqueues a background job only when `PENDING` — the response returns before extraction runs |
| POST | `/documents/upload` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Phase 19. Multipart, field `file`. Vaults the bytes and registers them with capture in one call. Always `201` now — a repeat upload of identical bytes creates a new `DUPLICATE` row rather than returning the earlier one (`created` is always `true`; the pre-19.4 `200`/`created: false` reuse was removed, see below) |
| GET | `/documents` | any member | Paginated, optional `?status=PENDING\|PROCESSING\|EXTRACTED\|FAILED\|POSTED\|DUPLICATE` |
| GET | `/documents/:id` | any member | One document plus its pages (redacted metadata, never `ocrText`), its extraction if any (now including `dueDate`), and its line items (each carrying `accountId`/`accountCode`/`accountName`, `mappingSource`, `mappingConfidence`). Also carries `billId`, `autoPosted`, `autoPostBlockers` (Phase 19), `modelCalls` (Phase 19.1), and `duplicateOfId`/`duplicateOfFilename` — non-null only when `status = DUPLICATE` |
| GET | `/documents/:id/pages/:pageNumber/image` | any member | The **redacted** page image — PII pixels painted over, this is what was sent to the vision model, never the original |
| POST | `/documents/:id/reextract` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Resets to `PENDING` and re-enqueues, discarding any line items, account overrides and `autoPostBlockers` from the prior run. `409` unless the document is `EXTRACTED`, `FAILED`, or `DUPLICATE` — the last of these is how a flagged duplicate is confirmed legitimate and pushed into the normal pipeline ("Not a duplicate — process it" client-side); `duplicateOfId` is left in place afterward as history, not cleared |
| GET | `/review-queue` | any member | Documents with `status = EXTRACTED`, ordered arithmetic failure first, then any unmapped line, then lowest model confidence, then newest. Each entry carries `autoPostBlockers` |
| PATCH | `/documents/:id/line-items/:lineId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Overrides one line item's account. Only legal while the document is `EXTRACTED`; sets `mappingSource` to `MANUAL` |
| POST | `/documents/:id/post` | `OWNER`, `ADMIN`, `ACCOUNTANT` | One-click approve & post. Phase 19: this now finds-or-creates the vendor and posts a real accounting **bill** (`createCapturedBillOnClient` + `approveBillOnClient`), not a raw journal entry — `source_type = 'bill'`, `source_id` = the bill's id — freezing `journalEntryId`/`billId`/`postedSha256`/`postedAt`/`autoPosted` on this row. No request body. `EXTRACTED → POSTED` only; `POSTED` is terminal, so re-posting is `409`, not a second entry |
| GET | `/settings` | any member | Phase 19. This org's auto-post gates — `autoPostEnabled`, `autoPostMinConfidence` (0.5–1), `autoPostMaxTotalCents` (`null` = no limit), `updatedAt`. Defaults (`false`, `0.9`, `null`, `null`) when never saved |
| PUT | `/settings` | `OWNER`, `ADMIN` | Phase 19. Replaces the auto-post gates. `400` on a bad body (schema) |

Failure paths: `400 documentId must be a UUID` · `400 Invalid page number` · `400 Unknown status filter` · `400 accountId must be a UUID` · `400 Send exactly one file in a field named "file"` · `403` for a write below its role tier · `404 Document not found` (the vault document, also another org's) · `404 Captured document not found` (also another org's) · `404 Page not found` / `404 Redacted page image not found` · `404 Line item not found` (also another document's) · `409 Cannot re-extract a document in status <status>` · `409 Cannot edit line items on a document in status <status>` · `409 Cannot post a document in status <status>` · `409 A bill with this invoice number already exists for this vendor` (Phase 19 — duplicate-invoice detection, via `ux_bills_vendor_reference`) · `413 File exceeds the 10 MB limit` · `415 Unsupported file type. Allowed: PDF, PNG, JPEG` · `422 The bill inbox can only process PDF, PNG and JPEG documents` · `422 Account is a header and cannot be posted to` · `422 Account is inactive` · `422 This document has no extraction to post` · `422 Extraction totals do not reconcile — re-extract before posting` · `422 This document needs an invoice date before it can be posted` · `422 This document needs a positive total before it can be posted` · `422 This document needs a vendor name before it can be posted` (Phase 19) · `422 This document needs an invoice number before it can be posted` (Phase 19) · `422 This document needs at least one line item before it can be posted` · `422 Every line item needs an account before this document can be posted` · `422 A line item with a negative amount cannot be posted as a bill` (Phase 19) · `422 Extracted line items and tax do not sum to the document total` · `422 No exchange rate for <from> to <to> on or before <date>`. Drive-connection failure paths moved to the Integrations section above. (`409 This document is already in the bill inbox` no longer fires from any real path since the 2026-09-18 duplicate-capture change removed the unique constraint it guarded — the code path is unreachable dead code, kept only as defensive handling.)

The capture pipeline (rasterize → local OCR → PII-mask → vision extraction → account classification → persist → attempt auto-post) runs entirely inside the background job, never inside the request. Extraction and classification run against whichever provider `CAPTURE_AI_PROVIDER` selects — `anthropic` (Claude, `claude-sonnet-5`, the SDK) or `gemini` (`gemini-3.6-flash` by default, plain `fetch`, no SDK) — behind one `StructuredModelClient` seam (`services/capture/modelClient.ts`). A server with no key configured for the selected provider processes every step through masking and then fails that one document with `FAILED` / `"Vision extraction is not configured (ANTHROPIC_API_KEY is unset)"` (or `GEMINI_API_KEY`) — nothing else in the app degrades. Account classification degrades quietly instead: a missing key or a model error leaves any still-unmapped line `NONE` rather than failing the document, since the extraction already succeeded. A Gemini call that itself fails (non-2xx) surfaces as `FAILED` / `"Gemini request failed with status <code>"`, with Google's error `status` enum appended in parentheses when the response carries one (e.g. `"... status 404 (NOT_FOUND)"`) — never the provider's free-text error message, which is never echoed.

GL coding is inferred in a fixed order, cheapest and most explainable first, and each tier that hits skips the ones after it: (1) the organization's own posting history for this vendor (`ap_flow_vendor_account_map`, keyed by a normalized vendor-name string, never accounting's `vendors` table — rule 16), (2) a name-similarity match against the org's own postable expense accounts, (3) the model, given only the line descriptions and the chart's account codes, forced into a tool call (or, on Gemini, constrained JSON output) so a code outside the chart is structurally discarded rather than becoming a suggestion. Posting itself finds-or-creates the vendor by normalized name (`vendorService.findOrCreateVendorByNameOnClient`), allocates any tax across the line items by the largest-remainder method (`utils/money.ts`'s `allocateCents`, exact to the cent), and creates + approves a accounting bill in one transaction — debiting the line items' own summed amount per account (never `subtotal_cents`, so a reviewer's override can never silently change the money), crediting the AP control account, splitting input tax to `1180 GST/VAT Input Credit` when present (never `2140`), and resolving its exchange rate at the **invoice date** via accounting's `fx_rates`. The due date is the extracted one when present and not before the invoice date, else invoice date + 30 days.

**Auto-posting (Phase 19).** Off by default, per organization. When enabled, the worker calls `evaluateAutoPost` (pure, `services/capture/autoPostPolicy.ts`) directly after an extraction saves; every gate is checked (not just the first), and a document that fails any of them is left `EXTRACTED` with the reasons recorded in `autoPostBlockers` (`ap_flow_documents.auto_post_blockers`) for the review queue to show. A document that clears every gate is posted with `autoPosted: true` by the worker itself — the actor recorded is the document's original uploader. A posting-time rejection (duplicate invoice, locked fiscal period, missing FX rate) degrades to a `POSTING_REJECTED` blocker rather than failing the document. See [capture.md](capture.md) for the full gate list. See [study/architecture/document-capture-pipeline.md](../study/architecture/document-capture-pipeline.md), [study/security-auth/pii-detection-and-redaction.md](../study/security-auth/pii-detection-and-redaction.md), and [study/architecture/llm-structured-extraction.md](../study/architecture/llm-structured-extraction.md).

**AI usage metering (Phase 19.1).** Every extraction and classification call — success or failure, whichever provider `CAPTURE_AI_PROVIDER` selects — is recorded to the platform's `ai_model_calls` table (see `/api/v1/ai-usage` above) with its token counts, latency, and cost when the model carries a verified price. Recording happens through an injected callback so `extractionService.ts`/`mappingService.ts` stay database-free; a metering failure is logged and swallowed, never surfaced to the pipeline — a spend-tracking bug must not be able to fail a document that extracted fine. Only calls that actually reached a provider are recorded — a `503 "... is not configured"` throws before any request and records nothing.

**Google Drive folder intake (Phase 19.2 — moved to the platform in 19.3).** capture still *receives* files imported this way — it just no longer owns the connection. See [the Integrations section above](#integrations--apiv1integrationsdrive--phase-193).

**Duplicate-content capture (2026-09-18 fix).** Every entry point that registers a document with capture — `/documents/upload`, the two-step `POST /documents`, and a Drive folder's sync — funnels through one function, `captureDocumentService.createApFlowDocument`, which is now the single place a repeat capture is detected: if this org already has a non-`DUPLICATE` registration for the same vault document (the Document Vault is content-addressed by SHA-256, so a renamed re-upload or a second Drive file with identical bytes resolves to the same vault row), the new row is born `status = DUPLICATE` with `duplicateOfId` pointing at the earlier one, and **no extraction is enqueued** — no AI spend on a capture nobody has confirmed is worth processing. This replaced the original behaviour (returning the pre-existing registration untouched, with no new row and no signal anywhere that a repeat capture happened) reported as a real bug: a genuine re-submission arriving through Drive under a different filename was invisible, with nothing for a reviewer to act on. A human decides from the document's own page — dismiss it, or `POST /documents/:id/reextract` ("Not a duplicate — process it"), which reuses the identical `DUPLICATE -> PENDING` transition `FAILED -> PENDING` already uses to re-run a failed extraction. `duplicateOfId` is left in place as history even after being pushed through. See [study/architecture/document-lifecycle-fsm.md](../study/architecture/document-lifecycle-fsm.md).

---

### Inventory — `/api/v1/inventory` — Phase 28

Full spec: [inventory.md](inventory.md). Perpetual inventory: industry setup, custom item/serial attributes, configurable item-code schemes, movements with a moving-average/specific-identification balance cache, QR labels. Reading is open to every member including `VIEWER`. Catalogue configuration (UoMs, categories, attributes, code schemes, locations, applying an industry profile) needs `OWNER`/`ADMIN`. Items, movements and serial changes are bookkeeping, so they need `ACCOUNTANT` and above, matching accounting's own item/document routes. **As of Phase 32 a linked item's movement posts a journal, and as of Phase 35a its GL accounts are true control accounts, reconciled whole — see [Inventory as a control account — Phase 35a](#inventory-as-a-control-account--phase-35a) below.**

**Setup & settings:**

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/settings` | any member | Returns `{ configured: false }` if `stock_settings` has no row yet |
| GET | `/setup/profiles` | any member | The 10 industry profiles, each with its keyword list for the suggestion banner |
| PATCH | `/settings` | `OWNER`, `ADMIN` | Phase 32. `{ defaultLocationId: uuid \| null }` — the location a bill/invoice line lands in when it names none (applying a profile sets it to the profile's main location if none is chosen). `422` for an unknown or inactive location; `409` before setup |
| POST | `/setup` | `OWNER`, `ADMIN` | `{ industryProfile }`. Copies that profile's UoMs/categories/attributes/code schemes/default location into the org's own tables. `409` once already configured |

**Catalogue — UoMs, categories, attributes, code schemes, locations:**

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/uoms` | any member | `?includeInactive=true` to include retired ones |
| POST | `/uoms` | `OWNER`, `ADMIN` | `{ code, name, decimalPlaces }` |
| PATCH | `/uoms/:id` | `OWNER`, `ADMIN` | Name/`decimalPlaces`/`isActive` — `code` is frozen |
| GET | `/categories` | any member | Full tree, each with computed `path`/`depth` |
| GET | `/categories/:id` | any member | One category with its attribute definitions |
| POST | `/categories` | `OWNER`, `ADMIN` | `{ code, name, itemType, defaultTracking, defaultUomId, parentId? }`. `422` past 3 levels deep |
| PATCH | `/categories/:id` | `OWNER`, `ADMIN` | Name/`defaultUomId`/`isActive` only — `code`, `parentId`, `itemType`, `defaultTracking` are frozen |
| POST | `/categories/:id/attributes` | `OWNER`, `ADMIN` | `{ appliesTo, key, label, dataType, options?, decimalPlaces?, isRequired? }` |
| PATCH | `/categories/:id/attributes/:attributeId` | `OWNER`, `ADMIN` | Label/required/options/`isActive` — `key`, `dataType`, `appliesTo` are frozen |
| GET | `/code-schemes` | any member | `?includeInactive=true` |
| GET | `/code-schemes/presets` | any member | The 7 ready-made pattern presets |
| POST | `/code-schemes/preview` | any member | `{ pattern, categoryId, attributes }`. Renders an example code with sequence 1 — never allocates a real counter value |
| POST | `/code-schemes` | `OWNER`, `ADMIN` | `{ name, pattern, isDefault? }` |
| PATCH | `/code-schemes/:id` | `OWNER`, `ADMIN` | Name/pattern/`isDefault`/`isActive` — setting `isDefault` un-sets any other default in the same transaction |
| GET | `/locations` | any member | Full tree with computed `path` |
| POST | `/locations` | `OWNER`, `ADMIN` | `{ code, name, kind, parentId? }`. `422` if `kind` and `parentId` disagree (top-level kinds have no parent; `ZONE`/`BIN` must have one) |
| PATCH | `/locations/:id` | `OWNER`, `ADMIN` | Name/`isActive` only |

**Items:**

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/items` | any member | `?categoryId=`/`?isActive=`/`?lowStock=true`/`?q=` filters, on-hand quantity/value joined in |
| GET | `/items/:id` | any member | Includes current balances by location and (for `SERIAL`/`LOT` items) its lots/serials |
| POST | `/items` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ name, categoryId?, tracking?, uomId?, attributes?, code? \| codeSchemeId?, barcode?, reorderPointMilli?, product?, opening? }`. Only `name` is required. Generates a code via the scheme if `code` is omitted; validates `attributes` against the category's definitions. See *One product form* below for the omitted-category, silent-setup and `opening` rules |
| POST | `/items/from-product/:productId` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Turns tracking on for an existing `NON_INVENTORY` product: `{ categoryId?, assetAccountId?, cogsAccountId?, opening? }` → `201 { item }` (the new stock item, `ledgerItemId = productId`). See *One product form* below |
| PATCH | `/items/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Name/description/`attributes` (merged, not replaced)/barcode/reorder point/`isActive` — `code`, `categoryId`, `tracking`, `uomId` are frozen |
| POST | `/items/:id/link-product` | `OWNER`, `ADMIN`, `ACCOUNTANT` | Phase 32 — links a pre-Phase-32 item to a new Products & Services entry (body: the `product` block below); posts opening stock if it already holds any. `409` if already linked |

**Phase 32 — linked products.** `POST /items` takes an optional `product: { salePriceCents, purchasePriceCents, revenueAccountId, assetAccountId, cogsAccountId, saleTaxRateBp, purchaseTaxRateBp }` (every field optional; blank accounts fall back to the org's inventory settings, then the default chart 1140 / 5050) and creates the accounting `INVENTORY` product with the same code in the same transaction — `409 A product with code X already exists in Products & Services` rolls back the stock item and its code-counter bump. Items carry `ledgerItemId`. `PATCH /items/:id` pushes `name`/`isActive` to the product. `POST /items/:id/link-product` (`OWNER`/`ADMIN`/`ACCOUNTANT`, body is the same `product` block) links an item created before Phase 32 — `409 Item is already linked to a product`; if it already holds stock it posts an opening entry (Dr Inventory / Cr Opening Balance Equity 3400). `GET /product-balances` (any member) returns `[{ ledgerItemId, stockItemId, tracking, uomCode, uomDecimalPlaces, onHandQuantityMilli, isActive }]` for linked items — what Products & Services and the line pickers show. Movements carry `sourceType`, `sourceId`, `glAccountId`, `reversesMovementId`, and the movement types `RECEIPT_REVERSAL` / `ISSUE_REVERSAL`. **A movement of a linked item posts one journal entry in the same transaction** (`sourceType 'stock'`, `sourceId` = the movement group): receipt → Dr Inventory / Cr Opening Balance Equity; issue and adjustment-out → Dr Inventory Adjustments (5400) / Cr Inventory; adjustment-in the reverse; transfers post nothing. New failure paths on the movement routes for a linked item: `422` when the movement date falls in a closed fiscal period (the stock does not move), `422 No opening-stock equity account is configured` / `422 No inventory-adjustment account is configured`. Unlinked items are unchanged.

**One product form (2026-09-30) — tracked products without an inventory setup step.** This is how the Products & Services form's "Track inventory" box works.
- **Silent setup.** `POST /items` and `POST /items/from-product/:productId` first make sure inventory is set up. An org with no `stock_settings` row gets the industry profile suggested by its onboarding industry (`GENERAL` when none), applied **inside the same transaction** under a per-org advisory lock. A failed create therefore leaves no setup behind, and two concurrent first creates apply the profile once. Because this only seeds a catalogue, any `ACCOUNTANT` can trigger it; the explicit `POST /setup` stays `OWNER`/`ADMIN`.
- **Omitted category.** An omitted `categoryId` resolves to the org's default category: one with no required item fields, preferring `QUANTITY` tracking, then `TRADING_GOOD`, then the oldest. `422 Choose a category` if none exists.
- **`opening`.** `opening: { quantityMilli ≥ 1, unitCostCents?, occurredOn, locationId? }` posts opening stock with the item through the ordinary manual-receipt path (purpose `OPENING`, so Dr Inventory / Cr Opening-stock equity) in the same transaction. `unitCostCents` defaults to `product.purchasePriceCents` (from-product: the product's purchase price), and `locationId` defaults to the default location. It fails with:
  - `422 Enter a unit cost for the opening stock, or a purchase price`
  - `422 Choose a stock location for the opening stock`
  - `422 Enter opening stock for lot- or serial-tracked items under Stock movements → Receive`
  - `422 Movement date cannot be in the future`
- **`from-product`.** It flips the product `NON_INVENTORY → INVENTORY` (the only permitted item-type transition, `ITEM_TYPE_TRANSITIONS` in `itemService.ts`). It clears the product's `expenseAccountId` and sets `assetAccountId`/`cogsAccountId` (both default to settings). It then creates the stock item with the product's code, upper-cased, or the default scheme's code if the product code does not fit the stock grammar. It is **forward-only**: documents already posted stay as posted (expensed, no COGS), and only documents posted afterwards move stock. Failures:
  - `404 Product not found` (including another org's product)
  - `409 This product already tracks inventory`
  - `422 Only a non-inventory product can start tracking inventory` (for a service or fixed asset)
  - `422 Reactivate the product before tracking its inventory`
  - `409 Item code already exists`
  - any `opening` error above, which rolls back the conversion.

**Movements, balances, lots, serials, summary:**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/receipts` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ itemId, locationId, quantity/lotNumber/serialNumbers, unitCostCents, occurredOn, reference?, purpose? }`. Phase 35a: `purpose` is `'OPENING'` (default) or `'ADJUSTMENT'` — for a linked item this picks the GL counter-account (opening-stock equity vs. inventory-adjustments) and the journal description ("Opening stock" vs. "Stock found — count gain") |
| POST | `/issues` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ itemId, locationId, quantity/lotId/serialIds, occurredOn, reference?, expenseAccountId? }`. `409` on insufficient stock. Phase 35a: `expenseAccountId` (a UUID or `null`, default `null`) is an active postable `Expense` account to charge the issue to — `422` if it is not Expense/postable/active; `null` (unchanged behaviour) posts to the inventory-adjustments account |
| POST | `/transfers` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ itemId, fromLocationId, toLocationId, quantity/lotId/serialIds, occurredOn }`. Writes a `TRANSFER_OUT`+`TRANSFER_IN` pair sharing one `movementGroupId` |
| POST | `/adjustments` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ itemId, locationId, quantityDelta/lotId/serialId, unitCostCents?, reason, occurredOn }` |
| GET | `/balances` | any member | `?itemId=`/`?locationId=`, non-zero by default |
| GET | `/movements` | any member | `?itemId=`/`?locationId=`/`?from=`/`?to=`, running quantity per row |
| GET | `/items/:id/lots` | any member | FEFO order (soonest `expiresOn` first) |
| GET | `/items/:id/serials` | any member | `?status=` filter |
| GET | `/summary` | any member | Org-wide on-hand value, low-stock count, item count |
| GET | `/product-balances` | any member | Phase 32 — on-hand quantity per linked product, keyed by `ledgerItemId`; what Products & Services and the invoice/bill line pickers show |

**Serial status and attributes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/serials/:id/status` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ to, note? }`. `422` on a transition not in `STOCK_SERIAL_TRANSITIONS` with `via: 'MANUAL'` |
| PATCH | `/serials/:id` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `attributes` (merged) |

**Lookup and labels:**

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/lookup?code=` | any member | Exact-match across items/lots/serials. `?kind=` narrows to one |
| POST | `/labels` | any member | `{ targets: [{ kind, id, copies }] }`, capped at 500 total copies. Returns each target's code/title/subtitle/scan payload/QR SVG |

Failure paths: `400 Invalid request body` (schema) · `403` for a write below its role tier · `404` on any inventory entity id (also another org's, or a malformed uuid) · `409 inventory is already configured for this organization` · `409` on a duplicate UoM/category/scheme/location code or item barcode · `409` on insufficient stock for an issue/transfer-out · `409` on a serial status transition already satisfied · `422` on a category depth/location-kind/attribute-validation/code-pattern violation · `422 A label sheet is limited to 500 labels`.

`services/inventory/` and `controllers/inventory/` contain no query against any other app's tables — proven structurally: `grep -rnE "FROM (accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|payments|ap_flow_)" server/src/services/inventory/ server/src/controllers/inventory/` returns nothing. `utils/stockCodePattern.ts`, `utils/stockAttributes.ts`, `utils/stockValuation.ts` and `utils/gtin.ts` are all pure functions with no database import, unit-tested without Postgres. Phase 28 shipped with no GL posting, no outbox event, no webhook — Phase 32 added journal posting for a linked item's movement (through `accounting/inventoryAccountingService.ts` and `accounting/documentStockLines.ts`, never a direct table read), and Phase 35a (below) makes the accounts that posting lands on reconcilable as whole control accounts. Still no outbox event and no webhook from any inventory route. See [inventory.md](inventory.md#deliberately-not-built).

#### Inventory as a control account — Phase 35a

Full detail: [inventory.md § GL reconciliation](inventory.md#gl-reconciliation--phase-35a). An account is an **inventory control account** when it is some `INVENTORY` product's `assetAccountId`, or (if any `INVENTORY` product has no override) the resolved default inventory account — this set, not a fixed code, is what every route below reconciles and what the control-account guard (see [accounting.md § Phase 35a](accounting.md#phase-35a--inventory-as-a-control-account)) refuses manual postings to.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/valuation` | any member | Every control/GL-touched account's stock subledger vs. its GL balance, `?asOf=YYYY-MM-DD` optional (defaults to all time). Also lists misplaced value (an item's value sitting on an account that is no longer its current one) and unlinked stock items' value |
| POST | `/reconcile/true-up` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `{ accountId, expectedDifferenceCents }`. Posts a journal dated today moving the GL to match the stock subledger (Dr/Cr the inventory-adjustments account) and records a `stock_gl_true_ups` row. `409 This account already ties to inventory` if the difference is already zero; `409 The difference has changed — refresh the valuation and try again` if `expectedDifferenceCents` no longer matches a fresh recompute (an optimistic-concurrency guard against acting on a stale report); `422 That account is not an inventory account`; `422 No inventory-adjustment account is configured. Set one in settings.` |
| POST | `/reconcile/reclass` | `OWNER`, `ADMIN`, `ACCOUNTANT` | No body. Sweeps every linked item's value off any account that is not its current one onto its current one (a `RECLASS_OUT`/`RECLASS_IN` movement pair each, no GL entry — see below). Returns `{ postingCount }` |
| POST | `/items/link-all` | `OWNER`, `ADMIN`, `ACCOUNTANT` | No body. Links every unlinked stock item to a same-code Products & Services entry one at a time, each in its own transaction; a failure (e.g. `409` code collision) is recorded per item and does not stop the rest. Returns `{ result: { linkedCount, failures: [{ stockItemId, code, message }] } }` |

`RECLASS_OUT`/`RECLASS_IN` are a value-only movement pair (`quantityMilli: 0`) that moves an item's already-posted value from one GL account to another without moving any stock — `stock_balances` is untouched (the pair nets to zero on the one balance row it anchors to). Every place inventory accounts change ownership posts this pair plus one journal in the same transaction: `PATCH /settings` changing `inventoryAccountId` (sweeps every defaulted product), `PATCH /items/:id` changing a product's own `assetAccountId` (that product only), and voiding a bill or invoice whose stock has since been reclassed (sweeps the reversal's movements onto the item's *current* account, not the one it posted to originally).

---

## Planned surface — by app

### Accounting — remaining phases

Phase 3, Phase 4, Phase 6, Phase 8, and Phase 9b are **built** and documented in the section above — the FX engine's `fx_rates`, foreign-currency invoices/bills/payments with realized settlement gain/loss, period-end unrealized revaluation, and the staged chart-of-accounts/opening-balance importer are all complete. Still to come:

#### QuickBooks Online sync — Phase 17

`/quickbooks/{connect,callback,status,sync}` for the OAuth 2.0 authorization-code flow and journal push. Documented properly when it lands.

capture and inventory are fully documented in the section above. accounting's QuickBooks Online sync (Phase 17) is the only remaining unbuilt surface. Five other apps were built and then removed from the suite in Phase 29 — see [roadmap.md](roadmap.md#phase-29-as-delivered) for what they were and why.

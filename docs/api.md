# API Reference

**No endpoints exist yet.** The table below is the planned surface. Document each route here as it lands, and keep this file verified against `server/src/routes/`.

## Conventions

- All routes prefixed `/api/v1/`. Every route except `/auth/*` requires the `auth` middleware.
- Mount modules at `/api/v1/<module>`.
- Success: `{ success: true, ... }`. List endpoints add `count`, `totalCount`, `currentPage`, `totalPages`.
- Pagination defaults to `page=1&limit=20`, `limit` capped at 100.
- Errors: throw or `next(new ApiError(status, message))` and let `errorHandler.ts` format them. Never hand-roll an error response.
- Financial mutations require an `Idempotency-Key` header from Phase 9 onward.
- Posted documents expose `POST /:id/reverse`, never `PUT` or `DELETE`.

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

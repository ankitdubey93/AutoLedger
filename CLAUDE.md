# AutoLedger — CLAUDE.md

This file is the authoritative reference for Claude Code when working on this repository. Read it fully before making any changes.

---

## Project Overview

AutoLedger is a full-stack double-entry bookkeeping application for small businesses. It enforces strict accounting principles: every journal entry must have balanced debits and credits, stored in PostgreSQL with full ACID transaction guarantees.

**Live URLs (local dev):**
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:5000/api/v1`

---

## Repository Structure

```
AutoLedger/                        ← repo root (run docker compose here)
├── docker-compose.yml             ← unified dev stack (postgres, redis, server, client)
├── .env.example                   ← copy to .env and fill secrets
├── CLAUDE.md                      ← this file
├── server/                        ← Node.js/Express backend
│   ├── src/
│   │   ├── index.ts               ← Express app entry point
│   │   ├── controllers/           ← thin HTTP adapters only (no SQL)
│   │   ├── services/              ← business logic + DB queries (source of truth)
│   │   │   ├── journalService.ts
│   │   │   ├── accountService.ts
│   │   │   └── reportService.ts
│   │   ├── routes/                ← route definitions
│   │   ├── middleware/
│   │   │   ├── auth.ts            ← JWT verification (uses ACCESS_TOKEN_SECRET)
│   │   │   └── errorHandler.ts    ← global error handler
│   │   ├── utils/
│   │   │   ├── apiError.ts        ← custom error class
│   │   │   ├── jwt.ts             ← token generation
│   │   │   └── ruleEngine.ts      ← NLP rule engine for MagicJournal
│   │   ├── db/
│   │   │   ├── connect.ts         ← pg Pool singleton
│   │   │   ├── migrate.ts         ← migration runner
│   │   │   ├── reset.ts           ← dev DB reset
│   │   │   └── migrations/        ← ONLY migration directory (001_, 002_, ...)
│   │   ├── types/
│   │   │   ├── accounting.ts      ← AccountType, JournalLineInput etc.
│   │   │   └── express.d.ts       ← AuthenticatedRequest module augmentation
│   │   └── __tests__/             ← all test files live here
│   ├── entrypoint.sh              ← runs migrate then starts server (used by Docker)
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── vitest.config.ts
│   └── package.json
└── client/                        ← React/Vite frontend
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx                 ← router + AuthProvider
    │   ├── Pages/
    │   ├── components/
    │   ├── context/AuthContext.tsx
    │   └── services/fetchServices.ts  ← all API calls + auto-refresh logic
    ├── Dockerfile
    ├── .dockerignore
    └── package.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 7, TailwindCSS 4, Vite 6 |
| Backend | Node.js, Express 4, TypeScript 5 (strict mode) |
| Database | PostgreSQL 16 |
| Auth | JWT (httpOnly cookies) — access token 15m, refresh token 7d |
| ORM | None — raw `pg` (parameterized queries only, never string interpolation) |
| Containerization | Docker Compose |
| Testing | Vitest + @vitest/coverage-v8 (backend only) |
| Linting | ESLint + Prettier (client), TypeScript strict (both) |

---

## Running the Stack

### Option A — Full Docker (recommended)

```bash
# From repo root (AutoLedger/)
cp .env.example .env          # fill in JWT secrets
docker compose up --build     # starts postgres, server, client
```

Migrations run automatically on server startup via `entrypoint.sh`. No manual steps needed.

To rebuild after dependency changes:
```bash
docker compose up --build server   # rebuild just the server image
docker compose up --build client   # rebuild just the client image
```

### Option B — Local (without Docker)

Requires a running PostgreSQL 16 instance.

```bash
# Terminal 1 — backend
cd server
cp .env.example .env   # set PG_HOST=localhost and JWT secrets
npm install
npm run migrate        # run migrations once
npm run dev            # nodemon + ts-node, port 5000

# Terminal 2 — frontend
cd client
npm install
npm run dev            # Vite dev server, port 5173
```

---

## Environment Variables

All required vars are documented in `.env.example` at the repo root.

| Variable | Used By | Notes |
|----------|---------|-------|
| `PORT` | server | defaults to 5000 |
| `FRONTEND_URL` | server | CORS allowed origin |
| `ACCESS_TOKEN_SECRET` | server | signs + verifies access JWTs |
| `REFRESH_TOKEN_SECRET` | server | signs + verifies refresh JWTs |
| `JWT_SECRET` | server | legacy — do not use for new token operations |
| `PG_HOST` | server | `postgres` in Docker, `localhost` locally |
| `PG_PORT` | server | 5432 |
| `PG_USER` | server | autodb_user |
| `PG_PASSWORD` | server | autodb_pass |
| `PG_DATABASE` | server | autodb |
| `NODE_ENV` | server | `development` or `production` |
| `VITE_API_BASE_URL` | client | `http://localhost:5000` |

**Important:** `VITE_API_BASE_URL` is consumed by the browser, not the Docker network. It must always point to the host-accessible port, not a Docker service name.

---

## API Reference

All routes are prefixed `/api/v1/`. Auth middleware applies to all non-auth routes.

### Auth (`/api/v1/auth`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/register` | Create account + seed default chart of accounts |
| POST | `/login` | Returns access + refresh tokens as httpOnly cookies |
| GET | `/check` | Verify session and return current user |
| GET | `/refresh` | Issue new access token from refresh token |
| POST | `/logout` | Clear cookies + delete refresh token from DB |

### Accounts (`/api/v1/accounts`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List all accounts for authenticated user |
| POST | `/` | Create new account (type must be Asset/Liability/Equity/Revenue/Expense) |

### Journal Entries (`/api/v1/journals`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/?page=1&limit=20` | Paginated journal entries with nested ledger lines |
| POST | `/` | Create balanced journal entry (debits must equal credits) |

### Reports (`/api/v1/reports`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/trial-balance` | Aggregated account balances with `isBalanced` flag |

### AI / Rule Engine (`/api/v1/ai`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyze` | Parse natural language → suggested balanced journal entry |

---

## Architecture Principles

### Controllers are thin HTTP adapters
Controllers must only: extract and validate HTTP input, call a service function, format the HTTP response. No SQL. No business logic.

```ts
// CORRECT
export const createJournalEntry = async (req, res, next) => {
  const { date, description, lines } = req.body;
  const entry = await journalService.createEntry(userId, { date, description, lines });
  res.status(201).json({ success: true, entry });
};

// WRONG — SQL in controller
export const createJournalEntry = async (req, res, next) => {
  await pool.query('INSERT INTO ...');  // ← belongs in a service
};
```

### Services own all DB logic
All `pool.query` / `client.query` calls live in `src/services/`. Services accept plain data arguments and return plain objects. They have no access to `req`/`res`.

### Double-entry invariant is always enforced in integer cents
Never use floating-point comparison for financial amounts:

```ts
// CORRECT
const toCents = (n: number) => Math.round(Number(n) * 100);
const totalDebitCents  = lines.reduce((s, l) => s + toCents(l.debit), 0);
const totalCreditCents = lines.reduce((s, l) => s + toCents(l.credit), 0);
if (totalDebitCents !== totalCreditCents) throw new ApiError(400, "Entry is unbalanced.");

// WRONG
if (Math.abs(totalDebit - totalCredit) > 0.01) { ... }  // accumulates float errors
```

### A ledger line must have exactly one side populated
A line with both `debit > 0` and `credit > 0` is invalid and must be rejected at the controller layer before the DB is touched. The DB also enforces this with a CHECK constraint.

### All queries use parameterized placeholders
Never interpolate user input into SQL strings. Always use `$1, $2, ...` placeholders with the values array argument.

### JWT tokens
- Access tokens are signed with `ACCESS_TOKEN_SECRET` (15 min expiry)
- Refresh tokens are signed with `REFRESH_TOKEN_SECRET` (7 day expiry)
- Auth middleware (`middleware/auth.ts`) verifies using `ACCESS_TOKEN_SECRET` — never `JWT_SECRET`
- Never log decoded token payloads

---

## Database Schema

Migrations are in `server/src/db/migrations/` only. Run in sorted filename order (001_, 002_, ...).

### Core Tables

**`accounts`** — Chart of accounts per user
- `id` UUID PK
- `user_id` UUID FK → users
- `name` TEXT, `code` TEXT, `type` TEXT (Asset/Liability/Equity/Revenue/Expense)
- UNIQUE(user_id, code)

**`journal_entries`** — Transaction headers
- `id` UUID PK, `user_id` UUID FK → users
- `date` DATE, `description` TEXT, `source_type` TEXT (manual/ai-generated)
- `created_at`, `updated_at` TIMESTAMP

**`ledger_lines`** — Individual debit/credit rows
- `id` UUID PK
- `journal_entry_id` UUID FK → journal_entries ON DELETE CASCADE
- `account_id` UUID FK → accounts
- `user_id` UUID FK → users
- `debit` DECIMAL(15,2) CHECK ≥ 0
- `credit` DECIMAL(15,2) CHECK ≥ 0
- CHECK: NOT (debit = 0 AND credit = 0)
- CHECK: NOT (debit > 0 AND credit > 0)  ← mutual exclusion

**`users`** — Auth
- `id`, `name`, `email` (case-insensitive unique), `password` (bcrypt), `email_verified`

**`refresh_tokens`** — Active refresh token store (deleted on logout)

### Default Accounts (seeded on user registration)
| Code | Name | Type |
|------|------|------|
| 1000 | Cash on Hand | Asset |
| 1001 | Bank Account | Asset |
| 1200 | Accounts Receivable | Asset |
| 2000 | Accounts Payable | Liability |
| 4000 | Sales Revenue | Revenue |
| 5000 | Cost of Goods Sold | Expense |
| 6000 | Office Expenses | Expense |

---

## Testing

### Run Tests
```bash
cd server
npm test                  # run all tests once
npm run test:watch        # watch mode
npm run test:coverage     # coverage report (target ≥ 80% for services/ and utils/)
```

### Test Structure (`server/src/__tests__/`)

| File | What it covers | DB needed? |
|------|---------------|-----------|
| `doubleEntry.test.ts` | Balance validation logic, cents conversion, mutual exclusion | No |
| `ruleEngine.test.ts` | NLP parsing, intent detection, balanced output guarantee | No |
| `journalService.test.ts` | createEntry transaction flow, ROLLBACK on failure | Mocked |
| `reportService.test.ts` | isBalanced flag, net_balance calculation per account type | Mocked |
| `auth.test.ts` | Middleware: missing token, valid token, expired token | No |

Mock the DB pool with `vi.mock('../db/connect')` — never hit the real database in unit tests.

### Test Framework
- **Vitest** with `@vitest/coverage-v8`
- Config: `server/vitest.config.ts`
- `globals: true` is set — no need to import `describe`, `it`, `expect`

---

## Docker Services

| Service | Container | Port | Hot Reload |
|---------|-----------|------|------------|
| PostgreSQL 16 | `autodb_postgres` | 5432 | N/A |
| Redis 7 | `autodb_redis` | 6379 | N/A |
| Express server | `autodb_server` | 5000 | nodemon watches `src/` |
| Vite frontend | `autodb_client` | 5173 | Vite HMR via volume mount |

The server container waits for PostgreSQL's healthcheck (`pg_isready`) before starting. Migrations run automatically via `entrypoint.sh`.

Source code volumes enable hot reload without rebuilding images:
- `./server/src` → `/app/src` (nodemon picks up changes)
- `./client/src` → `/app/src` (Vite HMR picks up changes)
- `/app/node_modules` anonymous volume prevents host `node_modules` from overwriting container-installed packages.

---


## Common Mistakes to Avoid

- **Do not** use `JWT_SECRET` to verify tokens — use `ACCESS_TOKEN_SECRET` for access tokens
- **Do not** put SQL queries in controllers — they belong in `src/services/`
- **Do not** use floating-point arithmetic for financial comparisons — convert to integer cents
- **Do not** use string template literals to build SQL — always use parameterized `$1, $2` placeholders
- **Do not** add new migration files outside `server/src/db/migrations/`
- **Do not** add new account types beyond: `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`
- **Do not** create a ledger line with both debit and credit > 0
- **Do not** log decoded JWT payloads (`console.log(decoded)`)
- **Do not** use `pool.query` inside a `client` transaction block — use `client.query` consistently to ensure the query runs within the transaction

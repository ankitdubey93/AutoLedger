# Build plan — LedgerCore Phase 3.5: onboarding, settings & dashboard

**Date:** 2026-09-02
**Status: DONE — 2026-09-02.** All 26 steps executed; 230 server + 41 client tests green;
`guardrail-review` and `docs-sync` both run clean.
**Phase:** 3.5 (LedgerCore) · **Spec:** [docs/ledger-core.md](../docs/ledger-core.md) · **Schema:** [docs/schema.md](../docs/schema.md) · **API:** [docs/api.md](../docs/api.md)

> This file is now a historical record, not a live plan. The durable account of what shipped
> and what deliberately changed is [roadmap.md § Phase 3.5, as delivered](../docs/roadmap.md#phase-35-as-delivered).
> Safe to delete. Do **not** execute it again — migration 005 is applied and checksummed, and
> re-running the steps would fail on the checksum guard, correctly.

**Deviations from the plan as written, all recorded in the roadmap:** `ledger_settings.cash_account_id`'s
composite FK uses `ON DELETE RESTRICT`, not the originally-considered `SET NULL` — a composite FK's
`SET NULL` nulls every column in the key, including this table's `NOT NULL` primary key `org_id`.
The dashboard's `position` exposes `currentEarningsCents` and `equationHolds` rather than a bare
`equityCents`, since Assets = Liabilities + Equity only holds once current-period earnings are
folded in by hand — this is not the Phase 4 balance sheet. The guardrail review also caught and
fixed a test gap: the cash-account-rejection test in `settings.test.ts` exercised `completeOnboarding`'s
ROLLBACK path (an organization rename followed by a downstream FK failure) without asserting the
rename actually rolled back — strengthened to assert the organization's name afterward.

Delete this file when it is no longer useful as a record. A stale plan file rots into the doc
drift that killed the previous build.

---

## Starting state — verified against the filesystem on 2026-09-02

**Built and relied on by this plan:**

- Migrations `001`–`004` applied. **Next prefix is `005`.** The runner (`server/src/db/migrate.ts`) asserts strictly sequential prefixes with no gaps, SHA-256 checksums every applied file, and refuses to start if an applied file changed. `MIGRATION_FILENAME = /^(\d{3})_[a-z0-9_-]+\.sql$/`.
- `organizations (id, name, slug, base_currency CHAR(3) DEFAULT 'USD', created_at, updated_at)`.
- `accounts (id, org_id, code, name, type, parent_id, is_postable, description, is_active, created_by, created_at, updated_at)` with `ux_accounts_org_code UNIQUE (org_id, code)`. **There is no `UNIQUE (org_id, id)` — Step 1 adds it.**
- `journal_entries`, `ledger_lines` with five triggers. Posted rows are immutable (`0A000`).
- Shared trigger function `set_updated_at()` from `001`. **Reuse it; do not define another.**
- `server/src/services/ledger-core/{accountService,journalService,reportService}.ts`; `services/{authService,organizationService,appService,healthService}.ts`.
- `organizationService.ts` exports `getById(orgId)` and `listMembers(orgId)` **only** — there is no update function.
- Routes mounted in `routes/ledger-core/index.ts`: `/accounts`, `/journals`, `/reports`. `reportRoutes.ts` has exactly one route (`GET /trial-balance`).
- `routes/organizations.ts` has `GET /` and `GET /members`. **No `PATCH`.**
- `utils/money.ts` (branded `Cents`, `parseCents`, `formatCents`), `utils/parseBody.ts`, `utils/requireUser.ts`, `utils/routeParam.ts`, `utils/apiError.ts`.
- `db/connect.ts` overrides the `DATE` type parser so `DATE` comes back as a `'YYYY-MM-DD'` string, never a `Date`.
- `config/apps.ts` — `ledger-core` is already `status: 'building'`. **No change needed there.**
- Client: `Pages/ledger-core/{LedgerCoreRoutes,AccountsPage,JournalEntryPage,TrialBalancePage,money}.tsx|ts`. `LedgerCoreRoutes` renders a horizontal `TABS` strip. `context/{AuthContext,OrgContext}.tsx`, `components/layout/{PlatformLayout,AppShell,OrgSwitcher}.tsx`.
- `client/src/services/fetchServices.ts` — `apiFetch<T>(path, init, options)`, `ApiRequestError`, and typed wrappers.
- **191 server tests, 27 client tests, all green.**

**Not built — this plan does not assume any of it:**

- No `ledger_settings` table, no org settings of any kind, no onboarding, no dashboard.
- No `fiscal_periods`, no period close/lock, no posting guard. **Phase 4 owns all of it.**
- No P&L, no balance sheet. Trial balance is the only report.
- No `PATCH /api/v1/organizations`.
- No client sidebar, no `Pages/ledger-core/{DashboardPage,SettingsPage,ReportsPage,OnboardingPage}.tsx`.
- No chart library. No `TodoWrite` tool in the executing session — **this file's numbered steps are the todo list.**

---

## Gate

- **Phase:** 3.5 — a half-step between the delivered Phase 3 and the unstarted Phase 4. It **renumbers nothing**. `docs/roadmap.md` fixes Phase 4 as four checkboxes with locked acceptance criteria; this work is none of them, and the roadmap's own renumbering entry is the precedent against letting a phase silently swell.
- **Prerequisite:** Phase 3 (LedgerCore GL core). **Verified built** — migrations 002–004 applied, services and routes present.
- **Blocked and deliberately excluded:** `fiscal_periods`, `EXCLUDE USING GIST`, `btree_gist`, close/lock FSM, closed-period posting rejection, P&L, balance sheet, AR/AP subledgers. All Phase 4. This plan stores a **fiscal-year setting** and derives windows from it in code. It creates **no period rows and no lock**.
- **No new npm dependency.** Rule 14. The trend chart is hand-rolled inline SVG.
- **Roadmap debt carried in:** none outstanding against Phase 3.

---

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

Anything this plan did not anticipate is a **stop-and-report**, not a judgment call.

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing `005` after it applied | A new `006` migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code — the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance assertion fails | An epsilon, a float, rounding | Integer cents equality (rule 3) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14) |
| "Let the user edit a posted entry" | Adding `PUT`/`DELETE` | `POST /:id/reverse` (rule 6) |
| Column missing at runtime | Adding it ad hoc in a service | Stop — a new migration, then update this plan |
| `exactOptionalPropertyTypes` complains | Making the field non-optional | Widen to `field?: T \| undefined` (see `accountService.updateAccount`) |

**TypeScript settings that will bite:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`), `noUnusedLocals`, `noUnusedParameters`. Server imports carry the `.js` extension — this is ESM and will not build without it. Client imports do not.

---

# Slice A — fiscal-year foundations

**Outcome:** the database can store a LedgerCore settings row, and pure code can turn a fiscal-year start into a dated window.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| App slug | `ledger-core` |
| Migration | `server/src/db/migrations/005_ledger-core_settings.sql` |
| Table | `ledger_settings` |
| Columns | `org_id, legal_name, fiscal_year_start_month, fiscal_year_start_day, books_start_date, industry, timezone, cash_account_id, onboarded_at, created_at, updated_at` |
| New constraint on `accounts` | `ux_accounts_org_id_id` |
| FK name | `fk_ledger_settings_cash_account` |
| Index | `idx_ledger_settings_cash_account` |
| Trigger | `trg_ledger_settings_updated_at` |
| Currency config | `server/src/config/currencies.ts` → `SUPPORTED_CURRENCIES`, `isSupportedCurrency` |
| Fiscal util | `server/src/utils/fiscalYear.ts` → `fiscalYearBounds`, `monthBounds`, `monthsBackStart` |

### Step 1 — migration `005_ledger-core_settings.sql`

- **Depends on:** nothing
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/002_ledger-core_accounts.sql` (comment density and idempotency style) and `004_ledger-core_journals.sql` (the `DROP TRIGGER IF EXISTS` idiom).
- **Files:** `server/src/db/migrations/005_ledger-core_settings.sql` (new)
- **Contract — write this SQL literally:**
  ```sql
  -- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, and migrations.test.ts
  -- replays every file against a populated database. The guard is what makes
  -- this replayable.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_accounts_org_id_id') THEN
      ALTER TABLE accounts ADD CONSTRAINT ux_accounts_org_id_id UNIQUE (org_id, id);
    END IF;
  END $$;

  CREATE TABLE IF NOT EXISTS ledger_settings (
    org_id                  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    legal_name              TEXT,
    fiscal_year_start_month SMALLINT NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    fiscal_year_start_day   SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_day BETWEEN 1 AND 28),
    books_start_date        DATE NOT NULL,
    industry                TEXT,
    timezone                TEXT NOT NULL DEFAULT 'UTC',
    cash_account_id         UUID,
    onboarded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_ledger_settings_cash_account
      FOREIGN KEY (org_id, cash_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_settings_cash_account
    ON ledger_settings (cash_account_id);

  CREATE OR REPLACE TRIGGER trg_ledger_settings_updated_at
    BEFORE UPDATE ON ledger_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  ```
  Decisions already made — do not revisit:
  - `org_id` is the **primary key**, not a separate `id`. Exactly one settings row per org, and it indexes the scope column for free.
  - **No backfill and no seed row.** Absence of the row *is* "not yet onboarded", which is the correct state for every existing organization. This is why `onboarded_at` is `NOT NULL` — the row exists only once onboarding completed.
  - `fiscal_year_start_day` is capped at **28** so a fiscal year can never start on a date absent from some month.
  - The FK is **composite** — `(org_id, cash_account_id) → accounts (org_id, id)`. A single-column FK would let an org point at another tenant's account with only a service check standing in the way. This is why `ux_accounts_org_id_id` exists.
  - `ON DELETE RESTRICT`, **not `SET NULL`**. A plain composite `SET NULL` would try to null `org_id` too, which is `NOT NULL`. Accounts are never deleted anyway (retired with `is_active = false`).
  - Composite FKs default to `MATCH SIMPLE`: with `cash_account_id` NULL the constraint is satisfied and not checked. That is exactly the wanted behaviour for an unset cash account.
  - Table name is **unprefixed** — LedgerCore is the system of record ([docs/schema.md](../docs/schema.md#table-naming-across-apps)).
- **Guardrails:** #8 every `*_id` has `REFERENCES` + explicit `ON DELETE`, and every FK used in a join is indexed · #13 sequential prefix, additive, idempotent, never edit an applied migration
- **Proof:**
  ```bash
  cd server && npm run migrate && npm run migrate
  ```
  Both runs exit 0; the second reports zero files applied. Then:
  ```bash
  npm test -- migrations
  ```
  green — that suite deletes `schema_migrations` and re-executes every file against a populated database, which is the real idempotency proof.
- **If it fails:** a checksum error means the file was edited after applying — **do not edit it further**; run `npm run db:reset && npm run migrate` in development, or write `006`. Never relax a CHECK to make a later step easier.
- **Owes:** `docs/schema.md` in Step 25.

### Step 2 — `config/currencies.ts`

- **Depends on:** nothing
- **Skill:** none (config file)
- **Read first:** `server/src/types/ledger-core.ts` lines 24–31 — copy the `as const` + narrowing-guard pattern used by `ACCOUNT_TYPES`.
- **Files:** `server/src/config/currencies.ts` (new)
- **Contract — write these literally:**
  ```ts
  export const SUPPORTED_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD',
    'JPY', 'SGD', 'AED', 'CHF', 'NZD', 'ZAR',
  ] as const;

  export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

  export function isSupportedCurrency(value: string): value is CurrencyCode {
    return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
  }
  ```
  Platform layer, unprefixed — currency lives on `organizations`. One source of truth feeding both the zod enum (Step 5) and the client select (Step 19).
- **Guardrails:** #4 — this is the whitelist that keeps a caller-supplied currency out of any query
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** fix the type. Do not widen `CurrencyCode` to `string`.
- **Owes:** nothing.

### Step 3 — `utils/fiscalYear.ts` + its unit test

- **Depends on:** nothing
- **Skill:** none (pure util); test tier is "unit" per [docs/testing.md](../docs/testing.md)
- **Read first:** `server/src/utils/money.ts` — same shape: pure, no DB import, exhaustively unit-tested.
- **Files:** `server/src/utils/fiscalYear.ts` (new), `server/src/__tests__/fiscalYear.test.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export interface FiscalYearBounds {
    startDate: string;  // 'YYYY-MM-DD'
    endDate: string;    // 'YYYY-MM-DD'
    label: string;
  }

  export function fiscalYearBounds(startMonth: number, startDay: number, on: string): FiscalYearBounds;
  export function monthBounds(on: string): { startDate: string; endDate: string };
  export function monthsBackStart(on: string, count: number): string;
  ```
  Algorithm, fixed:
  - Parse `on` by splitting the string on `-` and `Number()`-ing the parts. **Never `new Date(on)`** — that parses as local midnight and shifts the date at UTC+05:30. This is the exact bug `db/connect.ts`'s DATE parser already exists to prevent.
  - `fyStartYear = (month > startMonth) || (month === startMonth && day >= startDay) ? year : year - 1`.
  - `startDate = ${fyStartYear}-${pad2(startMonth)}-${pad2(startDay)}`.
  - `endDate` = one day before the next year's start: `new Date(Date.UTC(fyStartYear + 1, startMonth - 1, startDay) - 86_400_000).toISOString().slice(0, 10)`. Safe because `startDay <= 28`.
  - `label` = `FY ${fyStartYear}` when `startMonth === 1 && startDay === 1`, otherwise `FY ${fyStartYear}–${String(fyStartYear + 1).slice(2)}` (en dash, U+2013).
  - `monthsBackStart(on, count)` returns the first day of the month `count - 1` months before `on`'s month, via `Date.UTC`.
- **Test cases — write exactly these, with these expected values:**
  | Call | `startDate` | `endDate` | `label` |
  |---|---|---|---|
  | `fiscalYearBounds(1, 1, '2026-09-02')` | `2026-01-01` | `2026-12-31` | `FY 2026` |
  | `fiscalYearBounds(4, 1, '2026-09-02')` | `2026-04-01` | `2027-03-31` | `FY 2026–27` |
  | `fiscalYearBounds(4, 1, '2026-03-31')` | `2025-04-01` | `2026-03-31` | `FY 2025–26` |
  | `fiscalYearBounds(4, 1, '2026-04-01')` | `2026-04-01` | `2027-03-31` | `FY 2026–27` |
  | `fiscalYearBounds(3, 1, '2024-01-15')` | `2023-03-01` | `2024-02-29` | `FY 2023–24` |

  Plus: `monthBounds('2026-02-15')` → `{ startDate: '2026-02-01', endDate: '2026-02-28' }`; `monthsBackStart('2026-01-10', 6)` → `'2025-08-01'`.
- **Guardrails:** none specific — but no `Date` parsing of a `YYYY-MM-DD` string without `Date.UTC`.
- **Proof:** `cd server && npm test -- fiscalYear` — 7 assertions green.
- **If it fails:** an off-by-one day almost always means local-time parsing crept back in. Fix the parsing, never the expected value.
- **Owes:** nothing.

---

# Slice B — settings API

**Outcome:** an organization can complete LedgerCore onboarding once, read its settings back, and edit them, with tenancy enforced by the database.

Runs after Slice A. Steps 4–7 are strictly sequential; Steps 8–10 (tests + platform route) may follow in any order once 7 is green.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Types | `LedgerSettings`, `OnboardingInput`, `UpdateSettingsInput` in `server/src/types/ledger-core.ts` |
| Schemas | `server/src/schemas/ledger-core/settingsSchema.ts` → `onboardingSchema`, `updateSettingsSchema` |
| | `server/src/schemas/organizationSchema.ts` → `updateOrganizationSchema` |
| Service | `server/src/services/ledger-core/settingsService.ts` → `getSettings`, `completeOnboarding`, `updateSettings` |
| | `server/src/services/organizationService.ts` → **add** `updateOrganization` |
| Controller | `server/src/controllers/ledger-core/settingsController.ts` → `get`, `onboard`, `update` |
| | `server/src/controllers/organizationController.ts` → **add** `update` |
| Routes | `server/src/routes/ledger-core/settingsRoutes.ts` |
| Route base | `/api/v1/ledger-core/settings` |
| Tests | `server/src/__tests__/ledger-core/settings.test.ts` |

### Step 4 — types

- **Depends on:** Step 2
- **Skill:** `new-module` (types layer)
- **Read first:** `server/src/types/ledger-core.ts` in full — append, do not restructure.
- **Files:** `server/src/types/ledger-core.ts` (edit — append at the end)
- **Contract — write these literally:**
  ```ts
  export interface FiscalYearWindow {
    startDate: string;
    endDate: string;
    label: string;
  }

  export interface LedgerSettings {
    organizationName: string;
    legalName: string | null;
    baseCurrency: string;
    fiscalYearStartMonth: number;
    fiscalYearStartDay: number;
    booksStartDate: string;
    industry: string | null;
    timezone: string;
    cashAccountId: string | null;
    /** `null` when the wizard has never been completed for this organization. */
    onboardedAt: string | null;
    currentFiscalYear: FiscalYearWindow;
    /** `true` once any ledger line exists — base currency can no longer change. */
    baseCurrencyLocked: boolean;
  }
  ```
- **Guardrails:** #3 — there are no money fields here; if you find yourself adding one it is `*Cents: number`
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** fix the type.
- **Owes:** nothing.

### Step 5 — zod schemas

- **Depends on:** Steps 2, 4
- **Skill:** `new-module` (schema layer)
- **Read first:** `server/src/schemas/ledger-core/accountSchema.ts` — copy its zod **v4** idioms exactly (`z.uuid()`, `z.int()`, `z.iso.date()`, **not** `z.string().uuid()`), and its `.refine` on the update schema.
- **Files:** `server/src/schemas/ledger-core/settingsSchema.ts` (new), `server/src/schemas/organizationSchema.ts` (new)
- **Contract — write these literally:**
  ```ts
  // settingsSchema.ts
  export const onboardingSchema = z.object({
    organizationName:     z.string().trim().min(2).max(120),
    legalName:            z.string().trim().max(200).nullable().default(null),
    baseCurrency:         z.enum(SUPPORTED_CURRENCIES),
    fiscalYearStartMonth: z.int().min(1).max(12),
    fiscalYearStartDay:   z.int().min(1).max(28).default(1),
    booksStartDate:       z.iso.date(),
    industry:             z.string().trim().max(80).nullable().default(null),
    timezone:             z.string().trim().max(64).default('UTC'),
    cashAccountId:        z.uuid().nullable().default(null),
  });

  export const updateSettingsSchema = z.object({
    legalName:            z.string().trim().max(200).nullable().optional(),
    fiscalYearStartMonth: z.int().min(1).max(12).optional(),
    fiscalYearStartDay:   z.int().min(1).max(28).optional(),
    booksStartDate:       z.iso.date().optional(),
    industry:             z.string().trim().max(80).nullable().optional(),
    timezone:             z.string().trim().max(64).optional(),
    cashAccountId:        z.uuid().nullable().optional(),
  }).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

  // organizationSchema.ts
  export const updateOrganizationSchema = z.object({
    name:         z.string().trim().min(2).max(120).optional(),
    baseCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
  }).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
  ```
  `organizationName` and `baseCurrency` are on the **onboarding** schema but not on `updateSettingsSchema` — after onboarding they are edited through `PATCH /organizations` (Step 8), because they are platform fields.
- **Guardrails:** #12 account types untouched · #4 the currency enum is the whitelist
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** if zod rejects `z.int()` or `z.iso.date()`, you are reading v3 docs — this project is on zod v4. Check `accountSchema.ts` for the working form.
- **Owes:** nothing.

### Step 6 — `organizationService.updateOrganization`

- **Depends on:** Step 5
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/accountService.ts` → `updateAccount` — copy the **frozen `COLUMNS` map** dynamic-`SET` builder verbatim. `server/src/services/authService.ts` lines 31–32 for the `Queryable` type.
- **Files:** `server/src/services/organizationService.ts` (edit — add one export plus the `Queryable` type)
- **Contract — write this literally:**
  ```ts
  type Queryable = Pick<PoolClient, 'query'>;

  export async function updateOrganization(
    orgId: string,
    input: { name?: string | undefined; baseCurrency?: string | undefined },
    q: Queryable = pool,
  ): Promise<OrganizationSummary>;
  ```
  - Column map is frozen and local: `{ name: 'name', baseCurrency: 'base_currency' } as const`. **Never build `SET` from `Object.keys(input)` of the request.**
  - `UPDATE organizations SET ... WHERE id = $1 RETURNING id, name, slug, base_currency, created_at`.
  - No rows → `throw new ApiError(404, 'Organization not found')`.
  - No assignments → `throw new ApiError(400, 'No fields to update')`.
  - `.trim()` the returned `base_currency` (`CHAR(3)` is blank-padded), matching `getById`.
  - The `q` parameter defaulting to `pool` is what lets Step 7 call this **inside its transaction**. Rule 5: a stray `pool.query` there would commit independently.
- **Guardrails:** #1 `WHERE id = $1` from the token's `orgId` only · #2 no `req`/`res` in this file · #4 parameterized; identifiers from the frozen map · #5 the `q` parameter exists for the transaction case
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -n "base_currency" server/src/services/organizationService.ts` shows it only inside SQL strings and the frozen map.
- **If it fails:** fix the type. Do not make `q` `any`.
- **Owes:** nothing.

### Step 7 — `settingsService.ts`

- **Depends on:** Steps 1, 3, 4, 6
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/authService.ts` → `register` (lines 243–315) for the exact `BEGIN`/`COMMIT`/`ROLLBACK`/`release` shape and the service-to-service call on the shared client; `accountService.ts` → `getAccountById` for `ApiError` usage.
- **Files:** `server/src/services/ledger-core/settingsService.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export async function getSettings(orgId: string): Promise<LedgerSettings>;
  export async function completeOnboarding(orgId: string, input: OnboardingInput): Promise<LedgerSettings>;
  export async function updateSettings(orgId: string, input: UpdateSettingsInput): Promise<LedgerSettings>;
  ```
  **`getSettings`** — one query, `LEFT JOIN` so a missing settings row is not a 404:
  ```sql
  SELECT o.name AS organization_name, o.base_currency, o.created_at AS org_created_at,
         s.legal_name, s.fiscal_year_start_month, s.fiscal_year_start_day,
         s.books_start_date, s.industry, s.timezone, s.cash_account_id, s.onboarded_at,
         EXISTS (SELECT 1 FROM ledger_lines l WHERE l.org_id = o.id) AS has_lines
    FROM organizations o
    LEFT JOIN ledger_settings s ON s.org_id = o.id
   WHERE o.id = $1
  ```
  No `organizations` row → `ApiError(404, 'Organization not found')`. Settings columns all NULL → return `onboardedAt: null` with defaults: `fiscalYearStartMonth: 1`, `fiscalYearStartDay: 1`, `booksStartDate` = the org's `created_at` date (`toISOString().slice(0, 10)`), `industry: null`, `timezone: 'UTC'`, `cashAccountId: null`, `legalName: null`. `baseCurrencyLocked = has_lines`. `currentFiscalYear = fiscalYearBounds(month, day, todayUtc())` where `todayUtc()` is `new Date().toISOString().slice(0, 10)`.

  **`completeOnboarding`** — one `BEGIN…COMMIT` on one checked-out `client`:
  1. `await client.query('BEGIN')`
  2. Guard the currency: `SELECT EXISTS (SELECT 1 FROM ledger_lines WHERE org_id = $1)`. If it is `true` **and** the requested `baseCurrency` differs from the org's current one → `throw new ApiError(422, 'Base currency cannot be changed once journal entries exist')`. Identical code, or no lines, is fine.
  3. `await updateOrganization(orgId, { name: input.organizationName, baseCurrency: input.baseCurrency }, client)` — **`client`, never `pool`** (rule 5).
  4. Upsert:
     ```sql
     INSERT INTO ledger_settings
       (org_id, legal_name, fiscal_year_start_month, fiscal_year_start_day,
        books_start_date, industry, timezone, cash_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id) DO UPDATE SET
       legal_name = EXCLUDED.legal_name,
       fiscal_year_start_month = EXCLUDED.fiscal_year_start_month,
       fiscal_year_start_day = EXCLUDED.fiscal_year_start_day,
       books_start_date = EXCLUDED.books_start_date,
       industry = EXCLUDED.industry,
       timezone = EXCLUDED.timezone,
       cash_account_id = EXCLUDED.cash_account_id
     ```
     Upsert, not insert-or-409: a double-submit from the wizard must be harmless.
  5. `COMMIT`, then `return getSettings(orgId)`.
  6. `catch → ROLLBACK; throw`, `finally → client.release()`.

  **Error mapping** — catch the Postgres error and rethrow, matching `journalService`'s style:
  - `23503` with `constraint === 'fk_ledger_settings_cash_account'` → `ApiError(422, 'Cash account does not exist in this organization')`
  - `23514` → `ApiError(422, <pg message>)`

  **`updateSettings`** — no transaction needed (single table). `UPDATE ledger_settings SET ... WHERE org_id = $1` built from a frozen `COLUMNS` map exactly as in Step 6. Zero rows affected → `ApiError(409, 'Complete LedgerCore onboarding before changing settings')`. Then `return getSettings(orgId)`.
- **Guardrails:** #1 `org_id` predicate in **every** statement; `orgId` comes only from the token · #2 no SQL leaves this file into a controller · #4 parameterized, identifiers from a frozen map · #5 every statement inside `completeOnboarding` uses `client` · #16 `organizations` is a **platform** table, so calling `organizationService` is legal; this file must not read `ap_flow_*` or any other app's tables
- **Proof:**
  ```bash
  cd server && npm run typecheck                    # exits 0
  grep -c "pool.query" src/services/ledger-core/settingsService.ts   # must be 0 inside completeOnboarding
  ```
  Behaviour is proved by Step 9.
- **If it fails:** a `23505`/`23503` you did not expect means the fixture is wrong, not the constraint. **Never drop the `org_id` predicate to make a query return rows.**
- **Owes:** `docs/api.md` in Step 25; the composite-FK study note in Step 24.

### Step 8 — controllers and routes (LedgerCore settings + platform `PATCH /organizations`)

- **Depends on:** Steps 5, 6, 7
- **Skill:** `new-module` (controller + route layers)
- **Read first:** `server/src/controllers/ledger-core/accountController.ts` (the `requireUser` → `parseBody` → service → `res.json` shape) and `server/src/routes/ledger-core/accountRoutes.ts` (the `requireRole` placement).
- **Files:**
  - `server/src/controllers/ledger-core/settingsController.ts` (new)
  - `server/src/routes/ledger-core/settingsRoutes.ts` (new)
  - `server/src/routes/ledger-core/index.ts` (edit — add `router.use('/settings', settingsRoutes)`)
  - `server/src/controllers/organizationController.ts` (edit — add `update`)
  - `server/src/routes/organizations.ts` (edit — add the `PATCH /` route)
- **Contract — the route table, literally:**
  | Method | Path | Middleware | Success | Body key |
  |---|---|---|---|---|
  | GET | `/api/v1/ledger-core/settings` | `authenticate` | `200` | `{ success: true, settings }` |
  | POST | `/api/v1/ledger-core/settings/onboarding` | `authenticate`, `requireRole('OWNER', 'ADMIN')` | `200` | `{ success: true, settings }` |
  | PATCH | `/api/v1/ledger-core/settings` | `authenticate`, `requireRole('OWNER', 'ADMIN')` | `200` | `{ success: true, settings }` |
  | PATCH | `/api/v1/organizations` | `authenticate`, `requireRole('OWNER', 'ADMIN')` | `200` | `{ success: true, organization }` |

  Onboarding returns **200, not 201** — it is an idempotent upsert, not a creation. `OWNER`/`ADMIN` and **not** `ACCOUNTANT`: this is organization configuration, matching `/organizations/members`, not bookkeeping. `GET` is open to any member, including `VIEWER`, matching `reportRoutes.ts`.

  Controller bodies are three lines each, e.g.:
  ```ts
  export const onboard: RequestHandler = async (req, res) => {
    const user = requireUser(req);
    const input = parseBody(onboardingSchema, req.body);
    const settings = await settingsService.completeOnboarding(user.orgId, input);
    res.json({ success: true, settings });
  };
  ```
  Failure statuses come from the layers that already own them: `400` from `parseBody`, `401` from `authenticate`, `403` from `requireRole`, `422` from the service. **Never hand-roll an error response** — `errorHandler.ts` formats all of them.
- **Guardrails:** #1 `user.orgId` from `requireUser(req)` **only** — never `req.body.orgId`, `req.query.orgId` or an `X-Org-Id` header · #2 zero SQL in these files · #16 the slug is a namespace, not a boundary
- **Proof:**
  ```bash
  cd server && npm run typecheck   # exits 0
  grep -rn "pool\|query(" src/controllers/ledger-core/settingsController.ts   # no matches
  ```
- **If it fails:** if a route 404s, check the mount line in `routes/ledger-core/index.ts` — nothing mounts on `app.ts` directly.
- **Owes:** `docs/api.md` in Step 25.

### Step 9 — settings integration + isolation tests

- **Depends on:** Step 8
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ledger-core/accounts.test.ts` (fixture setup, `loginAgent`) and `server/src/__tests__/tenantIsolation.test.ts` (the forged-`orgId` assertions).
- **Files:** `server/src/__tests__/ledger-core/settings.test.ts` (new), `server/src/__tests__/helpers/factories.ts` (edit)
- **Contract — write exactly these cases with these expected values:**

  Factories edit: add `ledger_settings` to the `resetTables()` `TRUNCATE` list. It cascades from `organizations`, but the list is the documented contract and the next table may not cascade.

  | Case | Expected |
  |---|---|
  | `GET /settings` on a fresh org | `200`, `settings.onboardedAt === null`, `fiscalYearStartMonth === 1`, `baseCurrencyLocked === false` |
  | `POST /settings/onboarding` with `{organizationName:'Acme Books', baseCurrency:'INR', fiscalYearStartMonth:4, booksStartDate:'2026-04-01'}` | `200`, `settings.onboardedAt !== null`, `currentFiscalYear.startDate === '2026-04-01'` |
  | `GET /settings` after onboarding | `200`, values persist; `GET /organizations` shows `name === 'Acme Books'` and `baseCurrency === 'INR'` |
  | `POST /settings/onboarding` a **second** time | `200`, no error, values overwritten (idempotent) |
  | `POST /settings/onboarding` as a `VIEWER` | `403` |
  | `POST /settings/onboarding` as an `ACCOUNTANT` | `403` |
  | `PATCH /settings` with `{}` | `400` |
  | `PATCH /settings` with `fiscalYearStartMonth: 13` | `400` |
  | `POST /settings/onboarding` with `baseCurrency: 'XYZ'` | `400` |
  | Post a journal entry, then onboard with a **different** currency | `422`, message matches `/base currency/i` |
  | Post a journal entry, then onboard with the **same** currency | `200` |
  | `POST /settings/onboarding` with org B's `cashAccountId` under org A's token | `422`, message matches `/cash account/i` |
  | Insert a `ledger_settings` row via raw `pool` with a foreign-org `cash_account_id` | SQLSTATE **`23503`** — assert the code, not the message |
  | `PATCH /settings` before onboarding | `409` |

  **`describe('cross-tenant isolation')`** with the mandated three-user fixture — **user A** in org A only, **user C** in org B only, **user B in both**:
  - A onboards org A as `'Alpha Books'`; C onboards org B as `'Beta Books'`.
  - `GET /settings` as A → `organizationName === 'Alpha Books'`; as C → `'Beta Books'`.
  - As A, `GET /settings?orgId=<orgB>` with header `X-Org-Id: <orgB>` **and** a body field `orgId: <orgB>` → response **text is byte-identical** to the honest request (`expect(forged.text).toBe(honest.text)`).
  - B switches org via `POST /auth/switch-org` and sees `'Beta Books'` — proving the active org comes from the re-issued token.
- **Guardrails:** #15 a module without a cross-tenant test is not done
- **Proof:** `cd server && npm test -- settings` — all cases green. Then `npm test` — the full suite still green, **191 + new**, with **no pre-existing test modified**.
- **If it fails:** if the isolation case passes trivially, check that user B actually belongs to both orgs — that fixture is the one people leave out. **Never delete or weaken an assertion to get green.**
- **Owes:** nothing.

---

# Slice C — dashboard API

**Outcome:** one authenticated request returns every number the LedgerCore dashboard renders, aggregated from raw `ledger_lines`.

Runs after Slice B (it reads `ledger_settings`).

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Types | `DashboardSummary`, `TrendPoint` in `server/src/types/ledger-core.ts` |
| Service | `server/src/services/ledger-core/dashboardService.ts` → `dashboardSummary` |
| Controller export | `server/src/controllers/ledger-core/reportController.ts` → **add** `dashboard` |
| Route | `GET /api/v1/ledger-core/reports/dashboard` |
| Test | `server/src/__tests__/ledger-core/dashboard.test.ts` |

### Step 10 — dashboard types

- **Depends on:** Step 4
- **Skill:** `new-module` (types layer)
- **Read first:** `server/src/types/ledger-core.ts` → `TrialBalance` for the money-field naming convention.
- **Files:** `server/src/types/ledger-core.ts` (edit — append)
- **Contract — write these literally:**
  ```ts
  export interface TrendPoint {
    month: string;            // 'YYYY-MM'
    revenueCents: number;
    expenseCents: number;
  }

  export interface DashboardSummary {
    asOf: string;
    fiscalYear: FiscalYearWindow;
    position: {
      assetsCents: number;
      liabilitiesCents: number;
      equityCents: number;
      /** Revenue − Expenses over all time. Equity accounts alone do not balance the equation. */
      currentEarningsCents: number;
      /** `null` when no cash account is configured in settings. */
      cashCents: number | null;
      /** assets === liabilities + equity + currentEarnings. Integer equality. */
      equationHolds: boolean;
    };
    performance: {
      yearToDate:   { revenueCents: number; expenseCents: number; netIncomeCents: number };
      currentMonth: { revenueCents: number; expenseCents: number; netIncomeCents: number };
    };
    activity: { entryCountYtd: number; recentEntries: JournalEntry[] };
    integrity: { totalDebitCents: number; totalCreditCents: number; isBalanced: boolean };
    trend: TrendPoint[];   // exactly 6, oldest first
  }
  ```
  `currentEarningsCents` is deliberate: Assets = Liabilities + Equity only holds once current-period earnings are folded in. Exposing it separately keeps the dashboard honest **without** claiming to be the Phase 4 balance sheet.
- **Guardrails:** #3 every money field is `*Cents: number`
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** fix the type.
- **Owes:** nothing.

### Step 11 — `dashboardService.ts`

- **Depends on:** Steps 3, 7, 10
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/reportService.ts` in full — copy its `::text` + `parseCents` handling, its `base_*`-only rule, and its file-header comment about there being no summary table. `accountService.ts`'s `WITH RECURSIVE` block for the CTE shape.
- **Files:** `server/src/services/ledger-core/dashboardService.ts` (new)
- **Contract — write this signature literally:**
  ```ts
  export async function dashboardSummary(orgId: string, asOf: string | null): Promise<DashboardSummary>;
  ```
  Resolve first: `const settings = await getSettings(orgId)`; `const on = asOf ?? new Date().toISOString().slice(0, 10)`; `const fy = fiscalYearBounds(settings.fiscalYearStartMonth, settings.fiscalYearStartDay, on)`; `const month = monthBounds(on)`; `const trendFrom = monthsBackStart(on, 6)`.

  Then four reads via `Promise.all` — all `pool.query`, no transaction (reads only, rule 5 does not apply):

  **(a) Position + performance — one scan, aggregate `FILTER`:**
  ```sql
  SELECT
    COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Asset'),     0)::text AS assets,
    COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Liability'), 0)::text AS liabilities,
    COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Equity'),    0)::text AS equity,
    COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue'),   0)::text AS revenue_all,
    COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense'),   0)::text AS expense_all,
    COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $2::date), 0)::text AS revenue_ytd,
    COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense' AND e.entry_date >= $2::date), 0)::text AS expense_ytd,
    COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $3::date), 0)::text AS revenue_month,
    COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense' AND e.entry_date >= $3::date), 0)::text AS expense_month,
    COUNT(DISTINCT e.id) FILTER (WHERE e.entry_date >= $2::date)::text AS entry_count_ytd
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
  JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
  WHERE l.org_id = $1
    AND e.entry_date <= $4::date
  ```
  Params `[orgId, fy.startDate, month.startDate, on]`. Sign convention is `isDebitBalanceType` from `types/ledger-core.ts` — debit-positive for Asset and Expense, credit-positive otherwise, exactly as `trialBalance` already does it.

  **(b) Cash — recursive descendant walk.** Skip entirely and return `null` when `settings.cashAccountId === null`.
  ```sql
  WITH RECURSIVE subtree AS (
    SELECT id FROM accounts WHERE org_id = $1 AND id = $2
    UNION ALL
    SELECT a.id FROM accounts a JOIN subtree s ON a.parent_id = s.id WHERE a.org_id = $1
  )
  SELECT COALESCE(SUM(l.base_debit_cents - l.base_credit_cents), 0)::text AS cash
    FROM ledger_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
   WHERE l.org_id = $1
     AND l.account_id IN (SELECT id FROM subtree)
     AND e.entry_date <= $3::date
  ```
  `org_id = $1` appears in **both** the anchor and the recursive term. Omitting it from the recursive term is a cross-tenant leak through the tree.

  **(c) Integrity:**
  ```sql
  SELECT COALESCE(SUM(base_debit_cents), 0)::text  AS d,
         COALESCE(SUM(base_credit_cents), 0)::text AS c
    FROM ledger_lines WHERE org_id = $1
  ```
  `isBalanced = d === c` — **integer equality, never an epsilon** (rule 3).

  **(d) Trend — `generate_series` gap-filled, always 6 rows:**
  ```sql
  WITH months AS (
    SELECT generate_series($2::date, $3::date, INTERVAL '1 month')::date AS month_start
  )
  SELECT to_char(m.month_start, 'YYYY-MM') AS month,
         COALESCE(SUM(l.base_credit_cents - l.base_debit_cents) FILTER (WHERE a.type = 'Revenue'), 0)::text AS revenue,
         COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense'), 0)::text AS expense
    FROM months m
    LEFT JOIN journal_entries e ON e.org_id = $1
                              AND e.entry_date >= m.month_start
                              AND e.entry_date <  (m.month_start + INTERVAL '1 month')::date
    LEFT JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = e.org_id
    LEFT JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
   GROUP BY m.month_start
   ORDER BY m.month_start ASC
  ```
  Params `[orgId, trendFrom, month.startDate]`. The `org_id` predicate sits in the **JOIN condition**, not the `WHERE` — moving it to `WHERE` silently turns the `LEFT JOIN` into an `INNER JOIN` and drops every empty month. `reportService.trialBalance` carries the same warning for the same reason.

  Recent entries: `const { entries } = await journalService.listEntries(orgId, { page: 1, limit: 5 })`. **No new SQL for this.**

  Every `::text` result goes through `parseCents`. Derived values: `netIncomeCents = revenueCents - expenseCents`; `currentEarningsCents = revenue_all - expense_all`; `equationHolds = assets === liabilities + equity + currentEarnings`.

  **Add a file-header comment** stating that nothing here is cached and no summary table exists — `docs/schema.md`, `docs/ledger-core.md` and `reports.test.ts` each assert this independently.
- **Guardrails:** #1 `org_id` in every statement and in both terms of the recursive CTE · #2 no SQL escapes to a controller · #3 integer cents, integer equality · #4 parameterized only · #16 reads only LedgerCore + platform tables
- **Proof:** `cd server && npm run typecheck` exits 0. Behaviour proved by Step 13.
- **If it fails:** if the trend returns fewer than 6 rows, an `org_id` predicate has migrated into the `WHERE`. **Do not fill the gap in JavaScript** — fix the join.
- **Owes:** the `generate_series`/`FILTER` study note in Step 24.

### Step 12 — dashboard controller + route

- **Depends on:** Step 11
- **Skill:** `new-module` (controller + route layers)
- **Read first:** `server/src/controllers/ledger-core/reportController.ts` in full — reuse its `ISO_DATE` regex and `asOf` parsing verbatim.
- **Files:** `server/src/controllers/ledger-core/reportController.ts` (edit — add `dashboard`), `server/src/routes/ledger-core/reportRoutes.ts` (edit — add one line)
- **Contract:**
  | Method | Path | Middleware | Success |
  |---|---|---|---|
  | GET | `/api/v1/ledger-core/reports/dashboard?asOf=YYYY-MM-DD` | `authenticate` | `200` |

  ```ts
  router.get('/dashboard', authenticate, reportController.dashboard);
  ```
  Response spreads the summary at the top level, matching the `trial-balance` precedent:
  ```ts
  res.json({ success: true, ...summary });
  ```
  A malformed `asOf` → `ApiError(400, 'asOf must be a date in YYYY-MM-DD format')` — the same message the existing handler uses. No `requireRole`: a `VIEWER` exists precisely to read reports.
- **Guardrails:** #1 `requireUser(req).orgId` only · #2 zero SQL
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** if the route 404s, confirm the line landed in `reportRoutes.ts` and not a new file.
- **Owes:** `docs/api.md` in Step 25.

### Step 13 — dashboard integration + isolation tests

- **Depends on:** Step 12
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ledger-core/reports.test.ts` — copy its fixture-posting helper and its assertion style.
- **Files:** `server/src/__tests__/ledger-core/dashboard.test.ts` (new)
- **Contract — write exactly these cases:**
  | Case | Expected |
  |---|---|
  | Fresh org, no postings | `200`, every `*Cents` is `0`, `trend.length === 6`, `integrity.isBalanced === true` |
  | Onboard with `fiscalYearStartMonth: 4`, post an entry dated inside the FY and one before it | `performance.yearToDate` includes only the in-window entry |
  | Post `Dr 1110 Operating Cash 100000 / Cr 4100 Product Revenue 100000` | `position.assetsCents === 100000`, `performance.yearToDate.revenueCents === 100000`, `netIncomeCents === 100000` |
  | Same fixture | `position.equationHolds === true` |
  | Same fixture | `integrity.totalDebitCents === integrity.totalCreditCents`, `isBalanced === true` |
  | No `cashAccountId` configured | `position.cashCents === null` |
  | `cashAccountId` set to the `1100 Current Assets` **header** | `cashCents` sums the whole subtree, i.e. `100000` — proves the recursive walk |
  | Entries in only 2 of the last 6 months | `trend.length === 6`; the 4 empty months are present with `0`, not absent |
  | `?asOf=` a date before the entry | that entry excluded from `position` and `performance` |
  | `?asOf=not-a-date` | `400` |
  | As a `VIEWER` | `200` — reports are readable by every member |

  **`describe('cross-tenant isolation')`** with the A / B-in-both / C fixture: post different amounts in org A and org B; assert A's dashboard reports only A's totals; assert a forged `orgId` in query + `X-Org-Id` header + body yields a **byte-identical** response to the honest one.
- **Guardrails:** #15 · #3 assert exact integers, never `toBeCloseTo`
- **Proof:** `cd server && npm test -- dashboard` green, then `cd server && npm test` — whole suite green with no pre-existing test edited.
- **If it fails:** a wrong-signed tile means the debit/credit orientation for that account type is flipped — check against `isDebitBalanceType`, not against the expected value.
- **Owes:** nothing.

---

# Slice D — client shell, gate and onboarding wizard

**Outcome:** a newly registered user who picks LedgerCore is sent to a wizard, completes it once, and never sees it again.

Runs after Slice B. Step 14 may run in parallel with Slice C.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| API wrappers | `getLedgerSettings`, `completeLedgerOnboarding`, `updateLedgerSettings`, `getLedgerDashboard`, `updateOrganization` in `client/src/services/fetchServices.ts` |
| Context | `client/src/Pages/ledger-core/LedgerSettingsContext.tsx` → `LedgerSettingsProvider`, `useLedgerSettings` |
| Sidebar | `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` |
| Pages | `OnboardingPage.tsx`, `DashboardPage.tsx`, `SettingsPage.tsx`, `ReportsPage.tsx`, `TrendChart.tsx` — all in `client/src/Pages/ledger-core/` |
| Client util | `client/src/Pages/ledger-core/fiscalYear.ts` |
| Routes | `''` → Dashboard · `accounts` · `journals` · `trial-balance` · `reports` · `settings` · `onboarding` |

### Step 14 — API client wrappers

- **Depends on:** Steps 8, 12
- **Skill:** none (client service layer)
- **Read first:** `client/src/services/fetchServices.ts` in full — match the existing wrapper signatures exactly, including `signal?: AbortSignal` passed as `signal ?? null`.
- **Files:** `client/src/services/fetchServices.ts` (edit — append types and functions)
- **Contract — write these literally:**
  ```ts
  export interface FiscalYearWindow { startDate: string; endDate: string; label: string }
  export interface LedgerSettings { /* mirror server LedgerSettings exactly */ }
  export interface OnboardingInput { /* mirror the server onboardingSchema output */ }
  export interface TrendPoint { month: string; revenueCents: number; expenseCents: number }
  export interface DashboardSummary { /* mirror server DashboardSummary exactly */ }

  export async function getLedgerSettings(signal?: AbortSignal): Promise<LedgerSettings>;
  export async function completeLedgerOnboarding(input: OnboardingInput): Promise<LedgerSettings>;
  export async function updateLedgerSettings(input: Partial<OnboardingInput>): Promise<LedgerSettings>;
  export async function getLedgerDashboard(asOf?: string | null, signal?: AbortSignal): Promise<DashboardSummary>;
  export async function updateOrganization(input: { name?: string; baseCurrency?: string }): Promise<OrganizationSummary>;
  ```
  Paths: `/ledger-core/settings`, `/ledger-core/settings/onboarding`, `/ledger-core/reports/dashboard`, `/organizations`. `getLedgerSettings` unwraps `body.settings`; `getLedgerDashboard` returns the spread body minus `success`. **Do not** pass `NO_AUTO_REFRESH` — these are authenticated calls that must survive a token refresh.
- **Guardrails:** none server-side; keep types in lockstep with `server/src/types/ledger-core.ts`
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** fix the type. Do not use `any` to bridge a mismatch — a mismatch means the server contract was misread.
- **Owes:** nothing.

### Step 15 — settings context

- **Depends on:** Step 14
- **Skill:** none (React context)
- **Read first:** `client/src/context/AuthContext.tsx` — copy its discriminated-union state, its `ignore`-flag effect, and its `applySession` escape hatch. `client/src/services/fetchServices.ts` lines 79–88 explain why this project uses an `ignore` flag rather than `AbortSignal` in components.
- **Files:** `client/src/Pages/ledger-core/LedgerSettingsContext.tsx` (new)
- **Contract — write these literally:**
  ```ts
  export type LedgerSettingsState =
    | { status: 'loading' }
    | { status: 'ready'; settings: LedgerSettings }
    | { status: 'error'; message: string };

  export function LedgerSettingsProvider({ children }: { children: ReactNode }): JSX.Element;
  export function useLedgerSettings(): LedgerSettingsState & {
    refresh: () => Promise<void>;
    applySettings: (settings: LedgerSettings) => void;
  };
  ```
  Fetches once on mount with an `ignore` flag. `applySettings` lets the wizard and settings form update in place with the server's response instead of refetching — the same trick as `AuthContext.applySession`.
- **Guardrails:** none
- **Proof:** `cd client && npm run typecheck` exits 0.
- **If it fails:** fix the type.
- **Owes:** the React study-note extension in Step 24.

### Step 16 — client fiscal-year mirror

- **Depends on:** nothing
- **Skill:** none (pure util)
- **Read first:** `server/src/utils/fiscalYear.ts` from Step 3 — port it, do not redesign it.
- **Files:** `client/src/Pages/ledger-core/fiscalYear.ts` (new), `client/src/__tests__/ledgerCoreFiscalYear.test.ts` (new)
- **Contract:** export `fiscalYearBounds(startMonth, startDay, on)` with the identical algorithm and the identical label rule. It exists so the wizard can show the derived end date live without a round trip.
- **Test cases:** the same five rows from Step 3's table.
- **Guardrails:** no local-time `Date` parsing of a `YYYY-MM-DD` string
- **Proof:** `cd client && npm test -- ledgerCoreFiscalYear` green.
- **If it fails:** an off-by-one day means local-time parsing. Fix the parsing.
- **Owes:** nothing.

### Step 17 — sidebar + route table + onboarding gate

- **Depends on:** Steps 15, 16
- **Skill:** none (client routing)
- **Read first:** `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` in full (the `TABS` + `NavLink` idiom you are extending) and `client/src/components/layout/AppShell.tsx` (the `.skeleton` loading treatment to match).
- **Files:**
  - `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` (new)
  - `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` (rewrite)
  - `client/src/index.css` (edit — one rule)
- **Contract — the route table, literally:**
  ```
  ''              → DashboardPage
  'accounts'      → AccountsPage         (moved off the index route)
  'journals'      → JournalEntryPage     (unchanged component)
  'trial-balance' → TrialBalancePage     (unchanged component)
  'reports'       → ReportsPage
  'settings'      → SettingsPage
  'onboarding'    → OnboardingPage       (rendered WITHOUT the sidebar)
  '*'             → <Navigate to="" replace />
  ```
  `NAV` array, replacing `TABS`, same `{ to, label, icon, end }` shape, lucide icons: `LayoutDashboard`, `ListTree`, `BookOpen`, `Scale`, `FileBarChart`, `Settings`. Icons render as `<Icon size={16} aria-hidden="true" />`, matching every existing usage.

  **Gate**, evaluated in `LedgerCoreRoutes` inside `LedgerSettingsProvider`:
  - `status === 'loading'` → the existing `.skeleton` markup plus `<span className="visually-hidden">Loading LedgerCore…</span>`
  - `status === 'error'` → an inline error, no redirect
  - `settings.onboardedAt === null` and the current subpath is not `onboarding` → `<Navigate to="onboarding" replace />`
  - `settings.onboardedAt !== null` and the subpath **is** `onboarding` → `<Navigate to="" replace />`

  Layout: `grid grid-cols-[13rem_1fr] gap-6` above `md`; below `md` the sidebar becomes a horizontally scrolling row. Tailwind arbitrary values over the existing tokens — `var(--panel)`, `var(--border)`, `var(--text)`, `var(--muted)`. **Do not introduce new CSS custom properties.**

  `index.css` — one rule. `.app-main` is capped at `64rem` and centred, which strangles a sidebar. Widen it for app routes only, with no route coupling in JS:
  ```css
  .app-main:has(.app-shell) { max-width: 90rem; }
  ```

  Add a comment recording that `PlatformLayout`'s `key={org.id}-${orgVersion}` remount is **load-bearing here**: switching organization re-runs the gate, so an org that has not onboarded correctly gets the wizard. Nobody should "optimise" it away.
- **Guardrails:** #16 — LedgerCore owns its own internal routing; do not register these paths in `App.tsx`
- **Proof:** `cd client && npm run typecheck` exits 0 and `npm run build` succeeds. Manually: `/app/ledger-core/journals` still renders the existing journal page.
- **If it fails:** if every nav item highlights at once, the `end` flag is wrong on the index entry — it must be `true` there and `false` elsewhere.
- **Owes:** the React routing study-note extension in Step 24.

### Step 18 — `OnboardingPage.tsx`

- **Depends on:** Steps 14, 15, 16, 17
- **Skill:** none (client page)
- **Read first:** `client/src/Pages/ledger-core/JournalEntryPage.tsx` — reuse its `inputClass` string constant (line ~143) and its submit-button classes (line ~268) verbatim so the wizard matches the app. `client/src/Pages/auth/RegisterPage.tsx` for the controlled-form idiom.
- **Files:** `client/src/Pages/ledger-core/OnboardingPage.tsx` (new)
- **Contract — three steps, local state, ONE POST at the end:**
  - **Step 1 — Workspace:** `organizationName` (required, min 2, prefilled from `useOrg().organization.name`), `legalName` (optional), `industry` (select: Software / Services / Retail / Manufacturing / Nonprofit / Other).
  - **Step 2 — Financial year:** `baseCurrency` (select from a `CURRENCIES` const mirroring `SUPPORTED_CURRENCIES`), `fiscalYearStartMonth` (select, 1–12, default 1), `fiscalYearStartDay` (number, 1–28, default 1), **the derived fiscal-year end date rendered live** via `fiscalYearBounds`, `booksStartDate` (date input, default today), `cashAccountId` (select populated by `listAccounts()`, defaulting to the account whose `code === '1110'` if present, otherwise blank).
  - **Step 3 — Review:** read-only `<dl>` of every value, a **Back** button, and **Finish**.

  Step state is a discriminated union so an invalid step is unrepresentable:
  ```ts
  type WizardStep = { step: 1 } | { step: 2 } | { step: 3 };
  ```
  **Finish** calls `completeLedgerOnboarding(input)` once, then `applySettings(result)`, then `navigate('..', { replace: true })` to land on the dashboard. Disable Finish while the request is in flight so a double-click cannot double-submit. On `ApiRequestError`, show `err.message` inline and stay on step 3 — the server's 422 messages are user-facing.

  Renders full-width **without** the sidebar, with its own 1-2-3 progress indicator.
- **Guardrails:** none server-side
- **Proof:** `cd client && npm run typecheck && npm run build` succeed. Behaviour proved by Step 22.
- **If it fails:** if the wizard reappears after Finish, `applySettings` was not called with the server's response — do not paper over it with a `window.location.reload()`.
- **Owes:** the controlled-forms study-note extension in Step 24.

---

# Slice E — client dashboard, settings and reports

**Outcome:** LedgerCore has a home page with real numbers, an editable settings page, and an honest reports index.

Runs after Slices C and D.

### Step 19 — `TrendChart.tsx`

- **Depends on:** Step 14
- **Skill:** none (client component)
- **Read first:** `client/src/Pages/ledger-core/TrialBalancePage.tsx` for the token usage and table markup conventions.
- **Files:** `client/src/Pages/ledger-core/TrendChart.tsx` (new)
- **Contract:**
  ```ts
  export default function TrendChart({ points }: { points: TrendPoint[] }): JSX.Element;
  ```
  Hand-rolled inline `<svg>`, grouped bars — revenue and expense side by side per month, six months. **No chart library**: rule 14 forbids a dependency before the phase that needs it, and nothing here needs one. Scale to `Math.max(...all values, 1)` so an all-zero dataset does not divide by zero. Colours from `var(--good)` and `var(--bad)`. Accessibility: an `<svg role="img">` with a `<title>`, plus a `<table className="visually-hidden">` carrying the same numbers.
- **Guardrails:** #14 no new dependency
- **Proof:** `cd client && npm run typecheck` exits 0. `grep -rn "recharts\|chart.js\|d3" client/package.json` → no matches.
- **If it fails:** **do not `npm install` a chart library.** Stop and report.
- **Owes:** nothing.

### Step 20 — `DashboardPage.tsx`

- **Depends on:** Steps 14, 15, 17, 19
- **Skill:** none (client page)
- **Read first:** `client/src/Pages/ledger-core/TrialBalancePage.tsx` — reuse its `role="status"` banner and its `CheckCircle2` / `XCircle` idiom for the integrity strip. `./money.ts` → `formatCents` for **every** money value on the page.
- **Files:** `client/src/Pages/ledger-core/DashboardPage.tsx` (new)
- **Contract — the page renders, in this order:**
  1. A header line: the org name and `fiscalYear.label`.
  2. **Position tiles** — Assets, Liabilities, Equity, Cash. Cash renders `—` when `cashCents === null`, with the caption "No cash account configured — set one in Settings." An `equationHolds === false` state shows a warning strip.
  3. **Performance** — two panels, "This fiscal year" and "This month", each with Revenue, Expenses and Net income. Negative net income uses `var(--bad)`.
  4. `<TrendChart points={dashboard.trend} />` under the heading "Last 6 months".
  5. **Recent entries** — a table of `activity.recentEntries`: date, description, line count, total. Each row links to `../journals`.
  6. **Integrity banner** — `role="status"`, green when `integrity.isBalanced`, red otherwise, showing both totals.

  Data via `getLedgerDashboard()` in an effect with the `ignore` flag. Loading → `.skeleton`. `ApiRequestError` → an inline message, never a blank page.
- **Guardrails:** #3 — every money value goes through `formatCents`; never `toFixed` on cents
- **Proof:** `cd client && npm run typecheck && npm run build` succeed. Behaviour proved by Step 22.
- **If it fails:** a tile showing a value 100× too large means `formatCents` was skipped.
- **Owes:** nothing.

### Step 21 — `SettingsPage.tsx` and `ReportsPage.tsx`

- **Depends on:** Steps 14, 15, 17
- **Skill:** none (client pages)
- **Read first:** `client/src/Pages/AppChooserPage.tsx` — copy the `app-card--disabled` + `aria-disabled` idiom for the unbuilt report cards.
- **Files:** `client/src/Pages/ledger-core/SettingsPage.tsx` (new), `client/src/Pages/ledger-core/ReportsPage.tsx` (new)
- **Contract:**

  **SettingsPage** — a flat form over the same fields as the wizard, prefilled from `useLedgerSettings()`. Save issues **two** calls, because the fields live in two layers:
  - `updateOrganization({ name, baseCurrency })` → platform
  - `updateLedgerSettings({ legalName, fiscalYearStartMonth, fiscalYearStartDay, booksStartDate, industry, timezone, cashAccountId })` → LedgerCore

  Then `applySettings` with the second response. When `settings.baseCurrencyLocked === true`, render the currency `<select>` **disabled** with the caption: "Locked — journal entries already exist in this currency. Changing it would invalidate every posted line." Show the derived fiscal-year window live, as the wizard does.

  **ReportsPage** — three cards: **Trial balance** as a live `<Link to="../trial-balance">`; **Profit & loss** and **Balance sheet** as disabled cards carrying a "Phase 4" chip and `aria-disabled`. Being honest about what does not exist is the point of the page — do not link them to a stub.
- **Guardrails:** none server-side
- **Proof:** `cd client && npm run typecheck && npm run build` succeed.
- **If it fails:** if `updateOrganization` 403s, the user is an `ACCOUNTANT` — that is correct behaviour; surface the message rather than widening the role set.
- **Owes:** nothing.

### Step 22 — client tests

- **Depends on:** Steps 18, 20, 21
- **Skill:** none (client tests)
- **Read first:** `client/src/__tests__/AppChooserPage.test.tsx` and `ProtectedRoute.test.tsx` — copy the `jsonResponse` helper, the `vi.stubGlobal('fetch', fetchMock)` / `vi.unstubAllGlobals()` pair, the `<MemoryRouter>` wrapper, and the reusable `session` fixture.
- **Files:** `client/src/__tests__/ledgerCoreOnboarding.test.tsx` (new), `client/src/__tests__/ledgerCoreDashboard.test.tsx` (new)
- **Contract — write exactly these cases:**

  `ledgerCoreOnboarding.test.tsx`:
  | Case | Expected |
  |---|---|
  | Settings fetch returns `onboardedAt: null` | the wizard renders; the chart of accounts does not |
  | Settings fetch returns a non-null `onboardedAt` | the wizard does **not** render |
  | Step 2 with month `4`, day `1`, on a 2026 date | the derived end date `2027-03-31` is visible in the DOM |
  | Fill all three steps and click Finish | `fetchMock` was called once with `/ledger-core/settings/onboarding`, method `POST`, and a body containing `"fiscalYearStartMonth":4` |
  | Finish clicked twice rapidly | exactly **one** POST |

  `ledgerCoreDashboard.test.tsx`:
  | Case | Expected |
  |---|---|
  | `assetsCents: 100000` | the DOM contains `1,000.00` |
  | `cashCents: null` | the DOM contains `—` and the "No cash account configured" caption |
  | `integrity.isBalanced: false` | a `role="status"` element whose text matches `/not balanced/i` |
  | `trend` with 6 points, 4 of them zero | six bar groups render |
- **Guardrails:** #15 in spirit — the client mirror of the server's isolation guarantee is not required here; server tests own tenancy
- **Proof:** `cd client && npm test` — full suite green, **27 + new**, with no existing client test modified.
- **If it fails:** if a test hangs, `fetchMock` is missing a route the component calls — add the mock, never a `setTimeout`.
- **Owes:** nothing.

---

# Slice F — the spine

Non-negotiable. A plan without this tail is incomplete.

### Step 23 — small honesty fixes

- **Depends on:** Step 22
- **Skill:** none
- **Read first:** the two comment blocks named below.
- **Files:** `server/src/services/authService.ts` (edit — the JSDoc above `register`, ~lines 230–242), `client/src/Pages/AccountPage.tsx` (edit — `HealthPanel`'s module list, ~lines 206–224)
- **Contract:** the `register` JSDoc still says the default chart is *not* seeded there and that `accounts` "does not exist yet". Line 304 calls `seedDefaultChart(client, orgId)`. Rewrite the paragraph to describe what the code does. `HealthPanel`'s hardcoded list still labels shipped LedgerCore pages as pending — update it to reflect Phase 3 and 3.5. **Comments only; change no behaviour.**
- **Guardrails:** the "keeping docs honest" rule in [CLAUDE.md](../../../CLAUDE.md) — a comment that lies is the drift that killed the previous build
- **Proof:** `cd server && npm test && cd ../client && npm test` — both suites still green, proving nothing behavioural changed.
- **If it fails:** you edited code, not a comment. Revert and retry.
- **Owes:** nothing.

### Step 24 — study notes

- **Depends on:** Steps 11, 17, 18
- **Skill:** `study-note`
- **Read first:** `study/TEMPLATE.md`, `docs/study-notes.md`, `study/postgresql/recursive-ctes-and-hierarchies.md` (the depth bar to match).
- **Files:**
  - `study/postgresql/aggregating-a-ledger.md` (new) — aggregate `FILTER` vs `CASE WHEN` (and why `FILTER` is not merely sugar), one scan vs five round trips, `generate_series` gap-filling, why the `org_id` predicate must sit in a `LEFT JOIN`'s `ON` clause, and why there is no summary table.
  - `study/postgresql/composite-foreign-keys-for-tenancy.md` (new) — `FOREIGN KEY (org_id, x_id) REFERENCES t (org_id, id)` making a cross-tenant reference physically impossible; the `UNIQUE (org_id, id)` it requires; `MATCH SIMPLE` NULL semantics; and why `ON DELETE SET NULL` is wrong on a composite FK whose other column is `NOT NULL`.
  - `study/react/routing-nested-and-dynamic-segments.md` (**extend**, do not duplicate) — sidebar layout route, and redirect-based route gating on fetched state.
  - `study/react/react-foundations.md` (**extend**) — the controlled-forms section grows to cover the multi-step wizard and its discriminated-union step state, moving that tracker row from ◐ to ✅.
  - `study/README.md` (edit) — index rows for the two new notes, and the coverage tracker updated. **Do not** tick the `Window functions` or `EXCLUDE USING GIST` rows: neither is used here, both stay Phase 4.
- **Contract:** each new note follows TEMPLATE.md's seven sections — one-line summary, mechanism, why we chose it here, where it lives (real file paths), gotchas, **4–8 interview questions with full written answers** including one "tell me about a time", and follow-ups. State the PostgreSQL version verified against (16) and flag anything uncertain rather than guessing.
- **Guardrails:** the standing study-note task in [CLAUDE.md](../../../CLAUDE.md) — accuracy outranks completeness; the user will repeat these in an interview
- **Proof:** `grep -c "^## " study/postgresql/aggregating-a-ledger.md` ≥ 7, and every file path cited in a note actually exists (`ls` each one).
- **If it fails:** if a note claims a mechanism you did not verify, delete the claim. Do not write around uncertainty.
- **Owes:** nothing.

### Step 25 — docs sync

- **Depends on:** Steps 22, 23
- **Skill:** `docs-sync`
- **Read first:** `docs/roadmap.md` § "Phase 3, as delivered" — match its structure for the new section.
- **Files:** `docs/schema.md`, `docs/api.md`, `docs/roadmap.md`, `docs/ledger-core.md`, `docs/architecture.md`, `CLAUDE.md` (all edits)
- **Contract:**
  - `docs/schema.md` — `ledger_settings` in the **Applied** section with its full column list, the composite FK, `ux_accounts_org_id_id`, and the `MATCH SIMPLE` note. Update the header line to "Applied: `001`–`005`."
  - `docs/api.md` — the three settings routes, `GET /reports/dashboard`, and `PATCH /organizations`, each with method, auth, and response shape.
  - `docs/roadmap.md` — a new **"Phase 3.5, as delivered"** section between Phase 3 and the renumbering entry. State plainly that it renumbers nothing, and that fiscal **periods**, close/lock, the posting guard, P&L and the balance sheet all remain Phase 4. Add a "Deliberately changed" table if anything diverged from this plan.
  - `docs/ledger-core.md` — a Phase 3.5 ladder block with ticked boxes; leave every Phase 4 box unticked; update the "Not built yet" list.
  - `docs/architecture.md` — the client tree gains the new `Pages/ledger-core/` files.
  - `CLAUDE.md` — the State section: Phase 3.5 landed, with the **actual** test counts from Step 22, not estimates.
- **Guardrails:** "keeping docs honest" — claiming something works when it does not is worse than saying nothing. Make **no** compliance claim; there is still no audit trail (Phase 5).
- **Proof:** run the `docs-sync` skill; it reports zero drift. Manually confirm `grep -n "fiscal_periods" docs/roadmap.md` still shows it as Phase 4 and unbuilt.
- **If it fails:** correct the doc, never the claim.
- **Owes:** nothing.

### Step 26 — guardrail review and close-out

- **Depends on:** every prior step
- **Skill:** `guardrail-review`
- **Read first:** `docs/guardrails.md`
- **Files:** the full diff; then `plans/ledger-core-phase-3.5-onboarding-dashboard.md` (this file) and `plans/ledger-core-phase-3.md`
- **Contract:** run `guardrail-review` over every changed server file. It must report clean on rules 1, 2, 3, 4, 5, 6, 8, 13, 15 and 16 in particular. Then update this file's `Status:` line to `DONE — <date>`, record any deviation from the plan as written, and note that it is safe to delete. Delete the now-superseded `plans/ledger-core-phase-3.md`, which already marks itself safe to delete.
- **Guardrails:** all sixteen
- **Proof:**
  ```bash
  cd server && npm run typecheck && npm test
  cd client && npm run typecheck && npm test && npm run build
  ```
  All green. Plus the manual walkthrough below.
- **If it fails:** a guardrail finding is a bug, not a style note. Fix it before closing.
- **Owes:** nothing.

---

## Manual end-to-end walkthrough (part of Step 26)

Postgres and Redis in Docker; server and client from separate host terminals.

1. Register a brand-new user → lands on the app chooser.
2. Click **LedgerCore** → redirected to `/app/ledger-core/onboarding`, **not** the chart of accounts.
3. Complete the wizard with a **non-January** fiscal start (April) and a **non-USD** currency (INR) → lands on the dashboard.
4. Reload the page, navigate away and back → **the wizard does not reappear.** This is the persistence check.
5. Post a balanced journal entry → the position tiles, the trend chart and the recent-entries list all move.
6. Confirm the "This fiscal year" window starts in April, not January.
7. Open **Settings** → base currency is now **disabled** with the lock explanation. Change the fiscal start; the dashboard's window follows.
8. Every sidebar item reaches its page; **Reports** shows Trial balance live and P&L / Balance sheet honestly marked Phase 4.
9. Log in as a second organization's user → the dashboard shows that org's numbers only.

---

## Risks and open questions

- **`:has()` support.** `.app-main:has(.app-shell)` is used to widen the app container without route coupling. Baseline in every current browser; if the project ever needs an older target, replace it with a class toggled from `PlatformLayout` on `useLocation().pathname.startsWith('/app/')`. Noted, not blocking.
- **Composite FK on a replayed migration.** `migrations.test.ts` deletes `schema_migrations` and re-executes every file against a populated database. The `DO $$ … pg_constraint` guard in Step 1 is what makes `ALTER TABLE ADD CONSTRAINT` survive that. If Step 1's proof fails on the second run, this guard is the first thing to check.
- **Base-currency lock is coarse.** It refuses any change once *any* ledger line exists, org-wide. A finer rule (allow while only reversed entries exist, say) is not worth the complexity and is not specified anywhere. Recorded as a deliberate limitation for `docs/roadmap.md`.
- **The cash tile depends on configuration.** An org that clears its `cashAccountId`, or whose custom chart has no `1110`, sees `—`. This is intentional: inventing a cash account by name-matching would be a silent wrong answer. Alternative considered and rejected: hardcoding code `1110`.
- **Assumption made under a missing answer:** the industry list in Step 18 (Software / Services / Retail / Manufacturing / Nonprofit / Other) is invented — no doc specifies one, and `industry` is a free-text column, so widening the list later needs no migration.
- **Unknown:** whether the user wants the LedgerCore dashboard reachable from the platform chooser as a direct deep link. Not planned; the chooser continues to link to `/app/ledger-core`, which now resolves to the dashboard.

---

## Definition of done

- [ ] Migration `005` applies from empty **and** replays cleanly; `npm test -- migrations` green.
- [ ] `cd server && npm run typecheck && npm test` — green, **191 + new**, no pre-existing test modified.
- [ ] `cd client && npm run typecheck && npm test && npm run build` — green, **27 + new**.
- [ ] `settings.test.ts` and `dashboard.test.ts` each carry a `cross-tenant isolation` block with the A / B-in-both / C fixture and the forged-`orgId` byte-identical assertion.
- [ ] `guardrail-review` reports clean over the full diff.
- [ ] Two new study notes filed, two extended, `study/README.md` index and coverage tracker updated.
- [ ] `docs-sync` reports zero drift; `schema.md`, `api.md`, `roadmap.md`, `ledger-core.md`, `architecture.md` and `CLAUDE.md` all updated in this same change.
- [ ] The manual walkthrough passes end to end, step 4 included — **the wizard does not reappear**.
- [ ] No new npm dependency in either `package.json`.
- [ ] Phase 4 remains untouched: no `fiscal_periods` table, no close/lock, no P&L, no balance sheet.
- [ ] This file's `Status:` line updated; `plans/ledger-core-phase-3.md` deleted.

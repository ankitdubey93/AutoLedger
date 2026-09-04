# Build plan — LedgerCore Phase 6: bank reconciliation & confidence matching

**Date:** 2026-09-04
**Status: DONE — 2026-09-04.** All 8 slices executed; 645 server tests (up from 519, plan estimated ~570) + 139 client tests (up from 125); `guardrail-review` (1 finding — `unmatchTransaction` bypassed the shared FSM check with an ad-hoc status comparison — fixed) and `docs-sync` both run clean. Both roadmap acceptance criteria pass as named tests. `npm run verify:integrity` passes.
**Phase:** 6 (LedgerCore) · **Spec:** [docs/ledger-core.md § C](../docs/ledger-core.md) · **Roadmap:** [docs/roadmap.md § Phase 6](../docs/roadmap.md#phase-6-as-delivered) · **Schema:** [docs/schema.md](../docs/schema.md) · **API:** [docs/api.md](../docs/api.md)

> This file is now a historical record, not a live plan. The durable account of what shipped is [roadmap.md § Phase 6, as delivered](../docs/roadmap.md#phase-6-as-delivered). Safe to delete. Do **not** execute it again — migration 019 is applied and checksummed.

**Deviations from the plan as written, all recorded in the roadmap:** D2/E2 were merged during implementation — `bankImportService.importStatement` calls `bankMatchService.generateSuggestionsOnClient` directly rather than leaving the stub comment the plan sketched. `matchScore.ts` gained a `COUNTERPARTY_NOISE_FLOOR` (0.5) not in the original plan text, discovered while writing `matchScore.test.ts`: raw Levenshtein similarity between two genuinely unrelated strings (e.g. "Acme Ltd" vs "ATM WITHDRAWAL") is not zero in practice (~0.29), so a floor was needed to keep coincidental overlap from scoring as a real signal — the exact kind of tuning the plan's risk #1 anticipated. `unmatchTransaction` was tightened during `guardrail-review` to call `canTransitionBankTransaction` first (as the FSM source of truth) before layering its own narrower `status === 'MATCHED'` check, rather than using the ad-hoc check alone. The 100-line fixture (`bankFixture.ts`) is async and creates real invoices via the API, correlating true matches by line `description` rather than by positional index — the plan's originally sketched synchronous, index-keyed signature couldn't work against server-allocated invoice numbers.

---

## 1. Starting state (verified against the filesystem, 2026-09-04)

**Exists and may be assumed by every step below:**

- **Migrations `001`–`018` applied.** Latest three: `016_ledger-core_period_posting_guard.sql`, `017_platform_audit_logs.sql`, `018_platform_audit_triggers.sql`. **The next free prefix is `019`.**
- **Services** (`server/src/services/`): `appService`, `auditService`, `authService`, `healthService`, `organizationService`, and `ledger-core/`: `accountLedgerService`, `accountService`, `agingService`, `billService`, `customerService`, `dashboardService`, `fiscalPeriodService`, `invoiceService`, `invoiceSettingsService`, `journalService`, `paymentService`, `reportService`, `settingsService`, `vendorService`.
- **`journalService.createEntryOnClient(client, orgId, createdBy, input) => Promise<string>`** and **`reverseEntryOnClient(client, orgId, userId, entryId, entryDate) => Promise<string>`** — the only sanctioned way to post to the GL from another service. Both call `fiscalPeriodService.assertPeriodOpenOnClient` internally.
- **`paymentService`** — `createPayment` / `voidPayment`, each opening **its own** transaction with `pool.connect()` + `beginTransaction`. There is **no** `*OnClient` variant yet. `allocatedCentsSubquery(alias, column)` is exported and is the single definition of "how much of a document is settled".
- **`db/transaction.ts`** — `beginTransaction(client)` and `withTransaction(fn)`. Every write in the codebase goes through one of these (Phase 5). A bare `client.query('BEGIN')` is a bug.
- **`utils/money.ts`** — `Cents` brand, `cents`, `toCents`, `parseCents`, `formatCents`, `addCents`, `sumCents`, `scaleCents`. **No text→cents parser exists.**
- **`utils/`** also has: `apiError`, `cookies`, `fiscalYear`, `jwt`, `parseBody`, `queryParam` (`optionalText`, `optionalUuid`, `optionalIsoDate`, `readPagination`), `requestContext`, `requireUser`, `routeParam` (`requireParam`), `validate`.
- **`types/ledger-core.ts`** (700 lines) holds every FSM transition table: `INVOICE_TRANSITIONS`, `BILL_TRANSITIONS`, `PAYMENT_TRANSITIONS`, `FISCAL_PERIOD_TRANSITIONS`, each with a `canTransitionX` helper (guardrails rule 10).
- **`routes/ledger-core/index.ts`** mounts 10 sub-routers: accounts, bills, customers, fiscal-periods, invoices, journals, payments, reports, settings, vendors.
- **`config/apps.ts`** — `ledger-core` is `status: 'building'`. **No status flip is needed by this plan.**
- **`config/constants.ts`** — `JSON_BODY_LIMIT = '1mb'`.
- **Tests:** 519 server (`server/src/__tests__/`, 21 files under `ledger-core/`), 125 client. `helpers/factories.ts` exports `resetTables`, `uniqueEmail`, `createUserWithOrg`, `addMember`, `loginAgent`.
- **Client:** `client/src/Pages/ledger-core/` holds 40 pages/components incl. `LedgerCoreRoutes.tsx`, `LedgerCoreSidebar.tsx` (grouped `NAV_GROUPS`), `ConfirmDialog.tsx`, `BackLink.tsx`, `CreateMenu.tsx`, `BarChart.tsx`, `TrendChart.tsx`. `services/fetchServices.ts` (`apiFetch<T>`) is the only place the client talks to the API.
- **Dependencies:** server has `bcrypt, cookie-parser, cors, dotenv, express, express-rate-limit, jsonwebtoken, pg, zod` and nothing else. Vitest + supertest + tsx in dev.

**Does NOT exist — do not assume any of it:**

- No `bank_*` table, service, route, type, or page anywhere.
- No CSV parser, no Levenshtein, no fuzzy matching, no text→money parser, no flexible date parser.
- No file-upload path, no `multer`, no multipart handling, no object storage. Phase 6 accepts CSV **as a JSON string field**, not as a multipart upload.
- No `ioredis`/`bullmq` — Phase 7. Nothing in this plan may be queued or deferred past `COMMIT`.
- No FX. Every amount in this phase is in the organization's `base_currency`.
- No `pg_trgm`, no `fuzzystrmatch`, no `levenshtein()` SQL function. Scoring happens in TypeScript.

---

## 2. Gate

| Question | Answer |
|---|---|
| Phase | **6 — LedgerCore, bank reconciliation.** Owned by `ledger-core`. |
| Roadmap gate | "Needs 4." |
| Phase 4 built? | **Yes** — migrations 015–016, `fiscalPeriodService`, P&L + balance sheet, verified above. |
| Phase 5 built? | **Yes** — not a gate, but its `beginTransaction`/`withTransaction` discipline is mandatory here. |
| Anything blocked? | **No.** Phase 6 is legal today, in full. |
| Roadmap debt carried in | None assigned to Phase 6. |

**Nothing in this plan crosses a gate.** No queue (Phase 7), no FX (Phase 8), no QuickBooks (Phase 9), no LLM.

### Explicitly out of scope — do not build these, and do not "helpfully" add them

- Multipart file upload / stored statement files. The CSV arrives as a JSON string.
- Splitting one bank line across several documents, or several bank lines onto one document.
- Creating a journal entry directly from an unmatched bank line (bank fees, interest). `IGNORE` covers those for now.
- Bank feeds / Open Banking / OFX / QIF / MT940. CSV only.
- Multi-currency statements.
- Auto-accepting anything without a user action. `score >= 85` makes a line **eligible for one-click accept**; the click is still a click.

---

## 3. Execution rules (govern every step)

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**
> Anything this plan did not anticipate is a stop-and-report, not a judgment call.

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing `019` after it applied | A new sequential migration `020` (rule #13) |
| Test fails | Weakening/deleting the assertion | Fix the code — the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule #1) |
| Amount comparison fails | Epsilon, float, `parseFloat` | Integer cents equality (rule #3) |
| Need a CSV / fuzzy-match / date library | `npm install` anything | Stop and ask (rule #14) — this phase adds **zero** dependencies |
| "Just update the matched payment" | `PUT`/`PATCH` on a payment | `POST /:id/unmatch`, which voids it (rule #6) |
| Column missing at runtime | Adding it ad hoc in the service | New migration, then update this plan |
| A service needs its own `BEGIN` inside another service's transaction | `pool.connect()` inside a transaction | Add/use an `*OnClient` variant (rule #5) |

---

## 4. Cross-cutting decisions, settled here (§9 of the skill)

| Decision | Settled value |
|---|---|
| **Scoping** | All three new tables carry `org_id NOT NULL`. Every query in every new service has an `org_id` predicate. **No exceptions in this phase.** |
| **Money** | `bank_transactions.amount_cents BIGINT NOT NULL` — **signed**: `> 0` = money into the bank account, `< 0` = money out. `CHECK (amount_cents <> 0)`. `bank_statement_imports.closing_balance_cents BIGINT` nullable, signed. Every read goes through `parseCents`. |
| **Transaction boundary** | One import = one transaction (import row + all lines + all suggestions, or nothing). One match = one transaction (payment + journal entry + bank-line status, or nothing). One unmatch = one transaction (reversing entry + payment VOID + bank-line status + regenerated suggestions, or nothing). Nothing after `COMMIT` (rule #5). |
| **Lifecycle** | `BANK_TRANSACTION_TRANSITIONS` in `types/ledger-core.ts`; the migration's status `CHECK` lists exactly the same three values (rule #10). |
| **Immutability** | `bank_transactions` gets a `to_jsonb` row-diff carve-out trigger — only `status`, `matched_payment_id`, `matched_at`, `matched_by`, `updated_at` may change; `DELETE` always raises `0A000`. Correction of a match is `POST /:id/unmatch`, which **voids** the payment (rule #6). |
| **Roles** | Read (`GET`) = any member. Import, match, unmatch, ignore, unignore, rescore = `OWNER`, `ADMIN`, `ACCOUNTANT` — same set `/payments` uses, because every one of them either creates or voids a payment. Nothing here is `OWNER`-only. |
| **FKs** | `org_id` → `organizations` `ON DELETE RESTRICT` on the two record tables, `CASCADE` on `bank_match_suggestions` (derived data). Composite `(org_id, x_id)` FKs for account/import/payment/invoice/bill, all `ON DELETE RESTRICT`, except `bank_match_suggestions.bank_transaction_id` → `CASCADE` (child of its line). |
| **App boundary** | Every new table, service, route and page is LedgerCore's. Nothing reads another app's tables. GL postings go through `journalService.createEntryOnClient` / `reverseEntryOnClient` via `paymentService`, never a direct `INSERT` into `journal_entries` (rules #2, #16). |
| **Audit** | `bank_statement_imports` and `bank_transactions` get `audit_row_change('ledger-core')` triggers in migration 019. **`bank_match_suggestions` is deliberately NOT audited** — it is derived, deleted and regenerated wholesale on every rescore, and auditing it would write ~10 rows per rescore for no compliance value. Document that in the migration comment and in `docs/schema.md`, exactly as 018 documents its own exclusions. |
| **Dependencies** | **None added.** CSV parsing, Levenshtein, date parsing and money-text parsing are all hand-written (roadmap explicitly requires the hand-written Levenshtein). `node:crypto`'s `createHash` is built in. |

---

## Slice map

| Slice | Outcome | Depends on |
|---|---|---|
| **A — Pure utilities** | CSV, flexible dates, money-from-text, Levenshtein and the 40/30/30 scorer exist as pure, unit-tested functions with no database and no HTTP. | — |
| **B — Schema & types** | Migration 019 applies twice cleanly; the three tables, their constraints, the immutability trigger and the audit triggers exist; `types/ledger-core.ts` carries the FSM. | A (constants only) |
| **C — `paymentService` `*OnClient` extraction** | `createPaymentOnClient` / `voidPaymentOnClient` exist and every existing payment test still passes. | B |
| **D — Import** | `POST /bank-imports` ingests a CSV idempotently; re-importing the same file adds nothing. | A, B |
| **E — Scoring & suggestions** | Every imported line carries up to 5 explainable suggestions with a stored `score_breakdown`. | A, B, D |
| **F — Match / unmatch / ignore** | Accepting a suggestion posts a real payment; unmatching voids it. | C, D, E |
| **G — Reconciliation report** | `GET /reports/bank-reconciliation` answers "do the bank and the books agree". | D, F |
| **H — Client** | Import page, approval queue, reconciliation page, sidebar entries. | D–G |
| **Spine** | Tests, guardrail-review, study notes, docs-sync. | all |

**A and B may run in parallel** (A touches only `utils/`, B only `db/migrations/` + `types/`). Everything from C onward is strictly sequential.

---

# Slice A — pure utilities

**Outcome:** five pure modules, unit-tested, no `pg` import anywhere in them.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| App slug | `ledger-core` (from `server/src/config/apps.ts`) |
| Files | `server/src/utils/csv.ts`, `server/src/utils/dateParse.ts`, `server/src/utils/levenshtein.ts`, `server/src/utils/matchScore.ts`; edit `server/src/utils/money.ts` |
| Exports | `parseCsv`, `parseFlexibleDate`, `levenshtein`, `similarity`, `scoreMatch`, `normalizeForMatching`, `parseMoneyText` |
| Test files | `server/src/__tests__/csv.test.ts`, `dateParse.test.ts`, `levenshtein.test.ts`, `matchScore.test.ts`; edit `money.test.ts` |

---

### Step A1 — `utils/csv.ts`, an RFC 4180 parser that survives real bank exports

- **Depends on:** nothing
- **Skill:** none (pure utility) — treat as a `new-module` step with no service layer
- **Read first:** `server/src/utils/money.ts` (the doc-comment style and `ApiError` usage this file must copy) and `server/src/utils/apiError.ts`. Imports carry the `.js` extension (`./apiError.js`) — this is ESM and will not build without it.
- **Files:** `server/src/utils/csv.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export interface CsvTable {
    /** Header cells, trimmed, with the BOM stripped from the first one. */
    headers: string[];
    /** Data rows. Every row is padded with '' to headers.length. */
    rows: string[][];
    /** The delimiter that was detected: ',', ';' or '\t'. */
    delimiter: string;
  }

  export function parseCsv(text: string): CsvTable;
  ```
  Behaviour, exactly:
  1. Strip a leading `﻿` (BOM) if present.
  2. **Delimiter detection:** count occurrences of `,`, `;` and `\t` **outside quotes** in the first physical line; pick the highest count; tie or all-zero → `,`.
  3. Character-by-character state machine over the whole string. Two states: in-field and in-quoted-field. `"` opens a quoted field only at the start of a field; `""` inside a quoted field emits one `"`; a `"` immediately followed by the delimiter or a line break closes the field.
  4. Line breaks: `\r\n`, `\n` and a bare `\r` all end a record **outside** quotes; **inside** quotes they are literal characters kept in the field.
  5. Trailing line breaks at end of input produce no extra row. A row whose cells are all `''` is skipped.
  6. Every cell is `.trim()`ed **after** quote processing.
  7. The first non-skipped row is `headers`. If there are zero rows → `throw new ApiError(400, 'The file is empty')`.
  8. Unterminated quote at end of input → `throw new ApiError(400, 'Malformed CSV: an opening quote is never closed')`.
  9. A data row with **more** cells than headers → `throw new ApiError(400, \`Malformed CSV: row ${rowNumber} has ${cellCount} cells but the header has ${headerCount}\`)` where `rowNumber` is 1-based **including** the header row. A row with **fewer** cells is padded with `''`.
- **Guardrails:** #2 no `req`/`res`/`pool` in this file · #4 nothing here builds SQL
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** type error → fix the type, never `as any`. Do not proceed to A2 until typecheck is clean.
- **Owes:** the new study note `study/node-express/parsing-untrusted-csv.md` (Spine step S3), not now.

---

### Step A2 — `csv.test.ts`

- **Depends on:** A1
- **Skill:** none (pure unit test — `isolation-test` does not apply, there is no database here)
- **Read first:** `server/src/__tests__/money.test.ts` — copy its `describe`/`it` shape and its habit of naming the exact expected value in the test title.
- **Files:** `server/src/__tests__/csv.test.ts` (new)
- **Contract — these exact cases, with these exact expectations:**
  | Case name | Input → expected |
  |---|---|
  | `strips a UTF-8 BOM from the first header` | `'﻿Date,Amount\n2026-01-02,10.00'` → `headers` is `['Date','Amount']` |
  | `keeps a comma inside a quoted field` | `'a,b\n"Smith, John",5'` → `rows[0]` is `['Smith, John','5']` |
  | `keeps a newline inside a quoted field` | `'a,b\n"line1\nline2",5'` → `rows[0][0]` is `'line1\nline2'` and `rows.length` is `1` |
  | `unescapes a doubled quote` | `'a\n"He said ""hi"""'` → `rows[0][0]` is `'He said "hi"'` |
  | `handles CRLF line endings` | `'a,b\r\n1,2\r\n'` → `rows` is `[['1','2']]` |
  | `handles a bare CR line ending` | `'a,b\r1,2'` → `rows` is `[['1','2']]` |
  | `detects a semicolon delimiter` | `'Date;Amount\n2026-01-02;10,00'` → `delimiter` is `';'` and `headers.length` is `2` |
  | `detects a tab delimiter` | `'Date\tAmount\n2026-01-02\t10.00'` → `delimiter` is `'\t'` |
  | `does not detect a delimiter that only appears inside quotes` | `'"a;b",c\n1,2'` → `delimiter` is `','` and `headers` is `['a;b','c']` |
  | `pads a short row` | `'a,b,c\n1,2'` → `rows[0]` is `['1','2','']` |
  | `rejects a row longer than the header` | `'a,b\n1,2,3'` → throws `ApiError` with status `400` and a message containing `'row 2'` |
  | `rejects an unterminated quote` | `'a\n"oops'` → throws `ApiError` with status `400` |
  | `rejects an empty file` | `''` → throws `ApiError` with status `400` |
  | `skips a blank trailing row` | `'a,b\n1,2\n\n'` → `rows.length` is `1` |
- **Guardrails:** #15 every module ships tests
- **Proof:** `cd server && npm test -- csv` — 14 tests pass, 0 fail.
- **If it fails:** fix `csv.ts`, never the assertion.
- **Owes:** nothing

---

### Step A3 — `utils/dateParse.ts`

- **Depends on:** nothing
- **Skill:** none
- **Read first:** `server/src/utils/fiscalYear.ts` — copy how it handles `'YYYY-MM-DD'` strings without ever constructing a local-timezone `Date`.
- **Files:** `server/src/utils/dateParse.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export const DATE_FORMATS = ['ISO', 'DMY', 'MDY'] as const;
  export type DateFormat = (typeof DATE_FORMATS)[number];

  export function isDateFormat(value: string): value is DateFormat;

  /** Returns 'YYYY-MM-DD', or null when the text is not a real calendar date. */
  export function parseFlexibleDate(raw: string, format: DateFormat): string | null;
  ```
  Behaviour, exactly:
  1. Trim. Empty → `null`.
  2. **Month-name form is tried first, regardless of `format`:** `D MMM YYYY`, `DD-MMM-YYYY`, `DD/MMM/YY`, `MMM D YYYY` and `MMM DD, YYYY`, with `MMM` matching the first three letters of `jan feb mar apr may jun jul aug sep oct nov dec`, case-insensitive, and an optional full month name.
  3. Otherwise split on the first run of `-`, `/` or `.` into exactly three numeric parts; anything else → `null`.
  4. If the first part is 4 digits → treat as `YYYY MM DD` regardless of `format` (an ISO date is unambiguous, so honour it even under `DMY`).
  5. Otherwise apply `format`: `ISO` → `null` (a non-4-digit-year value under `ISO` is a caller error, surfaced as an unparseable row); `DMY` → `DD MM YYYY`; `MDY` → `MM DD YYYY`.
  6. Two-digit year: `< 70` → `2000 + yy`, otherwise `1900 + yy`.
  7. Validate the real calendar: month `1..12`, day `1..daysInMonth(year, month)` with leap-year handling. Invalid → `null`.
  8. Return zero-padded `` `${yyyy}-${mm}-${dd}` ``. **Never** construct a `Date` and call `toISOString()` — that shifts across the UTC boundary.
- **Guardrails:** #2 no HTTP here
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** fix the type. Do not add a date library (rule #14).
- **Owes:** nothing

---

### Step A4 — `dateParse.test.ts`

- **Depends on:** A3
- **Files:** `server/src/__tests__/dateParse.test.ts` (new)
- **Contract — these exact cases:**
  | Input | Format | Expected |
  |---|---|---|
  | `'2026-03-09'` | `ISO` | `'2026-03-09'` |
  | `'2026/03/09'` | `ISO` | `'2026-03-09'` |
  | `'09/03/2026'` | `DMY` | `'2026-03-09'` |
  | `'09/03/2026'` | `MDY` | `'2026-09-03'` |
  | `'9.3.2026'` | `DMY` | `'2026-03-09'` |
  | `'09-03-26'` | `DMY` | `'2026-03-09'` |
  | `'09-03-89'` | `DMY` | `'1989-03-09'` |
  | `'2026-03-09'` | `DMY` | `'2026-03-09'` (4-digit-first wins) |
  | `'9 Mar 2026'` | `ISO` | `'2026-03-09'` |
  | `'09-MAR-2026'` | `DMY` | `'2026-03-09'` |
  | `'Mar 9, 2026'` | `MDY` | `'2026-03-09'` |
  | `'31/02/2026'` | `DMY` | `null` |
  | `'29/02/2024'` | `DMY` | `'2024-02-29'` (leap year) |
  | `'29/02/2026'` | `DMY` | `null` |
  | `'13/13/2026'` | `DMY` | `null` |
  | `'09/03/2026'` | `ISO` | `null` |
  | `''` / `'  '` / `'n/a'` | any | `null` |
- **Proof:** `cd server && npm test -- dateParse` — all pass.
- **Owes:** nothing

---

### Step A5 — `parseMoneyText` in `utils/money.ts`

- **Depends on:** nothing
- **Skill:** none
- **Read first:** `server/src/utils/money.ts` **in full**, especially `toCents`'s comment on why `1.005 * 100` is `100.49999999999999`. That comment is the reason this function must not touch a float.
- **Files:** `server/src/utils/money.ts` (edit — append one exported function, change nothing existing)
- **Contract — write this signature literally:**
  ```ts
  /**
   * Parses money from untrusted text into integer cents, without ever
   * producing an intermediate float. See the note on toCents.
   */
  export function parseMoneyText(raw: string): Cents;
  ```
  Behaviour, exactly, in this order:
  1. Trim. Strip every character in `$£€₹¥` and every ASCII space, ` ` and `'`.
  2. Strip a trailing 3-letter currency code (`/[A-Za-z]{3}$/`) — but only after step 3's CR/DR handling.
  3. Sign: leading `-` → negative; wrapped in `( )` → negative and the parens are removed; trailing `CR` (case-insensitive) → positive, trailing `DR` → negative. Both a leading `-` and `( )` → still negative (do not double-negate).
  4. Empty, `'-'`, `'—'` or `'n/a'` after stripping → `cents(0)`.
  5. **Separator resolution:** if both `.` and `,` remain, the **last-occurring** one is the decimal separator and every occurrence of the other is a thousands separator, removed. If only `,` remains: it is a decimal separator **iff** it appears exactly once and is followed by exactly 1 or 2 digits to end of string; otherwise remove all of them. Same rule mirrored for `.`.
  6. What remains must match `/^\d+(\.\d{1,2})?$/` after normalising the decimal separator to `.`; anything else → `throw new ApiError(400, \`Unparseable amount "${raw}"\`)`. **A third decimal digit is a rejection, not a rounding.**
  7. Build the result as `BigInt(integerPart) * 100n + BigInt(fractionPadded)` where `fractionPadded` is the fraction right-padded to 2 with `'0'`; apply the sign; hand the `Number` to `cents(...)`.
- **Guardrails:** #3 integer cents, no floats, no `parseFloat`, no `Number(text) * 100`
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -c "parseFloat\|Number(.*) \* 100" server/src/utils/money.ts` returns `0`.
- **If it fails:** fix the string handling. Do not reach for a float as a shortcut.
- **Owes:** extends `study/typescript/branded-types-for-money.md` (Spine step S3).

---

### Step A6 — extend `money.test.ts`

- **Depends on:** A5
- **Files:** `server/src/__tests__/money.test.ts` (edit — add one `describe('parseMoneyText')` block, change nothing existing)
- **Contract — these exact cases:**
  | Input | Expected |
  |---|---|
  | `'1234.56'` | `123456` |
  | `'1,234.56'` | `123456` |
  | `'1.234,56'` | `123456` |
  | `'1 234,56'` | `123456` |
  | `'£1,234.56'` | `123456` |
  | `'1234.56 GBP'` | `123456` |
  | `'(1,234.56)'` | `-123456` |
  | `'-1234.56'` | `-123456` |
  | `'1234.56 CR'` | `123456` |
  | `'1234.56 DR'` | `-123456` |
  | `'1,234'` | `123400` (comma is a thousands separator: 3 digits follow) |
  | `'1,23'` | `123` (comma is a decimal separator: 2 digits follow, appears once) |
  | `'0.5'` | `50` |
  | `''` / `'-'` / `'n/a'` | `0` |
  | `'1234.567'` | throws `ApiError` `400` |
  | `'twelve'` | throws `ApiError` `400` |
  | `'1.2.3'` | throws `ApiError` `400` |
- **Proof:** `cd server && npm test -- money` — the pre-existing cases still pass **and** the 17 new ones pass.
- **If it fails:** if an existing money test broke, you changed something you were told not to — revert and re-append.
- **Owes:** nothing

---

### Step A7 — `utils/levenshtein.ts`

- **Depends on:** nothing
- **Skill:** none
- **Read first:** `server/src/utils/money.ts` for comment style. The roadmap requires this be hand-written: **do not install anything.**
- **Files:** `server/src/utils/levenshtein.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  /** Rolling-array DP. O(m×n) time, O(min(m,n)) space. */
  export function levenshtein(a: string, b: string): number;

  /** 1 - distance / max(length). 0 for two empty strings is defined as 1. */
  export function similarity(a: string, b: string): number;
  ```
  Behaviour, exactly:
  1. `levenshtein('', x)` is `x.length`; `levenshtein(x, '')` is `x.length`; `levenshtein(x, x)` is `0`.
  2. Swap the arguments if needed so the **inner** (rolling) dimension is the **shorter** string — that is what makes the space bound `min(m,n)`.
  3. One `Uint32Array` of length `shorter.length + 1`, plus two scalars for the diagonal and the previous cell. No 2-D matrix.
  4. `similarity(a, b)`: both empty → `1`; otherwise `1 - levenshtein(a, b) / Math.max(a.length, b.length)`, clamped to `[0, 1]`.
- **Guardrails:** #14 no new dependency
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** the new study note `study/architecture/fuzzy-matching-and-confidence-scoring.md` (Spine S3).

---

### Step A8 — `levenshtein.test.ts`

- **Depends on:** A7
- **Files:** `server/src/__tests__/levenshtein.test.ts` (new)
- **Contract — these exact known distances:**
  | a | b | distance |
  |---|---|---|
  | `'kitten'` | `'sitting'` | `3` |
  | `'saturday'` | `'sunday'` | `3` |
  | `'flaw'` | `'lawn'` | `2` |
  | `'abc'` | `'abc'` | `0` |
  | `''` | `'abc'` | `3` |
  | `'abc'` | `''` | `3` |
  | `''` | `''` | `0` |
  | `'acme ltd'` | `'acme limited'` | `4` |

  Plus: `is symmetric` — `levenshtein(a,b) === levenshtein(b,a)` for all eight pairs above; `similarity('abc','abc') === 1`; `similarity('','') === 1`; `similarity('abc','xyz') === 0`; `similarity` is always within `[0,1]` for the eight pairs.
- **Proof:** `cd server && npm test -- levenshtein` — all pass.
- **Owes:** nothing

---

### Step A9 — `utils/matchScore.ts`, the 40/30/30 engine

- **Depends on:** A7
- **Skill:** none (pure)
- **Read first:** `server/src/utils/levenshtein.ts` (A7) and the scoring table in [docs/ledger-core.md § C](../docs/ledger-core.md).
- **Files:** `server/src/utils/matchScore.ts` (new)
- **Contract — write these literally:**
  ```ts
  export const AMOUNT_MAX_POINTS = 40;
  export const DATE_MAX_POINTS = 30;
  export const COUNTERPARTY_MAX_POINTS = 30;

  /** Points by |whole days between| — index 0..3, anything further scores 0. */
  export const DATE_POINTS = [30, 22, 15, 7] as const;

  /** >= this is offered for one-click accept. */
  export const AUTO_MATCH_THRESHOLD = 85;
  /** Below this, no suggestion row is stored at all. */
  export const SUGGESTION_MIN_SCORE = 40;
  /** At most this many suggestions are kept per bank line. */
  export const MAX_SUGGESTIONS_PER_TRANSACTION = 5;

  export interface BankLineForScoring {
    /** Signed: > 0 money in, < 0 money out. */
    amountCents: number;
    txnDate: string; // 'YYYY-MM-DD'
    description: string;
    externalReference: string | null;
  }

  export interface CandidateForScoring {
    documentAmountDueCents: number; // always positive
    documentDate: string;           // 'YYYY-MM-DD'
    counterpartyName: string;
    documentReference: string;      // invoice_number or vendor_reference
  }

  export interface ScoreComponent {
    points: number;
    maxPoints: number;
    reason: string;
  }

  export interface ScoreBreakdown {
    amount: ScoreComponent;
    date: ScoreComponent;
    counterparty: ScoreComponent;
    total: number; // 0..100
  }

  /** lowercased, every non-alphanumeric run collapsed to one space, trimmed. */
  export function normalizeForMatching(value: string): string;

  export function scoreMatch(line: BankLineForScoring, candidate: CandidateForScoring): ScoreBreakdown;
  ```
  Behaviour, exactly:
  - **amount:** `Math.abs(line.amountCents) === candidate.documentAmountDueCents ? 40 : 0`. Integer equality, never an epsilon. `reason` is `'exact match'` or `'amount differs'`.
  - **date:** `days = Math.abs(daysBetween(line.txnDate, candidate.documentDate))` where `daysBetween` parses each `'YYYY-MM-DD'` with `Date.UTC(y, m-1, d)` and divides the millisecond difference by `86_400_000`. `points = DATE_POINTS[days] ?? 0`. `reason` is `` `${days} day(s) apart` ``.
  - **counterparty:** let `memo = normalizeForMatching(line.description + ' ' + (line.externalReference ?? ''))`, `name = normalizeForMatching(candidate.counterpartyName)`, `ref = normalizeForMatching(candidate.documentReference)`.
    `simOf(needle)` = `0` if `needle === ''`; `1` if `memo.includes(needle)`; else `similarity(needle, memo)`.
    `sim = Math.max(simOf(name), simOf(ref))`; `points = Math.round(30 * sim)`.
    `reason` names which of the two won, e.g. `'reference found in memo'`, `'name similarity 0.72'`, `'no textual overlap'`.
  - **total:** the integer sum of the three, so `0..100`.
- **Guardrails:** #3 integer cents equality for the amount signal · #2 nothing HTTP or SQL here
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** `study/architecture/fuzzy-matching-and-confidence-scoring.md` (Spine S3).

---

### Step A10 — `matchScore.test.ts`

- **Depends on:** A9
- **Files:** `server/src/__tests__/matchScore.test.ts` (new)
- **Contract — these exact cases:**
  | Case | Expectation |
  |---|---|
  | `a perfect match scores 100` | amount equal, same date, memo contains the invoice number → `total` is `100` |
  | `a sign-flipped amount still matches on absolute value` | line `-50000`, candidate due `50000` → `amount.points` is `40` |
  | `a different amount scores zero on amount` | line `50001`, due `50000` → `amount.points` is `0` |
  | `date points step down` | days apart 0,1,2,3,4 → `date.points` `30,22,15,7,0` |
  | `the reference beats the name when only the reference is in the memo` | memo `'faster payment inv 1042'`, name `'Wholly Unrelated Co'`, reference `'INV-1042'` → `counterparty.points` is `30` |
  | `a partial name match scores partially` | memo `'acme limited'`, name `'Acme Ltd'`, reference `''` → `counterparty.points` is greater than `0` and less than `30` |
  | `no overlap scores zero on counterparty` | memo `'atm withdrawal'`, name `'Acme Ltd'`, reference `'INV-1'` → `counterparty.points` is `0` |
  | `total never exceeds 100` | assert over all of the above |
  | `normalizeForMatching collapses punctuation` | `normalizeForMatching('ACME  Ltd. — #1042')` is `'acme ltd 1042'` |
  | `AUTO_MATCH_THRESHOLD is 85` | constant assertion, so a silent retune breaks a test |
- **Proof:** `cd server && npm test -- matchScore` — all pass.
- **Owes:** nothing

---

# Slice B — schema & types

**Outcome:** migration 019 applies twice cleanly; three tables, their constraints and triggers exist; the FSM is in `types/`.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/019_ledger-core_bank_reconciliation.sql` |
| Tables | `bank_statement_imports`, `bank_transactions`, `bank_match_suggestions` |
| Trigger fns | `reject_bank_transaction_mutation()` |
| Triggers | `trg_bank_transactions_immutable`, `trg_bank_transactions_updated_at`, `trg_bank_statement_imports_audit`, `trg_bank_transactions_audit` |
| Types file | `server/src/types/ledger-core.ts` (edit) |
| Type names | `BankTransactionStatus`, `BANK_TRANSACTION_STATUSES`, `BANK_TRANSACTION_TRANSITIONS`, `canTransitionBankTransaction`, `isBankTransactionStatus`, `BankStatementImport`, `BankTransaction`, `BankMatchSuggestion`, `BankReconciliationReport` |
| Test file | `server/src/__tests__/ledger-core/bankConstraints.test.ts` |

---

### Step B1 — migration `019_ledger-core_bank_reconciliation.sql`

- **Depends on:** nothing (A9's constants are duplicated as literals here, not imported)
- **Skill:** **new-migration**
- **Read first:** `server/src/db/migrations/014_ledger-core_payments.sql` **in full** — copy its header comment style, its `CONSTRAINT ux_<table>_org_id_id UNIQUE (org_id, id)` habit, its composite-FK idiom, and `reject_payment_mutation()`'s `to_jsonb` row-diff carve-out verbatim in shape. Then read `018_platform_audit_triggers.sql` for the audit-trigger attachment idiom and its "deliberately not audited" comment block.
- **Files:** `server/src/db/migrations/019_ledger-core_bank_reconciliation.sql` (new)
- **Contract — write this schema literally:**

  ```sql
  CREATE TABLE IF NOT EXISTS bank_statement_imports (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    account_id            UUID NOT NULL,
    file_name             TEXT NOT NULL CHECK (length(btrim(file_name)) > 0 AND length(file_name) <= 200),
    date_format           TEXT NOT NULL CHECK (date_format IN ('ISO', 'DMY', 'MDY')),
    delimiter             TEXT NOT NULL CHECK (length(delimiter) = 1),
    row_count             INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    imported_count        INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
    duplicate_count       INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    earliest_date         DATE,
    latest_date           DATE,
    closing_balance_cents BIGINT,
    closing_balance_on    DATE,
    created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_bank_statement_imports_org_id_id UNIQUE (org_id, id),
    CONSTRAINT chk_bank_imports_date_range CHECK (
      earliest_date IS NULL OR latest_date IS NULL OR earliest_date <= latest_date
    ),
    CONSTRAINT chk_bank_imports_closing_pair CHECK (
      (closing_balance_cents IS NULL AND closing_balance_on IS NULL) OR
      (closing_balance_cents IS NOT NULL AND closing_balance_on IS NOT NULL)
    ),
    CONSTRAINT chk_bank_imports_counts CHECK (imported_count + duplicate_count <= row_count),
    CONSTRAINT fk_bank_imports_account
      FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_bank_imports_org_created ON bank_statement_imports (org_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bank_imports_account     ON bank_statement_imports (account_id);
  CREATE INDEX IF NOT EXISTS idx_bank_imports_created_by  ON bank_statement_imports (created_by);

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    import_id          UUID NOT NULL,
    account_id         UUID NOT NULL,

    txn_date           DATE NOT NULL,
    description        TEXT NOT NULL CHECK (length(description) <= 500),
    external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) <= 100),
    currency_code      CHAR(3) NOT NULL,
    amount_cents       BIGINT NOT NULL CHECK (amount_cents <> 0),

    dedupe_hash        CHAR(64) NOT NULL,

    status             TEXT NOT NULL DEFAULT 'UNMATCHED'
                       CHECK (status IN ('UNMATCHED', 'MATCHED', 'IGNORED')),
    matched_payment_id UUID,
    matched_at         TIMESTAMPTZ,
    matched_by         UUID REFERENCES users(id) ON DELETE RESTRICT,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_bank_transactions_org_id_id UNIQUE (org_id, id),
    -- Idempotent re-import: the same statement uploaded twice yields one set of rows.
    CONSTRAINT ux_bank_transactions_dedupe UNIQUE (org_id, dedupe_hash),
    CONSTRAINT chk_bank_txn_matched_fields CHECK (
      (status = 'MATCHED'  AND matched_payment_id IS NOT NULL AND matched_at IS NOT NULL AND matched_by IS NOT NULL) OR
      (status <> 'MATCHED' AND matched_payment_id IS NULL     AND matched_at IS NULL     AND matched_by IS NULL)
    ),
    CONSTRAINT fk_bank_txn_import
      FOREIGN KEY (org_id, import_id) REFERENCES bank_statement_imports (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_bank_txn_account
      FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_bank_txn_payment
      FOREIGN KEY (org_id, matched_payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_bank_txn_org_status_date ON bank_transactions (org_id, status, txn_date DESC);
  CREATE INDEX IF NOT EXISTS idx_bank_txn_org_account     ON bank_transactions (org_id, account_id, txn_date DESC);
  CREATE INDEX IF NOT EXISTS idx_bank_txn_import          ON bank_transactions (import_id);
  CREATE INDEX IF NOT EXISTS idx_bank_txn_payment         ON bank_transactions (matched_payment_id);
  CREATE INDEX IF NOT EXISTS idx_bank_txn_matched_by      ON bank_transactions (matched_by);

  CREATE TABLE IF NOT EXISTS bank_match_suggestions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    bank_transaction_id UUID NOT NULL,
    target_type         TEXT NOT NULL CHECK (target_type IN ('invoice', 'bill')),
    invoice_id          UUID,
    bill_id             UUID,
    score               INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    score_breakdown     JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_bank_suggestion_one_target CHECK (
      (target_type = 'invoice' AND invoice_id IS NOT NULL AND bill_id IS NULL) OR
      (target_type = 'bill'    AND bill_id    IS NOT NULL AND invoice_id IS NULL)
    ),
    CONSTRAINT ux_bank_suggestion_invoice UNIQUE (bank_transaction_id, invoice_id),
    CONSTRAINT ux_bank_suggestion_bill    UNIQUE (bank_transaction_id, bill_id),
    CONSTRAINT fk_bank_suggestion_txn
      FOREIGN KEY (org_id, bank_transaction_id) REFERENCES bank_transactions (org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_bank_suggestion_invoice
      FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_bank_suggestion_bill
      FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_bank_suggestion_txn_score ON bank_match_suggestions (bank_transaction_id, score DESC);
  CREATE INDEX IF NOT EXISTS idx_bank_suggestion_invoice   ON bank_match_suggestions (invoice_id);
  CREATE INDEX IF NOT EXISTS idx_bank_suggestion_bill      ON bank_match_suggestions (bill_id);
  ```

  Then the immutability trigger — copy `reject_payment_mutation()`'s shape from 014:

  ```sql
  CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Bank transaction % is a record of fact and cannot be deleted', OLD.id
        USING ERRCODE = '0A000';
    END IF;

    IF to_jsonb(NEW) - 'status' - 'matched_payment_id' - 'matched_at' - 'matched_by' - 'updated_at'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'matched_payment_id' - 'matched_at' - 'matched_by' - 'updated_at' THEN
      RAISE EXCEPTION 'Bank transaction % may only change its match state', OLD.id
        USING ERRCODE = '0A000';
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE TRIGGER trg_bank_transactions_immutable
    BEFORE UPDATE OR DELETE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_bank_transaction_mutation();

  CREATE OR REPLACE TRIGGER trg_bank_transactions_updated_at
    BEFORE UPDATE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  CREATE OR REPLACE TRIGGER trg_bank_statement_imports_updated_at
    BEFORE UPDATE ON bank_statement_imports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  ```

  Then the audit attachment, with the exclusion documented:

  ```sql
  -- Phase 5's audit_row_change() covers both record tables. bank_match_suggestions
  -- is deliberately NOT audited: it is derived data, deleted and regenerated
  -- wholesale on every rescore, so auditing it would write ten rows per rescore
  -- with no compliance value. The same reasoning 018 applies to schema_migrations.
  CREATE OR REPLACE TRIGGER trg_bank_statement_imports_audit
    AFTER INSERT OR UPDATE OR DELETE ON bank_statement_imports
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

  CREATE OR REPLACE TRIGGER trg_bank_transactions_audit
    AFTER INSERT OR UPDATE OR DELETE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
  ```

- **Guardrails:** #1 every table carries `org_id` · #3 `BIGINT` cents, never `DECIMAL` · #8 every `*_id` has a `REFERENCES` with explicit `ON DELETE`, every FK and scope column indexed · #10 the status `CHECK` lists exactly the three values `BANK_TRANSACTION_TRANSITIONS` will name · #13 additive and idempotent; **never edit this file once applied**
- **Proof:** `cd server && npm run migrate` succeeds, then `npm run migrate` **again** reports nothing to apply; then `npm test -- migrations` passes (that suite deletes `schema_migrations` and re-executes every file against a populated database, which is the real idempotency proof).
- **If it fails:** a checksum error means the file was edited after applying — do **not** edit it further; write `020_…` instead. `ALTER TABLE ADD CONSTRAINT` has no `IF NOT EXISTS`; if you need one later, use the `DO $$ … pg_constraint …` guard from `012`.
- **Owes:** `docs/schema.md` (Spine S4) and `study/postgresql/idempotent-ingestion-and-dedupe-hashes.md` (Spine S3).

---

### Step B2 — types and the FSM in `types/ledger-core.ts`

- **Depends on:** B1
- **Skill:** new-module (types layer)
- **Read first:** `server/src/types/ledger-core.ts` lines 400–440 (`PAYMENT_TRANSITIONS`) and 610–650 (`FISCAL_PERIOD_TRANSITIONS`) — copy the `as const satisfies Record<...>` idiom exactly.
- **Files:** `server/src/types/ledger-core.ts` (edit — append a `// ---- Phase 6 — bank reconciliation` section at the end; change nothing above it)
- **Contract — write these literally:**
  ```ts
  export const BANK_TRANSACTION_STATUSES = ['UNMATCHED', 'MATCHED', 'IGNORED'] as const;
  export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];

  export function isBankTransactionStatus(value: string): value is BankTransactionStatus {
    return (BANK_TRANSACTION_STATUSES as readonly string[]).includes(value);
  }

  /**
   * The one lifecycle transition table for a bank line (guardrails rule 10).
   * Unlike VOID on an invoice or LOCKED on a period, MATCHED is NOT terminal —
   * it is reversible, and the reverse edge has a GL side effect: unmatching
   * voids the payment the match posted.
   */
  export const BANK_TRANSACTION_TRANSITIONS = {
    UNMATCHED: ['MATCHED', 'IGNORED'],
    MATCHED: ['UNMATCHED'],
    IGNORED: ['UNMATCHED'],
  } as const satisfies Record<BankTransactionStatus, readonly BankTransactionStatus[]>;

  export function canTransitionBankTransaction(
    from: BankTransactionStatus,
    to: BankTransactionStatus,
  ): boolean {
    return (BANK_TRANSACTION_TRANSITIONS[from] as readonly BankTransactionStatus[]).includes(to);
  }

  export interface BankStatementImport {
    id: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    fileName: string;
    dateFormat: string;
    delimiter: string;
    rowCount: number;
    importedCount: number;
    duplicateCount: number;
    earliestDate: string | null;
    latestDate: string | null;
    closingBalanceCents: number | null;
    closingBalanceOn: string | null;
    createdBy: string;
    createdByName: string | null;
    createdAt: string;
  }

  export interface BankMatchSuggestion {
    id: string;
    targetType: 'invoice' | 'bill';
    invoiceId: string | null;
    billId: string | null;
    /** invoice_number or vendor_reference. */
    documentReference: string;
    documentDate: string;
    counterpartyName: string;
    documentTotalCents: number;
    documentAmountDueCents: number;
    score: number;
    /** Shape mirrors utils/matchScore.ts's ScoreBreakdown exactly. */
    scoreBreakdown: unknown;
    /** score >= AUTO_MATCH_THRESHOLD — the one-click-accept flag. */
    autoMatchable: boolean;
  }

  export interface BankTransaction {
    id: string;
    importId: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    txnDate: string;
    description: string;
    externalReference: string | null;
    currencyCode: string;
    /** Signed: > 0 money in, < 0 money out. */
    amountCents: number;
    status: BankTransactionStatus;
    matchedPaymentId: string | null;
    matchedAt: string | null;
    matchedBy: string | null;
    matchedByName: string | null;
    createdAt: string;
    updatedAt: string;
    /** Empty for a MATCHED or IGNORED line. Ordered score DESC. */
    suggestions: BankMatchSuggestion[];
  }

  export interface BankReconciliationReport {
    accountId: string;
    accountCode: string;
    accountName: string;
    asOf: string;
    /** Debits minus credits on the GL cash account up to asOf. */
    glBalanceCents: number;
    /** Sum of every imported bank line for this account up to asOf. */
    statementBalanceCents: number;
    differenceCents: number;
    /** Integer equality, never an epsilon (guardrails rule 3). */
    reconciles: boolean;
    matchedCount: number;
    matchedCents: number;
    unmatchedCount: number;
    unmatchedCents: number;
    ignoredCount: number;
    /** From the latest import carrying one, on or before asOf. Null when none does. */
    statedClosingBalanceCents: number | null;
    statedClosingBalanceOn: string | null;
    statedClosingDifferenceCents: number | null;
  }
  ```
- **Guardrails:** #10 one FSM table, in `types/`, matching the migration's `CHECK` exactly · #12 account types stay five — nothing here adds one
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -c "BANK_TRANSACTION_TRANSITIONS" server/src/types/ledger-core.ts` is `2` (the definition and `canTransitionBankTransaction`).
- **Owes:** extends `study/architecture/document-lifecycle-fsm.md` (Spine S3).

---

### Step B3 — `bankConstraints.test.ts` (raw SQL, proving the DB holds without the service)

- **Depends on:** B1, B2
- **Skill:** **isolation-test**
- **Read first:** `server/src/__tests__/ledger-core/paymentConstraints.test.ts` — copy its structure exactly: raw `pool.query` inserts, `resetTables()` in `beforeEach`, and its habit of asserting on the Postgres error **code** rather than the message.
- **Files:** `server/src/__tests__/ledger-core/bankConstraints.test.ts` (new)
- **Contract — these exact cases:**
  | Case name | Expectation |
  |---|---|
  | `rejects a second bank line with the same (org_id, dedupe_hash)` | second raw `INSERT` rejects with code `23505` |
  | `allows the same dedupe_hash in a different organization` | insert succeeds — the UNIQUE is `(org_id, dedupe_hash)`, not global |
  | `rejects a zero amount` | `amount_cents = 0` rejects with code `23514` |
  | `rejects MATCHED without a payment id` | `status='MATCHED'`, `matched_payment_id` NULL → `23514` (`chk_bank_txn_matched_fields`) |
  | `rejects UNMATCHED carrying a payment id` | `status='UNMATCHED'` with a non-null `matched_payment_id` → `23514` |
  | `rejects a DELETE of a bank transaction` | raw `DELETE` rejects with code `0A000` |
  | `rejects changing the amount of a bank transaction` | `UPDATE … SET amount_cents = …` rejects with `0A000` |
  | `permits changing only the match fields` | `UPDATE … SET status='IGNORED'` succeeds |
  | `rejects an import row pointing at another organization's account` | composite FK `fk_bank_imports_account` rejects with code `23503` |
  | `rejects a suggestion pointing at another organization's invoice` | composite FK `fk_bank_suggestion_invoice` rejects with `23503` |
  | `rejects a suggestion naming both an invoice and a bill` | `chk_bank_suggestion_one_target` rejects with `23514` |
  | `writes an audit row for a bank transaction insert` | one `audit_logs` row with `table_name='bank_transactions'`, `operation='INSERT'`, `app_slug='ledger-core'` |
  | `writes no audit row for a suggestion insert` | zero `audit_logs` rows with `table_name='bank_match_suggestions'` |
- **Guardrails:** #15 every module ships tests, including a cross-tenant case — the two composite-FK cases and the cross-org dedupe case are it here
- **Proof:** `cd server && npm test -- bankConstraints` — 13 tests pass.
- **If it fails:** a failing constraint test means the migration is wrong. Since 019 is already applied, fix it with migration `020`, **never** by editing 019.
- **Owes:** nothing

---

# Slice C — `paymentService` `*OnClient` extraction

**Outcome:** a payment can be created or voided **inside a caller's transaction**, so a bank match posts its payment, its journal entry and its bank-line status change in one atomic unit (rule #5). All existing payment tests still pass.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| File | `server/src/services/ledger-core/paymentService.ts` (edit) |
| New exports | `createPaymentOnClient`, `voidPaymentOnClient` |
| Unchanged exports | `createPayment`, `voidPayment`, `getPaymentById`, `listPayments`, `allocatedCentsSubquery` |

---

### Step C1 — extract `createPaymentOnClient` / `voidPaymentOnClient`

- **Depends on:** B2
- **Skill:** none (refactor) — same fields apply
- **Read first:** `server/src/services/ledger-core/paymentService.ts` **in full**, and `server/src/services/ledger-core/journalService.ts` lines 326–460 — `createEntryOnClient`/`createEntry` is the exact pattern to mirror: the `*OnClient` function takes a `client` and does the work; the public function owns the transaction and the post-`COMMIT` re-read.
- **Files:** `server/src/services/ledger-core/paymentService.ts` (edit)
- **Contract — write these signatures literally:**
  ```ts
  /** Creates a payment on the caller's transaction. Returns the new payment's id.
   *  Does not COMMIT — the caller's COMMIT is where both deferred constraint
   *  triggers fire. */
  export async function createPaymentOnClient(
    client: PoolClient,
    orgId: string,
    createdBy: string,
    input: CreatePaymentInput,
  ): Promise<string>;

  /** Voids a payment on the caller's transaction, posting the reversal.
   *  Throws ApiError(409, 'This payment has already been voided') if it is
   *  not POSTED. Does not COMMIT. */
  export async function voidPaymentOnClient(
    client: PoolClient,
    orgId: string,
    userId: string,
    id: string,
    entryDate: string | null,
  ): Promise<void>;
  ```
  Mechanics, exactly:
  1. `createPaymentOnClient` is the **entire current body** of `createPayment` between `beginTransaction(client)` and `await client.query('COMMIT')`, verbatim, with the allocations-sum pre-check moved to its top and `return paymentId` at its end. Move nothing else.
  2. `createPayment` becomes: allocate the client, `beginTransaction`, call `createPaymentOnClient`, `COMMIT`, `return await getPaymentById(orgId, id)`, with **the existing `catch`/`finally` blocks unchanged** (the `ApiError` passthrough and the `P0001 → 422` mapping stay where they are).
  3. Same split for `voidPayment` / `voidPaymentOnClient`.
  4. **Do not** change any SQL, any error message, any status code, or `allocatedCentsSubquery`.
- **Guardrails:** #5 inside a transaction every query uses the checked-out `client` — the `*OnClient` functions must never touch `pool` · #6 no new mutation path on a posted payment
- **Proof:** `cd server && npm test -- payments` **and** `npm test -- paymentConstraints` — both suites pass with **exactly** the same number of tests as before the edit. Also `grep -n "pool.query" server/src/services/ledger-core/paymentService.ts` must show hits only inside `getPaymentById`, `listPayments` and `loadAllocations`.
- **If it fails:** a payment test that broke means the extraction changed behaviour — re-read `journalService`'s split and move less. Do not adjust the payment tests.
- **Owes:** nothing (the pattern is already covered by `study/postgresql/transactions-isolation-pooling.md`).

---

# Slice D — statement import

**Outcome:** `POST /api/v1/ledger-core/bank-imports` ingests a CSV; importing the same file twice yields one set of rows.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Service | `server/src/services/ledger-core/bankImportService.ts` → `importStatement`, `listImports`, `getImportById` |
| Schema | `server/src/schemas/ledger-core/bankSchema.ts` → `importStatementSchema` |
| Controller | `server/src/controllers/ledger-core/bankImportController.ts` → `create`, `list`, `getOne` |
| Routes | `server/src/routes/ledger-core/bankImportRoutes.ts`, mounted at `/bank-imports` |
| Test | `server/src/__tests__/ledger-core/bankImports.test.ts` |
| Constant | `MAX_CSV_CHARS = 900_000` in `server/src/config/constants.ts` |

---

### Step D1 — `schemas/ledger-core/bankSchema.ts`

- **Depends on:** A3 (`DateFormat`)
- **Skill:** new-module (validation layer)
- **Read first:** `server/src/schemas/ledger-core/paymentSchema.ts` — copy its `zod` v4 idioms (`z.uuid()`, `z.iso.date()`, `z.int()`, `.nullable().default(null)`) and its doc comment listing what is deliberately absent.
- **Files:** `server/src/schemas/ledger-core/bankSchema.ts` (new), `server/src/config/constants.ts` (edit — add `export const MAX_CSV_CHARS = 900_000;` with a comment that `JSON_BODY_LIMIT` is `'1mb'` and JSON escaping needs the headroom)
- **Contract — write these literally:**
  ```ts
  export const importStatementSchema = z.object({
    accountId: z.uuid(),
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(MAX_CSV_CHARS),
    dateFormat: z.enum(['ISO', 'DMY', 'MDY']).default('ISO'),
    columnMap: z
      .object({
        date: z.string().trim().min(1).max(100),
        description: z.string().trim().min(1).max(100),
        amount: z.string().trim().max(100).nullable().default(null),
        debit: z.string().trim().max(100).nullable().default(null),
        credit: z.string().trim().max(100).nullable().default(null),
        reference: z.string().trim().max(100).nullable().default(null),
      })
      .refine((v) => v.amount !== null || (v.debit !== null && v.credit !== null), {
        message: 'columnMap needs either an amount column or both a debit and a credit column',
      })
      .nullable()
      .default(null),
    closingBalanceCents: z.int().min(-1_000_000_000_000).max(1_000_000_000_000).nullable().default(null),
    closingBalanceOn: z.iso.date().nullable().default(null),
  }).refine((v) => (v.closingBalanceCents === null) === (v.closingBalanceOn === null), {
    message: 'closingBalanceCents and closingBalanceOn must be supplied together',
  });

  export const matchBankTransactionSchema = z
    .object({
      suggestionId: z.uuid().nullable().default(null),
      invoiceId: z.uuid().nullable().default(null),
      billId: z.uuid().nullable().default(null),
    })
    .refine(
      (v) =>
        [v.suggestionId, v.invoiceId, v.billId].filter((x) => x !== null).length === 1,
      { message: 'Name exactly one of suggestionId, invoiceId or billId' },
    );
  ```
  Deliberately absent, and say so in the file's doc comment: `currencyCode` (the organization's base currency), `status` (a line is born UNMATCHED), `dedupeHash` (server-computed — a client-supplied hash would let a caller suppress or forge deduplication).
- **Guardrails:** #4 nothing here builds SQL
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** nothing

---

### Step D2 — `bankImportService.importStatement`

- **Depends on:** A1, A3, A5, B1, D1
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/ledger-core/paymentService.ts` (transaction shape, local `pgErrorCode`/`pgErrorMessage` helpers, `toX` row mappers) and `server/src/services/ledger-core/invoiceService.ts` (how a service validates an account is postable and of the right type). Imports carry `.js`.
- **Files:** `server/src/services/ledger-core/bankImportService.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export interface ImportStatementInput {
    accountId: string;
    fileName: string;
    content: string;
    dateFormat: DateFormat;
    columnMap: {
      date: string; description: string;
      amount: string | null; debit: string | null; credit: string | null;
      reference: string | null;
    } | null;
    closingBalanceCents: number | null;
    closingBalanceOn: string | null;
  }

  export interface ImportStatementResult {
    import: BankStatementImport;
    /** Lines whose dedupe_hash was already present, and were therefore skipped. */
    duplicateCount: number;
    /** Newly inserted lines. */
    importedCount: number;
    /** Newly inserted lines that got at least one suggestion. */
    suggestedCount: number;
    /** Newly inserted lines with a suggestion scoring >= AUTO_MATCH_THRESHOLD. */
    autoMatchableCount: number;
  }

  export async function importStatement(
    orgId: string,
    createdBy: string,
    input: ImportStatementInput,
  ): Promise<ImportStatementResult>;

  export interface ListImportsOptions { page: number; limit: number; accountId: string | null }

  export async function listImports(
    orgId: string,
    options: ListImportsOptions,
  ): Promise<{ imports: BankStatementImport[]; totalCount: number }>;

  export async function getImportById(orgId: string, id: string): Promise<BankStatementImport>;
  ```
  `importStatement`, exactly, all inside one `pool.connect()` + `beginTransaction(client)`:
  1. Load `organizations.base_currency` for `orgId`; missing → `ApiError(404, 'Organization not found')`.
  2. `SELECT id, code, is_postable, type FROM accounts WHERE id = $1 AND org_id = $2`. Missing → `ApiError(422, 'Bank account not found')`. Not `is_postable` → ``ApiError(422, `Account ${code} is a header account and cannot be posted to`)``. `type !== 'Asset'` → ``ApiError(422, `Account ${code} is not an Asset account`)``.
  3. `parseCsv(input.content)`.
  4. **Column resolution.** If `input.columnMap` is non-null, look each named header up case-insensitively after trimming; a name not present → ``ApiError(422, `Column "${name}" is not in the file`)``. If null, auto-detect against these synonym lists, first match wins, case-insensitive, compared on the normalized header (`toLowerCase()`, non-alphanumerics collapsed to one space, trimmed):
     - date: `date`, `transaction date`, `txn date`, `posting date`, `value date`, `booking date`
     - description: `description`, `narrative`, `details`, `memo`, `particulars`, `payee`, `transaction`
     - amount: `amount`, `value`, `transaction amount`
     - debit: `debit`, `withdrawal`, `money out`, `paid out`, `dr`
     - credit: `credit`, `deposit`, `money in`, `paid in`, `cr`
     - reference: `reference`, `ref`, `transaction reference`, `cheque number`, `check number`
     Date and description are required; missing either → `ApiError(422, 'Could not find a date column in the file')` / `'…a description column…'`. Amount is required unless **both** debit and credit resolved → `ApiError(422, 'Could not find an amount column, or a debit/credit pair, in the file')`.
  5. **Per data row**, with `rowNumber` = index + 2 (1-based, header counted):
     - `parseFlexibleDate(cells[dateIdx], input.dateFormat)`; `null` → record the error ``row ${rowNumber}: unparseable date "${raw}"``.
     - amount: single column → `parseMoneyText(cells[amountIdx])`; debit/credit pair → `parseMoneyText(credit) - parseMoneyText(debit)` (**money in is positive**). A thrown `ApiError` from `parseMoneyText` is caught and recorded as ``row ${rowNumber}: ${err.message}``.
     - `amountCents === 0` → record ``row ${rowNumber}: amount is zero``.
     - description: the cell, trimmed, truncated to 500 chars. Empty → `''` is allowed.
     - reference: the cell trimmed and truncated to 100, or `null` when there is no reference column or the cell is empty.
  6. If any errors were recorded → `ApiError(422, …)` whose message is ``Import failed: ${n} row(s) could not be parsed (${first3.join('; ')}${n > 3 ? `; and ${n - 3} more` : ''})``. **The whole import fails; nothing is written.**
  7. If zero valid rows → `ApiError(422, 'The file contains no transaction rows')`.
  8. **Dedupe hash**, per row: count how many earlier rows **in this same file** share the identical tuple `(date, amountCents, normalizedDescription, reference)`; call that `occurrence` (0-based). Then
     ```
     sha256(`${orgId}|${accountId}|${date}|${amountCents}|${normalizeForMatching(description)}|${reference ?? ''}|${occurrence}`)
     ```
     as lowercase hex via `createHash('sha256')` from `node:crypto`. **The occurrence ordinal is load-bearing**: two genuinely identical lines in one statement must both survive, and re-importing the same file must still collide on both.
  9. `INSERT INTO bank_statement_imports (…) VALUES (…) RETURNING id` with `row_count = validRows.length`, `imported_count = 0`, `duplicate_count = 0`, `delimiter` from `parseCsv`, `earliest_date`/`latest_date` from the parsed dates.
  10. Batch-insert the lines with `unnest`, mirroring `paymentService`'s allocation insert:
      ```sql
      INSERT INTO bank_transactions
        (org_id, import_id, account_id, txn_date, description, external_reference,
         currency_code, amount_cents, dedupe_hash)
      SELECT $1, $2, $3, v.txn_date, v.description, v.external_reference, $4, v.amount_cents, v.dedupe_hash
        FROM unnest($5::date[], $6::text[], $7::text[], $8::bigint[], $9::text[])
             AS v(txn_date, description, external_reference, amount_cents, dedupe_hash)
      ON CONFLICT (org_id, dedupe_hash) DO NOTHING
      RETURNING id
      ```
      `importedCount = rows.length`; `duplicateCount = validRows.length - importedCount`.
  11. `UPDATE bank_statement_imports SET imported_count = $1, duplicate_count = $2 WHERE id = $3 AND org_id = $4`.
  12. Call `bankMatchService.generateSuggestionsOnClient(client, orgId, insertedIds)` (Slice E). **Until E2 lands, this call does not exist** — D2 leaves a `// suggestions are generated in Step E2` comment and returns `suggestedCount: 0, autoMatchableCount: 0`; E2 replaces the comment. That is the one deliberate stub in this plan; do not invent any other.
  13. `COMMIT`, then `return { import: await getImportById(orgId, importId), … }`.
  Error mapping in the `catch`: `ApiError` passthrough; `P0001` → `ApiError(422, message)`; `23505` → `ApiError(409, 'That statement is already being imported')` (a concurrent duplicate import racing the `ON CONFLICT`); everything else rethrown. `ROLLBACK` in `catch`, `release` in `finally` — copy `paymentService`'s block verbatim.
- **Guardrails:** #1 every statement carries `org_id` · #2 no `req`/`res` in this file · #3 `BIGINT` cents through `parseCents`/`parseMoneyText` only · #4 parameterized only; the column names resolved in step 4 index into a **parsed array**, never into SQL · #5 every query uses `client`
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -c "org_id" server/src/services/ledger-core/bankImportService.ts` is at least one per statement, and `grep -c "pool.query" …` shows hits only in `listImports`/`getImportById`.
- **If it fails:** a type error on `unnest` parameter arrays → check the cast list matches the array count. Never `as any`.
- **Owes:** `study/postgresql/idempotent-ingestion-and-dedupe-hashes.md` and `study/node-express/parsing-untrusted-csv.md` (Spine S3).

---

### Step D3 — controller + routes + mount

- **Depends on:** D1, D2
- **Skill:** new-module (controller → routes → mount)
- **Read first:** `server/src/controllers/ledger-core/paymentController.ts` and `server/src/routes/ledger-core/paymentRoutes.ts` — copy both verbatim in shape, including the doc comment that says why the role set is what it is.
- **Files:** `server/src/controllers/ledger-core/bankImportController.ts` (new), `server/src/routes/ledger-core/bankImportRoutes.ts` (new), `server/src/routes/ledger-core/index.ts` (edit — add `import bankImportRoutes from './bankImportRoutes.js';` and `router.use('/bank-imports', bankImportRoutes);`, keeping the alphabetical order of the existing block: `accounts, bank-imports, bills, …`)
- **Contract — the route table, literally:**
  | Method | Path | Auth | Roles | Success | Failure |
  |---|---|---|---|---|---|
  | `POST` | `/api/v1/ledger-core/bank-imports` | `authenticate` | `OWNER`, `ADMIN`, `ACCOUNTANT` | `201` `{ success: true, import, importedCount, duplicateCount, suggestedCount, autoMatchableCount }` | `400` malformed body/CSV · `422` domain (bad account, unparseable rows, no rows) · `409` concurrent duplicate |
  | `GET` | `/api/v1/ledger-core/bank-imports` | `authenticate` | any member | `200` `{ success: true, count, totalCount, currentPage, totalPages, imports }` | — |
  | `GET` | `/api/v1/ledger-core/bank-imports/:id` | `authenticate` | any member | `200` `{ success: true, import }` | `404` not found **or in another organization** |

  Controller exports: `create`, `list`, `getOne`. `list` reads `readPagination(req.query)` and `optionalUuid(req, 'accountId')`. Zero SQL in this file.
- **Guardrails:** #2 no SQL in controllers · #1 the org comes from `requireUser(req).orgId` only — never a header, param or body · `404` never `403` for another tenant's id
- **Proof:** `cd server && npm run typecheck` exits 0 and `npm test -- app` still passes (route mounting is asserted there).
- **Owes:** `docs/api.md` (Spine S4).

---

### Step D4 — `bankImports.test.ts`

- **Depends on:** D3
- **Skill:** **isolation-test**
- **Read first:** `server/src/__tests__/ledger-core/payments.test.ts` — copy its `beforeEach(resetTables)`, `createUserWithOrg`, `loginAgent` setup and its cross-tenant case shape.
- **Files:** `server/src/__tests__/ledger-core/bankImports.test.ts` (new)
- **Contract — these exact cases:**
  | Case name | Expectation |
  |---|---|
  | `imports a clean ISO statement` | `201`; `importedCount` `3`; `GET /bank-transactions` returns 3 lines |
  | `the same statement imported twice yields one set of rows` | **the roadmap's acceptance criterion.** Post the identical body twice → second response `importedCount` `0`, `duplicateCount` `3`; a `SELECT count(*)` on `bank_transactions` returns `3` |
  | `two identical lines in one file both survive, and re-import still dedupes` | a file with two byte-identical rows → `importedCount` `2`; re-import → `importedCount` `0`, `duplicateCount` `2` |
  | `parses a DMY statement with quoted commas and a BOM` | `201`, and the stored `txn_date` is `'2026-03-09'` for input `'09/03/2026'` |
  | `derives a signed amount from a debit/credit pair` | credit `100.00` → `amountCents` `10000`; debit `40.00` → `amountCents` `-4000` |
  | `rejects the whole file when one row has a bad date` | `422`, message contains `'row 3'`, and `SELECT count(*)` on `bank_transactions` is `0` |
  | `rejects a header account` | `422`, message contains `'header account'` |
  | `rejects a non-Asset account` | `422`, message contains `'not an Asset account'` |
  | `rejects a file with no recognisable date column` | `422`, message contains `'date column'` |
  | `rejects an ACCOUNTANT-less role` | a `VIEWER` posting an import gets `403` |
  | `cross-tenant: org B cannot read org A's import` | `GET /bank-imports/:id` with org A's id under org B's token → `404` |
  | `cross-tenant: org B cannot import into org A's account` | `POST` naming org A's `accountId` under org B's token → `422` (`'Bank account not found'`), never `403` |
- **Guardrails:** #15 the cross-tenant cases are mandatory
- **Proof:** `cd server && npm test -- bankImports` — 12 tests pass.
- **If it fails:** fix the service. Never relax an assertion, and never drop an `org_id` predicate to make a query return rows.
- **Owes:** nothing

---

# Slice E — scoring & suggestions

**Outcome:** every imported line carries up to 5 explainable suggestions, each with a stored `score_breakdown`.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Service | `server/src/services/ledger-core/bankMatchService.ts` → `generateSuggestionsOnClient`, `listTransactions`, `getTransactionById`, `rescoreTransaction` |
| Controller | `server/src/controllers/ledger-core/bankTransactionController.ts` → `list`, `getOne`, `rescore`, `match`, `unmatch`, `ignore`, `unignore` |
| Routes | `server/src/routes/ledger-core/bankTransactionRoutes.ts`, mounted at `/bank-transactions` |
| Test | `server/src/__tests__/ledger-core/bankMatching.test.ts` |
| Fixture helper | `server/src/__tests__/helpers/bankFixture.ts` → `buildHundredLineStatement` |

---

### Step E1 — candidate loading and `generateSuggestionsOnClient`

- **Depends on:** A9, B1, D2
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/ledger-core/agingService.ts` **in full** — it already knows how to select open AR/AP documents with a derived amount due; copy its use of `paymentService.allocatedCentsSubquery`. Also re-read `paymentService.allocatedCentsSubquery`'s doc comment on why its string interpolation is safe.
- **Files:** `server/src/services/ledger-core/bankMatchService.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  /** Candidate window: documents dated within this many days of the bank line. */
  export const CANDIDATE_WINDOW_DAYS = 30;

  /** Deletes and regenerates suggestions for the given bank lines, on the
   *  caller's transaction. Only UNMATCHED lines get suggestions. Returns the
   *  number of suggestion rows written. */
  export async function generateSuggestionsOnClient(
    client: PoolClient,
    orgId: string,
    bankTransactionIds: string[],
  ): Promise<number>;
  ```
  Mechanics, exactly:
  1. Empty `bankTransactionIds` → return `0` immediately.
  2. `DELETE FROM bank_match_suggestions WHERE org_id = $1 AND bank_transaction_id = ANY($2::uuid[])`.
  3. Load the lines: `SELECT id, txn_date, description, external_reference, amount_cents FROM bank_transactions WHERE org_id = $1 AND id = ANY($2::uuid[]) AND status = 'UNMATCHED'`.
  4. **One** candidate query for invoices, run only if at least one line is positive:
     ```sql
     SELECT i.id, i.invoice_number, i.issue_date, i.total_cents,
            c.name AS counterparty_name,
            (i.total_cents - <allocatedCentsSubquery('i', 'invoice_id')>::bigint) AS amount_due_cents
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
      WHERE i.org_id = $1
        AND i.status = 'ISSUED'
        AND i.issue_date BETWEEN $2::date AND $3::date
     ```
     where `$2`/`$3` are `min(txn_date) - 30 days` and `max(txn_date) + 30 days` across the positive lines, computed in SQL as `$2::date - 30` / `$3::date + 30`. Filter `amount_due_cents > 0` in a wrapping `SELECT … WHERE amount_due_cents > 0` (an alias cannot be referenced in its own `WHERE`).
  5. The mirror query for bills, run only if at least one line is negative: `bills b JOIN vendors v`, `b.status = 'POSTED'`, `b.bill_date` window, `vendor_reference` as the document reference, `allocatedCentsSubquery('b', 'bill_id')`.
  6. **Direction rule, enforced here and nowhere else:** a positive line is scored against **invoices only**; a negative line against **bills only**.
  7. For each line, `scoreMatch(...)` against every eligible candidate; keep those with `total >= SUGGESTION_MIN_SCORE`; sort by `total DESC`, then by candidate id ascending (a deterministic tiebreaker — without it, two equal-scoring candidates swap between runs); take the first `MAX_SUGGESTIONS_PER_TRANSACTION`.
  8. Batch-insert with `unnest` (`org_id, bank_transaction_id, target_type, invoice_id, bill_id, score, score_breakdown`), passing the breakdowns as a `jsonb[]` built from `JSON.stringify`. Return the row count.
- **Guardrails:** #1 `org_id` in every statement, including the `DELETE` · #4 parameterized; `allocatedCentsSubquery`'s alias arguments are compile-time constants from our own code · #5 every query on `client`
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** if `amount_due_cents > 0` cannot be referenced, wrap the query rather than repeating the subquery in the `WHERE`.
- **Owes:** `study/architecture/fuzzy-matching-and-confidence-scoring.md` (Spine S3).

---

### Step E2 — wire suggestion generation into the import

- **Depends on:** D2, E1
- **Skill:** none (one-line integration)
- **Read first:** the `// suggestions are generated in Step E2` comment left in `bankImportService.importStatement`.
- **Files:** `server/src/services/ledger-core/bankImportService.ts` (edit — replace the stub comment only)
- **Contract:** replace the comment with a call to `bankMatchService.generateSuggestionsOnClient(client, orgId, insertedIds)`, then compute `suggestedCount` and `autoMatchableCount` with a single query on the same client:
  ```sql
  SELECT count(DISTINCT bank_transaction_id) FILTER (WHERE true) AS suggested,
         count(DISTINCT bank_transaction_id) FILTER (WHERE score >= 85) AS auto_matchable
    FROM bank_match_suggestions
   WHERE org_id = $1 AND bank_transaction_id = ANY($2::uuid[])
  ```
  Use the literal `85` only via `AUTO_MATCH_THRESHOLD` interpolated from the imported constant — it is our own compile-time constant, not request input, exactly like `allocatedCentsSubquery`'s aliases.
- **Guardrails:** #5 the same `client`, still inside the import's transaction — a suggestion must not survive a rolled-back import
- **Proof:** `cd server && npm test -- bankImports` — the existing 12 cases still pass.
- **Owes:** nothing

---

### Step E3 — `listTransactions` / `getTransactionById` / `rescoreTransaction`

- **Depends on:** E1
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/ledger-core/paymentService.ts`'s `buildFilters`/`listPayments`/`loadAllocations` — copy the shared-predicate builder, the `p.id DESC` pagination tiebreaker, and the one-query-for-all-children loading of suggestions.
- **Files:** `server/src/services/ledger-core/bankMatchService.ts` (edit — append)
- **Contract — write these literally:**
  ```ts
  export interface ListBankTransactionsOptions {
    page: number;
    limit: number;
    accountId: string | null;
    importId: string | null;
    status: BankTransactionStatus | null;
    from: string | null;
    to: string | null;
    /** ILIKE over description and external_reference. */
    q: string | null;
    /** Only lines carrying a suggestion at or above this score. */
    minScore: number | null;
  }

  export async function listTransactions(
    orgId: string,
    options: ListBankTransactionsOptions,
  ): Promise<{ transactions: BankTransaction[]; totalCount: number }>;

  export async function getTransactionById(orgId: string, id: string): Promise<BankTransaction>;

  /** Deletes and regenerates one UNMATCHED line's suggestions. */
  export async function rescoreTransaction(orgId: string, id: string): Promise<BankTransaction>;
  ```
  - `listTransactions` orders by `bt.txn_date DESC, bt.created_at DESC, bt.id DESC` — the `bt.id DESC` tiebreaker is required or rows swap between pages. The count query and the page query share one predicate builder. `minScore` becomes `EXISTS (SELECT 1 FROM bank_match_suggestions s WHERE s.bank_transaction_id = bt.id AND s.org_id = bt.org_id AND s.score >= $n)`. `q` becomes `(bt.description ILIKE $n OR bt.external_reference ILIKE $n)` with the wildcards in the **parameter**, never in the SQL string.
  - Suggestions load in **one** query for the whole page, keyed into a `Map`, exactly like `loadAllocations`. `documentAmountDueCents` is recomputed at read time from the live document so a stale suggestion shows an honest figure. `autoMatchable` is `score >= AUTO_MATCH_THRESHOLD`.
  - `getTransactionById`: missing or another tenant's → `ApiError(404, 'Bank transaction not found')`.
  - `rescoreTransaction`: `withTransaction(...)`; re-read the line `FOR UPDATE`; status not `UNMATCHED` → `ApiError(422, 'Only an unmatched bank line can be rescored')`; call `generateSuggestionsOnClient`; then return `getTransactionById` after the commit.
- **Guardrails:** #1 `org_id` predicate in every statement · #4 `ILIKE` wildcards live in the bind parameter
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** extends `study/postgresql/aggregating-a-ledger.md` (Spine S3) — one more shared count/page predicate builder.

---

# Slice F — match, unmatch, ignore

**Outcome:** accepting a suggestion posts a real, balanced payment; unmatching voids it. This is the slice that touches money and the GL, so it is deliberately its own slice.

---

### Step F1 — `matchTransaction` / `unmatchTransaction` / `setIgnored`

- **Depends on:** C1, E3
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/ledger-core/paymentService.ts`'s `createPayment` (the transaction shape and the error mapping you will mirror) and `voidPayment`. Then `server/src/types/ledger-core.ts`'s `canTransitionBankTransaction`.
- **Files:** `server/src/services/ledger-core/bankMatchService.ts` (edit — append)
- **Contract — write these literally:**
  ```ts
  export interface MatchTargetInput {
    suggestionId: string | null;
    invoiceId: string | null;
    billId: string | null;
  }

  export async function matchTransaction(
    orgId: string,
    userId: string,
    id: string,
    target: MatchTargetInput,
  ): Promise<BankTransaction>;

  export async function unmatchTransaction(
    orgId: string,
    userId: string,
    id: string,
  ): Promise<BankTransaction>;

  /** POST /:id/ignore  -> ignored = true ; POST /:id/unignore -> ignored = false */
  export async function setIgnored(
    orgId: string,
    id: string,
    ignored: boolean,
  ): Promise<BankTransaction>;
  ```
  `matchTransaction`, exactly, in one transaction:
  1. `SELECT … FROM bank_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE`. Missing → `ApiError(404, 'Bank transaction not found')`.
  2. `canTransitionBankTransaction(current, 'MATCHED')` false → `ApiError(409, 'This bank line is already matched')` when current is `MATCHED`, `ApiError(409, 'This bank line is ignored — un-ignore it first')` when `IGNORED`.
  3. Resolve the target. With `suggestionId`: `SELECT … FROM bank_match_suggestions WHERE id = $1 AND org_id = $2 AND bank_transaction_id = $3` — missing → `ApiError(404, 'Suggestion not found')`. Otherwise the supplied `invoiceId`/`billId`.
  4. **Direction check:** `amount_cents > 0` requires an invoice → otherwise `ApiError(422, 'A deposit can only be matched to an invoice')`; `amount_cents < 0` requires a bill → otherwise `ApiError(422, 'A withdrawal can only be matched to a bill')`.
  5. Load the target `FOR UPDATE` and compute its live amount due (`total_cents` minus posted allocations, the same expression `paymentService.lockAndValidateTargets` uses). Status must be `ISSUED` (invoice) / `POSTED` (bill), else `ApiError(422, 'Only an issued invoice can be paid')` / `'Only an approved bill can be paid'`. Amount due `<= 0` → `ApiError(422, 'That document is already settled')`.
  6. `const amount = Math.abs(line.amount_cents);` if `amount > amountDue` → `ApiError(422, 'The bank line exceeds the amount still due on that document')`. **A single bank line settles at most one document, in full or in part — splitting is out of scope for Phase 6.**
  7. `createPaymentOnClient(client, orgId, userId, { direction: amount_cents > 0 ? 'RECEIVE' : 'PAY', paymentDate: txn_date, amountCents: amount, cashAccountId: line.account_id, customerId, vendorId, method: 'Bank import', reference: line.external_reference, notes: null, allocations: [{ invoiceId, billId, amountCents: amount }], entryDate: null })`.
  8. `UPDATE bank_transactions SET status = 'MATCHED', matched_payment_id = $1, matched_at = now(), matched_by = $2 WHERE id = $3 AND org_id = $4`.
  9. `DELETE FROM bank_match_suggestions WHERE org_id = $1 AND bank_transaction_id = $2` — spent suggestions are derived data and are not kept.
  10. `COMMIT`; return `getTransactionById(orgId, id)`.

  `unmatchTransaction`, exactly, in one transaction:
  1. Line `FOR UPDATE`; missing → `404`. `canTransitionBankTransaction(current, 'UNMATCHED')` false → `ApiError(409, 'This bank line is not matched')`.
  2. Read the linked payment's `status`. If `POSTED`, call `voidPaymentOnClient(client, orgId, userId, matched_payment_id, null)` — which posts the reversing entry. If already `VOID`, skip (someone voided it from `/payments`); do **not** throw.
  3. `UPDATE bank_transactions SET status = 'UNMATCHED', matched_payment_id = NULL, matched_at = NULL, matched_by = NULL WHERE id = $1 AND org_id = $2`.
  4. `generateSuggestionsOnClient(client, orgId, [id])`.
  5. `COMMIT`; return `getTransactionById(orgId, id)`.

  `setIgnored`: `withTransaction`; line `FOR UPDATE`; `canTransitionBankTransaction(current, ignored ? 'IGNORED' : 'UNMATCHED')` false → `ApiError(409, 'This bank line is matched — unmatch it first')`; `UPDATE … SET status = $1`; when un-ignoring, also `generateSuggestionsOnClient`; return the line.

  Error mapping: copy `paymentService`'s local `pgErrorCode`/`pgErrorMessage` helpers into this file (that is the codebase convention — `paymentService`, `billService` and `invoiceService` each carry their own copy) and map `P0001 → ApiError(422, message)`.
- **Guardrails:** #3 `Math.abs` on integer cents, no rounding, no epsilon · #5 every query on the checked-out `client`; `createPaymentOnClient`/`voidPaymentOnClient` exist precisely so this stays one transaction · #6 no `PUT`/`DELETE` on the payment — unmatch **voids** · #10 every status change goes through `canTransitionBankTransaction` · #16 the GL is reached only through `paymentService` → `journalService`, never a direct write to `journal_entries`
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -n "INSERT INTO journal_entries\|INSERT INTO ledger_lines" server/src/services/ledger-core/bankMatchService.ts` returns nothing.
- **If it fails:** if a deferred trigger fires at `COMMIT` with `P0001`, the allocation exceeds the document — fix step 6's check, do not disable the trigger.
- **Owes:** extends `study/architecture/document-lifecycle-fsm.md` (Spine S3).

---

### Step F2 — bank-transaction controller + routes + mount

- **Depends on:** E3, F1, D1 (`matchBankTransactionSchema`)
- **Skill:** new-module (controller → routes → mount)
- **Read first:** `server/src/controllers/ledger-core/billController.ts` (the multi-action controller with `/submit`, `/approve`, `/void`) and `server/src/routes/ledger-core/billRoutes.ts`.
- **Files:** `server/src/controllers/ledger-core/bankTransactionController.ts` (new), `server/src/routes/ledger-core/bankTransactionRoutes.ts` (new), `server/src/routes/ledger-core/index.ts` (edit — add `router.use('/bank-transactions', bankTransactionRoutes);` after `/bank-imports`)
- **Contract — the route table, literally:**
  | Method | Path | Roles | Success | Failure |
  |---|---|---|---|---|
  | `GET` | `/bank-transactions` | any member | `200` `{ success, count, totalCount, currentPage, totalPages, transactions }` | `400` bad `status`/`minScore` |
  | `GET` | `/bank-transactions/:id` | any member | `200` `{ success, transaction }` | `404` |
  | `POST` | `/bank-transactions/:id/rescore` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `200` `{ success, transaction }` | `404` · `422` not UNMATCHED |
  | `POST` | `/bank-transactions/:id/match` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `200` `{ success, transaction }` | `400` body names zero or two targets · `404` · `409` wrong state · `422` domain |
  | `POST` | `/bank-transactions/:id/unmatch` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `200` `{ success, transaction }` | `404` · `409` not matched |
  | `POST` | `/bank-transactions/:id/ignore` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `200` `{ success, transaction }` | `404` · `409` matched |
  | `POST` | `/bank-transactions/:id/unignore` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `200` `{ success, transaction }` | `404` · `409` not ignored |

  Query parsing in `list`: `readPagination`, `optionalUuid(req,'accountId')`, `optionalUuid(req,'importId')`, `optionalIsoDate(req,'from'/'to')`, `optionalText(req,'q',100)`, plus two local helpers mirroring `paymentController`'s `optionalPaymentStatus`: `optionalBankStatus` (`400 'status must be UNMATCHED, MATCHED or IGNORED'`) and `optionalMinScore` (integer `0..100`, else `400 'minScore must be a whole number between 0 and 100'`).

  **There is no `PATCH` and no `DELETE` on this router.** Say so in the file's doc comment, citing rule 6.
- **Guardrails:** #2 zero SQL in the controller · #1 org from `requireUser(req).orgId`
- **Proof:** `cd server && npm run typecheck` exits 0; `npm test -- app` passes.
- **Owes:** `docs/api.md` (Spine S4).

---

### Step F3 — `bankMatching.test.ts` and the 100-line fixture

- **Depends on:** F2
- **Skill:** **isolation-test**
- **Read first:** `server/src/__tests__/ledger-core/payments.test.ts` and `server/src/__tests__/ledger-core/aging.test.ts` (how a non-trivial invoice/bill fixture is built through the API rather than by raw insert).
- **Files:** `server/src/__tests__/helpers/bankFixture.ts` (new), `server/src/__tests__/ledger-core/bankMatching.test.ts` (new)
- **Contract:**
  `bankFixture.ts` exports:
  ```ts
  export interface HundredLineFixture {
    csv: string;
    /** bank line index (0-based) -> the invoice number it truly belongs to. */
    trueMatches: Map<number, string>;
  }
  /** Deterministic — no Math.random, no Date.now. Seeded by a counter. */
  export function buildHundredLineStatement(): HundredLineFixture;
  ```
  100 lines: 40 that exactly match a seeded invoice (same amount, same date, invoice number in the memo), 30 near-misses (right counterparty, amount off by 1 cent or date 5+ days away), 30 pure noise (`'ATM WITHDRAWAL'`, `'CARD PAYMENT TESCO'`, bank fees) with amounts that match no document.

  Test cases, exactly:
  | Case name | Expectation |
  |---|---|
  | `scores a known-good 100-line statement with no false auto-reconcile` | **the roadmap's acceptance criterion.** Import the fixture; for every line, every suggestion with `score >= 85` must point at that line's `trueMatches` entry. Assert `falsePositives` is `0` **and** that at least 30 lines are auto-matchable (so a scorer that suggests nothing cannot pass) |
  | `a near-miss on amount never reaches the threshold` | a line 1 cent off its invoice has no suggestion with `score >= 85` |
  | `accepting a suggestion posts a balanced payment` | `POST /:id/match` → `200`; the invoice's `amountDueCents` drops by the line amount; the created journal entry's debits equal its credits by integer equality |
  | `a matched line reports MATCHED with a payment id` | `status` `'MATCHED'`, `matchedPaymentId` non-null, `suggestions` empty |
  | `unmatching voids the payment and restores the amount due` | `POST /:id/unmatch` → `200`; the payment's status is `'VOID'`; the invoice's `amountDueCents` is back to its original value; a reversing journal entry exists |
  | `unmatching regenerates suggestions` | after unmatch, `suggestions.length` is greater than `0` |
  | `a deposit cannot be matched to a bill` | `422`, message contains `'deposit'` |
  | `a withdrawal cannot be matched to an invoice` | `422`, message contains `'withdrawal'` |
  | `a line larger than the amount due is refused` | `422`, message contains `'exceeds the amount still due'` |
  | `matching an already-matched line is 409` | second `POST /:id/match` → `409` |
  | `unmatching an unmatched line is 409` | `409` |
  | `ignoring then un-ignoring returns to UNMATCHED with suggestions` | statuses `'IGNORED'` then `'UNMATCHED'`, `suggestions.length > 0` |
  | `a matched line cannot be ignored` | `409` |
  | `rescoring a matched line is 422` | `422` |
  | `a VIEWER cannot match` | `403` |
  | `cross-tenant: org B cannot match org A's bank line` | `POST /bank-transactions/:id/match` with org A's line id under org B's token → `404` |
  | `cross-tenant: a suggestion cannot name another tenant's invoice` | matching with org A's `invoiceId` under org B's token → `422`, never `403` |
  | `matching inside a closed fiscal period is refused` | close the period covering the line's date, then match → `422` with the closed-period message; assert the bank line is still `UNMATCHED` (the whole transaction rolled back) |
- **Guardrails:** #15 cross-tenant cases mandatory · #3 the balance assertion is integer equality
- **Proof:** `cd server && npm test -- bankMatching` — 18 tests pass.
- **If it fails:** the false-positive assertion failing means the scorer is too loose — tune `matchScore.ts` and update `matchScore.test.ts`'s constant assertion. **Never** raise the threshold in the test to make it pass.
- **Owes:** nothing

---

# Slice G — reconciliation report

### Step G1 — `reportService.bankReconciliation` + route

- **Depends on:** B2, D2, F1
- **Skill:** new-module (service → controller → route)
- **Read first:** `server/src/services/ledger-core/agingService.ts` — specifically how it computes a subledger total and its GL control-account total **independently** and compares them by integer equality to produce `reconciles`. Copy that discipline exactly.
- **Files:** `server/src/services/ledger-core/reportService.ts` (edit — append `bankReconciliation`), `server/src/controllers/ledger-core/reportController.ts` (edit — append `bankReconciliation`), `server/src/routes/ledger-core/reportRoutes.ts` (edit — add one line)
- **Contract — write these literally:**
  ```ts
  export async function bankReconciliation(
    orgId: string,
    accountId: string,
    asOf: string,
  ): Promise<BankReconciliationReport>;
  ```
  Route: `GET /api/v1/ledger-core/reports/bank-reconciliation?accountId=<uuid>&asOf=<YYYY-MM-DD>`, `authenticate` only (any member — a `VIEWER` exists to read reports, matching every other `/reports` route). `accountId` is **required**: missing → `ApiError(400, 'accountId is required')`. `asOf` defaults to today (UTC) when absent.

  Figures, each its own query, all scoped by `org_id`:
  - `glBalanceCents`: `SUM(l.debit_cents) - SUM(l.credit_cents)` over `ledger_lines l JOIN journal_entries e` for `l.account_id = $2` and `e.entry_date <= $3`.
  - `statementBalanceCents`: `SUM(amount_cents)` over `bank_transactions` for `account_id = $2`, `txn_date <= $3`, `status <> 'IGNORED'`.
  - `matchedCount`/`matchedCents`/`unmatchedCount`/`unmatchedCents`/`ignoredCount`: one query with `FILTER` clauses (the idiom `dashboardService` already uses), not five queries.
  - `differenceCents = glBalanceCents - statementBalanceCents`; `reconciles = differenceCents === 0` — **integer equality, never an epsilon**.
  - `statedClosingBalanceCents`/`statedClosingBalanceOn`: from the `bank_statement_imports` row for this account with the greatest `closing_balance_on <= asOf` and a non-null balance; `null` when there is none. `statedClosingDifferenceCents = statementBalanceCents - statedClosingBalanceCents`, or `null`.

  **Write this caveat into the service's doc comment, and repeat it in `docs/api.md`:** `reconciles` is true only when every GL movement on the cash account also arrived as an imported bank line and vice versa. It is a statement about *completeness of import*, not about correctness of the books — an un-imported month makes it false, correctly.
- **Guardrails:** #1 `org_id` in all four queries · #3 integer equality for `reconciles` · #2 no SQL in the controller
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** `docs/api.md` (Spine S4); extends `study/postgresql/subledger-reconciliation-and-aging.md` (Spine S3).

---

### Step G2 — `bankReconciliation.test.ts`

- **Depends on:** G1
- **Skill:** **isolation-test**
- **Read first:** `server/src/__tests__/ledger-core/aging.test.ts` — its `reconciles === true` fixture is the model.
- **Files:** `server/src/__tests__/ledger-core/bankReconciliation.test.ts` (new)
- **Contract — these exact cases:**
  | Case name | Expectation |
  |---|---|
  | `reconciles when every bank line is matched and nothing else touched cash` | seed one invoice, import one matching line, match it → `reconciles` is `true` and `differenceCents` is `0` |
  | `does not reconcile when a cash movement was never imported` | post a manual journal entry debiting cash → `reconciles` is `false`, `differenceCents` non-zero |
  | `an unmatched line still counts toward the statement balance` | import without matching → `unmatchedCount` `1`, `statementBalanceCents` equals the line |
  | `an ignored line is excluded from the statement balance` | ignore it → `statementBalanceCents` is `0`, `ignoredCount` is `1` |
  | `reports the stated closing balance difference when one was supplied` | import with `closingBalanceCents` → `statedClosingDifferenceCents` is the exact integer difference |
  | `omits the stated closing balance when none was supplied` | all three `stated*` fields are `null` |
  | `requires accountId` | `GET` without it → `400` |
  | `cross-tenant: org B asking about org A's account sees zeroes, not org A's figures` | all counts `0`, `glBalanceCents` `0` — and specifically **not** org A's numbers |
- **Proof:** `cd server && npm test -- bankReconciliation` — 8 tests pass.
- **Owes:** nothing

---

# Slice H — client

**Outcome:** an import page, the approval queue with one-click accept, a reconciliation page, and sidebar entries.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Pages | `client/src/Pages/ledger-core/BankImportPage.tsx`, `BankTransactionsPage.tsx`, `BankReconciliationPage.tsx` |
| Component | `client/src/Pages/ledger-core/MatchScoreBadge.tsx` |
| Routes | `bank/import`, `bank`, `bank/reconciliation` under `/app/ledger-core/` |
| Sidebar group | `Banking` — items `Bank Lines` (`bank`), `Import Statement` (`bank/import`), `Reconciliation` (`bank/reconciliation`) |
| Tests | `client/src/__tests__/ledgerCoreBankImport.test.tsx`, `ledgerCoreBankTransactions.test.tsx`, `ledgerCoreBankReconciliation.test.tsx` |

---

### Step H1 — `BankImportPage.tsx`

- **Depends on:** D3
- **Skill:** none (client page)
- **Read first:** `client/src/Pages/ledger-core/NewBillPage.tsx` (form shape, `apiFetch` usage, error display) and `client/src/services/fetchServices.ts`.
- **Files:** `client/src/Pages/ledger-core/BankImportPage.tsx` (new)
- **Contract:** a form with — a postable Asset account `<select>` (loaded from `GET /ledger-core/accounts`, filtered to `type === 'Asset' && isPostable`), a `<input type="file" accept=".csv,text/csv">` read via `FileReader.readAsText` into state (**the file is never uploaded as multipart** — its text goes in the JSON body), a `dateFormat` `<select>` of `ISO`/`DMY`/`MDY`, an optional collapsible "Column mapping" fieldset with six text inputs, and optional closing-balance + closing-date inputs.
  Submit → `apiFetch<{ import: …; importedCount: number; duplicateCount: number; suggestedCount: number; autoMatchableCount: number }>('/ledger-core/bank-imports', { method: 'POST', body: JSON.stringify(...) })`.
  On success show a summary panel — "Imported N lines, skipped M duplicates, N suggestions, K ready for one-click accept" — and a link to `bank`. On `ApiRequestError` show `err.message` verbatim (the server's `422` already names the failing rows).
  Guard client-side: file text longer than `900_000` characters → refuse before posting, with "That file is too large to import — split it by month."
  A `BackLink` at the top, matching every other drill-down page.
- **Proof:** `cd client && npm run build` succeeds.
- **Owes:** nothing

---

### Step H2 — `MatchScoreBadge.tsx` and `BankTransactionsPage.tsx` (the approval queue)

- **Depends on:** F2, H1
- **Skill:** none (client page)
- **Read first:** `client/src/Pages/ledger-core/BillsPage.tsx` (the tabbed register with per-row actions) and `ConfirmDialog.tsx`.
- **Files:** `client/src/Pages/ledger-core/MatchScoreBadge.tsx` (new), `client/src/Pages/ledger-core/BankTransactionsPage.tsx` (new)
- **Contract:**
  `MatchScoreBadge` — props `{ score: number }`. Renders the number with a band: `>= 85` green ("auto"), `65–84` amber, `< 65` grey. No `any`; the thresholds are module constants mirroring the server's `AUTO_MATCH_THRESHOLD = 85`, with a comment naming `server/src/utils/matchScore.ts` as the source of truth.
  `BankTransactionsPage` — a register over `GET /ledger-core/bank-transactions` with:
  - status tabs `All` / `Unmatched` / `Matched` / `Ignored` (each sets the `status` query param; `All` omits it), plus account, date-range and text filters.
  - one row per line: date, description, reference, signed amount (money in green, money out plain), status, and an Actions cell.
  - an expandable suggestions panel per unmatched line, ordered by score, each row showing `MatchScoreBadge`, the document reference, counterparty, amount due, and the three `scoreBreakdown` reasons rendered as plain text — **the suggestion must be explainable on screen, not just a number**.
  - **Accept** on a suggestion → `POST /:id/match` with `{ suggestionId }`. For a suggestion at or above 85 the button reads `Accept` and acts immediately; below 85 it reads `Match` and is gated by `ConfirmDialog`.
  - **Ignore** / **Un-ignore** → the matching route, no confirmation (both reversible).
  - **Unmatch** → gated by `ConfirmDialog` with the text "This voids the payment this match created and posts a reversing entry." — it is the only irreversible-in-the-GL action on this page.
  - **Rescore** on an unmatched line with no suggestions.
  - Every mutation refetches the current page on success; every failure renders `err.message` in an inline error row.
- **Proof:** `cd client && npm run build` succeeds.
- **Owes:** nothing

---

### Step H3 — `BankReconciliationPage.tsx`

- **Depends on:** G1
- **Read first:** `client/src/Pages/ledger-core/BalanceSheetPage.tsx` (report layout, `EquationBar` usage) and `MetricTile.tsx`.
- **Files:** `client/src/Pages/ledger-core/BankReconciliationPage.tsx` (new)
- **Contract:** account `<select>` + `asOf` date input; four `MetricTile`s (GL balance, statement balance, difference, unmatched count); a clear `reconciles` banner — green "The bank and the books agree" / amber "Difference of X" — and, when `statedClosingBalanceCents` is non-null, a row comparing it. Render the completeness caveat from G1 as a one-line footnote under the banner, in the page itself, not only in the docs.
- **Proof:** `cd client && npm run build` succeeds.
- **Owes:** nothing

---

### Step H4 — routes and sidebar

- **Depends on:** H1, H2, H3
- **Read first:** `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` and `LedgerCoreSidebar.tsx` — note the doc comments explaining that every `to` is a **suffix** resolved against `useAppBasePath()`, never a relative path.
- **Files:** `client/src/Pages/ledger-core/LedgerCoreRoutes.tsx` (edit), `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` (edit)
- **Contract:**
  Routes, added inside the existing `<Routes>`:
  ```tsx
  <Route path="bank" element={<BankTransactionsPage />} />
  <Route path="bank/import" element={<BankImportPage />} />
  <Route path="bank/reconciliation" element={<BankReconciliationPage />} />
  ```
  Sidebar: a new `NAV_GROUPS` entry placed **after** `Purchases` and **before** `Reporting`:
  ```ts
  {
    heading: 'Banking',
    items: [
      { to: 'bank', label: 'Bank Lines', icon: Landmark, end: true },
      { to: 'bank/import', label: 'Import Statement', icon: Upload, end: false },
      { to: 'bank/reconciliation', label: 'Reconciliation', icon: GitCompareArrows, end: false },
    ],
  },
  ```
  `Landmark`, `Upload` and `GitCompareArrows` are added to the existing `lucide-react` import, in alphabetical order with the rest. `end: true` on `bank` is required — without it the parent link stays active on the two child routes.
- **Proof:** `cd client && npm run build` succeeds and `npm test -- Navigation` passes.
- **Owes:** nothing

---

### Step H5 — client tests

- **Depends on:** H4
- **Read first:** `client/src/__tests__/ledgerCoreBills.test.tsx` — copy its `apiFetch` mocking and render-with-router helper exactly.
- **Files:** `client/src/__tests__/ledgerCoreBankImport.test.tsx`, `ledgerCoreBankTransactions.test.tsx`, `ledgerCoreBankReconciliation.test.tsx` (all new)
- **Contract — these exact cases:**
  - **Import (4):** `renders the account picker with only postable Asset accounts`; `posts the file text as JSON, not multipart` (assert the mocked `apiFetch` was called with a `body` containing the CSV text); `shows the imported/duplicate summary on success`; `renders the server's 422 message verbatim`.
  - **Transactions (7):** `lists bank lines with signed amounts`; `shows a green badge for a score of 85 and an amber one for 70`; `renders the three score reasons for a suggestion`; `Accept posts suggestionId to /match`; `Match below the threshold opens the confirm dialog first`; `Unmatch opens a confirm dialog naming the reversing entry`; `renders an empty state when nothing has been imported`.
  - **Reconciliation (3):** `shows the agree banner when reconciles is true`; `shows the difference when reconciles is false`; `renders the completeness caveat`.
- **Proof:** `cd client && npm test` — 125 pre-existing tests still pass, plus 14 new (139 total).
- **Owes:** nothing

---

# Spine — mandatory tail, in this order

### Step S1 — full suite green

- **Depends on:** every step above
- **Proof:**
  ```
  cd server && npm run typecheck && npm test
  cd client && npm run build && npm test
  cd server && npm run verify:integrity
  ```
  Expected: server tests **519 + 51 new = 570** (csv 14, dateParse 17, money +17, levenshtein 11, matchScore 10, bankConstraints 13, bankImports 12, bankMatching 18, bankReconciliation 8 — the arithmetic will not land exactly on 570 if a case count shifts; **report the real number, do not adjust a test file to hit a target**). Client **139**. `verify:integrity` reports all three checks passing.
- **If it fails:** a failing pre-existing test means this phase broke something — fix the cause, do not quarantine the test.

### Step S2 — `guardrail-review`

- **Skill:** **guardrail-review**
- **Scope:** the full diff. Pay particular attention to: every `bank_*` query carrying `org_id`; zero SQL in the two new controllers; no `pool.query` inside any `*OnClient` function; the `paymentService` extraction not having changed behaviour; no `PUT`/`DELETE` route on a bank transaction; integer-cents comparisons only.
- **Proof:** the review reports no rule violations. Fix anything it finds **before** S3.

### Step S3 — study notes

- **Skill:** **study-note**
- **New notes:**
  1. `study/node-express/parsing-untrusted-csv.md` — the RFC 4180 state machine, why a regex cannot parse CSV, BOM handling, delimiter sniffing outside quotes, `\r\n` vs `\r` vs `\n`, whole-string vs streaming parsing and the memory trade-off, and why no library (rule 14 plus the interview value of the state machine).
  2. `study/architecture/fuzzy-matching-and-confidence-scoring.md` — Levenshtein DP, the rolling-array reduction to `O(min(m,n))` space and why the row order matters, normalization before comparison, weighted multi-signal scoring, why the breakdown is stored rather than just the total (explainability), threshold selection and the false-positive cost asymmetry in accounting, and the rejected alternatives: `pg_trgm`/trigram similarity, Jaro-Winkler, Soundex, and an embedding model (Phase 14/16 territory, and forbidden here by rule 14).
  3. `study/postgresql/idempotent-ingestion-and-dedupe-hashes.md` — content-addressed deduplication, `UNIQUE (org_id, dedupe_hash)` scoped rather than global, `INSERT … ON CONFLICT DO NOTHING RETURNING id` as an atomic "how many were new" counter, the identical-rows-within-one-file problem and the occurrence-ordinal fix, why a natural key `(date, amount, description)` fails, and why the hash is computed server-side.
- **Extend:**
  4. `study/typescript/branded-types-for-money.md` — a new section on parsing money from untrusted text without an intermediate float: separator ambiguity (`1,234` vs `1,23`), accounting parentheses, CR/DR suffixes, and why a third decimal digit is a rejection rather than a rounding.
  5. `study/architecture/document-lifecycle-fsm.md` — a new section on a **reversible** FSM whose reverse edge carries a GL side effect, contrasted with `VOID` (terminal because the correction already happened) and `LOCKED` (terminal by promise).
  6. `study/postgresql/subledger-reconciliation-and-aging.md` — a new section on reconciling a GL cash account against an imported statement, and why `reconciles` there is a completeness claim rather than a correctness one.
  7. `study/postgresql/aggregating-a-ledger.md` — one paragraph on the `EXISTS`-based `minScore` filter reusing the shared count/page predicate builder.
- **Also edit:** `study/README.md` — add the three new notes to the index tables (Node & Express, Architecture, PostgreSQL) and update the coverage tracker for Phase 6.
- **Proof:** every new note has all `TEMPLATE.md` sections, including **4–8 interview questions with full written answers**, and states the version verified against (PostgreSQL 17, Node 24, TypeScript 7 — confirm the actual versions from `server/package.json` and `docker-compose.yml` before writing).
- **If unsure of a claim:** flag it in the note rather than asserting it. Accuracy outranks completeness.

### Step S4 — `docs-sync`

- **Skill:** **docs-sync**
- **Files to update:**
  - `docs/api.md` — a `### Bank reconciliation` block under LedgerCore: the 3 `/bank-imports` routes, the 7 `/bank-transactions` routes, and `GET /reports/bank-reconciliation`, each with its role set, request shape and status codes, plus the `reconciles` completeness caveat.
  - `docs/schema.md` — the three new tables with every column, constraint, index and trigger, **and** an explicit line recording that `bank_match_suggestions` is deliberately not audited, added to the audited-table inventory 018 established.
  - `docs/roadmap.md` — tick all five Phase 6 boxes; add a `## Phase 6, as delivered` section in the established voice, recording the real test counts, the deliberate non-goals from §2 of this plan, and the honest statement that a bank line matches at most one document.
  - `docs/ledger-core.md` — update the `**Status:**` line at the top and tick the Phase 6 ladder.
  - `CLAUDE.md` — update the `## State:` heading to Phase 6 and add a Phase 6 bullet to the **Built** list; move bank reconciliation out of **Not built**; leave the Phase 7/8/9 entries alone.
- **Proof:** `docs-sync` reports no drift between `docs/` and the filesystem.

---

## Risks & open questions

| # | Risk / unknown | Handling |
|---|---|---|
| 1 | **The 100-line fixture may not clear "no false auto-reconcile" on the first tuning.** `DATE_POINTS` and the containment rule are judgement calls made here, not measured. | The fixture test is the arbiter. If it fails, tune `matchScore.ts` and update `matchScore.test.ts`'s constant assertion in the same change — never raise the threshold in the test. |
| 2 | **`DMY` vs `MDY` is genuinely ambiguous** for a day ≤ 12 and there is no way to detect it from the data alone. | Resolved by making `dateFormat` an explicit request field defaulting to `ISO`. No heuristic guessing. Documented as a deliberate choice, not a gap. |
| 3 | **A bank line settles at most one document.** Real statements carry batched deposits covering several invoices. | Explicitly out of scope (§2). Stated in the roadmap's "as delivered" section as a known limitation, not hidden. |
| 4 | **`reconciles` is a completeness claim.** An organization that has imported one month of statements against a year of GL activity will see `false`. | Documented in the service comment, `docs/api.md`, and on the page itself (H3). Do not "fix" it by scoping the GL side to the imported date range — that would make the flag meaningless. |
| 5 | **1 MB JSON body limit** caps a statement at roughly 900 KB of CSV, a few thousand lines. | `MAX_CSV_CHARS` enforces it with a clear message on both sides. Raising `JSON_BODY_LIMIT` or adding multipart upload is Phase 10's problem, not this one. |
| 6 | **The `paymentService` extraction (C1) touches a shipped, tested money path.** | Its proof is that the existing payment suites pass **unchanged**, with the same test count. If they do not, the extraction moved too much. |
| 7 | **Suggestion generation runs inside the import transaction**, so a 500-line import scores 500 lines against up to 60 days of open documents before committing. | Acceptable at this scale, and the alternative — deferring it — requires a queue, which is Phase 7 and gated. If it proves slow, that is a Phase 7 follow-up, not an improvisation here. |
| 8 | ~~Unknown: whether `set_updated_at()` exists.~~ **Resolved:** defined in `001_organizations_and_users.sql:20` and reused by nine later migrations. 019 attaches it, it does not define it. |
| 9 | **Same-timing trigger firing order on `bank_transactions`.** Both `trg_bank_transactions_immutable` and `trg_bank_transactions_updated_at` are `BEFORE UPDATE`. PostgreSQL fires same-timing triggers alphabetically by name, so `…_immutable` runs first and `…_updated_at` sets `NEW.updated_at` after it — which is exactly why the immutability trigger's `to_jsonb` diff excludes `updated_at`. This mirrors `trg_payments_immutable` / `trg_payments_updated_at` on `payments`. **Do not rename either trigger** — the ordering is load-bearing. |

---

## Definition of done

- [ ] Migration `019` applies twice cleanly; `npm test -- migrations` passes.
- [ ] `npm run typecheck` exits 0 with no `any`, no `@ts-ignore`, no `tsconfig` change.
- [ ] Server suite green, roughly **570** tests; client suite green, roughly **139**. Real numbers reported, not targets hit by editing tests.
- [ ] Every new module has a cross-tenant isolation case (rule 15): `bankConstraints`, `bankImports`, `bankMatching`, `bankReconciliation`.
- [ ] Both roadmap acceptance criteria have a **named** passing test: `the same statement imported twice yields one set of rows` and `scores a known-good 100-line statement with no false auto-reconcile`.
- [ ] `npm run verify:integrity` passes — matching thousands of bank lines has not written a single unbalanced entry.
- [ ] `guardrail-review` clean over the full diff.
- [ ] Three new study notes plus four extensions filed; `study/README.md` index and coverage tracker updated.
- [ ] `docs/api.md`, `docs/schema.md`, `docs/roadmap.md`, `docs/ledger-core.md` and `CLAUDE.md` all updated in the same change.
- [ ] This plan file deleted, or its `Status:` line changed to `DONE — <date>` with the deviations recorded.

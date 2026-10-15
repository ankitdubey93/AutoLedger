# Phase 43 follow-ups — test-run lock, prefix log redaction, credit-note integrity, email-in checklist

Date: 2026-10-15 · **Status: not started** · Branch: `phase-43` (continue on it; do not create a new branch).

Closes the four caveats left by Phase 43:

1. **Overlapping server test runs fail falsely.** Two `vitest` processes drop and recreate each other's `autodb_test_N` databases. Fix: a session-level PostgreSQL advisory lock taken by `globalSetup`, so a second run fails fast with a clear message.
2. **Log redaction depends on Express internals.** `middleware/requestContext.ts` intercepts `req.params` assignments with an accessor. Fix: replace that with a frozen list of credential-bearing path prefixes, plus a guard test that fails when a new `:token`/`:secret` route appears.
3. **The 43c integrity run skips the invoice side.** The credit-note-on-issue case never runs the integrity verifier. Fix: run it there, and correct case 10's title.
4. **Email-in has never run against real Brevo.** This needs the user's Brevo account and DNS (see Gate). Fix: a written end-to-end checklist in `docs/development.md` (Step 5). The live run itself stays with the user.

## Dispatch — read this before executing anything

You are executing this plan as **one tier only**. Your tier is the one named in the request
(`[Haiku]` or `[Sonnet]`). Then:

1. Work **down the dispatch manifest in step order**. If the request names a batch, run only
   that batch's steps. Do not reorder steps to group tiers.
2. Run a step only if its tier matches yours **and** every step in its `Depends on`
   is marked `done` in the manifest. Otherwise stop and report the blocking step.
3. When the next `todo` step carries the **other** tier, stop and report:
   "Step N is [other tier] — switch model and resume." Do not run it because it looks small.
4. After a step's proof command passes, set its `Status` to `done` in the manifest in the
   same edit session. That column is the only record of progress.
5. If a proof fails twice, stop and report per Execution rules. Never weaken a test,
   a type, an assertion or a guardrail to get a step through, and never `npm install`
   anything the step did not name.
6. Anything this plan did not anticipate is a stop-and-report, not a judgment call.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing an applied migration | This plan has **no migration**. If you think one is needed, stop. |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| A secret or token appears in a log line | Narrowing the test so it no longer looks | Fix `redactPath` |
| Need a helper library | `npm install` anything | Stop and ask (rule 14). **This plan adds no dependency.** |
| The advisory lock blocks your own proof run | Removing the lock, or catching and ignoring the error | Find the other `vitest` process (`pgrep -af vitest`), wait for it, then rerun |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the same step, unchanged, to Sonnet with the failure output, and write "escalated" in its Status cell |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

**Never run two server `vitest` processes at once** while executing this plan. Until Step 1 lands, that is exactly the false failure this plan fixes.

Commands:

- Server tests: `cd server && npx vitest run <path>`; the full suite is `cd server && npm test`.
- Checks: `cd server && npm run typecheck && npm run lint`, and the same three commands in `client/`.
- Direct SQL on the **test** cluster: `docker exec autodb_postgres_test psql -U autodb_user -d postgres -c '…'`. Container `autodb_postgres_test`, port 5433.
- Direct SQL on the dev cluster: `docker exec autodb_postgres psql -U autodb_user -d autodb -c '…'`.

## Starting state (verified 2026-10-15 on `phase-43` @ `6896bd3`)

- **Baseline:** 2249 server tests passing (2 skipped), 660 client tests passing, `npm run verify:integrity` all 7 PASS, last migration `096`.
- **Test databases** are set up by `server/src/__tests__/setup/globalSetup.ts`.
  - It migrates `autodb_test` (from `TEST_DATABASE`), then `DROP DATABASE IF EXISTS … WITH (FORCE)` and `CREATE DATABASE … TEMPLATE` for `autodb_test_1..3` (`TEST_MAX_WORKERS = 3`), then `flushdb` on Redis dbs 1..3.
  - Admin connections are `new Client({ host, port, user, password, database: 'postgres', connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS })`.
  - It exports only a default `setup()` and returns nothing. Vitest is 4.1.10; a `globalSetup` default export may return a teardown function.
  - Nothing stops a second run from executing the same drop/create underneath the first.
- **Request log redaction** lives in `server/src/middleware/requestContext.ts` (`attachRequestContext`).
  - It holds `SECRET_PARAMS = ['token', 'secret']`, `redactPath(path, params)`, and an `Object.defineProperty(req, 'params', { get, set })` accessor that records credential params into `routeParams`.
  - The `finish` listener logs `path: redactPath(req.originalUrl.split('?')[0] ?? '', routeParams)`.
  - `API_BASE_PATH` (`/api/v1`) comes from `server/src/config/constants.ts`.
- **Routes that carry a credential in the path.** `grep -rn ":token\|:secret" server/src/routes` gives exactly **13 routes**:

  | Mount | Router file | Routes |
  |---|---|---|
  | `/api/v1/auth/invitations/` | `routes/auth.ts` | 2 |
  | `/api/v1/public/quotes/` | `routes/accounting/publicQuoteRoutes.ts`, mounted in `routes/accounting/index.ts` | 6 |
  | `/api/v1/public/statements/` | `routes/accounting/publicStatementRoutes.ts` | 4 |
  | `/api/v1/public/inbound-mail/brevo/` | `routes/integrations/inboundMail.ts`, mounted in `routes/index.ts` | 1 |

- **Existing redaction test:** `server/src/__tests__/logRedaction.test.ts` has 2 tests (webhook secret; quote token on `/pdf?x=1`) that spy on `logger.info` and filter calls whose second argument is `'request completed'`.
- **Router-walker pattern:** `server/src/__tests__/platform/routePermissions.test.ts`, function `collect(router, out, trail)`. It walks Express 5.2 internals (`stack`, `layer.route`, `layer.handle.stack`) and **skips `authRouter`** by identity. Route paths are relative (the mount prefix is not recoverable).
- **43c test:** `server/src/__tests__/accounting/applyCreditsOnApproval.test.ts` has an `expectIntegrity()` helper.
  - Case `7. an unapplied customer credit note is applied when the invoice is issued` ends with `expect(ledger.body.closingBalanceCents).toBe(open.body.outstandingCents);` and never calls `expectIntegrity()`.
  - Case 10's title claims "a note, a prepayment and a credit note", but it applies only a debit note and a prepayment.
- **Docs.**
  - `docs/development.md` L130, the `LOG_LEVEL` row, has a **malformed extra table cell** that describes the param-based redaction.
  - L179 `### Setting up email-in (Brevo inbound parsing)` has setup steps but no verification checklist.
  - `study/architecture/inbound-email-webhooks.md` L19, L50 and L64–65 describe the `req.params` accessor.
  - `study/*/testing-with-vitest.md` exists; find it with `ls study/*/testing-with-vitest.md`.
  - `docs/testing.md` L58–60 describes the per-worker clones.

## Gate

Phase 43 is built. Nothing in caveats 1–3 is blocked.

**Caveat 4 is blocked on things only the user can provide:** a Brevo account with inbound parsing, MX records on a receiving subdomain, and a publicly reachable URL for the webhook. This plan writes the checklist (Step 5). It does **not** plan the live run, any live-test harness, or the OAuth-bearer fallback for attachment downloads — that last one stays a stop-and-report if a live run returns 401 (see Risks).

## Decisions fixed at plan time

- **Test-run lock.**
  - Lock type: `pg_try_advisory_lock(7243001)`, a **session-level** advisory lock on the `postgres` maintenance database of the test cluster. The key `7243001` is arbitrary and unique in this repo; verify with `grep -rn 7243001 server/src` → only the new code.
  - It is taken **first** in `setup()`, before any migrate, drop, create or flush, on a dedicated `Client` that stays open for the whole run.
  - Teardown (the function `setup()` returns) runs `SELECT pg_advisory_unlock(7243001)` and `end()`.
  - A crashed run releases the lock automatically when its connection closes. That is why it is a session lock and not a lock file.
  - **Fail fast, never wait.** A waiting run would still clone over databases that the earlier run's workers had already finished with; failing is unambiguous.
- **Redaction.**
  - Redaction matches by **path prefix**, case-insensitively, because Express routing is case-insensitive by default, so `/API/V1/PUBLIC/QUOTES/x` reaches the quote route.
  - The **one segment** after the prefix becomes `[redacted]`; everything after it stays.
  - An empty segment (the path ends at the prefix) leaves the path unchanged.
  - The query string is still stripped before redaction.
  - `req.params` is no longer touched.
  - A guard test counts the `:token`/`:secret` routes (13). Adding one fails the test until its mount is added to the prefix list.
- **One commit** for the whole plan (Step 7), message `Phase 43 follow-ups: test-run lock, prefix log redaction, credit-note integrity check`. Step 7 also deletes `plans/phase-43-terms-attachments-credits-email-in.md` (committed in `6896bd3` as a record) and this file.

---

## Slice A — test runs cannot overlap

Outcome: a second `npm test` started while one is running fails within seconds with a message naming the cause, instead of producing false failures in both.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Constant | `TEST_RUN_LOCK_KEY = 7243001` (in `globalSetup.ts`, module scope) |
| Error message | `'Another server test run is already using the test databases (autodb_test_N). Wait for it to finish — two runs cannot overlap.'` |
| Teardown | the `async () => Promise<void>` returned by `setup()` |

### Step 1 — [Sonnet] Advisory lock in `globalSetup`

- **Model:** [Sonnet] — test-infrastructure concurrency; a mistake here either deadlocks every run or silently drops the guard.
- **Depends on:** —
- **Read first:** `server/src/__tests__/setup/globalSetup.ts` (whole file — the `admin` and `clone` clients and their timeout handling).
- **Files:** `server/src/__tests__/setup/globalSetup.ts` (edit)
- **Contract:**
  - Change the signature to `export default async function setup(): Promise<() => Promise<void>>`.
  - Immediately after the `process.env.*` overrides, and **before** the existing `admin` client connects, create `const lock = new Client({ …same options as admin, database: 'postgres' })` and `await lock.connect()`.
    - On a connect failure, reuse the existing "Could not reach PostgreSQL…" error. Move that throw into a small local `function unreachable(err: unknown): Error` that both `admin` and `lock` call, so the text is not duplicated.
  - Then run `const { rows } = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [TEST_RUN_LOCK_KEY]);`.
    - If `rows[0]?.locked !== true`: `await lock.end()` and throw `new Error(<the message in the registry>)`.
  - Everything else in `setup()` stays exactly as it is.
  - If any later part of `setup()` throws, the lock must still be released. Wrap the rest of the body in `try { … } catch (err) { await lock.query('SELECT pg_advisory_unlock($1)', [TEST_RUN_LOCK_KEY]).catch(() => undefined); await lock.end().catch(() => undefined); throw err; }`.
  - At the end, return the teardown: `return async () => { await lock.query('SELECT pg_advisory_unlock($1)', [TEST_RUN_LOCK_KEY]).catch(() => undefined); await lock.end().catch(() => undefined); };`.
  - Add a doc comment above `TEST_RUN_LOCK_KEY` covering four points: why a session-level advisory lock (it is released by the server when the connection drops, so a crashed or killed run never leaves a stale lock); why `try` rather than a blocking `pg_advisory_lock` (fail fast); why it is taken before the drop/create loop; and that it guards against `autodb_test_N` being dropped under a running suite.
- **Guardrails:** #4 the key is a bound parameter · #14 `pg` only, no new package.
- **Proof** (run each command one at a time, in the foreground):
  1. `cd server && npx vitest run src/__tests__/dueDate.test.ts`. Expect 12 passed; the lock is taken and released.
  2. `docker exec autodb_postgres_test psql -U autodb_user -d postgres -tc "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 7243001"`. Expect `0` (released after the run).
  3. Hold the lock from outside, then start a run:
     - `docker exec -d autodb_postgres_test psql -U autodb_user -d postgres -c "SELECT pg_advisory_lock(7243001), pg_sleep(40)"`
     - `until docker exec autodb_postgres_test psql -U autodb_user -d postgres -tc "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 7243001 AND granted" | grep -q 1; do :; done`
     - `cd server && npx vitest run src/__tests__/dueDate.test.ts 2>&1 | grep -c "Another server test run is already using the test databases"`

     Expect `1`, with the run failing in under 10 seconds.
  4. Wait for the held lock to expire: `until [ "$(docker exec autodb_postgres_test psql -U autodb_user -d postgres -tc "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 7243001")" -eq 0 ]; do :; done`. Then `cd server && npm run typecheck && npm run lint` clean, and `npx vitest run src/__tests__/migrations.test.ts`, 15 passed.
- **If it fails:** a run that hangs means a blocking call slipped in. The lock call must be `pg_try_advisory_lock`. Never remove the lock to make a proof pass.
- **Owes:** `docs/testing.md` and the vitest study note (Step 7).

---

## Slice B — redaction by path prefix

Outcome: credential path segments are redacted by a plain, testable prefix function that touches no Express internals, and a new credential route cannot ship unredacted without a test failing.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Constant | `SECRET_PATH_PREFIXES` (exported, `readonly string[]`, in `server/src/middleware/requestContext.ts`) |
| Function | `export function redactPath(path: string): string` (same file; replaces the current two-argument one) |
| Removed | `SECRET_PARAMS`, `routeParams`, `currentParams`, the `Object.defineProperty(req, 'params', …)` block |
| Test file | `server/src/__tests__/logRedaction.test.ts` (edit) |
| Guard count | `CREDENTIAL_ROUTE_COUNT = 13` (in the test file) |

### Step 2 — [Sonnet] Replace the `req.params` accessor with `SECRET_PATH_PREFIXES`

- **Model:** [Sonnet] — security behaviour on every request (rule 11).
- **Depends on:** 1
- **Read first:** `server/src/middleware/requestContext.ts` (whole file); `server/src/config/constants.ts` (`API_BASE_PATH`).
- **Files:** `server/src/middleware/requestContext.ts` (edit)
- **Contract:**
  ```ts
  import { API_BASE_PATH } from '../config/constants.js';

  /**
   * Mount prefixes of routes whose next path segment is a credential —
   * invitation, quote and statement link tokens, and the inbound-mail
   * webhook secret. That one segment is logged as `[redacted]` (rule 11).
   * A new `:token`/`:secret` route must add its mount here; the guard test in
   * logRedaction.test.ts counts those routes and fails until it does.
   */
  export const SECRET_PATH_PREFIXES: readonly string[] = Object.freeze([
    `${API_BASE_PATH}/auth/invitations/`,
    `${API_BASE_PATH}/public/quotes/`,
    `${API_BASE_PATH}/public/statements/`,
    `${API_BASE_PATH}/public/inbound-mail/brevo/`,
  ]);

  /** `path` has no query string. Case-insensitive prefix match — Express routing is case-insensitive. */
  export function redactPath(path: string): string;
  ```
  - Body behaviour: lowercase `path` once for comparison only. For the first prefix that the lowercased path `startsWith` (prefix also lowercased), let `rest = path.slice(prefix.length)`.
    - If `rest === ''` or `rest.startsWith('/')`, return `path` unchanged.
    - Otherwise let `i = rest.indexOf('/')` and return `path.slice(0, prefix.length) + '[redacted]' + (i === -1 ? '' : rest.slice(i))`.
    - No prefix matches → return `path`.
  - The `finish` listener logs `path: redactPath(req.originalUrl.split('?')[0] ?? '')`. Keep the existing comment about stripping the query string.
  - Delete `SECRET_PARAMS`, the old `redactPath`, `routeParams`, `currentParams`, the `Object.defineProperty` block and its comment.
- **Guardrails:** #11 — nothing else in the log line changes, and no new field is logged.
- **Proof:** `cd server && npm run typecheck && npm run lint` clean; `grep -c "defineProperty\|SECRET_PARAMS" src/middleware/requestContext.ts` → `0`; `npx vitest run src/__tests__/logRedaction.test.ts`, the existing 2 pass unchanged.
- **If it fails:** an existing redaction test failing means `redactPath` is wrong. Do not edit those two tests.

### Step 3 — [Sonnet] Redaction tests: unit table, every credential mount, route-count guard

- **Model:** [Sonnet] — a security test whose job is to fail on a future omission.
- **Depends on:** 2
- **Read first:** `server/src/__tests__/logRedaction.test.ts`; `server/src/__tests__/platform/routePermissions.test.ts` (the `RouteLayer` interface and `collect`).
- **Files:** `server/src/__tests__/logRedaction.test.ts` (edit)
- **Contract — keep the two existing tests unchanged and add:**
  1. `describe('redactPath')` with `it.each` over exactly these rows, asserting `redactPath(input) === expected`:

     | input | expected |
     |---|---|
     | `/api/v1/public/quotes/abc/pdf` | `/api/v1/public/quotes/[redacted]/pdf` |
     | `/api/v1/public/quotes/abc` | `/api/v1/public/quotes/[redacted]` |
     | `/api/v1/public/statements/abc/payments/pi_1/confirm` | `/api/v1/public/statements/[redacted]/payments/pi_1/confirm` |
     | `/api/v1/auth/invitations/abc/accept` | `/api/v1/auth/invitations/[redacted]/accept` |
     | `/api/v1/public/inbound-mail/brevo/s3cret` | `/api/v1/public/inbound-mail/brevo/[redacted]` |
     | `/API/V1/PUBLIC/QUOTES/abc` | `/API/V1/PUBLIC/QUOTES/[redacted]` |
     | `/api/v1/public/quotes/` | `/api/v1/public/quotes/` |
     | `/api/v1/invoices/123e4567-e89b-12d3-a456-426614174000` | `/api/v1/invoices/123e4567-e89b-12d3-a456-426614174000` |
     | `/api/v1/auth/login` | `/api/v1/auth/login` |
  2. Two request-driven tests in the existing `describe('request log redaction')`, in the same style as the existing two (`vi.spyOn(logger, 'info')`, `loggedPaths`, `not.toContain(<raw>)`):
     - `'redacts an invitation token'`: `GET /api/v1/auth/invitations/<'invite-token-' + 'z'.repeat(30)>` → paths contain `/api/v1/auth/invitations/[redacted]`.
     - `'redacts a statement token'`: `GET /api/v1/public/statements/<'stmt-token-' + 'w'.repeat(30)>` → paths contain `/api/v1/public/statements/[redacted]`.

     The response status is irrelevant; only the log line is asserted.
  3. `describe('credential routes')`, `it('every :token / :secret route is covered — update SECRET_PATH_PREFIXES when this count changes')`.
     - Copy `RouteLayer` and `collect` from `routePermissions.test.ts`, **minus** the `layer.handle === authRouter` skip, since the invitation routes live there.
     - Walk the default export of `../routes/index.js`, keep routes whose `layer.route.path` contains `:token` or `:secret`, and assert their count `toBe(CREDENTIAL_ROUTE_COUNT)` (13).
     - Assert `SECRET_PATH_PREFIXES` has length 4.
     - Put a comment above `CREDENTIAL_ROUTE_COUNT`: "Adding a route with a `:token`/`:secret` param changes this count. Add the route's mount to SECRET_PATH_PREFIXES in middleware/requestContext.ts, add a row to the redactPath table above, then update the count."
- **Guardrails:** #11 every request-driven test asserts the raw credential never appears in `JSON.stringify(spy.mock.calls)`.
- **Proof:** `cd server && npx vitest run src/__tests__/logRedaction.test.ts` → **14 passed** (2 existing + 9 table rows + 2 request-driven + 1 guard); `npm run typecheck && npm run lint` clean.
- **If it fails:** if the guard counts something other than 13, re-run `grep -rn ":token\|:secret" server/src/routes` and report both numbers. Do not change the constant to match an unexplained count.

---

## Slice C — integrity on the credit-note path

Outcome: the integrity verifier also runs after a credit note is applied when an invoice is issued.

### Step 4 — [Sonnet] Run `expectIntegrity()` in 43c case 7; fix case 10's title

- **Model:** [Sonnet] — an integration test against real PostgreSQL (the plan tier rule), though the edit is literal.
- **Depends on:** 3
- **Read first:** `server/src/__tests__/accounting/applyCreditsOnApproval.test.ts`: `expectIntegrity` (~L141), case 7 (~L274), case 10 (~L378).
- **Files:** `server/src/__tests__/accounting/applyCreditsOnApproval.test.ts` (edit)
- **Contract:**
  - In case 7, after `expect(ledger.body.closingBalanceCents).toBe(open.body.outstandingCents);`, add `await expectIntegrity();`.
  - Rename case 10's title to `'10. the integrity verifier passes after a debit note and a prepayment have been applied on posting'`. Its body is unchanged.
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/applyCreditsOnApproval.test.ts` → 10 passed.
- **If it fails:** an integrity failure in case 7 is a real defect in the 43c invoice path (`applyCreditNoteOnClient` on issue). **Stop and report the failing check's name and details.** Do not remove the call.

---

## Slice D — email-in end-to-end checklist

Outcome: the user has a literal checklist for the one verification only they can run.

### Step 5 — [Haiku] "Verifying email-in end to end" in `docs/development.md`

- **Model:** [Haiku] — transcription; the full text is below.
- **Depends on:** —
- **Read first:** `docs/development.md` from `### Setting up email-in (Brevo inbound parsing)` (~L179) to the next `###` heading.
- **Files:** `docs/development.md` (edit)
- **Contract:** insert this block verbatim **immediately after** the last line of the "Setting up email-in" section, before the next `###` heading:

  ```markdown
  #### Verifying email-in end to end

  The automated tests fake Brevo (`server/src/__tests__/integrations/inboundMail.test.ts`); nothing has yet been verified against the real service. After the setup above:

  1. `dig MX <INBOUND_MAIL_DOMAIN> +short` lists `10 inbound1.sendinblue.com.` and `20 inbound2.sendinblue.com.`.
  2. Sign in, open **Settings → Bill inbox** and copy the address from **Email bills in**.
  3. From any mailbox, send one email to that address with a one-page PDF invoice attached, and a second with only a `.docx` attached.
  4. Within a minute, the **Email bills in** table shows the first message `IMPORTED` (1/1) and the second `REJECTED`. The bill inbox lists the PDF as a new document.
  5. The server log has a `request completed` line for `POST /api/v1/public/inbound-mail/brevo/[redacted]` with status `200` — and the secret itself appears nowhere in the log.
  6. Click **Generate new address**, send to the old address again: no new message appears.

  If step 4 shows `FAILED` with an HTTP 401 from the attachment download, Brevo is rejecting the `api-key` header for inbound attachments. Do not change the code; record it — an OAuth-bearer download path is a separate, unplanned change.
  ```
- **Proof:** `grep -c "#### Verifying email-in end to end" docs/development.md` → `1`; `grep -n "Verifying email-in\|^### \|^#### " docs/development.md` shows the new heading directly after the "Setting up email-in" section and before the next `###`.
- **If it fails:** the section boundary is unclear → stop and report the surrounding headings.

---

## Close-out

### Step 6 — [Sonnet] Guardrail review, study notes, docs-sync, commit, delete plan files

- **Model:** [Sonnet] — accuracy tasks plus the commit.
- **Depends on:** 1, 2, 3, 4, 5
- **Skills:** guardrail-review → study-note → docs-sync
- **Files:**
  - `docs/development.md`: rewrite the malformed `LOG_LEVEL` row (~L130) as a valid 3-column row. The redaction sentence becomes: "The `request completed` line's `path` has the path segment after each prefix in `SECRET_PATH_PREFIXES` (`middleware/requestContext.ts` — invitation, quote and statement links, the inbound-mail webhook) replaced by `[redacted]`, and the query string is dropped (rule 11)."
  - `docs/testing.md`: after the per-worker clone paragraph (~L60), add one paragraph covering four points: `globalSetup` takes session advisory lock `7243001` on the test cluster before cloning; a second concurrent run fails at once with the registry message; a killed run releases the lock when its connection closes; check with `pgrep -af vitest`.
  - `docs/api.md`: check the inbound-mail section's "replaced by `[redacted]`" sentence (~L1187). It stays true; change nothing unless docs-sync finds drift.
  - `docs/roadmap.md`: under `## Phase 43, as delivered`, before `**Deliberately not built (Phase 43):**`, add a `**Follow-ups (2026-10-15):**` paragraph. It names the test-run lock, prefix redaction replacing the `req.params` accessor (and why: it relied on Express assigning `req.params` per layer — an internal behaviour), the credit-note integrity run, and the email-in checklist. Remove "no real-Brevo end-to-end run" from "Deliberately not built" **only if** that list claims a checklist is missing. The live run itself is still not done; keep that.
  - `CLAUDE.md`: in the Phase 43 bullet, append one clause: `; follow-ups: test runs serialised by an advisory lock, log redaction by path prefix`.
  - `study/architecture/inbound-email-webhooks.md`: rewrite L19, the L50 gotcha and the L64–65 Q&A. They should say: redaction is by mount prefix; the `req.params`-at-`finish` trap is kept as the *reason* the params-based approach was abandoned (Express restores `req.params` while unwinding, and an accessor fix depends on Express assigning `req.params` per layer, which is not a public API); the guard test makes a new credential route fail CI.
  - `study/*/testing-with-vitest.md` (extend): a section "Serialising whole test runs with a PostgreSQL advisory lock". Cover:
    - session- vs transaction-level advisory locks;
    - `pg_try_advisory_lock` vs `pg_advisory_lock`;
    - release on disconnect, and why that beats a lock file (no stale-lock cleanup);
    - why the lock is taken before `DROP DATABASE … WITH (FORCE)`;
    - the alternative rejected: unique database names per run, which costs a clone per run and orphans databases on crash;
    - 2–3 new Q&A with full answers.

    State the PostgreSQL version verified against (`docker exec autodb_postgres_test psql -U autodb_user -d postgres -tc "SHOW server_version"`).
  - `study/README.md`: update the index and tracker entries for both notes.
- **Proof:**
  - guardrail-review over `git diff HEAD` (the working tree since the plan commit) reports zero violations.
  - Run one at a time: `cd server && npm test` → ≥ 2261 passed (2249 + 12 new in logRedaction, + 0 elsewhere), 2 skipped. `cd client && npm test` → 660 passed. `npm run typecheck && npm run lint` clean in both. `cd server && npm run verify:integrity` → all 7 PASS.
  - `git rm plans/phase-43-terms-attachments-credits-email-in.md`, then stage every changed file by path, plus this plan file's deletion (`git rm plans/phase-43-followups.md` — it is committed in the commit right after `6896bd3`).
  - Commit `Phase 43 follow-ups: test-run lock, prefix log redaction, credit-note integrity check`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - `git status --short` → empty.
- **If it fails:** a guardrail finding goes back to the step that introduced it. A test-count shortfall means a test was lost: stop and report.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Advisory lock in `globalSetup` | — | 2 | todo |
| A | 2 | Sonnet | Prefix redaction in `requestContext` | 1 | 3 | todo |
| A | 3 | Sonnet | Redaction tests + route-count guard | 2 | 4 | todo |
| A | 4 | Sonnet | Integrity in 43c case 7 | 3 | 6 | todo |
| B | 5 | Haiku | Email-in verification checklist | — | 6 | todo |
| C | 6 | Sonnet | Review, study notes, docs-sync, commit, delete plans | 1–5 | — | todo |

Batches: A (Sonnet 1–4) → B (Haiku 5) → C (Sonnet 6). Step 5 has no dependency and could run first, but keep the manifest order.

Do **not** split: Steps 2 and 3 must land together before any commit (a prefix list without its guard test is the regression this plan exists to stop); Step 1 is one step because the lock, its error path and its teardown are one invariant.

## Risks & open questions

- **Route count of 13** was verified by `grep` on 2026-10-15. If the walker counts differently (for example, a router mounted twice), Step 3 stops and reports rather than adjusting the constant.
- **Vitest teardown on Ctrl-C:** if Vitest is killed before calling the teardown, the lock is still released when the process's connection closes. That is the reason for a session lock. Not separately tested.
- **CI** runs one suite per job, so it is unaffected. If CI ever runs server tests twice in parallel against one database service, the second will now fail. That is intended.
- **Brevo:** the live run, and whether inbound attachment download accepts `api-key` alone, remain unknown until the user runs the Step 5 checklist. An OAuth-bearer path is not planned.
- **Path variants:** redaction assumes Express does not route paths with `//` or encoded `/` (`%2F`) into these routers. A path the prefix check misses but Express still routes would log a token. Express 5's path-to-regexp does not match `%2F` as a separator. Not separately verified — flag it in the study note as unverified.

## Definition of done

- All 6 steps `done`.
- Server ≥ 2261 passed (2 skipped) and client 660 passed, with no overlapping runs used to get there.
- A second concurrent server run fails fast with the registry message.
- No `req.params` accessor remains.
- `verify:integrity` clean; guardrail-review zero violations.
- `development.md`, `testing.md`, `roadmap.md` and `CLAUDE.md` updated; two study notes updated and indexed.
- One commit on `phase-43`; both Phase 43 plan files deleted in it; `git status` clean.

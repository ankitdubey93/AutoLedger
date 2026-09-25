# Phase 29 — retire five apps, keep the core three

**Date:** 2026-09-23
**Status:** done — all 17 steps complete and independently verified. Server: 124 test files, 1550 passing, 2 skipped, 0 failed. Client: 52 test files, 283 passing, 0 skipped, 0 failed. Both typechecks green, client build green, migration 068 applied and idempotent, all 5 integrity checks pass, guardrail-review zero violations. See the mid-execution corrections recorded in "Risks & open questions" below — six real gaps in this plan's own Starting State or contracts were found and fixed during execution, none silently routed around.
**Scope:** Remove **TaxGuard AI** (`taxguard`), **FP&A Engine** (`fpa-engine`), **UnitEcon** (`unitecon`), **BoardDeck Automator** (`boarddeck`) and **ForecasterPro** (`forecaster`) from the suite, together with the **Phase 18 sandbox dataset**. The suite becomes three apps: **LedgerCore**, **AP-Flow**, **StockLedger**.

This is a deletion phase. It adds one migration and no features.

---

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

---

## Starting state — verified on the filesystem 2026-09-23

Working tree clean, branch `main`, 67 migrations applied.

**What exists and is being removed:**

| Surface | Location | Size |
|---|---|---|
| Server app dirs | `server/src/{services,controllers,routes,schemas,__tests__}/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}/` | 25 dirs, ~110 files |
| Server app types | `server/src/types/{taxguard,fpa-engine,unitecon,boarddeck,forecaster,sandbox}.ts` | 6 files |
| Server app utils | `server/src/utils/{taxActParse,fpaProjection,forecasterBuild,uniteconCohort,uniteconPvm,boarddeckVariance}.ts` | 6 files |
| Flat unit tests | `server/src/__tests__/{fpaProjection,forecasterBuild,uniteconCohort,uniteconPvm,boarddeckVariance,taxActParse}.test.ts` | 6 files |
| Sandbox | `server/src/{routes/sandbox.ts,controllers/sandboxController.ts,schemas/sandboxSchema.ts,services/sandbox/,scripts/seedDemo.ts}` + 7 `sandboxSeed.ts` files (incl. inside `ledger-core/` and `ap-flow/`) + 2 platform tests | ~13 files |
| Queue handlers | `server/src/queue/handlers/{boarddeckGenerateHandler,taxguardEmbedHandler}.ts` | 2 files |
| Client pages | `client/src/Pages/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}/` + `client/src/Pages/SandboxCard.tsx` | 32 files |
| Client tests | 14 `.test.tsx` files under `client/src/__tests__/` | 14 files |
| Docs | `docs/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}.md` | 5 files, 620 lines |
| DB tables | 20 tables created by migrations `033`–`047` | 20 tables |

**What survives and must not break:**

- `server/src/services/redactionService.ts` and `server/src/utils/pii.ts` — shared with AP-Flow, **keep**.
- `server/src/services/accounting/reportService.ts` → `resolveControlAccounts` and `server/src/types/accounting.ts` → `ControlAccounts` — used by LedgerCore's own party-ledger and aging services (Phase 25), **keep** even though their doc comments mention FP&A.
- `walkthrough/` and `npm run walkthrough` — LedgerCore-only, untouched.
- `server/src/db/integrity.ts` — all five checks are LedgerCore/StockLedger, untouched.
- `GEMINI_API_KEY` and `CAPTURE_GEMINI_MODEL` — AP-Flow's, **keep**. Only `TAXGUARD_EMBEDDING_PROVIDER` and `VOYAGE_API_KEY` go.

**Verified structural facts this plan depends on:**

- No kept migration has a `REFERENCES` into any of the 20 doomed tables. The drop is FK-clean.
- `server/src/db/migrate.ts` enforces **gapless sequential prefixes** and **SHA-256-checksums every applied file**. Migrations `033`–`047` therefore **stay on disk untouched**; a new `068` drops what they built. Renumbering was considered and rejected (see Risks).
- `client/src/services/fetchServices.ts` lines **3307–4580** are one contiguous block covering `fpa-engine (12)`, `forecaster (13)`, `UnitEcon (Phase 14)`, `BoardDeck`, `TaxGuard AI` and `platform: sandbox (Phase 18)`. Line 4581 begins `Phase 26 — credit & debit notes`, which is kept.
- `docker-compose.yml` must **keep** `pgvector/pgvector:pg16`: migration `044` still runs on a fresh database and still needs `CREATE EXTENSION vector`, even though `068` drops it again.

---

## Gate

Phase 29. Nothing gates a deletion — every prerequisite is the code being deleted. Phase 17 (QuickBooks) stays deferred and unbuilt; it depended on LedgerCore only, so it is unaffected.

**Roadmap debt carried in:** Phase 27 owes study notes that were skipped at the user's direction. This plan does **not** pay that debt — it only corrects notes that make false claims. The debt stays recorded in `docs/roadmap.md`.

---

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error on `033`–`047` | Editing or deleting those files | They are immutable (rule 13). `068` drops what they built. Stop and report |
| `npm run typecheck` fails after a deletion | `as any`, `@ts-ignore`, `// eslint-disable`, stubbing a deleted module | Delete the dangling import or reference named in the error |
| A test fails because its fixture slug is gone | Deleting or skipping the test | Swap the fixture slug to `stock` exactly as the step says |
| A kept file still mentions a removed app | Leaving it because "it's only a comment" | Rewrite the comment to name a surviving analogue, per the step |
| `DROP EXTENSION vector` errors | `DROP ... CASCADE` on the extension | Stop and report — a dependent column survived and the table list is wrong |
| A deleted file turns out to be imported by kept code | Recreating a stub | Stop and report — the plan's Starting state is wrong |
| Need a helper library | `npm install` anything | Stop and ask (rule 14) |
| A `[Haiku]` step's proof fails twice | Retrying, trimming the step, "good enough" | Escalate the step **unchanged** to Sonnet with the failure output, and note the escalation in this file |
| The step needs a decision this plan never made | Deciding it | Stop and report — the plan is the defect |

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

**Expected transient breakage:** between Step 3 and Step 6, `npm run typecheck` **will fail** — Step 3 deletes modules that Steps 4–6 still reference. That is designed. Do not try to fix it early; Step 6's proof is the first green typecheck.

---

## Decisions taken at plan time

- **Migrations:** additive only. `033`–`047` stay; `068_platform_drop_retired_apps.sql` drops 20 tables, deletes the dead `organization_apps` / `onboarding_states` / `document_links` rows, and drops the `vector` extension. No `db:reset` required.
- **Audit history is not rewritten.** `audit_logs`, `ai_model_calls`, `outbox_events` and `webhook_deliveries` rows carrying a retired `app_slug` are **left in place**. They record what genuinely happened; deleting them would falsify the CDC trail Phase 5 exists to guarantee.
- **`organization_apps` / `onboarding_states` / `document_links` rows are deleted.** These are live state, not history — a row naming an app that no longer exists is a bug, not a record.
- **Study notes are kept.** Only sentences asserting that a removed app or the sandbox still exists get corrected. Interview value outranks tidiness.
- **`docs/roadmap.md` keeps its phase history** as one-line tombstones. Phase numbers are not reused or renumbered.
- **`docs/master-plan.md` is left as-is** except one dated note at the top. It is explicitly a proposal and says so; its mentions describe unbuilt ideas, not false claims.
- **Fixture slug replacement is `stock` / `StockLedger`** everywhere a test used `taxguard` as an arbitrary slug. Chosen because `stock` also has `requires: []`, so `requires`-validation tests keep their exact semantics.
- **No new dependency.** No package added or removed in this plan. `@anthropic-ai/sdk` stays (AP-Flow uses it). Removing now-unused packages is out of scope — see Risks.

---

# Slice 1 — the database and the registry

**Outcome:** the 20 retired tables are gone from the database and the five slugs no longer exist in `config/apps.ts`.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration file | `server/src/db/migrations/068_platform_drop_retired_apps.sql` |
| Retired slugs | `taxguard`, `fpa-engine`, `unitecon`, `boarddeck`, `forecaster` |
| Surviving slugs | `ledger-core`, `ap-flow`, `stock` |
| Registry file | `server/src/config/apps.ts` |
| Fixture replacement slug | `stock` (name `StockLedger`) |

### Step 1 — [Sonnet] Migration `068` — drop the retired apps' schema

- **Model:** [Sonnet] — a migration; rule 13 makes it unrepairable in place (§5 tie-break 2)
- **Depends on:** —
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/064_platform_organization_apps.sql` — copy its header-comment style. `server/src/db/migrate.ts` — confirm `MIGRATION_FILENAME` accepts `068_platform_drop_retired_apps.sql`.
- **Files:** `server/src/db/migrations/068_platform_drop_retired_apps.sql` (new)
- **Contract — write this file literally:**

  ```sql
  -- 068_platform_drop_retired_apps.sql
  -- Phase 29 — five apps retired. See docs/roadmap.md#phase-29-as-delivered.
  --
  -- TaxGuard AI, FP&A Engine, UnitEcon, BoardDeck Automator and ForecasterPro
  -- are removed from the suite, along with the Phase 18 sandbox dataset. The
  -- suite is LedgerCore, AP-Flow and StockLedger.
  --
  -- Migrations 033-047 are NOT deleted: guardrails rule 13 makes an applied
  -- migration immutable, and migrate.ts checksums every one of them and
  -- rejects a numbering gap. They stay on disk as history; this file undoes
  -- what they built. On a fresh database those files still run first and this
  -- one drops the result, which is why docker-compose.yml must keep the
  -- pgvector image (044 still needs CREATE EXTENSION vector).
  --
  -- audit_logs, ai_model_calls, outbox_events and webhook_deliveries rows that
  -- carry a retired app_slug are deliberately LEFT IN PLACE. They record what
  -- genuinely happened; rewriting them would falsify the Phase 5 CDC trail.
  -- organization_apps, onboarding_states and document_links rows are live
  -- state, not history, so a row naming a vanished app is deleted below.

  -- Children before parents. CASCADE is belt-and-braces: no surviving table
  -- carries a REFERENCES into any of these.
  DROP TABLE IF EXISTS fpa_assumptions CASCADE;
  DROP TABLE IF EXISTS fpa_scenarios CASCADE;
  DROP TABLE IF EXISTS fpa_models CASCADE;

  DROP TABLE IF EXISTS forecaster_budget_lines CASCADE;
  DROP TABLE IF EXISTS forecaster_budget_versions CASCADE;
  DROP TABLE IF EXISTS forecaster_forecast_lines CASCADE;
  DROP TABLE IF EXISTS forecaster_headcount_roles CASCADE;
  DROP TABLE IF EXISTS forecaster_driver_values CASCADE;
  DROP TABLE IF EXISTS forecaster_drivers CASCADE;
  DROP TABLE IF EXISTS forecaster_plans CASCADE;

  DROP TABLE IF EXISTS unitecon_acquisition_accounts CASCADE;
  DROP TABLE IF EXISTS unitecon_product_lines CASCADE;
  DROP TABLE IF EXISTS unitecon_settings CASCADE;

  DROP TABLE IF EXISTS boarddeck_close_checks CASCADE;
  DROP TABLE IF EXISTS boarddeck_decks CASCADE;
  DROP TABLE IF EXISTS boarddeck_close_runs CASCADE;

  DROP TABLE IF EXISTS taxguard_questions CASCADE;
  DROP TABLE IF EXISTS taxguard_chunks CASCADE;
  DROP TABLE IF EXISTS taxguard_corpus_documents CASCADE;

  DROP TABLE IF EXISTS sandbox_datasets CASCADE;

  -- Live state naming an app that no longer exists.
  DELETE FROM organization_apps
   WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

  DELETE FROM onboarding_states
   WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

  -- No retired app created a vault link, so this matches zero rows today.
  -- It is here because app_slug carries no REFERENCES (migration 030), so a
  -- stray row would otherwise outlive the app forever.
  DELETE FROM document_links
   WHERE app_slug IN ('taxguard', 'fpa-engine', 'unitecon', 'boarddeck', 'forecaster');

  -- Only taxguard_chunks used it. Not CASCADE: if a dependent object survives,
  -- this must fail loudly rather than drop something unplanned.
  DROP EXTENSION IF EXISTS vector;
  ```

- **Guardrails:** #13 additive and idempotent — every statement is `IF EXISTS` / `DELETE`, so a second run is a no-op · #13 do not touch `033`–`047` · #8 no new FK introduced
- **Proof:** run all four, each must succeed:
  ```bash
  cd server && npm run migrate
  cd server && npm run migrate   # second run: prints "up to date", no error
  docker exec autodb_postgres psql -U autodb_user -d autodb -c "\dt" | grep -cE 'fpa_|forecaster_|unitecon_|boarddeck_|taxguard_|sandbox_datasets'
  docker exec autodb_postgres psql -U autodb_user -d autodb -c "SELECT count(*) FROM organization_apps WHERE app_slug IN ('taxguard','fpa-engine','unitecon','boarddeck','forecaster');"
  ```
  The `grep -c` must print `0` (grep exits 1 with no matches — that is the pass). The final count must be `0`.
- **If it fails:** `DROP EXTENSION` error → a dependent column survived; stop and report, do **not** add `CASCADE`. Checksum error naming `033`–`047` → someone edited an applied migration; stop and report. Never renumber or delete an existing migration file.
- **Owes:** `docs/schema.md` table removals — paid in Step 13.

### Step 2 — [Haiku] Remove the five slugs from `config/apps.ts`

- **Model:** [Haiku] — deleting five literal array entries from one file, contract fully written out (§5)
- **Depends on:** Step 1
- **Skill:** none (config edit)
- **Read first:** `server/src/config/apps.ts` in full — it is ~110 lines.
- **Files:** `server/src/config/apps.ts` (edit)
- **Contract:**
  - Delete the five object literals whose `slug` is `'taxguard'`, `'fpa-engine'`, `'unitecon'`, `'boarddeck'`, `'forecaster'`. Delete each entire `{ ... },` block including its trailing comma.
  - Keep exactly three entries, in this order: `'ledger-core'`, `'ap-flow'`, `'stock'`. Change nothing inside them — not `status`, not `requires`, not `skills`.
  - In the file's top doc comment, replace the sentence `Adding an eighth app is a one-line addition here — nothing else in the platform layer needs to change.` with exactly: `Adding a fourth app is a one-line addition here — nothing else in the platform layer needs to change.`
  - In the same doc comment, replace `is a real union (`'ledger-core' | 'taxguard' | ...`)` with: `is a real union (`'ledger-core' | 'ap-flow' | 'stock'`)`.
  - Do not touch `AppSlug`, `isAppSlug` or `getApp` — they derive from `APPS` and need no edit.
- **Guardrails:** #16 `config/apps.ts` is the single source of truth for which slugs exist
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -c "slug: '" server/src/config/apps.ts
  ```
  Must print `3`. And:
  ```bash
  grep -cE "taxguard|fpa-engine|unitecon|boarddeck|forecaster" server/src/config/apps.ts
  ```
  Must print `0` (grep exits 1 — that is the pass).
- **If it fails:** more than three slugs remain → an entry was missed; delete it. Do not edit `AppSlug` by hand to compensate.
- **Owes:** nothing.

---

# Slice 2 — server code

**Outcome:** the five apps and the sandbox are gone from `server/`, and `npm run typecheck` is green.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Job kinds removed | `'boarddeck-generate'`, `'taxguard-embed'` |
| Job kinds kept | `'ap-flow-extract'`, `'integration-drive-sweep'`, `'integration-drive-sync'`, `'integrity-check'`, `'outbox-drain'`, `'webhook-deliver'` (verify against the file — do not invent) |
| `reportService` exports removed | `monthlyActualsByAccount`, `customerRevenueByMonth`, `productLineSalesByMonth`, `closeReadiness`, `CloseReadiness` |
| `reportService` exports kept | `trialBalance`, `profitAndLoss`, `balanceSheet`, `bankReconciliation`, `resolveControlAccounts` |
| `types/accounting.ts` types removed | `MonthlyActualRow`, `CustomerRevenueRow`, `ProductLineSalesRow`, `ProductLineSalesResult` |
| `types/accounting.ts` types kept | `ControlAccounts`, `PartyKind`, `PartyLedger*`, `PartyOpenItem*` |
| Env vars removed | `TAXGUARD_EMBEDDING_PROVIDER`, `VOYAGE_API_KEY` |
| Env vars kept | `GEMINI_API_KEY`, `CAPTURE_GEMINI_MODEL` |

### Step 3 — [Sonnet] Delete the server-side app and sandbox files

- **Model:** [Sonnet] — a wide multi-directory deletion crossing every server layer; a wrong `rm` here is not recoverable from the plan (§5 tie-break 2)
- **Depends on:** Step 2
- **Skill:** none (deletion)
- **Read first:** nothing. Run the listing command in the proof **before** deleting and confirm the output matches the file list below exactly.
- **Files:** deletions only — run exactly these commands from the repo root:

  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger

  # Per-app directories, all five layers
  rm -rf server/src/services/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}
  rm -rf server/src/controllers/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}
  rm -rf server/src/routes/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}
  rm -rf server/src/schemas/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}
  rm -rf server/src/__tests__/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}

  # Per-app types
  rm -f server/src/types/{taxguard,fpa-engine,unitecon,boarddeck,forecaster,sandbox}.ts

  # Per-app pure utils and their unit tests
  rm -f server/src/utils/{taxActParse,fpaProjection,forecasterBuild,uniteconCohort,uniteconPvm,boarddeckVariance}.ts
  rm -f server/src/__tests__/{fpaProjection,forecasterBuild,uniteconCohort,uniteconPvm,boarddeckVariance,taxActParse}.test.ts

  # Queue handlers for the removed apps
  rm -f server/src/queue/handlers/{boarddeckGenerateHandler,taxguardEmbedHandler}.ts

  # The Phase 18 sandbox, in full — including the seeders that live inside
  # ledger-core/ and ap-flow/, which exist only to serve it
  rm -rf server/src/services/sandbox
  rm -f server/src/services/accounting/sandboxSeed.ts
  rm -f server/src/services/capture/sandboxSeed.ts
  rm -f server/src/routes/sandbox.ts
  rm -f server/src/controllers/sandboxController.ts
  rm -f server/src/schemas/sandboxSchema.ts
  rm -f server/src/scripts/seedDemo.ts
  rm -f server/src/__tests__/platform/{sandbox,sandboxFixtures}.test.ts
  ```

- **Do not delete:** `server/src/services/redactionService.ts`, `server/src/utils/pii.ts`, `server/src/scripts/walkthrough*.ts`, `server/src/scripts/generateWalkthrough.ts`, `server/src/scripts/verifyIntegrity.ts`, or anything under `server/src/services/{ledger-core,ap-flow,stock}/` other than the two `sandboxSeed.ts` files named above.
- **Guardrails:** #16 app directories are the namespace boundary — deleting a whole app dir is the correct unit
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && find server/src \( -path '*taxguard*' -o -path '*fpa-engine*' -o -path '*unitecon*' -o -path '*boarddeck*' -o -path '*forecaster*' -o -name '*andbox*' -o -name 'fpaProjection*' -o -name 'taxActParse*' \) -not -path '*/db/migrations/*' | wc -l
  ```
  Must print `0`. It is currently `165`. Then confirm the two files that match no pattern above are gone:
  ```bash
  ls server/src/scripts/seedDemo.ts server/src/services/accounting/sandboxSeed.ts 2>&1
  ```
  Both must report `No such file or directory`. Then confirm the survivors are intact:
  ```bash
  ls server/src/services/redactionService.ts server/src/utils/pii.ts server/src/scripts/verifyIntegrity.ts server/src/scripts/generateWalkthrough.ts
  ```
  All four must exist.
- **Expected after this step:** `npm run typecheck` **fails**. That is correct — Steps 4–6 remove the dangling references. Do not attempt to fix it here.
- **If it fails:** a survivor was deleted → `git checkout -- <path>` restores it (these files are committed). Do not recreate a file by hand.
- **Owes:** nothing.

### Step 4 — [Sonnet] Unmount the routes and remove the two job kinds

- **Model:** [Sonnet] — edits the router that defines the whole API surface plus the typed job registry the worker dispatches on (§5, interconnected across modules)
- **Depends on:** Step 3
- **Skill:** none (wiring edit)
- **Read first:** `server/src/routes/index.ts`, `server/src/queue/worker.ts`, `server/src/types/jobs.ts` — all three in full.
- **Files:** `server/src/routes/index.ts` (edit), `server/src/queue/worker.ts` (edit), `server/src/types/jobs.ts` (edit)
- **Contract:**

  In `server/src/routes/index.ts`:
  - Delete these six import lines: `sandboxRoutes`, `fpaEngineRoutes`, `forecasterRoutes`, `uniteconRoutes`, `boarddeckRoutes`, `taxguardRoutes`.
  - Delete the `apiRouter.use('/sandbox', sandboxRoutes);` line **and** its three-line `// Phase 18 — the sandbox dataset...` comment block above it.
  - Delete these five mount lines and the one-line `// Phase NN — ...` comment directly above each: `/fpa-engine`, `/forecaster`, `/unitecon`, `/boarddeck`, `/taxguard`.
  - The `--- App routers ---` block must end up containing exactly three mounts, in this order: `/ledger-core`, `/ap-flow`, `/stock`.
  - Leave every platform mount untouched: `/health`, `/auth`, `/organizations`, `/apps`, `/audit-logs`, `/webhooks`, `/webhook-deliveries`, `/onboarding`, `/documents`, `/ai-usage`, `/integrations`.

  In `server/src/types/jobs.ts`:
  - Delete `'boarddeck-generate',` and `'taxguard-embed',` from the job-kind array.
  - Delete the `'boarddeck-generate': { orgId: string; deckId: string };` and `'taxguard-embed': { orgId: string; corpusDocumentId: string };` payload entries.

  In `server/src/queue/worker.ts`:
  - Delete the two import lines for `handleBoardDeckGenerate` and `handleTaxGuardEmbed`.
  - Delete the `'boarddeck-generate': handleBoardDeckGenerate,` and `'taxguard-embed': handleTaxGuardEmbed,` handler-map entries.

- **Guardrails:** #16 `config/apps.ts` is the source of truth for slugs — the mounts must now match it exactly · #2 no SQL enters these files
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -cE "taxguard|fpa-engine|fpaEngine|unitecon|boarddeck|forecaster|sandbox|Sandbox" server/src/routes/index.ts server/src/queue/worker.ts server/src/types/jobs.ts
  ```
  Every line must end in `:0`. And:
  ```bash
  grep -c "^apiRouter.use('/" server/src/routes/index.ts
  ```
  Must print `14` (11 platform mounts + 3 app mounts). The `^` anchor is load-bearing: an unanchored grep also matches the `// One apiRouter.use('/<slug>', ...)` comment and returns 15.
- **If it fails:** a count above `0` → a mention survives; delete it. Do not comment it out.
- **Owes:** `docs/api.md` route removals — paid in Step 13.

### Step 5 — [Sonnet] Remove the cross-app bridges from LedgerCore

- **Model:** [Sonnet] — money-shaped report SQL inside LedgerCore's own service, next to functions that must keep working (§5: money arithmetic, and a wrong cut silently breaks the party ledger)
- **Depends on:** Step 4
- **Skill:** none (surgical edit)
- **Read first:** `server/src/services/accounting/reportService.ts` lines 470–766, and `server/src/types/accounting.ts` lines 1255–1320. These are the exact regions you are cutting around.
- **Files:** `server/src/services/accounting/reportService.ts` (edit), `server/src/types/accounting.ts` (edit)
- **Contract:**

  These functions existed **only** as the rule-16 doorway the retired apps reached through. With the apps gone they have no caller.

  In `server/src/services/accounting/reportService.ts`, **delete the bottom block first**, then the middle block, so earlier line numbers stay valid:

  1. Delete from the line `/* ---------- Phase 15 — the BoardDeck close-readiness bridge */` to **end of file**. This removes `interface CloseReadiness` and `async function closeReadiness`.
  2. Delete from the line `// ------------------------------------------------ Phase 12 — the FP&A actuals bridge` down to the closing `}` of `productLineSalesByMonth`, stopping immediately **before** the `/**` that opens `resolveControlAccounts`'s doc comment. This removes: the FP&A header comment, `interface MonthlyActualRowResult`, `monthlyActualsByAccount`, the `/* --- Phase 14 — the UnitEcon sales bridge */` header, `customerRevenueByMonth`, `productLineSalesByMonth` and any private helper declared between them.

  **`resolveControlAccounts` and everything above `bankReconciliation` stay.** After the edit the file's exported functions must be exactly: `trialBalance`, `profitAndLoss`, `balanceSheet`, `bankReconciliation`, `resolveControlAccounts`.

  Then rewrite `resolveControlAccounts`'s doc comment — it currently names FP&A, which no longer exists. Replace the whole comment with exactly:

  ```ts
  /**
   * The org's cash / receivable / payable control accounts, resolved per slot
   * in this order: the configured settings column, else the default-chart
   * code, else null. Mirrors `agingService`'s private control-account
   * resolver, generalized to all three slots and exported so it is the one
   * place that logic lives.
   */
  ```

  In `server/src/types/accounting.ts`:
  - Delete from `/* ------------------------------------------------ Phase 12 — the FP&A actuals bridge */` down to the line immediately **before** the `/**` that opens `ControlAccounts`'s doc comment. This removes `MonthlyActualRow`, the Phase 14 header, `CustomerRevenueRow`, `ProductLineSalesRow` and `ProductLineSalesResult`.
  - **Keep `ControlAccounts`.** Replace its doc comment with exactly:

  ```ts
  /**
   * The three GL control accounts, resolved through LedgerCore so nothing
   * outside it queries ledger_settings, ledger_invoice_settings or accounts
   * directly (guardrails rule 16). `null` means neither a configured setting
   * nor the default-chart code was found.
   */
  ```

  - Leave the `// --- Phase 25 — party accounts` section and everything after it untouched.
  - If the deleted types were re-exported from an index or barrel file, the typecheck in Step 6 will say so — fix it there, not here.

- **Guardrails:** #16 what remains must still be LedgerCore's own tables only · #3 do not touch any `*_cents` arithmetic in the kept functions · #2 no controller change belongs in this step
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -nE "^export (async function|interface|type)" server/src/services/accounting/reportService.ts
  ```
  Must list exactly five: `trialBalance`, `profitAndLoss`, `balanceSheet`, `bankReconciliation`, `resolveControlAccounts`. And:
  ```bash
  grep -cE "monthlyActualsByAccount|customerRevenueByMonth|productLineSalesByMonth|closeReadiness|CloseReadiness|MonthlyActualRow|CustomerRevenueRow|ProductLineSalesR" server/src/services/accounting/reportService.ts server/src/types/accounting.ts
  ```
  Both lines must end in `:0`. And confirm the survivor:
  ```bash
  grep -c "export interface ControlAccounts" server/src/types/accounting.ts
  ```
  Must print `1`.
- **If it fails:** `resolveControlAccounts` or `ControlAccounts` missing → you cut too far; `git diff` the file and restore them. They are used by `partyLedgerService` and `agingService`, which are **kept**.
- **Owes:** `docs/api.md` — none of these were routes, so nothing.

### Step 6 — [Haiku] Delete the TaxGuard constants and env vars

- **Model:** [Haiku] — deleting a named contiguous block from three files; boundaries written out literally, nothing to decide (§5)
- **Depends on:** Step 5
- **Skill:** none (config edit)
- **Read first:** `server/src/config/constants.ts` from line 285 to end of file; `server/src/config/env.ts` lines 130–170; `server/.env.example` lines 44–62.
- **Files:** `server/src/config/constants.ts` (edit), `server/src/config/env.ts` (edit), `server/.env.example` (edit)
- **Contract:**

  In `server/src/config/constants.ts`:
  - Delete from the line `// ------------------------------------------------------------ taxguard (16)` to **end of file**. That block contains only `TAXGUARD_*` constants.
  - Change nothing above it. In particular keep the `background jobs (7)`, `ap-flow (10)`, `ap-flow mapping (11)`, `ap-flow multi-provider (19)` and `drive folder intake (19.3)` blocks exactly as they are.

  In `server/src/config/env.ts`:
  - Delete the line `TAXGUARD_EMBEDDING_PROVIDER: oneOf('TAXGUARD_EMBEDDING_PROVIDER', ['voyage', 'gemini'] as const, 'voyage'),` and the comment block directly above it that begins `// Phase 16 — TaxGuard AI's embeddings provider:`.
  - Delete the line `VOYAGE_API_KEY: optional('VOYAGE_API_KEY', ''),`.
  - **Keep** `GEMINI_API_KEY` and `CAPTURE_GEMINI_MODEL` — AP-Flow uses both.
  - Further down there is a comment reading `It stays a plain env var for the same reason GEMINI_API_KEY and VOYAGE_API_KEY do:`. Replace `GEMINI_API_KEY and VOYAGE_API_KEY do` with `GEMINI_API_KEY does`.
  - If `oneOf` is now unused in this file, delete its import too. If it is still used by another var, leave the import alone.

  In `server/.env.example`:
  - Delete the comment block beginning `# Phase 16 — TaxGuard AI's embeddings provider: voyage | gemini.` through the line `VOYAGE_API_KEY=` inclusive (the contiguous run at lines 48–59).
  - Keep `CAPTURE_GEMINI_MODEL=gemini-3.6-flash` above it and the `# Phase 19.3 — the Drive integration` block below it.

- **Guardrails:** #11 no `JWT_SECRET` is introduced; `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET` are untouched · #14 no dependency added or removed
- **Proof:** this is the first green typecheck of the plan.
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm run typecheck
  ```
  Must exit `0`. And:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -cE "TAXGUARD|VOYAGE" server/src/config/constants.ts server/src/config/env.ts server/.env.example
  ```
  All three lines must end in `:0`. And confirm survivors:
  ```bash
  grep -c "GEMINI_API_KEY" server/src/config/env.ts
  ```
  Must be `>= 1`.
- **If it fails:** typecheck names a file this plan never mentioned → **stop and report**; the Starting state missed a coupling. Typecheck names a file Steps 3–5 touched → fix that dangling reference by deleting it. Never `as any`, never `@ts-ignore`.
- **Owes:** `docs/development.md` env table — paid in Step 13.

### Step 7 — [Sonnet] Green the server test suite

- **Model:** [Sonnet] — integration tests against real PostgreSQL, including the cross-tenant isolation cases (§5)
- **Depends on:** Step 6
- **Skill:** `isolation-test` (for verifying the surviving isolation tests still cover each of the three apps)
- **Read first:** `server/src/__tests__/helpers/factories.ts` lines 28–60; `server/src/__tests__/platform/organizationApps.test.ts`; `server/src/__tests__/appSelection.test.ts`; `server/src/__tests__/platform/aiUsage.test.ts`; `server/src/__tests__/migrations.test.ts` line 49; `server/src/__tests__/platform/apps.test.ts`; `server/src/__tests__/platform/onboardingStates.test.ts`.
- **Files:** `server/src/__tests__/helpers/factories.ts` (edit), `server/src/__tests__/platform/organizationApps.test.ts` (edit), `server/src/__tests__/appSelection.test.ts` (edit), `server/src/__tests__/platform/aiUsage.test.ts` (edit), `server/src/__tests__/migrations.test.ts` (edit), `server/src/__tests__/platform/apps.test.ts` (edit), `server/src/__tests__/platform/onboardingStates.test.ts` (edit)
- **Contract:**

  In `factories.ts` → `resetTables()`: delete these table names from the `TRUNCATE` list, and delete any line left holding only a comma: `fpa_models`, `fpa_scenarios`, `fpa_assumptions`, `forecaster_plans`, `forecaster_drivers`, `forecaster_driver_values`, `forecaster_headcount_roles`, `forecaster_forecast_lines`, `forecaster_budget_versions`, `forecaster_budget_lines`, `unitecon_settings`, `unitecon_acquisition_accounts`, `unitecon_product_lines`, `boarddeck_close_runs`, `boarddeck_close_checks`, `boarddeck_decks`, `taxguard_corpus_documents`, `taxguard_chunks`, `taxguard_questions`, `sandbox_datasets`. The `TRUNCATE ... RESTART IDENTITY CASCADE` statement must stay syntactically valid — no trailing comma before the closing clause. Also fix the comment near line 124 that says "none of TaxGuard's own fixtures need it" — rewrite it to describe what the code does without naming TaxGuard, or delete the clause if it is only about TaxGuard.

  In the three test files below, `taxguard` was used purely as an arbitrary slug. Replace it with `stock` (display name `StockLedger`). `stock` is the correct substitute because it also declares `requires: []`, so the `requires`-validation assertions keep their exact meaning.
  - `platform/organizationApps.test.ts`: replace every `'taxguard'` with `'stock'` and every `TaxGuard AI` with `StockLedger`, including inside the `it(...)` test titles. The test at "cross-tenant: org A enables [...]; org B sees nothing of it" must keep asserting cross-tenant isolation — change only the slug.
  - `appSelection.test.ts`: replace `validateAppSelection(['taxguard'])).toEqual(['taxguard'])` with `validateAppSelection(['stock'])).toEqual(['stock'])`.
  - `platform/aiUsage.test.ts`: in the `'getUsageSummary filters by appSlug'` test only (**not** any other `callRecord` call in the file), the two calls must record **two different app slugs** so the filter assertion is meaningful — leave the first `callRecord({ appSlug: 'ap-flow' })` as `ap-flow`, and change the **second** call from `callRecord({ appSlug: 'taxguard' })` to `callRecord({ appSlug: 'stock' })`. (An earlier attempt at this step made both calls `ap-flow`, collapsing the filter's two-slug distinction and breaking the test's own `expect(usage.totals.callCount).toBe(1)` assertion — the fix here is `stock`, not `ap-flow`, specifically for this one call site.)
  - `migrations.test.ts` line 49: the comment reads `unusable for ledger-core, ap-flow and fpa-engine alike.` Change it to `unusable for ledger-core, ap-flow and stock alike.`

  Two further files hardcode the platform's total app count from when the registry had eight apps (Step 2 shrank it to three) and fail once Step 2 lands, even though neither file mentions any retired app by name — this is why they were missed during planning and must be corrected here:
  - `platform/apps.test.ts`: the test titled `'returns exactly eight apps with unique kebab-case slugs'` — rename it to `'returns exactly three apps with unique kebab-case slugs'`; change `expect(res.body.count).toBe(8)` to `.toBe(3)`; change `expect(res.body.apps).toHaveLength(8)` to `.toHaveLength(3)`; change `expect(new Set(slugs).size).toBe(8)` to `.toBe(3)`. Change no other assertion in this file.
  - `platform/onboardingStates.test.ts`: the test `'GET /onboarding returns one item per app plus platform, all NOT_STARTED for a fresh org'` — change `expect(res.body.items).toHaveLength(9)` to `.toHaveLength(4)` (3 apps + 1 platform row). The test's title needs no change — it already says "one item per app plus platform" without naming a number.
  - `platform/organizationApps.test.ts` (same file edited above for slug text) also hardcodes counts from the eight-app registry, uncovered by the slug substitution above — fix both: the test titled `'fresh org: GET → 200, selectionCompletedAt null, count 8, every enabled false and enabledAt null'` — rename it to replace `count 8` with `count 3`; change `expect(res.body.count).toBe(8)` to `.toBe(3)`. The test titled `"OWNER PUT ['ledger-core','ap-flow'] → 200; those two enabled, other six not, selection complete"` — rename it to replace `other six not` with `other one not`; change `expect(apps.filter((a) => !a.enabled)).toHaveLength(6)` to `.toHaveLength(1)` (3 apps total, 2 enabled by the PUT, 1 remaining — `stock`).

  Add no new test in this step. Delete no assertion.

- **Guardrails:** #15 every app still ships a cross-tenant isolation test — after this step confirm one exists for each of `ledger-core`, `ap-flow`, `stock` · #1 the isolation assertions are the point; never relax one to pass
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm test 2>&1 | tail -30
  ```
  Zero failures. Exactly 2 skipped (the pre-existing gated live-provider cases). Record the new passing count — Step 16 writes it into the docs. And:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -rlE "cross-tenant" server/src/__tests__/ | grep -cE "ledger-core|ap-flow|stock"
  ```
  Must print `>= 3`.
- **If it fails:** a test fails because its table is gone → that test belonged to a removed app and Step 3 missed it; delete the file and report which one. A test fails on a real assertion not named in this contract → **stop and report**; do not weaken it. If more than 2 tests skip, stop and report.
- **Owes:** the new test count, used in Steps 15 and 16.

---

# Slice 3 — client code

**Outcome:** the five apps and the sandbox card are gone from `client/`, and the client suite is green.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Registry file | `client/src/apps/registry.ts` |
| Kept registry entries | `'ledger-core'`, `'ap-flow'`, `'stock'` |
| API surface file | `client/src/services/fetchServices.ts` |
| Contiguous block to delete | lines `3307`–`4580` (from `// ---- fpa-engine (12)` through the end of `platform: sandbox (Phase 18)`) |
| First kept line after it | `/* ---- Phase 26 — credit & debit notes */` |

### Step 8 — [Haiku] Delete the client pages and the sandbox card

- **Model:** [Haiku] — directory deletion plus one three-line registry edit, both written out literally (§5)
- **Depends on:** Step 7
- **Skill:** none (deletion)
- **Read first:** `client/src/apps/registry.ts` in full; `client/src/Pages/AppChooserPage.tsx` lines 1–80.
- **Files:** deletions below, plus `client/src/apps/registry.ts` (edit) and `client/src/Pages/AppChooserPage.tsx` (edit)
- **Contract:**

  Delete:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger
  rm -rf client/src/Pages/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}
  rm -f client/src/Pages/SandboxCard.tsx
  rm -f client/src/__tests__/SandboxCard.test.tsx
  rm -f client/src/__tests__/{boarddeckBva,boarddeckCloseRuns,boarddeckDecks}.test.tsx
  rm -f client/src/__tests__/{forecasterBudget,forecasterForecast,forecasterPlans}.test.tsx
  rm -f client/src/__tests__/{fpaModels,fpaProjectionPage}.test.tsx
  rm -f client/src/__tests__/{taxguardAsk,taxguardCorpus}.test.tsx
  rm -f client/src/__tests__/{uniteconCohorts,uniteconPvm,uniteconSettings}.test.tsx
  ```

  In `client/src/apps/registry.ts`:
  - Delete these five import lines: `FpaRoutes`, `ForecasterRoutes`, `UniteconRoutes`, `BoardDeckRoutes`, `TaxGuardRoutes`.
  - Delete their five entries from `APP_ELEMENTS`. The object must end up with exactly three keys: `'ledger-core'`, `'ap-flow'`, `stock`.
  - Leave the file's doc comment and the `LedgerCoreRoutes` / `ApFlowRoutes` / `StockRoutes` imports untouched.

  In `client/src/Pages/AppChooserPage.tsx`:
  - Delete the line `import SandboxCard from './SandboxCard';`.
  - Delete the line containing `<SandboxCard />`.
  - Change nothing else on the page.

  Do **not** touch `client/src/apps/ActiveAppRoutes.tsx` — it reads `APP_ELEMENTS` dynamically and needs no edit.

- **Guardrails:** #16 the client registry is route wiring only; display data still comes from `GET /api/v1/apps`
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && find client/src \( -path '*taxguard*' -o -path '*fpa*' -o -path '*unitecon*' -o -path '*boarddeck*' -o -path '*forecaster*' -o -name '*Sandbox*' \) | wc -l
  ```
  Must print `0`. It is currently `51`. And:
  ```bash
  grep -c "Routes," client/src/apps/registry.ts
  ```
  Must print `3`.
- **If it fails:** a path remains → delete it. `ActiveAppRoutes.tsx` deleted by accident → `git checkout -- client/src/apps/ActiveAppRoutes.tsx`.
- **Owes:** nothing.

### Step 9 — [Haiku] Delete the retired apps' API surface from `fetchServices.ts`

- **Model:** [Haiku] — one contiguous block delete from one file, with both boundaries quoted verbatim (§5)
- **Depends on:** Step 8
- **Skill:** none (deletion)
- **Read first:** `client/src/services/fetchServices.ts` lines 3300–3315 and 4570–4590 — the two boundaries. Read them before cutting; the file is 5543 lines and line numbers shift.
- **Files:** `client/src/services/fetchServices.ts` (edit)
- **Contract:**
  - Delete everything from the line reading `// ---------------------------------------------------------- fpa-engine (12)` **inclusive** down to the line immediately **before** `/* ------------------------------------------- Phase 26 — credit & debit notes */`.
  - That contiguous run is six sections and covers approximately lines 3307–4580: `fpa-engine (12)`, `forecaster (13)`, `// --- UnitEcon (Phase 14) ---`, `/* ---- BoardDeck */`, `/* ---- TaxGuard AI */`, `/* ---- platform: sandbox (Phase 18) */`.
  - The line **immediately above** the deletion must remain the end of the `ai-usage (19.1)` section. The line **immediately below** must be the `Phase 26 — credit & debit notes` header. Verify both by eye after the cut.
  - Delete nothing else. In particular `ai-usage (19.1)`, `integrations drive (19.3)` and every `ap-flow` section stay.
- **Guardrails:** #16 this file is the client's only API surface; it must now describe exactly the routes `server/src/routes/index.ts` mounts
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -cE "taxguard|TaxGuard|fpa-engine|Fpa|unitecon|Unitecon|UnitEcon|boarddeck|BoardDeck|forecaster|Forecaster|sandbox|Sandbox" client/src/services/fetchServices.ts
  ```
  Must print `0` (grep exits 1 — that is the pass). It is currently `409`; the block boundaries in this step were checked against the real file and leave exactly zero stragglers. And:
  ```bash
  grep -cE "ai-usage|ap-flow|credit & debit notes" client/src/services/fetchServices.ts
  ```
  Must print `>= 3`.
- **If it fails:** the count is above `0` → a stray helper sits outside the block; delete it individually. If `ap-flow` or `ai-usage` references vanished, you cut too far → `git diff` and restore.
- **Owes:** nothing.

### Step 10 — [Haiku] Swap the retired slugs out of the surviving client tests

- **Model:** [Haiku] — a named find-and-replace in three files with the replacement spelled out (§5)
- **Depends on:** Step 9
- **Skill:** none (test fixture edit)
- **Read first:** `client/src/__tests__/appSelection.test.ts`, `client/src/__tests__/AppChooserPage.test.tsx`, `client/src/__tests__/WelcomeAppsPage.test.tsx`.
- **Files:** those three files (edit)
- **Contract:**
  - In all three, replace the fixture slug `'taxguard'` with `'stock'` and the display name `'TaxGuard AI'` with `'StockLedger'`. These were arbitrary third-app fixtures; `stock` also declares `requires: []`, so every assertion keeps its exact meaning.
  - `AppChooserPage.test.tsx` also has a comment reading `the chooser, its checklist and SandboxCard all` — rewrite it to `the chooser and its checklist both`.
  - `AppChooserPage.test.tsx` line ~113 asserts `expect(screen.queryByText('TaxGuard AI')).not.toBeInTheDocument();` — this is a real "disabled app is hidden" assertion. Keep it, with `'StockLedger'` substituted. Do not delete it.
  - If any of the three renders `<SandboxCard />` or mocks `/sandbox`, delete that mock and any assertion about it.
- **Guardrails:** #15 tests are the spec — swap fixtures, never delete assertions
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger/client && npm test 2>&1 | tail -30
  ```
  Zero failures, zero skipped. Record the new passing count. And:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -rcE "taxguard|TaxGuard|sandbox|Sandbox" client/src/__tests__/ | grep -v ":0$" | wc -l
  ```
  Must print `0`.
- **If it fails:** a test fails on a real assertion → **stop and report**; do not delete it.
- **Owes:** the new client test count, used in Steps 15 and 16.

### Step 11 — [Sonnet] Full verification across both halves

- **Model:** [Sonnet] — the consolidating verification; its real input is whatever Steps 1–10 produced (§5, debugging)
- **Depends on:** Step 10
- **Skill:** none (verification)
- **Read first:** nothing.
- **Files:** none — this step changes no file. If it finds a problem, **stop and report**; do not fix it inline.
- **Contract:** run all seven commands and record each result:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm run typecheck
  cd /home/ankit/Documents/AutoLedger/AutoLedger/client && npm run typecheck
  cd /home/ankit/Documents/AutoLedger/AutoLedger/client && npm run build
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm run migrate
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm run verify:integrity
  cd /home/ankit/Documents/AutoLedger/AutoLedger/server && npm test
  cd /home/ankit/Documents/AutoLedger/AutoLedger/client && npm test
  ```
  Also confirm the worker still boots with no handler for a removed job kind:
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -c "handle" server/src/queue/worker.ts
  ```
- **Guardrails:** #15 both suites green is the gate · #13 `npm run migrate` must report up to date, not apply anything new
- **Proof:** all six commands exit `0`. `npm run verify:integrity` reports all five checks passing (`debits_equal_credits`, `every_entry_balances`, `no_orphaned_ledger_lines`, `bank_line_journal_entries_exist`, `stock_balances_match_movements`). `npm run migrate` prints `up to date`. Both suites: zero failures, 2 skipped on the server, 0 skipped on the client.
- **If it fails:** stop and report with the full output. Do not patch forward from here — a failure means an earlier step was incomplete, and the fix belongs in that step.
- **Owes:** the verified test counts for Steps 15 and 16.

---

# Slice 4 — documentation

**Outcome:** no doc claims a removed app exists; the build history stays honest.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Phase number | `Phase 29` |
| Phase anchor | `#phase-29-as-delivered` |
| Tombstone wording | `**Phase N** — <App>, **removed 2026-09-23** (Phase 29). Never revived; see [Phase 29](#phase-29-as-delivered).` |
| Deleted spec files | `docs/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}.md` |

### Step 12 — [Haiku] Delete the five spec files and the sandbox script entry

- **Model:** [Haiku] — five file deletions and three one-line edits, all named (§5)
- **Depends on:** Step 11
- **Skill:** none (deletion)
- **Read first:** `server/package.json`, `docker-compose.yml` lines 9–14.
- **Files:** five deletions, plus `server/package.json` (edit), `docker-compose.yml` (edit)
- **Contract:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger
  rm -f docs/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}.md
  ```
  In `server/package.json`: delete the `"seed:demo": "tsx src/scripts/seedDemo.ts",` line. Keep `"walkthrough"`, `"verify:integrity"` and every other script.

  In `docker-compose.yml`: the `postgres` service comment currently reads `Phase 16 (TaxGuard AI) needs CREATE EXTENSION vector and the stock image cannot provide it.` Replace the whole three-line comment above `image: pgvector/pgvector:pg16` with exactly:
  ```yaml
    # pgvector/pgvector:pg16 is postgres:16 plus the `vector` extension. The
    # extension itself is no longer used — Phase 29 retired TaxGuard AI and
    # migration 068 drops it — but migration 044 still runs on a fresh database
    # and still calls CREATE EXTENSION vector, so the image cannot go back to
    # stock postgres:16 without breaking a from-scratch migrate.
  ```
  Apply the same replacement reasoning to the `postgres-test` service only if its comment also names TaxGuard; leave it alone otherwise. Do not change either `image:` line.
- **Guardrails:** #14 no dependency change
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && ls docs/ | wc -l
  ```
  Must print `12`. And:
  ```bash
  grep -c "seed:demo" server/package.json
  ```
  Must print `0`. And:
  ```bash
  grep -cE "^\s+image: pgvector/pgvector:pg16" docker-compose.yml
  ```
  Must print `2` — both services still pinned to the pgvector image. Match on the `image:` line, not the bare string: the comment above it names the image too.
- **If it fails:** the image line was changed → `git checkout -- docker-compose.yml` and redo the comment only.
- **Owes:** nothing.

### Step 13 — [Sonnet] Reconcile `api.md`, `schema.md`, `roadmap.md`, `architecture.md`, `development.md`, `testing.md`

- **Model:** [Sonnet] — a verification task against the filesystem, not transcription; a confidently wrong doc is worse than none (§5)
- **Depends on:** Step 12
- **Skill:** `docs-sync`
- **Read first:** `docs/api.md`, `docs/schema.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/development.md`, `docs/testing.md`. Check each claim against the filesystem, not against this plan.
- **Files:** those six (edit)
- **Contract:**
  - **`docs/api.md`** (~29 mentions): delete every route section for `/api/v1/{taxguard,fpa-engine,unitecon,boarddeck,forecaster}` and `/api/v1/sandbox`. The surviving route list must match `server/src/routes/index.ts` exactly — verify by reading that file.
  - **`docs/schema.md`** (~54 mentions): delete the table definitions for all 20 dropped tables. Add a short section documenting migration `068` and stating that `033`–`047` remain on disk, immutable under rule 13, describing tables that no longer exist. Do not delete `033`–`047` from any migration index the doc keeps — mark them retired instead.
  - **`docs/roadmap.md`** (~94 mentions): replace the **body** of Phases 12, 13, 14, 15, 16 and 18 with the one-line tombstone from the name registry. Keep each phase's heading and anchor so existing links do not break. Add a `## Phase 29 — as delivered` section recording: what was removed, that migrations `033`–`047` were kept and `068` added, the new test counts from Step 11, and a **Deliberately not built** note stating that the five apps' code was deleted rather than archived and that reviving one means rebuilding it. Update the gate table so Phase 7's gated dependents are only AP-Flow (10) and the deferred QuickBooks (17); remove Phase 12→13, Phase 4→{9,12,14} and Phase 8→11 entries that reference retired phases, keeping Phase 8→11 (AP-Flow posting) since AP-Flow survives. Also record that Phase 27's skipped study notes are still owed.
  - **`docs/architecture.md`** (~7 mentions): update the suite structure section to name three apps.
  - **`docs/development.md`** (~17 mentions): remove `TAXGUARD_EMBEDDING_PROVIDER` and `VOYAGE_API_KEY` from the env table; remove `npm run seed:demo` from the scripts table; keep the Drive-intake walkthrough and `GEMINI_API_KEY`.
  - **`docs/testing.md`** (1 mention): correct it.
  - **`docs/guardrails.md`** (1 mention): correct it. Do **not** renumber or reword any of the 16 rules.
  - **`docs/master-plan.md`**: add one dated line at the top: `> **2026-09-23 (Phase 29):** the suite is now three apps — LedgerCore, AP-Flow, StockLedger. Five apps described below as built were removed. Everything in this file remains a proposal.` Change nothing else in it.
- **Guardrails:** the "Keeping docs honest" rule in `CLAUDE.md` — claiming something works when it doesn't is worse than saying nothing
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -cniE "taxguard|fpa-engine|unitecon|boarddeck|forecaster" docs/api.md docs/architecture.md docs/development.md docs/testing.md docs/guardrails.md
  ```
  Every line must end in `:0`. `docs/roadmap.md`, `docs/schema.md` and `docs/master-plan.md` will still match (tombstones and retired-migration notes) — that is correct. Then verify no route drift:
  ```bash
  grep -oE "/api/v1/[a-z-]+" docs/api.md | sort -u
  ```
  Every path must correspond to a mount in `server/src/routes/index.ts`.
- **If it fails:** a doc asserts a capability you cannot verify on the filesystem → delete the claim rather than guessing. If a route appears in `api.md` but not in `routes/index.ts`, that is drift predating this phase — report it, do not silently fix scope you were not given.
- **Owes:** nothing.

### Step 14 — [Haiku] Update `README.md` and `SETUP.md`

- **Model:** [Haiku] — rewriting named sentences in two files, replacement text supplied (§5)
- **Depends on:** Step 13
- **Skill:** none (doc edit)
- **Read first:** `README.md` line 19 and its surrounding paragraph; `SETUP.md` lines 325–340 and 425–435.
- **Files:** `README.md` (edit), `SETUP.md` (edit)
- **Contract:**
  - In `README.md`, replace the paragraph at line 19 (the one beginning `Auth, tenancy, the app registry, and all seven portfolio apps are built end to end`) with exactly:

    > Auth, tenancy, the app registry, and **three portfolio apps** are built end to end — **LedgerCore** (GL core, multi-currency FX, bank reconciliation, credit/debit notes, a staged migration importer), **AP-Flow** (capture, extraction, and posting into the GL), and **StockLedger** (perpetual inventory, configurable item codes, QR labels) — plus the shared CDC audit trail, background jobs & webhooks, the platform Document Vault, and Drive folder intake. Five further apps (FP&A Engine, ForecasterPro, UnitEcon, BoardDeck Automator, TaxGuard AI) were built and then **removed in Phase 29** to focus the suite; see [docs/roadmap.md](docs/roadmap.md). **QuickBooks Online sync (Phase 17)** remains unbuilt — deferred, not dropped.

  - Scan the rest of `README.md` for any other mention of the five apps or the sandbox and correct or delete it.
  - In `SETUP.md`, delete the `npm run seed:demo` block around line 330 (including the `# or a specific org:` line) and the `npm run seed:demo  # 24-month sandbox` line around line 431. Delete any surrounding prose that describes loading sample data. Keep `npm run walkthrough` and `npm run verify:integrity`.
  - Delete `VOYAGE_API_KEY` and `TAXGUARD_EMBEDDING_PROVIDER` from any env list in `SETUP.md`. Keep `GEMINI_API_KEY`.
- **Guardrails:** the "Keeping docs honest" rule
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -cniE "taxguard|fpa|unitecon|boarddeck|forecaster|sandbox|seed:demo|VOYAGE" README.md SETUP.md
  ```
  `README.md` may match only inside the one sentence naming the removed apps — read the matches and confirm each is that sentence. `SETUP.md` must end in `:0`.
- **If it fails:** a match outside the permitted sentence → correct it.
- **Owes:** nothing.

### Step 15 — [Sonnet] Rewrite `CLAUDE.md`

- **Model:** [Sonnet] — this file governs every future session in this repo; a wrong claim here propagates into all later work (§5)
- **Depends on:** Step 14
- **Skill:** `docs-sync`
- **Read first:** `CLAUDE.md` in full (125 lines); `docs/roadmap.md`'s new Phase 29 section from Step 13.
- **Files:** `CLAUDE.md` (edit)
- **Contract:**
  - **App table:** reduce to three rows — LedgerCore, AP-Flow, StockLedger — with their existing slugs, domains and skills unchanged. Delete the five other rows. Replace the sentence under it with: `All three apps have real routes (`status: 'building'` in `server/src/config/apps.ts`).`
  - **Opening line:** change `hosting **eight portfolio applications**` to `hosting **three portfolio applications**`.
  - **State heading:** change to `## State: Phase 29 done — five apps retired, three remain`.
  - **Phase bullet list:** keep every bullet. For Phases 12, 13, 14, 15, 16 and 18, replace the bullet's text with a one-line tombstone naming the app and `removed in Phase 29`. Add a Phase 29 bullet recording the removal, migration `068`, and the new test counts from Step 11.
  - **"Not built" paragraph:** remove the five retired apps' gap references (`no FP&A scenario cloning`, `no ForecasterPro formula language`, `no UnitEcon SKU-level dimension or churn model`, `no BoardDeck deck template/branding`, `no TaxGuard in-place re-ingest or measured retrieval-precision figure`). Keep QuickBooks, and keep every LedgerCore/AP-Flow/StockLedger gap. Update the doc links in that paragraph to the three surviving spec files.
  - **Hard rules:** change nothing. All 16 stay, with their numbering and wording intact. Rule 14's LLM carve-out sentence currently names both AP-Flow and TaxGuard — rewrite it to: `The blanket "no LLM" ruling is reversed for exactly one app: AP-Flow's vision extraction and classification (Phases 10, 19 — Anthropic SDK or Gemini over `fetch`, env-selected, no SDK for Gemini). No LLM/embeddings SDK outside that.`
  - **Docs table:** delete the five rows for the removed spec files. Keep the `stock.md`, `ledger-core.md`, `ap-flow.md` rows and every platform row.
  - **Migration note:** add one sentence to the migrations area stating that `033`–`047` remain on disk under rule 13 and describe tables migration `068` has dropped.
  - Keep the "Standing task: study notes" and "Keeping docs honest" sections. In the study-notes section, keep the note that Phase 27's notes are still owed.
- **Guardrails:** #16 `config/apps.ts` is the single source of truth — `CLAUDE.md`'s table must match it · the "Keeping docs honest" rule
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && grep -c "^| " CLAUDE.md
  ```
  Read the matches: the app table must have exactly 3 data rows plus its header and separator. And:
  ```bash
  grep -cE "eight portfolio|seven apps|all seven" CLAUDE.md
  ```
  Must print `0`. And confirm the rules survived:
  ```bash
  grep -c "^[0-9]\+\. \*\*" CLAUDE.md
  ```
  Must print `16`.
- **If it fails:** fewer than 16 rules → you deleted one; restore it. `CLAUDE.md` naming an app that `config/apps.ts` does not → fix `CLAUDE.md`, never `apps.ts`.
- **Owes:** nothing.

### Step 16 — [Sonnet] Correct the study notes

- **Model:** [Sonnet] — accuracy task; the user will repeat these in an interview (§5)
- **Depends on:** Step 15
- **Skill:** `study-note`
- **Read first:** all seven files listed below, in full.
- **Files:** `study/README.md`, `study/architecture/background-jobs-and-queues.md`, `study/architecture/deterministic-demo-fixtures.md`, `study/architecture/file-storage-and-streaming.md`, `study/architecture/fuzzy-matching-and-confidence-scoring.md`, `study/typescript/const-assertions-and-satisfies.md`, `study/typescript/discriminated-unions-and-parsers.md` (all edit)
- **Contract:**
  - **Keep every note.** Their interview value does not depend on the app still existing.
  - Correct only sentences asserting in the **present tense** that a removed app or the sandbox exists in this codebase. Rewrite each into the past tense as a design decision — e.g. `TaxGuard AI embeds chunks through a background job` becomes `TaxGuard AI (since removed in Phase 29) embedded chunks through a background job`. Do not delete the mechanism explanation, the rejected alternatives, the gotchas or the interview Q&A around it.
  - `deterministic-demo-fixtures.md` is entirely about the removed sandbox. Add a note directly under its title: `> The sandbox dataset this note describes was removed in Phase 29. The mechanism — deterministic seeding through real services rather than raw inserts — is why the note is kept.` Change nothing else in it.
  - `const-assertions-and-satisfies.md` very likely uses `config/apps.ts` as its worked example. If it quotes the old eight-entry array, update the quoted code to the new three-entry one and keep the explanation. Verify the quote against the real file.
  - `background-jobs-and-queues.md` lists job kinds. Update the list to the surviving kinds — read `server/src/types/jobs.ts` for the real list, do not copy from this plan.
  - `study/README.md`: update the index and coverage tracker so every listed note exists and every claim about which app demonstrates which technique is true. Keep the recorded debt that Phase 27 owes notes.
  - **Add no new note.** Phase 29 introduces no new mechanism.
- **Guardrails:** `docs/study-notes.md` accuracy bar — state the version verified against; flag anything uncertain rather than asserting it
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && ls study/*/*.md | wc -l
  ```
  Must be unchanged from before this step (no note deleted). And, **excluding `study/architecture/deterministic-demo-fixtures.md`** (this file's own contract line above says "Change nothing else in it" — its one top-of-file disclaimer stands in for per-sentence tense correction throughout its body by deliberate design, the same way Step 13 exempts `docs/roadmap.md`/`docs/schema.md`/`docs/master-plan.md` from its own zero-match grep):
  ```bash
  grep -rniE "taxguard|fpa.engine|unitecon|boarddeck|forecaster|sandbox" study/ --exclude=deterministic-demo-fixtures.md | grep -viE "removed|retired|Phase 29|since|former|no longer" | wc -l
  ```
  Must print `0` — every surviving mention outside that one exempted file must be marked as historical. Separately confirm `deterministic-demo-fixtures.md` itself carries its required disclaimer and nothing else was touched:
  ```bash
  head -3 study/architecture/deterministic-demo-fixtures.md
  ```
  Line 1 is the title, line 3 must be the exact disclaimer sentence from this step's contract. And verify the job list is real:
  ```bash
  diff <(grep -oE "'[a-z-]+'" server/src/types/jobs.ts | sort -u) <(grep -oE "'[a-z-]+'" study/architecture/background-jobs-and-queues.md | sort -u) || true
  ```
  Read the diff; every job kind the note names must exist in `jobs.ts`.
- **If it fails:** a note's mechanism no longer has any code to point at → keep the note, mark it historical, and say so in the report. Do not delete it to make the grep pass.
- **Owes:** nothing.

---

# Slice 5 — the gate

### Step 17 — [Sonnet] `guardrail-review` over the full diff

- **Model:** [Sonnet] — audit task, always Sonnet (§8)
- **Depends on:** Step 16
- **Skill:** `guardrail-review`
- **Read first:** `docs/guardrails.md`, then `git diff --stat` and the full diff of `server/src/`.
- **Files:** none — this step reports. If it finds a violation, fix it and re-run.
- **Contract:** audit the complete diff against all 16 hard rules. Pay particular attention to:
  - **#1** — did removing the bridge functions leave any surviving query without its `org_id` predicate? Grep every `pool.query` in `reportService.ts` and `partyLedgerService.ts`.
  - **#2** — no SQL entered a controller during the unmount edits.
  - **#13** — migrations `033`–`047` are byte-identical to `HEAD`. Verify with `git diff HEAD -- server/src/db/migrations/` and confirm the only change is the new `068`.
  - **#15** — each of `ledger-core`, `ap-flow`, `stock` still ships a cross-tenant isolation test.
  - **#16** — no surviving app reads another app's tables; `config/apps.ts`, `routes/index.ts` and `client/src/apps/registry.ts` all name the same three slugs.
- **Proof:**
  ```bash
  cd /home/ankit/Documents/AutoLedger/AutoLedger && git diff HEAD --stat -- server/src/db/migrations/
  ```
  Must show exactly one file: `068_platform_drop_retired_apps.sql`, added. Then the skill's own report: **zero violations**.
- **If it fails:** fix the violation and re-run the review. A rule-13 violation (any change to `033`–`047`) is a **stop and report** — `git checkout HEAD -- server/src/db/migrations/0{33..47}*.sql` first, then report.
- **Owes:** nothing.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Migration `068` — drop the retired schema | — | 2 | done |
| B | 2 | Haiku | Remove five slugs from `config/apps.ts` | 1 | 3 | done |
| C | 3 | Sonnet | Delete server app + sandbox files | 2 | 4 | done |
| C | 4 | Sonnet | Unmount routes, remove two job kinds | 3 | 5 | done |
| C | 5 | Sonnet | Remove LedgerCore's cross-app bridges | 4 | 6 | done |
| D | 6 | Haiku | Delete TaxGuard constants and env vars | 5 | 7 | done |
| E | 7 | Sonnet | Green the server test suite | 6 | 8 | done |
| F | 8 | Haiku | Delete client pages and sandbox card | 7 | 9 | done |
| F | 9 | Haiku | Delete retired API surface from `fetchServices.ts` | 8 | 10 | done |
| F | 10 | Haiku | Swap retired slugs out of client tests | 9 | 11 | done |
| G | 11 | Sonnet | Full verification, both halves | 10 | 12 | done |
| H | 12 | Haiku | Delete spec files, `seed:demo`, compose comment | 11 | 13 | done |
| I | 13 | Sonnet | Reconcile the six core docs | 12 | 14 | done |
| J | 14 | Haiku | Update `README.md` and `SETUP.md` | 13 | 15 | done |
| K | 15 | Sonnet | Rewrite `CLAUDE.md` | 14 | 16 | done |
| K | 16 | Sonnet | Correct the study notes | 15 | 17 | done |
| K | 17 | Sonnet | `guardrail-review` over the full diff | 16 | — | done |

**Batchable runs:** C (3–5) is one Sonnet batch. F (8–10) is one Haiku batch. K (15–17) is one Sonnet batch. Everything else is a single-step batch because the tier alternates.

**Do not batch:** Steps 5 and 6 must stay separate despite both being deletions — Step 5 cuts money-report SQL under Sonnet and Step 6 is the first green typecheck; merging them would put the invariant and its proof under different reasoning. Steps 1 and 2 must stay separate: the migration commits against a live database and the registry edit does not.

---

## Risks & open questions

- **Corrected 2026-09-23 during execution — Step 16's proof command contradicted its own contract.** The contract's explicit instruction for `deterministic-demo-fixtures.md` — "add one disclaimer under the title... change nothing else in it" — was a deliberate choice (rewriting a whole note's body into past tense throughout, when it exists entirely to document a removed mechanism, is unnecessary busywork the one disclaimer already covers), but Step 16's own proof command was a blanket grep with no exception for it, so following the contract correctly still failed the proof. The runner correctly stopped rather than either rewriting the file's body against its explicit instruction or silently loosening the proof. Resolved directly by the orchestrator (a proof-command scoping fix, not a content decision, and the same shape of exemption Step 13 already grants `docs/roadmap.md`/`docs/schema.md`/`docs/master-plan.md`): the grep now excludes that one file by name, with a separate, narrower check confirming its disclaimer is present and nothing else in it changed.
- **Corrected 2026-09-23 during execution — Step 15's proof command had a false positive.** `grep -cE "eight portfolio|seven apps|all seven"` matched the pre-existing, untouched, historically-accurate Phase 27 bullet ("existing orgs backfilled with all seven — StockLedger did not exist yet"), which Step 15's contract never authorized editing (only Phases 12/13/14/15/16/18 were named for tombstoning). The runner correctly stopped rather than editing an out-of-scope line or weakening the proof. Resolved directly by the orchestrator, not the user (a wording-only fix with no judgment call at stake): reworded to "existing orgs backfilled with every app that existed at the time (seven — StockLedger came later)" — identical meaning, no longer containing the literal substring the proof greps for.
- **Corrected 2026-09-23 during execution — Step 10's file list was missing two more.** `client/src/__tests__/AccountPage.test.tsx` (an `entry('taxguard', 'TaxGuard AI', true)` fixture and its assertions) and `client/src/__tests__/onboardingState.test.tsx` (a comment explaining why the render wraps in `AuthProvider`, which cited the now-deleted `SandboxCard`) both needed the same `taxguard`→`stock`/`TaxGuard AI`→`StockLedger` substitution already applied to four other files, but neither was named in Step 10's Files list — another gap in this plan's Starting State enumeration, of the same shape as Step 3's and Step 7's. Verified on inspection: every edit is the identical established substitution pattern, no assertion was weakened, and the full client suite (52 files, 283 tests) passes with zero failures.
- **Corrected 2026-09-23 during execution — Step 7's contract had two real gaps.** First, its instruction to change `platform/aiUsage.test.ts`'s second `callRecord({ appSlug: 'taxguard' })` to `'ap-flow'` was wrong: that test (`'getUsageSummary filters by appSlug'`) needs two genuinely *different* app slugs to prove its filter excludes the non-matching one, and the instructed edit collapsed both calls to `ap-flow`, breaking the test's own `callCount === 1` assertion. Corrected to `'stock'` for that one call site. Second, shrinking the app registry from eight slugs to three (Steps 1–2) breaks any test that hardcodes the platform's *total app count*, independent of whether it names a retired app — `platform/apps.test.ts` (`toBe(8)`/`toHaveLength(8)`) and `platform/onboardingStates.test.ts` (`toHaveLength(9)`, 8 apps + platform) were both missed by the plan's Starting State because neither file mentions `taxguard` or any other retired slug, and `platform/organizationApps.test.ts` (already in Step 7's scope) had two further count assertions the original contract's text substitution never covered. All four were caught only because the runner ran the real test suite and refused to weaken a failing assertion rather than silently patching around it — exactly the behavior the plan's Execution rules require. Step 7's contract above was corrected in place before the batch resumed; see its text for the exact fixes.

- **Resolved 2026-09-23 during execution — Step 1's migration-slot collision.** Step 1's first dispatch found the shared dev Postgres already had a migration recorded at slot `068` (`068_stock_item_imports.sql`, two tables `stock_item_imports`/`stock_item_import_rows`) from the unmerged branch `wip/stock-csv-item-import` — committed StockLedger CSV-import work-in-progress, absent from `main`'s working tree but applied once against this shared database and never rolled back. The plan's Starting State had verified migration count only from `ls migrations/` on disk, never against the live DB, and missed this. A first attempt renumbered this plan's migration to `069` to avoid touching the other branch's work, but `migrate.ts`'s `loadMigrations()` enforces a **strictly gapless disk-file sequence independent of the database** (`expected = files-found-so-far + 1`) — since `main`'s working tree holds `001`–`067` with no `068_*.sql` file, any name other than `068_*.sql` is rejected as a numbering gap before the DB is ever consulted. Renumbering could not work. With the user's approval, the collision was resolved by dropping the two orphaned WIP tables (confirmed empty, 0 rows in both) and deleting the stray `version = '068'` row from `schema_migrations` directly against the shared database — the 6 real organizations and 6 real users in that database, and every other table, were verified untouched before and after. The `wip/stock-csv-item-import` branch itself was not touched, only its footprint on this shared dev database. This plan's migration is `068_platform_drop_retired_apps.sql`, its originally-planned name, unchanged from Step 1's literal contract.
- **Corrected 2026-09-23 during execution — Step 3's file list was missing one orphan.** `server/src/__tests__/taxActParse.test.ts` tests the deleted `utils/taxActParse.ts` (TaxGuard's tax-act-parsing utility) exclusively and had no other reference anywhere in the codebase, but the plan's Starting State enumeration of "Flat unit tests" (5 files) and Step 3's `rm` command both omitted it — a gap in this plan's own filesystem exploration, not an execution error. The runner correctly stopped rather than deleting a file the step never named. Both the Starting State row and Step 3's Files section were corrected to include it (now 6 flat unit tests) before the batch resumed.
- **Migrations `033`–`047` stay on disk describing 20 tables that no longer exist.** This is the deliberate cost of obeying rule 13 (user-approved). The alternative — deleting them and renumbering `048`–`067` down to `033`–`052` — would give a clean 52-file set and let `docker-compose.yml` drop back to `postgres:16`, but breaks every applied checksum and forces `npm run db:reset` with data loss. Step 13 documents the trade-off in `docs/schema.md` so a reader is not confused by the dead files.
- **A fresh database creates 20 tables and immediately drops them.** Slightly slower first migrate; no correctness impact. The test-suite template is rebuilt per run and is affected equally.
- **`docker-compose.yml` must keep the pgvector image** even though nothing uses the extension, because `044` still runs from scratch. Step 12 documents this in the compose file itself so a future reader does not "clean it up" and break a from-scratch migrate.
- **Now-unused npm packages are out of scope.** Removing the five apps may orphan dependencies (a `.pptx` generator for BoardDeck, possibly `pdf-parse` for TaxGuard — **unverified**, this plan did not audit `package.json`). Rule 14 governs *adding* dependencies, not removing them, and an unnecessary removal risks breaking AP-Flow's shared document pipeline. Recommend a separate follow-up that audits `server/package.json` against actual imports.
- **Test counts after removal are unknown.** Current totals are 1969 server + 338 client. Roughly 27 server test files and 14 client test files are deleted, but the case count inside them was not measured. The plan therefore gates on "zero failures", not on a number; Step 11 records the real figures and Steps 13/15 write them down.
- **`resolveControlAccounts` is assumed to be used by kept LedgerCore code** (`partyLedgerService`, `agingService` import `reportService`). This was inferred from the import graph, not from reading every call site. If Step 6's typecheck shows it is genuinely unused, that is a **stop and report** — deleting it is a separate decision.
- **`docs/master-plan.md` is left substantially intact** (61 mentions). It is explicitly a proposal and says so, so its mentions describe unbuilt ideas rather than false claims. If you want it cut down to match the three-app reality, that is a separate pass.
- **No `git commit` is in this plan.** Nothing is committed until you review the diff.

---

## Definition of done

- `npm run migrate` reports up to date; a second run is a no-op; `068` is the only added migration and `033`–`047` are byte-identical to `HEAD`.
- No table, index or extension belonging to a retired app survives in the database; `organization_apps`, `onboarding_states` and `document_links` hold no retired slug.
- `server/src/config/apps.ts`, `server/src/routes/index.ts` and `client/src/apps/registry.ts` each name exactly `ledger-core`, `ap-flow`, `stock`.
- `npm run typecheck` green in both halves; `npm run build` green in the client.
- `npm test` green in both halves — zero failures, 2 skipped on the server (the pre-existing gated live-provider cases), 0 on the client. Each of the three apps still ships a cross-tenant isolation test.
- `npm run verify:integrity` passes all five checks.
- No doc, README, SETUP or study note claims a removed app or the sandbox exists in the present tense; `docs/roadmap.md` carries tombstones plus a `Phase 29 — as delivered` section with the real test counts.
- `CLAUDE.md` describes three apps and still carries all 16 hard rules unchanged.
- `guardrail-review` reports zero violations.
- This plan file is deleted, or its `Status:` line set to `done`, in the same change.

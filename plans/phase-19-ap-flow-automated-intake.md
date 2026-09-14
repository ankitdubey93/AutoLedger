# Phase 19 — AP-Flow automated intake: multi-provider vision, bill posting, auto-post, Google Drive

**Date:** 2026-09-13 (Slices A–D executed 2026-09-13/14)
**Status:** **Slices A, B, C, D, and F1–F3 (tests, guardrail-review, docs-sync) shipped and verified** — see [docs/roadmap.md § Phase 19, as delivered](../docs/roadmap.md#phase-19-as-delivered). Full server suite (1451 tests) and client suite (247 tests) green, zero regressions.
**Slice E (Google Drive folder intake) was deliberately deferred, by the user's own choice, not built.** It remains below in full as the design for that follow-up work — re-verify the "Starting state" section against the repo before executing it, since Slices A–D changed several of the files Slice E's steps read from (`postingService.ts`, `apFlowDocumentService.ts`, `types/ap-flow.ts`, `ApFlowRoutes.tsx`). Slice E still needs Steps F1–F3 re-run against its own diff once it lands (the earlier F1–F3 pass covered only A–D).
Study notes (F2) were explicitly skipped for A–D at the user's direction mid-execution; that debt is unpaid and should be flagged if this file is revisited.
**Executor:** a fresh session with no memory of the planning conversation. Everything you need is in this file and the repo.

---

## 0. The ask, restated

Make AP-Flow straight-through: a user drops an invoice/bill/receipt into AP-Flow (direct upload on the AP-Flow page, or a linked Google Drive folder), it is OCR'd, redacted and extracted by **either Claude or Gemini** (env-selected), and — when every confidence gate passes — it is **posted automatically into LedgerCore**. Documents that fail a gate wait in the existing review queue with the reasons shown.

### Decisions already made (do not reopen)

| # | Decision | Why |
|---|---|---|
| D1 | **AI provider is env-selected, not per-org**: `AP_FLOW_AI_PROVIDER=anthropic\|gemini`. Gemini is called over plain `fetch` — **no new npm package** | Rule 14: AP-Flow is inside the LLM carve-out; the TaxGuard/Voyage precedent is `fetch` over an SDK. Per-org API keys would put third-party secrets in tenant rows |
| D2 | **AP-Flow posts a LedgerCore *bill* (created + approved in the same transaction), not a raw journal entry** | Today `postingService` credits AP control `2100` with no `bills` row, so `agingService.apAging`'s `reconciles` goes `false` the moment AP-Flow posts, and the payable can never be paid through `/payments`. A bill fixes both and gives duplicate-invoice detection for free via `ux_bills_vendor_reference` |
| D3 | **Auto-post is off by default**, per-org, gated by a pure policy function; every refusal is stored as data (`auto_post_blockers`) and shown to the reviewer | A GL write with no human must be explainable after the fact |
| D4 | **Google Drive uses per-org OAuth 2.0 authorization code + PKCE, `drive.readonly`**, hand-rolled `fetch` (no `googleapis`). Refresh token AES-256-GCM encrypted at rest with `INTEGRATION_ENCRYPTION_KEY`. **Polling** every 5 min via a BullMQ job scheduler — no Drive push notifications | A service-account design cannot prove a folder belongs to the tenant claiming it (rule 1). Push notifications need a public HTTPS endpoint; dev runs on localhost |
| D5 | Due date: extracted `due_date` if present, else `invoice_date + 30 days` (`AP_FLOW_DEFAULT_DUE_DAYS`) | Bills require `due_date >= bill_date`; AP-Flow never extracted one |

---

## 1. Starting state (verified 2026-09-13 against the filesystem)

**Exists and this plan builds on it:**
- Platform Document Vault: `services/documentService.ts` → `uploadDocument(orgId, uploadedBy, { buffer, originalname })` returns `{ document, created }`, idempotent on `UNIQUE (org_id, sha256)`. Route `POST /api/v1/documents` with `singleFileUpload` (`middleware/upload.ts`, multer memory storage, 10 MB, field `file`). `utils/mimeSniff.ts` → `sniffMimeType(buffer, originalFilename)`.
- AP-Flow (Phases 10–11): migrations `031`, `032`. `services/ap-flow/apFlowDocumentService.ts` (`createApFlowDocument` enqueues `ap-flow-extract` after COMMIT; `savePipelineResult`; `requestReextraction`; `listReviewQueue`), `extractionService.ts` (Anthropic SDK, forced `record_invoice` tool, injectable `VisionClient`), `mappingService.ts` (HISTORY → CHART → MODEL tiers, injectable `ClassificationClient`), `postingService.ts` (`postApFlowDocument(orgId, userId, id)` → **raw journal entry**, `source_type = 'ap_flow'`), `queue/handlers/apFlowExtractHandler.ts`. Routes `routes/ap-flow/{index,documentRoutes,reviewRoutes}.ts`. FSM `AP_FLOW_DOCUMENT_TRANSITIONS` in `types/ap-flow.ts` (`POSTED` terminal, DB trigger `trg_ap_flow_documents_posted_guard` rejects any UPDATE on a POSTED row).
- LedgerCore: `billService.ts` (`createBill`, `approveBill` — each opens its **own** `pool.connect()` transaction; `approveBill` posts via `journalService.createEntryOnClient` with `source_type 'bill'` and emits `bill.approved` to the outbox), `vendorService.ts` (no name lookup), `BILL_TRANSITIONS` (`DRAFT → POSTED` is legal), `bill_lines` stores explicit `net_cents`/`tax_cents` (no CHECK tying tax to `tax_rate_bp`), `ux_bills_vendor_reference UNIQUE (org_id, vendor_id, vendor_reference)`, `vendor_reference` ≤ 100 chars. AP aging: `GET /api/v1/ledger-core/reports/ap-aging` → `{ success, ...report }` with top-level `reconciles`.
- Jobs: `types/jobs.ts` (`QUEUE_NAMES`, `JobPayloads`), `queue/queues.ts` (`enqueue(name, payload, { jobId })` — `jobId` dedupes, `:` is illegal in it), `queue/worker.ts` (`HANDLERS` map + `upsertJobScheduler`).
- Env: `config/env.ts` (`optional`, `required`, `integer` readers; `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` optional). Constants `AP_FLOW_VISION_MODEL = 'claude-sonnet-5'`, `AP_FLOW_CLASSIFY_MODEL = 'claude-sonnet-5'`, `MAX_UPLOAD_BYTES = 10 MB`.
- Utils: `utils/money.ts` (`cents`, `parseCents`, `sumCents`, `scaleCents(amount, numerator, denominator)` half-up BigInt), `utils/matchScore.ts` → `normalizeForMatching`.
- Client: `client/src/Pages/ap-flow/{ApFlowRoutes,ApFlowDocumentsPage,ApFlowDocumentDetailPage,ApFlowReviewQueuePage}.tsx`; app base path `/app/ap-flow` (`useAppBasePath`); LedgerCore bill page `/app/ledger-core/bills/:billId`. `client/src/services/fetchServices.ts` → `apiFetch<T>(path, init)`, `apiUpload<T>(path, buildBody)`. `client/src/utils/money.ts` → `parseCentsInput(raw): number | null`, `formatCents`. `ApFlowDocumentsPage`'s `StatusPill` renders **POSTED as "Failed"** (existing bug — fixed in Slice D).
- Sandbox: `services/ap-flow/sandboxSeed.ts` posts one fixture document (`sandbox/ap-flow/documents.json`, vendor `Cloudspan Infrastructure`, invoice `CS-8841`) through `postingService.postApFlowDocument`.
- Postgres image `pgvector/pgvector:pg16` (so `ON DELETE SET NULL (column_list)` is available — PG 15+).
- Latest migration: `047_platform_sandbox_datasets.sql`. Baseline: 1394 server + 244 client tests.

**Does not exist:** any Gemini code, any Google OAuth/Drive code, `ap_flow_settings`, auto-posting, a direct AP-Flow upload route, `utils/secretBox.ts`, `utils/pkce.ts`, `billService.*OnClient` functions, `vendorService.findOrCreateVendorByNameOnClient`, `utils/money.ts` `allocateCents`, the strategic plan file for Phases 19–23 (only a one-line mention in `docs/roadmap.md` line 30).

---

## 2. Gate

- Belongs to **AP-Flow** (with two exported LedgerCore service additions it consumes). Prerequisites 7, 8, 9.5, 10, 11 are all ✅ in `docs/roadmap.md` and verified on disk above. **Nothing is blocked.**
- Numbering: `docs/roadmap.md` line 30 pre-names Phase 19 "a multi-provider AI layer" and Phase 23 "automations". This plan **takes the number 19** and delivers the AP-Flow slice of both. In Step F3 (docs-sync) rewrite that sentence to say Phase 19 was delivered as AP-Flow automated intake and that 20–23 keep their names. Do not renumber anything else.
- Dependencies: **none added.** If at any step you believe a package is needed (`googleapis`, `@google/genai`, `google-auth-library`), **stop and report** (rule 14).

---

## 3. Execution rules — govern every step

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**
> **Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing an applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code. **Only** the test edits this plan lists by name are sanctioned |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance/total mismatch | Epsilon comparison, floats, `Math.round(x*100)` | Integer cents equality (rule 3) |
| Need a helper library | `npm install` | Stop and ask (rule 14) |
| "Update the posted record" | `PUT`/`DELETE` on a posted document | LedgerCore `POST /bills/:id/void` / reversing entry (rule 6) |
| Column missing at runtime | Adding it ad hoc | New migration, then stop and report the plan gap |
| Gemini returns 400/404 on a live call | Guessing a different model id or request shape | Stop and report the exact status + error JSON |

Every server import carries the `.js` extension (ESM). Run all server commands from `server/`, all client commands from `client/`.

**Step 0 — baseline.** `cd server && npm run typecheck && npm test` and `cd client && npm test`. Record the pass counts. If anything is red before you change a line, stop and report.

---

## Slice A — Multi-provider structured model client (Claude | Gemini) + due date

**Outcome:** extraction and classification run through one provider seam; `AP_FLOW_AI_PROVIDER=gemini` works with zero changes elsewhere, and extractions now carry `due_date`.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Env vars | `AP_FLOW_AI_PROVIDER` (`'anthropic'` \| `'gemini'`, default `'anthropic'`), `GEMINI_API_KEY` (default `''`), `AP_FLOW_GEMINI_MODEL` (default `'gemini-2.5-flash'`) |
| Constant | `AP_FLOW_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'` in `config/constants.ts` |
| Migration | `server/src/db/migrations/048_ap-flow_extraction_due_date.sql` |
| Column | `ap_flow_extractions.due_date DATE NULL` |
| New file | `server/src/services/ap-flow/modelClient.ts` |
| Exports | `ApFlowAiProvider`, `ModelPurpose`, `MessagesClient`, `StructuredSchema`, `StructuredRequest`, `StructuredModelClient`, `ModelConfig`, `anthropicModelClient`, `geminiModelClient`, `resolveModelClient`, `isModelConfigured`, `findToolUseInput` |
| Schema consts | `GEMINI_EXTRACTION_SCHEMA` in `extractionService.ts`; `GEMINI_CLASSIFICATION_SCHEMA` in `mappingService.ts` |
| Type fields | `ExtractionResult.dueDate`, `ApFlowExtraction.dueDate` |
| Tests | `server/src/__tests__/ap-flow/modelClient.test.ts` (new); additions to `extraction.test.ts` |

### Step A1 — env + constants

- **Depends on:** Step 0
- **Skill:** none (config)
- **Read first:** `server/src/config/env.ts` (the `optional`/`integer` readers and the `problems` array)
- **Files:** `server/src/config/env.ts` (edit), `server/src/config/constants.ts` (edit, beside `AP_FLOW_VISION_MODEL`), `server/.env.example` (edit, after `ANTHROPIC_API_KEY`)
- **Contract:** add a reader to `env.ts`:
  ```ts
  function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T;
  // read(name) undefined → fallback; not in allowed → problems.push(`${name} must be one of ${allowed.join(' | ')}, got "${value}"`) and return fallback
  ```
  Add to `parsed`, directly after `ANTHROPIC_API_KEY`, with a `// Phase 19 —` comment in the file's existing style:
  ```ts
  AP_FLOW_AI_PROVIDER: oneOf('AP_FLOW_AI_PROVIDER', ['anthropic', 'gemini'] as const, 'anthropic'),
  GEMINI_API_KEY: optional('GEMINI_API_KEY', ''),
  AP_FLOW_GEMINI_MODEL: optional('AP_FLOW_GEMINI_MODEL', 'gemini-2.5-flash'),
  ```
  `.env.example` block:
  ```
  # Phase 19 — which vision/classification provider AP-Flow uses: anthropic | gemini.
  # Optional; defaults to anthropic. Only the selected provider's key is needed.
  AP_FLOW_AI_PROVIDER=anthropic
  # Google AI Studio / Gemini API key (called over fetch, no SDK). Optional.
  GEMINI_API_KEY=
  AP_FLOW_GEMINI_MODEL=gemini-2.5-flash
  ```
- **Guardrails:** #14 no package · #11 do not touch token secrets
- **Proof:** `npm run typecheck` exits 0; `AP_FLOW_AI_PROVIDER=openai npx tsx -e "import('./src/config/env.js')"` exits non-zero with `AP_FLOW_AI_PROVIDER must be one of anthropic | gemini`
- **If it fails:** fix the reader; never cast
- **Owes:** env table rows in `docs/development.md` (paid in F3)

### Step A2 — migration 048

- **Depends on:** A1
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/032_ap-flow_mapping_and_posting.sql` (header-comment style, `ADD COLUMN IF NOT EXISTS`)
- **Files:** `server/src/db/migrations/048_ap-flow_extraction_due_date.sql` (new)
- **Contract — literal SQL body (plus a header comment in 032's style explaining the column and that ADD COLUMN does not fire the UPDATE-immutability trigger):**
  ```sql
  ALTER TABLE ap_flow_extractions ADD COLUMN IF NOT EXISTS due_date DATE NULL;
  ```
- **Guardrails:** #13 additive, idempotent, never edit 031/032
- **Proof:** `npm run migrate` twice, both exit 0; `npx vitest run src/__tests__/migrations.test.ts` green
- **If it fails:** a new migration, never an edit
- **Owes:** `docs/schema.md` (F3)

### Step A3 — `modelClient.ts`

- **Depends on:** A1
- **Skill:** none (service without DB)
- **Read first:** `server/src/services/ap-flow/extractionService.ts` (current `realClient`, `findToolUseBlock`, request body), `server/src/services/taxguard/` embedding client file that calls Voyage over `fetch` (find it with `grep -rln "fetch(" server/src/services/taxguard/`) — copy its timeout/error style
- **Files:** `server/src/services/ap-flow/modelClient.ts` (new). **This file must not import `db/connect.js`.**
- **Contract — write these literally:**
  ```ts
  export type ApFlowAiProvider = 'anthropic' | 'gemini';
  export type ModelPurpose = 'extract' | 'classify';

  /** The Anthropic messages surface both existing test stubs already implement. */
  export interface MessagesClient {
    messages: { create(body: unknown, options?: { timeout?: number }): Promise<unknown> };
  }

  export interface StructuredSchema {
    name: string;                              // Anthropic tool name
    description: string;
    jsonSchema: Record<string, unknown>;       // Anthropic input_schema (JSON Schema)
    geminiSchema: Record<string, unknown>;     // Gemini responseSchema (OpenAPI subset)
  }

  export interface StructuredRequest {
    images: Buffer[];   // PNG bytes — REDACTED pages only
    prompt: string;
    schema: StructuredSchema;
    maxTokens: number;
    timeoutMs: number;
  }

  export interface StructuredModelClient {
    readonly provider: ApFlowAiProvider;
    readonly model: string;
    /** The structured object, or null when the model produced none. */
    generateStructured(request: StructuredRequest): Promise<unknown>;
  }

  export interface ModelConfig {
    provider: ApFlowAiProvider;
    anthropicApiKey: string;
    geminiApiKey: string;
    geminiModel: string;
  }

  export function findToolUseInput(response: unknown): unknown;   // tool_use block's input, or null
  export function anthropicModelClient(purpose: ModelPurpose, messages?: MessagesClient, apiKey?: string): StructuredModelClient;
  export function geminiModelClient(options: { apiKey: string; model: string; fetchImpl?: typeof fetch }): StructuredModelClient;
  export function isModelConfigured(config?: ModelConfig): boolean;
  export function resolveModelClient(purpose: ModelPurpose, config?: ModelConfig): StructuredModelClient;
  ```
  - `config` defaults to `{ provider: env.AP_FLOW_AI_PROVIDER, anthropicApiKey: env.ANTHROPIC_API_KEY, geminiApiKey: env.GEMINI_API_KEY, geminiModel: env.AP_FLOW_GEMINI_MODEL }`.
  - `anthropicModelClient`: `model` = `AP_FLOW_VISION_MODEL` for `'extract'`, `AP_FLOW_CLASSIFY_MODEL` for `'classify'`. `messages` defaults to a real `new Anthropic({ apiKey })` adapter (move `realClient` here). Body is **byte-for-byte the current extraction body shape**: `{ model, max_tokens: maxTokens, tools: [{ name, description, input_schema: jsonSchema }], tool_choice: { type: 'tool', name }, messages: [{ role: 'user', content: [...images as { type:'image', source:{ type:'base64', media_type:'image/png', data } }, { type:'text', text: prompt }] }] }`, called with `{ timeout: timeoutMs }`. Returns `findToolUseInput(response)`.
  - `geminiModelClient.generateStructured`:
    - `POST ${AP_FLOW_GEMINI_BASE_URL}/models/${model}:generateContent`
    - headers `{ 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }`, `signal: AbortSignal.timeout(timeoutMs)`
    - body:
      ```ts
      {
        contents: [{ role: 'user', parts: [
          ...images.map((png) => ({ inline_data: { mime_type: 'image/png', data: png.toString('base64') } })),
          { text: prompt },
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema.geminiSchema,
          maxOutputTokens: maxTokens,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }
      ```
    - `!response.ok` → `throw new ApiError(502, \`Gemini request failed with status ${String(response.status)}\`)` — never include the response body in the message.
    - Parse JSON; take `candidates[0].content.parts`, first part whose `text` is a string; `JSON.parse` it inside `try` → return the object; on any missing piece or parse failure return `null`.
  - `resolveModelClient`: provider `'anthropic'` with `anthropicApiKey === ''` → `throw new ApiError(503, 'Vision extraction is not configured (ANTHROPIC_API_KEY is unset)')` (this exact string — an existing test asserts 503). Provider `'gemini'` with `geminiApiKey === ''` → `throw new ApiError(503, 'Vision extraction is not configured (GEMINI_API_KEY is unset)')`.
  - `isModelConfigured` → the selected provider's key is non-empty.
- **Guardrails:** #14 no SDK for Gemini · PII: the file only ever receives buffers from its caller; do not add any rasterize/OCR import here
- **Proof:** `npm run typecheck` exits 0; `grep -c "db/connect" src/services/ap-flow/modelClient.ts` prints `0`
- **If it fails:** fix types; do not widen `generateStructured` to `any`
- **Owes:** nothing yet

### Step A4 — wire extraction + classification + handler; add `due_date`

- **Depends on:** A2, A3
- **Skill:** none (service edit)
- **Read first:** `server/src/services/ap-flow/extractionService.ts`, `mappingService.ts`, `apFlowExtractHandler.ts`, `schemas/ap-flow/extractionSchema.ts`, `services/ap-flow/sandboxSeed.ts` (its `ExtractionResult` literal)
- **Files (edit):** `services/ap-flow/extractionService.ts`, `services/ap-flow/mappingService.ts`, `queue/handlers/apFlowExtractHandler.ts`, `schemas/ap-flow/extractionSchema.ts`, `types/ap-flow.ts`, `services/ap-flow/apFlowDocumentService.ts` (`ExtractionRow`, `toExtraction`, the extraction `SELECT` in `getApFlowDocumentById`, the `INSERT` in `savePipelineResult`), `services/ap-flow/sandboxSeed.ts` (add `dueDate: null`)
- **Contract:**
  - `extractionService.ts`:
    - `export type VisionClient = MessagesClient;` (keeps every existing import compiling). Remove the local `realClient` and `findToolUseBlock` (now in `modelClient.ts`).
    - `EXTRACTION_TOOL.input_schema.properties` gains `due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' }`. Prompt text becomes `'Extract the vendor, invoice number, invoice date, due date, currency, subtotal, tax, total and line items from this document using the record_invoice tool. Report field_confidence keys using the same snake_case field names.'`
    - Add `export const GEMINI_EXTRACTION_SCHEMA` literally:
      ```ts
      const nullableString = (description?: string) => ({ type: 'STRING', nullable: true, ...(description === undefined ? {} : { description }) });
      const nullableNumber = { type: 'NUMBER', nullable: true };
      export const GEMINI_EXTRACTION_SCHEMA = {
        type: 'OBJECT',
        properties: {
          vendor_name: nullableString(),
          invoice_number: nullableString(),
          invoice_date: nullableString('YYYY-MM-DD'),
          due_date: nullableString('YYYY-MM-DD'),
          currency: nullableString('ISO 4217, e.g. USD'),
          subtotal: nullableString('Decimal STRING exactly as printed, e.g. "450.00"'),
          tax: nullableString('Decimal STRING exactly as printed'),
          total: nullableString('Decimal STRING exactly as printed'),
          line_items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { description: { type: 'STRING' }, amount: { type: 'STRING', description: 'Decimal STRING exactly as printed' } },
              required: ['description', 'amount'],
            },
          },
          field_confidence: {
            type: 'OBJECT',
            description: '0-1 confidence per field',
            properties: {
              vendor_name: nullableNumber, invoice_number: nullableNumber, invoice_date: nullableNumber, due_date: nullableNumber,
              currency: nullableNumber, subtotal: nullableNumber, tax: nullableNumber, total: nullableNumber,
            },
          },
        },
        required: ['line_items', 'field_confidence'],
      } as const;
      ```
      (Gemini's `responseSchema` has no `additionalProperties`, which is why confidence is a fixed object here.)
    - New signature: `export async function extractFromPages(pages: Buffer[], client?: VisionClient, modelClient?: StructuredModelClient): Promise<ExtractionResult>`. Resolution order: `modelClient` → `client !== undefined ? anthropicModelClient('extract', client) : resolveModelClient('extract')`. The `resolveModelClient` 503 replaces the old inline key check.
    - Call `generateStructured({ images: pages, prompt, schema: { name: 'record_invoice', description: EXTRACTION_TOOL.description, jsonSchema: EXTRACTION_TOOL.input_schema, geminiSchema: GEMINI_EXTRACTION_SCHEMA }, maxTokens: AP_FLOW_VISION_MAX_TOKENS, timeoutMs: AP_FLOW_VISION_TIMEOUT_MS })`. `null` → `throw new ApiError(502, 'Vision model returned no structured result')` (unchanged string).
    - Date guard: add `function parseIsoDate(raw, fieldName, errors): string | null` — `null/undefined` → `null`; matches `/^\d{4}-\d{2}-\d{2}$/` **and** `new Date(\`${raw}T00:00:00Z\`).toISOString().slice(0, 10) === raw` → `raw`; otherwise push `\`Could not parse ${fieldName} as a date\`` and return `null`. Apply to `invoice_date` and `due_date`.
    - `ExtractionResult` gains `dueDate: string | null`; `model: effectiveClient.model`.
  - `extractionSchema.ts`: add `due_date: z.string().nullable().optional(),`.
  - `types/ap-flow.ts`: `ApFlowExtraction` gains `dueDate: string | null; // 'YYYY-MM-DD'`.
  - `mappingService.ts`:
    - `export type ClassificationClient = MessagesClient;` remove `realClassifierClient` and the local `findToolUseBlock`.
    - Add `export const GEMINI_CLASSIFICATION_SCHEMA = { type: 'OBJECT', properties: { assignments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { line_index: { type: 'INTEGER' }, account_code: { type: 'STRING' }, confidence: { type: 'NUMBER' } }, required: ['line_index', 'account_code', 'confidence'] } } }, required: ['assignments'] } as const;`
    - `classifyLineItems(orgId, input, deps?: { classifier?: ClassificationClient; modelClient?: StructuredModelClient })`.
    - `classifyWithModel(unmapped, candidates, deps)`: client = `deps.modelClient` → `deps.classifier ? anthropicModelClient('classify', deps.classifier)` → `isModelConfigured() ? resolveModelClient('classify')` → else `console.warn('[ap-flow] account classification unavailable: no AI provider key is configured')` and return the empty map. `images: []`. Everything else (discarding unknown codes, degrade-on-throw) unchanged.
  - Handler: `deps?: { ocr?: OcrAdapter; vision?: VisionClient; classifier?: ClassificationClient; modelClient?: StructuredModelClient }`; pass `deps?.modelClient` as the 3rd arg of `extractFromPages` and inside `classifyLineItems`' deps.
  - `apFlowDocumentService.ts`: `due_date` added to `ExtractionRow` (`string | null`), `toExtraction` (`dueDate: row.due_date`), the extraction SELECT column list, and the `savePipelineResult` INSERT (new `$15` = `extraction.dueDate`).
  - `pg` returns `DATE` as a JS `Date` unless a type parser is set — check how `invoice_date` is typed/parsed today (`ExtractionRow.invoice_date: string | null`) and treat `due_date` identically.
- **Guardrails:** #3 money still strings→cents via `parseMoneyText` · #4 parameterized INSERT · PII: `extractFromPages` still receives only `redactedBuffers` from the handler — do not touch that call site's first argument
- **Proof:** `npm run typecheck` exits 0; `npx vitest run src/__tests__/ap-flow` — **every existing test passes unchanged**
- **If it fails:** an existing AP-Flow test failing means the seam changed behaviour — fix the code, not the test
- **Owes:** extend `study/architecture/llm-structured-extraction.md` (A5)

### Step A5 — tests + study note

- **Depends on:** A4
- **Skill:** `isolation-test` (conventions only — these are unit tests), `study-note`
- **Read first:** `server/src/__tests__/ap-flow/extraction.test.ts` (fetch spy pattern, `stubClient`)
- **Files:** `server/src/__tests__/ap-flow/modelClient.test.ts` (new), `server/src/__tests__/ap-flow/extraction.test.ts` (edit — add cases only), `study/architecture/llm-structured-extraction.md` (edit), `study/README.md` (edit)
- **Contract — test names and expectations (fake `fetchImpl` = `vi.fn` returning `new Response(JSON.stringify(...), { status })`):**
  - `modelClient.test.ts`
    - `geminiModelClient sends redacted PNGs as inline_data and the schema as responseSchema` → URL ends `/models/gemini-2.5-flash:generateContent`; header `x-goog-api-key` = `'test-key'`; `body.contents[0].parts[0].inline_data` = `{ mime_type: 'image/png', data: <png>.toString('base64') }`; last part `{ text: prompt }`; `generationConfig.responseMimeType === 'application/json'`; `generationConfig.responseSchema` deep-equals the passed `geminiSchema`
    - `geminiModelClient parses the JSON text part` → `{ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }` → `{ a: 1 }`
    - `geminiModelClient returns null when there are no candidates` → `{}` → `null`
    - `geminiModelClient returns null for non-JSON text` → text `'not json'` → `null`
    - `geminiModelClient throws 502 without echoing the response body` → status 429, body `{"error":"SECRET-ECHO"}` → rejects `ApiError` status 502, message `Gemini request failed with status 429`, message does not contain `SECRET-ECHO`
    - `anthropicModelClient returns the tool_use input` → stub returns `{ content: [{ type: 'tool_use', input: { x: 1 } }] }` → `{ x: 1 }`
    - `resolveModelClient throws 503 for gemini with no key` → `resolveModelClient('extract', { provider: 'gemini', anthropicApiKey: 'k', geminiApiKey: '', geminiModel: 'm' })` → 503, message contains `GEMINI_API_KEY`
    - `resolveModelClient returns a gemini client reporting its model` → `provider === 'gemini'`, `model === 'm'`
    - `live Gemini extraction of a generated invoice image` — `it.skipIf(process.env.AP_FLOW_GEMINI_E2E !== '1')`; renders a PNG with `sharp` SVG text `ACME SUPPLIES / Invoice INV-77 / Total 120.00`, calls `extractFromPages([png], undefined, resolveModelClient('extract', { provider: 'gemini', anthropicApiKey: '', geminiApiKey: process.env.GEMINI_API_KEY ?? '', geminiModel: process.env.AP_FLOW_GEMINI_MODEL ?? 'gemini-2.5-flash' }))` → `totalCents === 12000`
  - `extraction.test.ts` additions
    - `a StructuredModelClient stub yields the same cents as the Anthropic path` → stub `{ provider: 'gemini', model: 'gemini-test', generateStructured: () => Promise.resolve(<the worked-example input already used in this file>) }` → same cents as `extracts the docs/ap-flow.md worked example correctly`, `model === 'gemini-test'`
    - `a malformed invoice_date is nulled and recorded, not thrown` → `invoice_date: '15/08/2026'` → `invoiceDate === null`, `validationErrors` contains `Could not parse invoice_date as a date`
    - `due_date is extracted` → `due_date: '2026-09-14'` → `dueDate === '2026-09-14'`
  - Study note: extend `llm-structured-extraction.md` with a "Two providers, one seam" section — Anthropic forced `tool_choice` vs Gemini `responseMimeType` + `responseSchema` (constrained decoding), why Gemini's OpenAPI-subset schema forced `field_confidence` into a fixed object, why money stays a string on both, why `thinkingBudget: 0`, the adapter-over-interface pattern, 2 new interview Q&As. **Mark every Gemini API detail "verified against generativelanguage v1beta docs on <date you checked>" or "unverified".**
- **Proof:** `npx vitest run src/__tests__/ap-flow/modelClient.test.ts src/__tests__/ap-flow/extraction.test.ts` green, 1 skipped (the live case)
- **If it fails:** fix code. If you have a real key, run `AP_FLOW_GEMINI_E2E=1 GEMINI_API_KEY=... npx vitest run src/__tests__/ap-flow/modelClient.test.ts`; a 400/404 is a **stop-and-report** with the error JSON
- **Owes:** paid here

---

## Slice B — AP-Flow posts a real LedgerCore bill

**Outcome:** `POST /ap-flow/documents/:id/post` creates and approves a LedgerCore bill (vendor found-or-created, tax allocated exactly) in one transaction; AP aging reconciles and the bill is payable.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/049_ap-flow_bill_posting.sql` |
| Columns | `ap_flow_documents.bill_id UUID NULL` (no REFERENCES — rule 16), `ap_flow_documents.auto_posted BOOLEAN NOT NULL DEFAULT false` |
| Index | `idx_ap_flow_documents_bill` |
| Money util | `allocateCents` in `server/src/utils/money.ts` |
| Vendor export | `findOrCreateVendorByNameOnClient` in `services/ledger-core/vendorService.ts` |
| Bill exports | `CapturedBillLineInput`, `CapturedBillInput`, `createCapturedBillOnClient`, `approveBillOnClient` in `services/ledger-core/billService.ts` |
| Constant | `AP_FLOW_DEFAULT_DUE_DAYS = 30` in `config/constants.ts` |
| Posting | `postApFlowDocument(orgId, userId, id, options?: { autoPosted?: boolean })` |
| Record fields | `ApFlowDocumentRecord.billId: string \| null`, `ApFlowDocumentRecord.autoPosted: boolean` |
| Tests | `server/src/__tests__/ledger-core/capturedBills.test.ts` (new); edits to `ap-flow/posting.test.ts`, `money.test.ts` |

### Step B1 — migration 049

- **Depends on:** A2
- **Skill:** `new-migration`
- **Read first:** `032_ap-flow_mapping_and_posting.sql` (its rule-16-over-rule-8 header ruling — cite it)
- **Files:** `server/src/db/migrations/049_ap-flow_bill_posting.sql` (new)
- **Contract — literal SQL:**
  ```sql
  ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS bill_id UUID NULL;
  ALTER TABLE ap_flow_documents ADD COLUMN IF NOT EXISTS auto_posted BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS idx_ap_flow_documents_bill
    ON ap_flow_documents (org_id, bill_id) WHERE bill_id IS NOT NULL;
  ```
  Header comment must state: (1) `bill_id` has no FK, same ruling as `journal_entry_id` in 032; (2) `ADD COLUMN ... DEFAULT false` on a table holding POSTED rows is safe because PostgreSQL 11+ stores a constant default in the catalog (no rewrite, **no UPDATE, so `trg_ap_flow_documents_posted_guard` never fires**) — a backfill `UPDATE` would have been rejected by that trigger; (3) no new CHECK requires `bill_id` on POSTED rows, because pre-Phase-19 POSTED rows posted a raw journal entry and legitimately have `bill_id IS NULL`.
- **Guardrails:** #13 · #8/#16 ruling cited
- **Proof:** `npm run migrate` twice exits 0; `npx vitest run src/__tests__/migrations.test.ts` green
- **If it fails:** new migration, never edit
- **Owes:** `docs/schema.md` (F3); study note in B6

### Step B2 — `allocateCents`

- **Depends on:** Step 0
- **Skill:** none (pure util)
- **Read first:** `server/src/utils/money.ts` (`scaleCents`, `divideCents`) and `server/src/__tests__/money.test.ts`
- **Files:** `server/src/utils/money.ts` (edit), `server/src/__tests__/money.test.ts` (edit — add cases)
- **Contract:**
  ```ts
  /**
   * Splits `total` across `weights` in proportion, largest-remainder method,
   * in exact BigInt arithmetic. The parts always sum to `total`. Ties on the
   * remainder go to the lowest index.
   */
  export function allocateCents(total: Cents, weights: readonly Cents[]): Cents[];
  ```
  Errors: `total < 0` or any weight `< 0` → `new ApiError(400, 'Allocation amounts must not be negative')`; `weights.length === 0` or every weight `0` → `new ApiError(422, 'Cannot allocate across zero weights')`.
  Algorithm: `W = Σw`; `base_i = floor(total·w_i / W)`; `rem_i = (total·w_i) mod W`; hand the `total − Σbase` leftover cents one each to indices sorted by `rem_i` desc, then index asc.
- **Tests (add):** `allocateCents(1000, [3333, 3333, 3334])` → `[333, 333, 334]` · `allocateCents(100, [1, 1, 1])` → `[34, 33, 33]` · `allocateCents(0, [5, 5])` → `[0, 0]` · `allocateCents(7, [0, 10])` → `[0, 7]` · `allocateCents(10, [0, 0])` throws 422 · for `total` in `[1, 99, 12345]` and weights `[17, 29, 54]`, `sum === total`
- **Guardrails:** #3 no float division anywhere in the function
- **Proof:** `npx vitest run src/__tests__/money.test.ts` green; `grep -n "Math.round\|Math.floor\| / " src/utils/money.ts` shows no new hit inside `allocateCents`
- **If it fails:** fix arithmetic; never an epsilon
- **Owes:** B6 study note

### Step B3 — LedgerCore: `*OnClient` bill functions + vendor find-or-create

- **Depends on:** B2
- **Skill:** `new-module` (service layer, LedgerCore)
- **Read first:** `server/src/services/ledger-core/billService.ts` (all of `createBill`, `approveBill`, `computeLineTotals`, `insertBillLines`, `assertExpenseAccounts`, `resolveDocumentFxRate`), `server/src/services/ledger-core/vendorService.ts`, `server/src/services/ledger-core/journalService.ts` → `createEntryOnClient` (the `*OnClient` precedent)
- **Files (edit):** `server/src/services/ledger-core/billService.ts`, `server/src/services/ledger-core/vendorService.ts`
- **Contract:**
  - **Refactor, behaviour-preserving:** move the body between `beginTransaction(client)` and `COMMIT` of `createBill` into a private `insertBillOnClient(client, orgId, createdBy, header: Omit<CreateBillInput, 'lines'>, totals: LineTotal[]): Promise<string>` returning the bill id. `createBill` keeps `validateBillInput`, `computeLineTotals`, the transaction, the error mapping, and `getBillById`. Same for `approveBill` → exported `approveBillOnClient`. **`bills.test.ts`, `billConstraints.test.ts`, `payments.test.ts`, `aging.test.ts` must pass unchanged — that is the refactor's proof.**
  - New exports:
    ```ts
    export interface CapturedBillLineInput {
      description: string;       // non-blank, ≤ 500
      netCents: number;          // integer ≥ 0
      taxCents: number;          // integer ≥ 0
      expenseAccountId: string;
    }
    export interface CapturedBillInput {
      vendorId: string;
      vendorReference: string;   // non-blank, ≤ 100
      billDate: string;          // YYYY-MM-DD
      dueDate: string;           // YYYY-MM-DD, ≥ billDate
      currencyCode: string;
      notes: string | null;
      lines: CapturedBillLineInput[];
    }
    /** Inserts a DRAFT bill with explicit per-line net/tax on the caller's transaction. Returns the bill id. */
    export async function createCapturedBillOnClient(client: PoolClient, orgId: string, createdBy: string, input: CapturedBillInput): Promise<string>;
    /** approveBill's posting on the caller's transaction — no BEGIN/COMMIT/ROLLBACK/release inside. */
    export async function approveBillOnClient(client: PoolClient, orgId: string, userId: string, id: string, entryDate: string | null): Promise<{ journalEntryId: string }>;
    ```
    `createCapturedBillOnClient` builds `LineTotal[]` as `{ input: { description, quantityMilli: 1000, unitPriceCents: netCents, expenseAccountId, taxRateBp }, netCents, taxCents }` where `taxRateBp = netCents === 0 ? 0 : Math.min(10000, scaleCents(cents(taxCents), 10000, netCents))`, calls `validateBillInput` on the equivalent `CreateBillInput` shape (`paymentTerms: null`), then `insertBillOnClient`. **Neither OnClient function catches errors** — callers map them.
  - `vendorService.ts`:
    ```ts
    /**
     * Returns the id of this org's active vendor whose name normalizes equal
     * to `name`, creating one if none exists. Serialized per (org, normalized
     * name) by a transaction-scoped advisory lock, because vendors.name has no
     * UNIQUE constraint and two concurrent captures would otherwise both insert.
     */
    export async function findOrCreateVendorByNameOnClient(client: PoolClient, orgId: string, createdBy: string, name: string): Promise<string>;
    ```
    SQL, in order, all on `client`:
    1. `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))` with `[orgId, normalizeForMatching(name)]`
    2. `SELECT id, name FROM vendors WHERE org_id = $1 AND is_active = true ORDER BY created_at ASC, id ASC` → first row whose `normalizeForMatching(row.name) === normalizeForMatching(name)`
    3. none → `INSERT INTO vendors (org_id, created_by, name) VALUES ($1, $2, $3) RETURNING id` with `name.trim().slice(0, 200)`
    Empty/blank `name` → `throw new ApiError(422, 'A vendor name is required')`.
- **Guardrails:** #1 `org_id` in every statement · #5 every query on `client`, **zero `pool.query` inside either OnClient function** · #7 balance still checked in `approveBillOnClient` · #10 `canTransitionBill` still consulted
- **Proof:** `npm run typecheck` exits 0; `npx vitest run src/__tests__/ledger-core/bills.test.ts src/__tests__/ledger-core/billConstraints.test.ts src/__tests__/ledger-core/payments.test.ts src/__tests__/ledger-core/aging.test.ts src/__tests__/ledger-core/vendors.test.ts` all green with **no test edits**; `awk '/export async function approveBillOnClient/,/^}/' src/services/ledger-core/billService.ts | grep -c "pool\.\|COMMIT\|ROLLBACK"` prints `0`
- **If it fails:** a bill test changing result = the refactor changed behaviour → fix the refactor
- **Owes:** B6

### Step B4 — rewrite `postingService` onto bills; surface `billId`/`autoPosted`

- **Depends on:** B1, B3, A4
- **Skill:** `new-module` (service)
- **Read first:** `server/src/services/ap-flow/postingService.ts` (whole file), `apFlowDocumentService.ts` (`DOCUMENT_SELECT`, `toDocument`)
- **Files (edit):** `server/src/services/ap-flow/postingService.ts`, `server/src/services/ap-flow/apFlowDocumentService.ts`, `server/src/types/ap-flow.ts`, `server/src/config/constants.ts`, `sandbox/ap-flow/documents.json` (edit the first document's `outcomeComment` only: replace the `source_type 'ap_flow'` sentence with `Posted through postingService as a LedgerCore bill, so it appears in AP aging and can be paid; the bill links back to this AP-Flow document and its SHA-256.`)
- **Contract — `postApFlowDocument(orgId, userId, id, options?: { autoPosted?: boolean })`, one transaction, in this order:**
  1. `SELECT a.id, a.status, a.document_id, d.sha256, d.original_filename, x.vendor_name, x.invoice_number, x.invoice_date, x.due_date, x.currency, x.subtotal_cents, x.tax_cents, x.total_cents, x.arithmetic_ok ... FOR UPDATE OF a` (existing joins).
  2. Existing checks, **same strings, same order**: 404 → 409 status → 422 no extraction → 422 arithmetic → 422 invoice date → 422 positive total.
  3. **New** `422 'This document needs a vendor name before it can be posted'` (null or blank).
  4. **New** `422 'This document needs an invoice number before it can be posted'` (null or blank).
  5. Existing 422 no line items → 422 unmapped line.
  6. **New** `422 'A line item with a negative amount cannot be posted as a bill'`.
  7. `Σ line amount_cents + taxCents !== totalCents` → existing `422 'Extracted line items and tax do not sum to the document total'` (moved before any write).
  8. `baseCurrency` from `organizations` (existing query); `currencyCode = (doc.currency ?? baseCurrency).trim()`.
  9. `vendorId = await vendorService.findOrCreateVendorByNameOnClient(client, orgId, userId, doc.vendor_name)`.
  10. `lineTaxes = allocateCents(cents(taxCents), lines.map((l) => cents(amount)))` — when `taxCents === 0` skip the call and use zeros (all-zero line amounts would otherwise throw).
  11. `dueDate = doc.due_date !== null && doc.due_date >= doc.invoice_date ? doc.due_date : addDays(doc.invoice_date, AP_FLOW_DEFAULT_DUE_DAYS)` — write `addDays(isoDate: string, days: number): string` as a private UTC helper (`new Date(\`${d}T00:00:00Z\`)`, `setUTCDate`, `toISOString().slice(0, 10)`).
  12. `billId = await billService.createCapturedBillOnClient(client, orgId, userId, { vendorId, vendorReference: doc.invoice_number.trim().slice(0, 100), billDate: doc.invoice_date, dueDate, currencyCode, notes: \`Captured by AP-Flow from ${doc.original_filename}\`.slice(0, 1000), lines })` where each line is `{ description: row.description.trim() === '' ? \`Line ${String(row.line_index + 1)}\` : row.description.slice(0, 500), netCents, taxCents: lineTaxes[i], expenseAccountId: row.account_id }`. **Line items are not merged** — `approveBillOnClient` already merges same-account lines into one ledger line.
  13. `{ journalEntryId } = await billService.approveBillOnClient(client, orgId, userId, billId, null)`.
  14. `INSERT INTO document_links (org_id, document_id, app_slug, entity_type, entity_id, created_by) VALUES ($1, $2, 'ledger-core', 'bill', $3, $4) ON CONFLICT DO NOTHING`.
  15. `UPDATE ap_flow_documents SET status = 'POSTED', journal_entry_id = $3, bill_id = $4, posted_sha256 = $5, posted_at = now(), posted_by = $6, auto_posted = $7 WHERE org_id = $1 AND id = $2` with `$7 = options?.autoPosted === true`.
  16. Existing vendor-history upsert, unchanged.
  17. `COMMIT`.
  Catch: `ApiError` rethrow · `pgErrorCode(err) === '23505' && pgConstraint(err) === 'ux_bills_vendor_reference'` → `new ApiError(409, 'A bill with this invoice number already exists for this vendor')` · `P0001` → 422 (existing). Copy `pgConstraint` from `billService.ts`.
  Remove the now-unused imports of `journalService`, `fxRateService`, `resolveApPostingAccountsOnClient`, `sumCents` if unused. Update the file's header comment to describe bill posting.
  - `types/ap-flow.ts`: `ApFlowDocumentRecord` gains `billId: string | null;` (comment: `Phase 19. No REFERENCES to bills — rule 16.`) and `autoPosted: boolean;`.
  - `apFlowDocumentService.ts`: `DOCUMENT_SELECT` adds `a.bill_id, a.auto_posted`; `DocumentRow` + `toDocument` map them.
  - `constants.ts`: `export const AP_FLOW_DEFAULT_DUE_DAYS = 30;`
- **Guardrails:** #5 every write on `client`; no work after COMMIT · #16 **no** `FROM bills`/`FROM vendors`/`FROM accounts`/`FROM journal_entries` in `services/ap-flow/` · #6 a POSTED AP-Flow row is never updated again · #3 integer cents throughout
- **Proof:** `npm run typecheck` exits 0; `grep -rnE "FROM (accounts|journal_entries|ledger_lines|ledger_settings|fx_rates|bills|bill_lines|vendors)\b|INTO (bills|bill_lines|vendors|journal_entries)" src/services/ap-flow/ src/controllers/ap-flow/ src/routes/ap-flow/` prints nothing
- **If it fails:** a rule-16 grep hit means the SQL belongs in a LedgerCore service function — move it there, never inline it
- **Owes:** B5 tests, B6 notes

### Step B5 — tests for bill posting (the sanctioned test edits are listed here, and only here)

- **Depends on:** B4
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ap-flow/posting.test.ts` (whole file), `server/src/__tests__/ledger-core/bills.test.ts` (fixture setup), `server/src/__tests__/ledger-core/aging.test.ts` (how it calls the AP aging route)
- **Files:** `server/src/__tests__/ap-flow/posting.test.ts` (edit), `server/src/__tests__/ledger-core/capturedBills.test.ts` (new)
- **Sanctioned edits to existing tests in `posting.test.ts` — the spec changed (D2), nothing else may change:**
  - Fixture `seedExtractedDocument`: add option `invoiceNumber?: string | null`; insert `options.invoiceNumber === undefined ? \`INV-${sha256.slice(0, 8)}\` : options.invoiceNumber` instead of the literal `'INV-1'`.
  - Every query of the form `source_type = 'ap_flow' AND source_id = $2` with `apFlowDocId` becomes `source_type = 'bill' AND source_id = $2` with `res.body.document.billId` (or `first.body.document.billId`). Find them with `grep -n "'ap_flow'" src/__tests__/ap-flow/posting.test.ts`. The line-count and debit/credit assertions stay exactly as written.
  - Rename `the posted entry's source_id resolves back to the document's stored hash` → `the posted bill resolves back to the document's stored hash`; body: after posting, `SELECT source_id FROM journal_entries WHERE org_id = $1 AND id = $2` (the response's `journalEntryId`) equals `billId`, and `SELECT d.sha256 FROM ap_flow_documents a JOIN documents d ON d.org_id = a.org_id AND d.id = a.document_id WHERE a.org_id = $1 AND a.bill_id = $2` equals `sha256`.
  - `a failed post leaves the document EXTRACTED and the ledger untouched`: additionally assert `SELECT count(*) FROM bills WHERE org_id = $1` is unchanged.
- **New cases in `posting.test.ts`:**
  - `posting creates a POSTED bill and AP aging reconciles` → `bills.status = 'POSTED'`, `bills.total_cents = 20000`, `GET /api/v1/ledger-core/reports/ap-aging` → `body.reconciles === true`
  - `posting reuses an existing vendor whose name normalizes equal` → pre-insert vendor `'ACME VENDOR'` via `vendorService.createVendor(orgA, userA.id, { name: 'ACME VENDOR', email: null, phone: null, billingAddress: null, taxNumber: null, paymentTerms: null, notes: null })`; fixture vendor `'Acme Vendor.'` → `bills.vendor_id` = that id; `SELECT count(*) FROM vendors WHERE org_id = $1` = 1
  - `posting a duplicate invoice number for the same vendor returns 409 and leaves the second document EXTRACTED` → two fixtures, `invoiceNumber: 'DUP-1'`, different `sha256` → second post `409`, `error` = `A bill with this invoice number already exists for this vendor`, second doc status `EXTRACTED`, bills count 1
  - `document tax is allocated across bill lines and sums exactly` → lines `3333, 3333, 3334`, tax `1000`, total `11000` → `SELECT tax_cents FROM bill_lines ... ORDER BY line_number` = `[333, 333, 334]`, `bills.tax_cents = 1000`, `bills.total_cents = 11000`
  - `posting refuses a negative line item` → one line `-500`, total positive → `422`, `A line item with a negative amount cannot be posted as a bill`
  - `posting refuses a document with no invoice number` → `invoiceNumber: null` → `422`, `This document needs an invoice number before it can be posted`
  - `the vault document is linked to the posted bill` → `document_links` row with `app_slug = 'ledger-core'`, `entity_type = 'bill'`, `entity_id = billId`
  - `a missing due date defaults to invoice date plus 30 days` → invoice `2026-08-15` → `bills.due_date = '2026-09-14'`
  - `a manual post records auto_posted false` → `res.body.document.autoPosted === false`
- **`capturedBills.test.ts` (real PG, `pool.connect()` + `BEGIN` in the test):**
  - `createCapturedBillOnClient stores explicit per-line net and tax` → net `[500, 700]`, tax `[40, 56]` → `bill_lines` match; `bills.subtotal_cents = 1200`, `tax_cents = 96`, `total_cents = 1296`
  - `a ROLLBACK after approveBillOnClient leaves no bill and no journal entry` → create + approve, then `ROLLBACK` → `bills` count 0, `journal_entries` count 0 for the org
  - `findOrCreateVendorByNameOnClient never matches another organization's vendor` → org B has `'Globex'`; call for org A with `'globex'` → returns a new id; org A vendors count 1; org B's vendor untouched (cross-tenant)
  - `findOrCreateVendorByNameOnClient ignores inactive vendors` → inactive `'Initech'` in org A → new vendor created
- **Proof:** `npx vitest run src/__tests__/ap-flow src/__tests__/ledger-core src/__tests__/platform/sandbox.test.ts src/__tests__/integrity.test.ts` all green; `npm run verify:integrity` exits 0 after `npm run seed:demo` against the dev DB
- **If it fails:** `sandbox.test.ts` hitting `409` on vendor reference → stop and report (fixture collision, needs a plan decision). Any other failure → fix code
- **Owes:** B6

### Step B6 — study notes for Slice B

- **Depends on:** B5
- **Skill:** `study-note`
- **Files (edit):** `study/postgresql/subledger-reconciliation-and-aging.md` (add: the real bug — posting to a control account with no subledger document breaks `reconciles`; why the fix is routing through the subledger document, not adjusting the check), `study/typescript/branded-types-for-money.md` (add: largest-remainder allocation, why per-line rounding cannot reproduce a document-level tax), `study/postgresql/migrations-and-schema-evolution.md` (add: PG11+ fast default — `ADD COLUMN ... DEFAULT <constant>` writes no rows and fires no row triggers, and why that mattered next to a POSTED-row guard trigger), `study/postgresql/transactions-isolation-pooling.md` (add: `pg_advisory_xact_lock(hashtext(...))` for find-or-create without a UNIQUE constraint; hash collisions only over-serialize, never corrupt), `study/README.md` (index + coverage tracker)
- **Proof:** each note has its new section with ≥ 2 new Q&As and a "Verified against: PostgreSQL 16" line
- **Owes:** paid here

---

## Slice C — Confidence-gated auto-posting

**Outcome:** with auto-post enabled, the extraction worker posts a clean document as a bill with no human; otherwise the document stays `EXTRACTED` carrying the exact reasons it was not posted.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/050_ap-flow_auto_post.sql` |
| Table | `ap_flow_settings` — `id, org_id, auto_post_enabled, auto_post_min_confidence, auto_post_max_total_cents, updated_by, created_at, updated_at` |
| Column | `ap_flow_documents.auto_post_blockers JSONB NOT NULL DEFAULT '[]'` |
| Types | `AP_FLOW_AUTO_POST_BLOCKER_CODES`, `ApFlowAutoPostBlockerCode`, `ApFlowAutoPostBlocker`, `ApFlowSettings`, `AP_FLOW_AUTO_POST_DEFAULTS` in `types/ap-flow.ts`; `ApFlowDocumentRecord.autoPostBlockers`, `ApFlowReviewQueueEntry.autoPostBlockers` |
| Pure policy | `services/ap-flow/autoPostPolicy.ts` → `AutoPostCandidate`, `evaluateAutoPost` |
| Service | `services/ap-flow/autoPostService.ts` → `getSettings`, `updateSettings`, `attemptAutoPost` |
| Doc service | `apFlowDocumentService.recordAutoPostBlockers` |
| Schema | `schemas/ap-flow/settingsSchema.ts` → `updateApFlowSettingsSchema` |
| Controller | `controllers/ap-flow/apFlowSettingsController.ts` → `getSettings`, `updateSettings` |
| Routes | `routes/ap-flow/settingsRoutes.ts`, mounted `router.use('/settings', settingsRoutes)` → `/api/v1/ap-flow/settings` |
| Tests | `__tests__/ap-flow/autoPostPolicy.test.ts`, `__tests__/ap-flow/autoPost.test.ts` (new); `apFlowConstraints.test.ts` (add) |

### Step C1 — migration 050

- **Depends on:** B1
- **Skill:** `new-migration`
- **Read first:** `032_ap-flow_mapping_and_posting.sql` (trigger idioms), `server/src/db/migrations/010_ledger-core_*settings*.sql` or whichever migration creates `ledger_settings` (`ls src/db/migrations | grep settings`) — copy its per-org settings shape
- **Files:** `server/src/db/migrations/050_ap-flow_auto_post.sql` (new)
- **Contract — literal SQL:**
  ```sql
  CREATE TABLE IF NOT EXISTS ap_flow_settings (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    auto_post_enabled         BOOLEAN NOT NULL DEFAULT false,
    auto_post_min_confidence  NUMERIC(4,3) NOT NULL DEFAULT 0.900
                              CHECK (auto_post_min_confidence >= 0.500 AND auto_post_min_confidence <= 1.000),
    auto_post_max_total_cents BIGINT NULL
                              CHECK (auto_post_max_total_cents IS NULL OR auto_post_max_total_cents > 0),
    updated_by                UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ux_ap_flow_settings_org UNIQUE (org_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ap_flow_settings_updated_by ON ap_flow_settings (updated_by);

  CREATE OR REPLACE TRIGGER trg_ap_flow_settings_updated
    BEFORE UPDATE ON ap_flow_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  CREATE OR REPLACE TRIGGER trg_ap_flow_settings_audit
    AFTER INSERT OR UPDATE OR DELETE ON ap_flow_settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');

  ALTER TABLE ap_flow_documents
    ADD COLUMN IF NOT EXISTS auto_post_blockers JSONB NOT NULL DEFAULT '[]'::jsonb;

  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_documents_auto_post_blockers_array') THEN
      ALTER TABLE ap_flow_documents ADD CONSTRAINT chk_ap_flow_documents_auto_post_blockers_array
        CHECK (jsonb_typeof(auto_post_blockers) = 'array');
    END IF;
  END $$;
  ```
- **Guardrails:** #1 `org_id` + UNIQUE · #8 FKs with explicit ON DELETE, `updated_by` indexed · #13
- **Proof:** `npm run migrate` twice exits 0; migrations test green
- **Owes:** `docs/schema.md` (F3)

### Step C2 — types + pure policy

- **Depends on:** C1
- **Skill:** none (pure)
- **Read first:** `server/src/types/ap-flow.ts` (the `as const` + `satisfies` style)
- **Files:** `server/src/types/ap-flow.ts` (edit), `server/src/services/ap-flow/autoPostPolicy.ts` (new — no DB import)
- **Contract:**
  ```ts
  // types/ap-flow.ts
  export const AP_FLOW_AUTO_POST_BLOCKER_CODES = [
    'AUTO_POST_DISABLED', 'ARITHMETIC_MISMATCH', 'MISSING_VENDOR_NAME', 'MISSING_INVOICE_NUMBER',
    'MISSING_INVOICE_DATE', 'NON_POSITIVE_TOTAL', 'NO_LINE_ITEMS', 'UNMAPPED_LINE',
    'NEGATIVE_LINE_AMOUNT', 'LOW_FIELD_CONFIDENCE', 'LOW_MAPPING_CONFIDENCE',
    'ABOVE_AMOUNT_LIMIT', 'FOREIGN_CURRENCY_WITH_LIMIT', 'POSTING_REJECTED',
  ] as const;
  export type ApFlowAutoPostBlockerCode = (typeof AP_FLOW_AUTO_POST_BLOCKER_CODES)[number];
  export interface ApFlowAutoPostBlocker { code: ApFlowAutoPostBlockerCode; message: string }
  export interface ApFlowSettings {
    autoPostEnabled: boolean;
    autoPostMinConfidence: number;      // 0.5–1, 3 dp
    autoPostMaxTotalCents: number | null;
    updatedAt: string | null;           // null = never saved, defaults in force
  }
  export const AP_FLOW_AUTO_POST_DEFAULTS: ApFlowSettings = {
    autoPostEnabled: false, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null, updatedAt: null,
  };
  // ApFlowDocumentRecord gains: autoPostBlockers: ApFlowAutoPostBlocker[];
  // ApFlowReviewQueueEntry gains: autoPostBlockers: ApFlowAutoPostBlocker[];

  // services/ap-flow/autoPostPolicy.ts
  export interface AutoPostCandidate {
    vendorName: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    currency: string | null;
    baseCurrency: string;
    totalCents: number | null;
    arithmeticOk: boolean;
    fieldConfidence: Record<string, number>;
    lineItems: { amountCents: number; accountId: string | null; mappingSource: ApFlowMappingSource; mappingConfidence: number | null }[];
  }
  export function evaluateAutoPost(candidate: AutoPostCandidate, settings: ApFlowSettings): ApFlowAutoPostBlocker[];
  ```
  Rules, in this order, exact messages:
  1. `!settings.autoPostEnabled` → return **only** `[{ code: 'AUTO_POST_DISABLED', message: 'Auto-posting is turned off for this organization' }]`
  2. `!arithmeticOk` → `ARITHMETIC_MISMATCH`, `'Extraction totals do not reconcile'`
  3. vendor null/blank → `MISSING_VENDOR_NAME`, `'No vendor name was extracted'`
  4. invoice number null/blank → `MISSING_INVOICE_NUMBER`, `'No invoice number was extracted'`
  5. invoice date null → `MISSING_INVOICE_DATE`, `'No invoice date was extracted'`
  6. total null or ≤ 0 → `NON_POSITIVE_TOTAL`, `'The total is missing or not positive'`
  7. no line items → `NO_LINE_ITEMS`, `'No line items were extracted'`
  8. `n` lines with `accountId === null` (n > 0) → `UNMAPPED_LINE`, `` `${n} line item(s) have no account` ``
  9. any `amountCents < 0` → `NEGATIVE_LINE_AMOUNT`, `'A line item has a negative amount'`
  10. field confidence for the pairs `[['vendor_name','vendorName'], ['invoice_number','invoiceNumber'], ['invoice_date','invoiceDate'], ['total','total']]` — value = `fieldConfidence[snake] ?? fieldConfidence[camel] ?? 0`; collect the snake names below `autoPostMinConfidence`; if any → one `LOW_FIELD_CONFIDENCE`, `` `Low extraction confidence on: ${names.join(', ')}` ``
  11. `n` lines with `mappingSource` `'CHART'` or `'MODEL'` and `(mappingConfidence ?? 0) < autoPostMinConfidence` → `LOW_MAPPING_CONFIDENCE`, `` `${n} line item(s) were mapped below the confidence threshold` ``. `HISTORY` and `MANUAL` pass regardless of confidence (history is the org's own ground truth — Phase 11 ruling).
  12. `autoPostMaxTotalCents !== null`: `(currency ?? baseCurrency) !== baseCurrency` → `FOREIGN_CURRENCY_WITH_LIMIT`, `'An amount limit is set and this document is not in the base currency'`; else `totalCents !== null && totalCents > autoPostMaxTotalCents` → `ABOVE_AMOUNT_LIMIT`, `'The total is above the auto-post limit'`
- **Guardrails:** #3 integer compare for money; confidence is a ratio, not money, a `number` is correct · #10 no status writes here
- **Proof:** `npm run typecheck` exits 0; `grep -c "db/connect" src/services/ap-flow/autoPostPolicy.ts` prints `0`
- **Owes:** C5 tests

### Step C3 — settings service, `attemptAutoPost`, handler hook, doc-service edits

- **Depends on:** C2, B4
- **Skill:** `new-module` (service)
- **Read first:** `server/src/services/ledger-core/settingsService.ts` (lazy-defaults read + upsert pattern), `apFlowDocumentService.ts`
- **Files:** `server/src/services/ap-flow/autoPostService.ts` (new), `server/src/services/ap-flow/apFlowDocumentService.ts` (edit), `server/src/queue/handlers/apFlowExtractHandler.ts` (edit)
- **Contract:**
  ```ts
  export async function getSettings(orgId: string): Promise<ApFlowSettings>;
  export async function updateSettings(
    orgId: string,
    userId: string,
    input: { autoPostEnabled: boolean; autoPostMinConfidence: number; autoPostMaxTotalCents: number | null },
  ): Promise<ApFlowSettings>;
  /** Never throws. Called by the extraction worker after savePipelineResult. */
  export async function attemptAutoPost(orgId: string, apFlowDocumentId: string): Promise<'POSTED' | 'BLOCKED' | 'SKIPPED'>;
  ```
  - `getSettings`: `SELECT auto_post_enabled, auto_post_min_confidence, auto_post_max_total_cents, updated_at FROM ap_flow_settings WHERE org_id = $1` → none → `{ ...AP_FLOW_AUTO_POST_DEFAULTS }`. `NUMERIC` arrives as a string → `Number()`; `BIGINT` string → `Number()`.
  - `updateSettings` via `withTransaction`: `INSERT INTO ap_flow_settings (org_id, auto_post_enabled, auto_post_min_confidence, auto_post_max_total_cents, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id) DO UPDATE SET auto_post_enabled = EXCLUDED.auto_post_enabled, auto_post_min_confidence = EXCLUDED.auto_post_min_confidence, auto_post_max_total_cents = EXCLUDED.auto_post_max_total_cents, updated_by = EXCLUDED.updated_by`, then return `getSettings(orgId)`.
  - `attemptAutoPost`:
    1. `settings = await getSettings(orgId)`
    2. `doc = await apFlowDocumentService.getApFlowDocumentById(orgId, id)` — `ApiError` 404 → return `'SKIPPED'`; `doc.status !== 'EXTRACTED' || doc.extraction === null` → `'SKIPPED'`
    3. `baseCurrency` via `SELECT base_currency FROM organizations WHERE id = $1` (`.trim()`)
    4. `blockers = evaluateAutoPost({ ...from doc.extraction and doc.lineItems }, settings)`; non-empty → `recordAutoPostBlockers(orgId, id, blockers)`; return `'BLOCKED'`
    5. `try { await postingService.postApFlowDocument(orgId, doc.createdBy, id, { autoPosted: true }); return 'POSTED'; }`
       `catch (err)`: `err instanceof ApiError && (err.status === 409 || err.status === 422)` → record `[{ code: 'POSTING_REJECTED', message: err.message }]`; any other error → `console.error('[ap-flow] auto-post failed:', err)` and record `[{ code: 'POSTING_REJECTED', message: 'Posting failed unexpectedly — post it manually from the review queue' }]`. Recording itself inside its own `try/catch` that only logs. Return `'BLOCKED'`.
    (Check the `ApiError` class for its status field name — `grep -n "class ApiError" -A8 src/utils/apiError.ts` — and use that exact name.)
  - `apFlowDocumentService.ts`:
    ```ts
    export async function recordAutoPostBlockers(orgId: string, id: string, blockers: ApFlowAutoPostBlocker[]): Promise<void>;
    // withTransaction: UPDATE ap_flow_documents SET auto_post_blockers = $3::jsonb
    //   WHERE org_id = $1 AND id = $2 AND status = 'EXTRACTED'
    ```
    (`status = 'EXTRACTED'` in the WHERE is load-bearing: a concurrently POSTED row is filtered out before the UPDATE, so the posted-guard trigger never fires.)
    - `DOCUMENT_SELECT` adds `a.auto_post_blockers`; `DocumentRow`/`toDocument` map it.
    - `listReviewQueue` selects `a.auto_post_blockers`; `ReviewQueueRow`/`toReviewQueueEntry` map it.
    - `requestReextraction`'s UPDATE and `savePipelineResult`'s EXTRACTED UPDATE both add `auto_post_blockers = '[]'::jsonb`.
  - Handler: import `* as autoPostService`; directly after `await apFlowDocumentService.savePipelineResult(...)` add `await autoPostService.attemptAutoPost(orgId, apFlowDocumentId);` with a comment that it never throws, so an auto-post refusal can never mark an extracted document `FAILED`.
- **Guardrails:** #1 · #5 (posting owns its own transaction; `attemptAutoPost` holds none open around it) · #16 `organizations` is a platform table, allowed
- **Proof:** `npm run typecheck` exits 0; `npx vitest run src/__tests__/ap-flow` still green (auto-post defaults to disabled, so existing pipeline tests end `EXTRACTED` as before)
- **Owes:** C5

### Step C4 — settings routes

- **Depends on:** C3
- **Skill:** `new-module` (controller + routes + mount)
- **Read first:** `server/src/controllers/ap-flow/apFlowDocumentController.ts`, `server/src/routes/ap-flow/reviewRoutes.ts`, `server/src/schemas/ap-flow/lineItemSchema.ts`
- **Files:** `server/src/schemas/ap-flow/settingsSchema.ts` (new), `server/src/controllers/ap-flow/apFlowSettingsController.ts` (new), `server/src/routes/ap-flow/settingsRoutes.ts` (new), `server/src/routes/ap-flow/index.ts` (edit)
- **Contract:**
  ```ts
  export const updateApFlowSettingsSchema = z.object({
    autoPostEnabled: z.boolean(),
    autoPostMinConfidence: z.number().min(0.5).max(1)
      .refine((v) => /^(0\.\d{1,3}|1(\.0{1,3})?)$/.test(String(v)), 'autoPostMinConfidence allows at most 3 decimal places'),
    autoPostMaxTotalCents: z.number().int().positive().nullable(),
  });
  ```
  | Method | Path | Roles | Success | Failures |
  |---|---|---|---|---|
  | GET | `/api/v1/ap-flow/settings` | every member | `200 { success: true, settings }` | `401` |
  | PUT | `/api/v1/ap-flow/settings` | `requireRole('OWNER', 'ADMIN')` | `200 { success: true, settings }` | `400` (schema, via `parseBody`), `401`, `403` |
  Mount in `routes/ap-flow/index.ts`: `router.use('/settings', settingsRoutes);` before `/documents`.
- **Guardrails:** #2 zero SQL in controller · #1 `orgId` from `requireUser(req)` only
- **Proof:** `npm run typecheck`; `grep -c "query" src/controllers/ap-flow/apFlowSettingsController.ts` prints `0`
- **Owes:** `docs/api.md` (F3)

### Step C5 — tests for auto-post

- **Depends on:** C4
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ap-flow/pipeline.test.ts` (queue obliterate, `buildFixture`, `ordinaryOcr`, handler called directly), `apFlowConstraints.test.ts`
- **Files:** `server/src/__tests__/ap-flow/autoPostPolicy.test.ts` (new), `server/src/__tests__/ap-flow/autoPost.test.ts` (new), `server/src/__tests__/ap-flow/apFlowConstraints.test.ts` (edit — add)
- **Contract — named cases:**
  - `autoPostPolicy.test.ts` (pure; build a `clean()` candidate: vendor `'Acme'`, invoice `'A-1'`, date `'2026-08-15'`, currency `'USD'`, base `'USD'`, total 10000, arithmetic ok, confidence 0.99 on all four snake keys, one line 10000 HISTORY 0.65 mapped; settings enabled 0.9 no limit)
    - `disabled returns only AUTO_POST_DISABLED` → length 1
    - `a clean HISTORY-mapped document has no blockers` → `[]`
    - `camelCase field_confidence keys are honoured` → keys `vendorName, invoiceNumber, invoiceDate, total` at 0.99 → `[]`
    - `a missing confidence key counts as zero` → drop `total` → one `LOW_FIELD_CONFIDENCE` with message `Low extraction confidence on: total`
    - `MODEL mapping below threshold blocks, HISTORY below threshold does not` → MODEL 0.8 → `LOW_MAPPING_CONFIDENCE`; HISTORY 0.65 → none
    - `ABOVE_AMOUNT_LIMIT when the total exceeds the limit` → limit 9999
    - `FOREIGN_CURRENCY_WITH_LIMIT when a limit is set and the currency differs` → currency `'EUR'`, limit 1
    - `every failing gate is reported, not just the first` → vendor null + invoice null + arithmetic false → codes include all three
  - `autoPost.test.ts` (integration; `modelClient` stub returns `{ vendor_name: 'Acme Vendor', invoice_number: <unique per test>, invoice_date: '2026-08-15', due_date: null, currency: 'USD', subtotal: '100.00', tax: '0.00', total: '100.00', line_items: [{ description: 'Office supplies', amount: '100.00' }], field_confidence: { vendor_name: 0.99, invoice_number: 0.99, invoice_date: 0.99, total: 0.99 } }`; classification made HISTORY by inserting `ap_flow_vendor_account_map (org_id, vendor_key, account_id)` with `vendor_key = 'acme vendor'` → the `6130` account — confirm the key with `mappingService.vendorKeyOf('Acme Vendor')` in the test rather than hardcoding)
    - `GET /settings returns defaults for a fresh organization` → `{ autoPostEnabled: false, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null, updatedAt: null }`
    - `PUT /settings is refused for an ACCOUNTANT` → `403`
    - `PUT /settings rejects a threshold below 0.5` → `400`
    - `PUT /settings persists and GET reads it back` → `200`, then GET → `autoPostEnabled: true`, `updatedAt` non-null
    - `the pipeline auto-posts a clean document when enabled` → after handler: `status === 'POSTED'`, `autoPosted === true`, `billId` non-null, `bills.status = 'POSTED'`, `autoPostBlockers` `[]`
    - `the pipeline leaves a document EXTRACTED with AUTO_POST_DISABLED when disabled` → `autoPostBlockers[0].code === 'AUTO_POST_DISABLED'`
    - `a duplicate invoice is blocked with POSTING_REJECTED, not FAILED` → two different PNGs (vary `background`), same invoice number → second doc `EXTRACTED`, `autoPostBlockers[0].code === 'POSTING_REJECTED'`, handler promise resolves
    - `re-extracting clears auto_post_blockers` → blocked doc → `POST /documents/:id/reextract` → `autoPostBlockers` `[]`
    - `settings are isolated per organization` → org A enabled; org B `GET /settings` → defaults; org B pipeline doc ends `EXTRACTED` with `AUTO_POST_DISABLED` (cross-tenant)
  - `apFlowConstraints.test.ts` additions (raw SQL bypassing services)
    - `ap_flow_settings rejects a threshold above 1` → `23514`
    - `ap_flow_settings allows one row per organization` → second INSERT same org → `23505`
    - `auto_post_blockers must be a JSON array` → `UPDATE ... SET auto_post_blockers = '{}'` on an EXTRACTED row → `23514`
- **Proof:** `npx vitest run src/__tests__/ap-flow` green; then full `npm test` green
- **If it fails:** fix code; a POSTED doc raising `0A000` from `recordAutoPostBlockers` means the `status = 'EXTRACTED'` predicate is missing
- **Owes:** C6

### Step C6 — study note

- **Depends on:** C5
- **Skill:** `study-note`
- **Files:** `study/architecture/confidence-gated-automation.md` (new, from `study/TEMPLATE.md`), `study/README.md`
- **Contract:** mechanism = straight-through processing: pure policy function → blockers as persisted data → same posting path for human and machine; why every gate is evaluated (not short-circuit) except the disabled switch; why HISTORY bypasses the threshold; why posting refusals from the DB (duplicate, locked period, missing FX) become blockers rather than job failures; why the actor is the uploader; rejected alternatives (auto-post at a fixed confidence with no settings; a separate auto-post queue; model-self-reported "ok to post"). 5 interview Q&As with full answers.
- **Owes:** paid here

---

## Slice D — Upload straight into AP-Flow from its own page

**Outcome:** a user drags invoices onto the AP-Flow page; each file is vaulted and registered in one call, and the list refreshes itself until processing finishes. *Can run in parallel with Slices B/C after Slice A.*

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Service | `apFlowDocumentService.captureFile(orgId, userId, file)` |
| Controller | `apFlowDocumentController.upload` |
| Route | `POST /api/v1/ap-flow/documents/upload` |
| Client fetch | `uploadApFlowDocument(file: File)` in `client/src/services/fetchServices.ts` |
| Client component | `client/src/Pages/ap-flow/ApFlowUploadPanel.tsx` (default export `ApFlowUploadPanel`, prop `onUploaded: () => void`) |
| Tests | `server/src/__tests__/ap-flow/upload.test.ts`, `client/src/__tests__/apFlowUpload.test.tsx` |

### Step D1 — `captureFile` + route

- **Depends on:** A4
- **Skill:** `new-module`
- **Read first:** `server/src/controllers/documentController.ts` (`upload`), `server/src/routes/documents.ts` (middleware order comment), `apFlowDocumentService.createApFlowDocument`
- **Files:** `server/src/services/ap-flow/apFlowDocumentService.ts` (edit), `server/src/controllers/ap-flow/apFlowDocumentController.ts` (edit), `server/src/routes/ap-flow/documentRoutes.ts` (edit)
- **Contract:**
  ```ts
  export async function captureFile(
    orgId: string,
    userId: string,
    file: { buffer: Buffer; originalname: string },
  ): Promise<{ document: ApFlowDocumentRecord; created: boolean }>;
  ```
  1. `const mime = sniffMimeType(file.buffer, file.originalname)`; `mime === null` → `throw new ApiError(415, 'Unsupported file type. Allowed: PDF, PNG, JPEG')`; `!SCANNABLE_MIME_TYPES.has(mime)` → `throw new ApiError(422, 'AP-Flow can only process PDF, PNG and JPEG documents')` — **before** anything is stored.
  2. `const { document: vaultDoc } = await documentService.uploadDocument(orgId, userId, file)`.
  3. `SELECT id FROM ap_flow_documents WHERE org_id = $1 AND document_id = $2` → found → `{ document: await loadDocument(orgId, id), created: false }`.
  4. Else `try { return { document: await createApFlowDocument(orgId, userId, { documentId: vaultDoc.id }), created: true }; }` catch `ApiError` status 409 → re-run the step-3 SELECT and return `created: false`.
  Controller:
  ```ts
  /** POST /ap-flow/documents/upload — multipart, field "file". */
  export const upload: RequestHandler = async (req, res) => {
    const user = requireUser(req);
    if (req.file === undefined) throw new ApiError(400, 'Send exactly one file in a field named "file"');
    const { document, created } = await apFlowDocumentService.captureFile(user.orgId, user.id, { buffer: req.file.buffer, originalname: req.file.originalname });
    res.status(created ? 201 : 200).json({ success: true, document, created });
  };
  ```
  Route, placed directly after `router.post('/', ...)`:
  `router.post('/upload', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), singleFileUpload, apFlowDocumentController.upload);` — `singleFileUpload` **after** `requireRole`, same reason as `routes/documents.ts`.
  Status table: `201` new · `200` already captured · `400` no file · `401` · `403` VIEWER · `413 File exceeds the 10 MB limit` · `415` · `422`.
- **Guardrails:** #2 · #1 · rule 16: calls the platform `documentService`, never another app
- **Proof:** `npm run typecheck`
- **Owes:** `docs/api.md` (F3)

### Step D2 — server tests

- **Depends on:** D1
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ap-flow/documents.test.ts` (upload via supertest `.attach`, queue cleanup)
- **Files:** `server/src/__tests__/ap-flow/upload.test.ts` (new)
- **Cases:**
  - `uploading a PNG vaults it and creates a PENDING AP-Flow document in one call` → `201`, `document.status === 'PENDING'`, `created === true`, `documents` count 1, `document_links` row `app_slug = 'ap-flow'`
  - `re-uploading identical bytes returns 200 with the same document` → `200`, `created === false`, same `document.id`, `ap_flow_documents` count 1
  - `a CSV upload returns 422 and stores nothing` → `422`, `documents` count 0
  - `an unrecognised file returns 415` → random bytes → `415`
  - `a VIEWER cannot upload` → `403`
  - `an upload is visible only to the uploader's organization` → org B `GET /api/v1/ap-flow/documents` → `totalCount === 0`; org B `GET /api/v1/ap-flow/documents/<orgA doc id>` → `404` (cross-tenant)
- **Proof:** `npx vitest run src/__tests__/ap-flow/upload.test.ts` green

### Step D3 — client upload panel, POSTED pill fix, auto-refresh

- **Depends on:** D1
- **Skill:** none (client)
- **Read first:** `client/src/Pages/ap-flow/ApFlowDocumentsPage.tsx`, `client/src/services/fetchServices.ts` (`uploadDocument`, `apiUpload`, `ApFlowDocument` type), `client/src/__tests__/apFlowDocuments.test.tsx` (how services are mocked)
- **Files:** `client/src/services/fetchServices.ts` (edit), `client/src/Pages/ap-flow/ApFlowUploadPanel.tsx` (new), `client/src/Pages/ap-flow/ApFlowDocumentsPage.tsx` (edit), `client/src/__tests__/apFlowUpload.test.tsx` (new)
- **Contract:**
  - `fetchServices.ts`:
    ```ts
    /** POST /ap-flow/documents/upload — 201 new, 200 already captured. */
    export function uploadApFlowDocument(file: File): Promise<{ success: boolean; document: ApFlowDocument; created: boolean }> {
      return apiUpload('/ap-flow/documents/upload', () => { const body = new FormData(); body.append('file', file); return body; });
    }
    ```
    Add `billId: string | null; autoPosted: boolean; autoPostBlockers: { code: string; message: string }[]` to the client `ApFlowDocument` type, `dueDate: string | null` to its extraction type, `autoPostBlockers` to the review-queue entry type.
  - `ApFlowUploadPanel`: a bordered panel (`rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4`, dashed border while dragging) with text `Drop invoices, bills or receipts here (PDF, PNG, JPEG — up to 10 MB each)`, a visually-labelled `<input type="file" multiple accept="application/pdf,image/png,image/jpeg">` (label `Choose files`), `onDragOver` (preventDefault) / `onDrop`. Files upload **sequentially** (`for ... of` with `await`). Per-file list rows: `Uploading…` · `Captured` (201) · `Already captured` (200) · the error message (catch). Call `onUploaded()` once after the batch.
  - `ApFlowDocumentsPage`:
    - Render `<ApFlowUploadPanel onUploaded={() => setReloadToken((t) => t + 1)} />` above the filters.
    - Rename the vault picker label `Capture a document` → `Or capture from the Document Vault`. Replace both "upload one to the Document Vault first" empty-state texts with `No documents yet — drop one above.`
    - `STATUS_OPTIONS` = `['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED', 'POSTED']`; `StatusPill` gets a `POSTED` branch (`bg-violet-500/10 text-violet-400 ring-violet-500/20`, text `Posted`) **before** the fallthrough Failed branch.
    - New table column `Posting` after Status: `Auto` when `doc.autoPosted`, `Manual` when `status === 'POSTED'`, `—` otherwise.
    - Auto-refresh: a `useEffect` on `documents` that, when any row is `PENDING` or `PROCESSING`, sets `setInterval(() => setReloadToken((t) => t + 1), 5000)` and clears it in cleanup.
  - `apFlowUpload.test.tsx` cases: `uploads each selected file in order and reports a duplicate` (mock `uploadApFlowDocument` → first `{created:true}`, second `{created:false}`; assert call order and texts `Captured`, `Already captured`) · `an upload error is shown against that file` · `a POSTED document renders a Posted pill, not Failed`
- **Proof:** `cd client && npm run typecheck` (or the project's equivalent — check `client/package.json` scripts) and `npm test` green
- **Owes:** study note: extend `study/react/context-effects-and-data-fetching.md` with interval polling tied to derived state and its cleanup (in this step)

---

## Slice E — Google Drive folder intake

**Outcome:** an OWNER/ADMIN connects Google Drive, pastes a folder link, and every new PDF/PNG/JPEG in that folder is pulled into AP-Flow within 5 minutes (or on "Sync now"), once per file, into that org only.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Env vars | `GOOGLE_OAUTH_CLIENT_ID` (`''`), `GOOGLE_OAUTH_CLIENT_SECRET` (`''`), `GOOGLE_OAUTH_REDIRECT_URI` (default `'http://localhost:5000/api/v1/ap-flow/drive/oauth/callback'`), `INTEGRATION_ENCRYPTION_KEY` (`''`; when set must be 64 hex chars) |
| Constants | `AP_FLOW_DRIVE_POLL_INTERVAL_MS = 300_000`, `AP_FLOW_DRIVE_MAX_FILES_PER_SYNC = 25`, `AP_FLOW_DRIVE_OAUTH_STATE_TTL_MINUTES = 10`, `GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'`, `GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'`, `GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'`, `GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'`, `GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'`, `GOOGLE_HTTP_TIMEOUT_MS = 30_000` |
| Utils | `server/src/utils/secretBox.ts` → `encryptSecret`, `decryptSecret`; `server/src/utils/pkce.ts` → `randomUrlToken`, `pkceChallengeS256`, `sha256Hex` |
| Migration | `server/src/db/migrations/051_ap-flow_drive_intake.sql` |
| Tables | `ap_flow_drive_connections`, `ap_flow_drive_files` |
| Types | `AP_FLOW_DRIVE_CONNECTION_STATUSES`, `ApFlowDriveConnectionStatus`, `AP_FLOW_DRIVE_CONNECTION_TRANSITIONS`, `canTransitionApFlowDriveConnection`, `ApFlowDriveConnection` in `types/ap-flow.ts` |
| Google client | `server/src/services/ap-flow/googleDriveClient.ts` → `FetchLike`, `GoogleOAuthConfig`, `GoogleDriveError`, `DRIVE_ID_PATTERN`, `parseFolderInput`, `buildAuthorizationUrl`, `exchangeCode`, `refreshAccessToken`, `getAccountEmail`, `getFolder`, `DriveFile`, `listFolderFiles`, `downloadFile`, `revokeToken` |
| Service | `server/src/services/ap-flow/driveConnectionService.ts` → `DriveServiceDeps`, `isDriveConfigured`, `getConnection`, `startConnect`, `completeConnect`, `setFolder`, `requestSync`, `disconnect`, `listConnectionsDueForSync`, `syncConnection` |
| Queues | `'ap-flow-drive-sweep'` (payload `Record<string, never>`), `'ap-flow-drive-sync'` (payload `{ orgId: string; connectionId: string }`) |
| Handlers | `queue/handlers/apFlowDriveSweepHandler.ts` → `handleApFlowDriveSweep`; `queue/handlers/apFlowDriveSyncHandler.ts` → `handleApFlowDriveSync` |
| Scheduler id | `'ap-flow-drive-sweep-tick'` |
| Schema | `schemas/ap-flow/driveSchema.ts` → `setDriveFolderSchema` |
| Controller | `controllers/ap-flow/apFlowDriveController.ts` → `getConnection`, `connect`, `oauthCallback`, `setFolder`, `sync`, `disconnect` |
| Routes | `routes/ap-flow/driveRoutes.ts`, mounted `router.use('/drive', driveRoutes)` |
| Client | `client/src/Pages/ap-flow/ApFlowSettingsPage.tsx`, route `settings` in `ApFlowRoutes.tsx` |
| Tests | `__tests__/secretBox.test.ts`, `__tests__/ap-flow/googleDriveClient.test.ts`, `__tests__/ap-flow/driveIntake.test.ts`, additions to `apFlowConstraints.test.ts`, `client/src/__tests__/apFlowSettings.test.tsx` |

**Rule-1 exceptions in this slice — exactly two, each commented in code with its reason:**
1. `completeConnect`'s state lookup `WHERE oauth_state_sha256 = $1` has no `org_id` predicate: the Google redirect carries no session, the 256-bit state *is* the credential, and it was bound to exactly one org by an authenticated OWNER/ADMIN in `startConnect`. The org comes **from the matched row**, never from the request.
2. `listConnectionsDueForSync` reads across orgs: it is the scheduler sweep (same status as `verifyIntegrity`), returns ids only, and every downstream call takes that row's own `org_id`.

### Step E1 — env, constants, `secretBox`, `pkce`

- **Depends on:** Step 0
- **Skill:** none (config + pure utils)
- **Read first:** `server/src/config/env.ts` (`secret()` reader), `server/src/utils/checksum.ts` or any `node:crypto` user (`grep -rln "node:crypto" src/utils`)
- **Files:** `config/env.ts`, `config/constants.ts`, `.env.example` (edit); `utils/secretBox.ts`, `utils/pkce.ts`, `__tests__/secretBox.test.ts` (new)
- **Contract:**
  - `env.ts`: four `optional(..., '')`/default entries as named above; after `parsed`, if `INTEGRATION_ENCRYPTION_KEY !== ''` and `!/^[0-9a-fA-F]{64}$/.test(...)` → `problems.push('INTEGRATION_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32')`.
  - `.env.example` block with a comment listing the Google Cloud setup (enable Drive API, OAuth consent screen, Web OAuth client, authorized redirect URI = `GOOGLE_OAUTH_REDIRECT_URI`) and `openssl rand -hex 32` for the key.
  - `secretBox.ts`:
    ```ts
    /** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>`, each base64url. 12-byte random IV per call. */
    export function encryptSecret(plaintext: string, keyHex: string): string;
    /** Throws `new Error('Invalid secret payload')` on a bad format, wrong key, or tampered tag. */
    export function decryptSecret(payload: string, keyHex: string): string;
    ```
    Use `createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)`, `getAuthTag()`, `createDecipheriv` + `setAuthTag` before `final()`. Key length ≠ 32 bytes → `throw new Error('Encryption key must be 32 bytes')`.
  - `pkce.ts`:
    ```ts
    export function randomUrlToken(bytes?: number): string;       // default 32 → randomBytes(bytes).toString('base64url')
    export function pkceChallengeS256(verifier: string): string;  // createHash('sha256').update(verifier).digest('base64url')
    export function sha256Hex(value: string): string;             // createHash('sha256').update(value).digest('hex')
    ```
  - `secretBox.test.ts`: `round-trips a secret` · `two encryptions of the same plaintext differ` · `a tampered ciphertext is rejected` (flip one char of the last segment → throws `Invalid secret payload`) · `the wrong key is rejected` · `pkceChallengeS256 matches the RFC 7636 appendix B vector` (verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`)
- **Guardrails:** #11 this key is not a JWT secret; do not reuse `ACCESS_TOKEN_SECRET`/`REFRESH_TOKEN_SECRET` · #14 `node:crypto` only
- **Proof:** `npx vitest run src/__tests__/secretBox.test.ts` green; `npm run typecheck`

### Step E2 — migration 051

- **Depends on:** C1
- **Skill:** `new-migration`
- **Read first:** `031_ap-flow_documents.sql` (composite FKs), `study/postgresql/composite-foreign-keys-for-tenancy.md` (the `ON DELETE SET NULL` trap on composite keys)
- **Files:** `server/src/db/migrations/051_ap-flow_drive_intake.sql` (new)
- **Contract — literal SQL:**
  ```sql
  CREATE TABLE IF NOT EXISTS ap_flow_drive_connections (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status                    TEXT NOT NULL CHECK (status IN ('PENDING_AUTH','CONNECTED','NEEDS_REAUTH')),
    google_account_email      TEXT NULL CHECK (google_account_email IS NULL OR length(google_account_email) <= 320),
    refresh_token_ciphertext  TEXT NULL,
    oauth_state_sha256        CHAR(64) NULL CHECK (oauth_state_sha256 IS NULL OR oauth_state_sha256 ~ '^[0-9a-f]{64}$'),
    pkce_verifier_ciphertext  TEXT NULL,
    oauth_state_expires_at    TIMESTAMPTZ NULL,
    folder_id                 TEXT NULL CHECK (folder_id IS NULL OR folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
    folder_name               TEXT NULL CHECK (folder_name IS NULL OR length(folder_name) <= 255),
    last_synced_at            TIMESTAMPTZ NULL,
    last_sync_error           TEXT NULL CHECK (last_sync_error IS NULL OR length(last_sync_error) <= 1000),
    connected_by              UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ux_ap_flow_drive_connections_org UNIQUE (org_id),
    CONSTRAINT ux_ap_flow_drive_connections_org_id_id UNIQUE (org_id, id),
    CONSTRAINT chk_ap_flow_drive_connections_connected_token
      CHECK (status <> 'CONNECTED' OR refresh_token_ciphertext IS NOT NULL),
    CONSTRAINT chk_ap_flow_drive_connections_state_complete
      CHECK ((oauth_state_sha256 IS NULL) = (oauth_state_expires_at IS NULL)
         AND (oauth_state_sha256 IS NULL) = (pkce_verifier_ciphertext IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_flow_drive_connections_state
    ON ap_flow_drive_connections (oauth_state_sha256) WHERE oauth_state_sha256 IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_connections_connected_by
    ON ap_flow_drive_connections (connected_by);
  CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_connections_due
    ON ap_flow_drive_connections (status) WHERE status = 'CONNECTED' AND folder_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS ap_flow_drive_files (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connection_id        UUID NOT NULL,
    drive_file_id        TEXT NOT NULL CHECK (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
    name                 TEXT NOT NULL CHECK (length(name) <= 255),
    mime_type            TEXT NOT NULL CHECK (length(mime_type) <= 100),
    md5_checksum         TEXT NULL CHECK (md5_checksum IS NULL OR md5_checksum ~ '^[0-9a-f]{32}$'),
    drive_modified_at    TIMESTAMPTZ NULL,
    status               TEXT NOT NULL CHECK (status IN ('IMPORTED','SKIPPED')),
    skip_reason          TEXT NULL CHECK (skip_reason IS NULL OR length(skip_reason) <= 1000),
    ap_flow_document_id  UUID NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_ap_flow_drive_files_connection
      FOREIGN KEY (org_id, connection_id) REFERENCES ap_flow_drive_connections (org_id, id) ON DELETE CASCADE,
    -- PG15+ column-list form: nulls only ap_flow_document_id, never org_id (the composite SET NULL trap).
    CONSTRAINT fk_ap_flow_drive_files_document
      FOREIGN KEY (org_id, ap_flow_document_id) REFERENCES ap_flow_documents (org_id, id)
      ON DELETE SET NULL (ap_flow_document_id),
    CONSTRAINT ux_ap_flow_drive_files_file UNIQUE (org_id, drive_file_id),
    CONSTRAINT chk_ap_flow_drive_files_outcome CHECK (
      (status = 'IMPORTED' AND skip_reason IS NULL) OR (status = 'SKIPPED' AND skip_reason IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_files_connection ON ap_flow_drive_files (org_id, connection_id);
  CREATE INDEX IF NOT EXISTS idx_ap_flow_drive_files_document ON ap_flow_drive_files (org_id, ap_flow_document_id);

  CREATE OR REPLACE TRIGGER trg_ap_flow_drive_connections_updated
    BEFORE UPDATE ON ap_flow_drive_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  ```
  Header comment must record: **neither table is audited** — `audit_row_change` snapshots `to_jsonb(NEW)`, which would copy `refresh_token_ciphertext` into an append-only table forever; `ap_flow_drive_files` is an ingestion log whose outcome is already audited through `ap_flow_documents`. Imported documents themselves are audited as normal.
  **Note:** `ux_ap_flow_drive_files_file` makes one Drive file importable once per org even after a folder change or reconnect-cascade — `disconnect` deletes the history (cascade), and re-import after reconnect is safe because `captureFile` is idempotent on content hash.
- **Guardrails:** #1 · #8 · #13
- **Proof:** `npm run migrate` twice exits 0; migrations test green
- **Owes:** `docs/schema.md` (F3); study note E7

### Step E3 — `googleDriveClient.ts` + tests

- **Depends on:** E1
- **Skill:** none (HTTP adapter, no DB)
- **Read first:** `server/src/services/ap-flow/modelClient.ts` (A3 — same `fetchImpl` injection style)
- **Files:** `server/src/services/ap-flow/googleDriveClient.ts` (new), `server/src/__tests__/ap-flow/googleDriveClient.test.ts` (new)
- **Contract:**
  ```ts
  export type FetchLike = typeof fetch;
  export interface GoogleOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }
  export type GoogleDriveErrorCode = 'INVALID_GRANT' | 'NO_REFRESH_TOKEN' | 'TOO_LARGE' | 'HTTP_ERROR';
  export class GoogleDriveError extends Error {
    constructor(readonly code: GoogleDriveErrorCode, message: string);
  }
  export const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
  /** Accepts a raw id, `.../folders/<id>...`, or `...?id=<id>`. Returns null when nothing valid is found. */
  export function parseFolderInput(input: string): string | null;
  export function buildAuthorizationUrl(config: GoogleOAuthConfig, state: string, codeChallenge: string): string;
  export async function exchangeCode(config: GoogleOAuthConfig, code: string, codeVerifier: string, fetchImpl?: FetchLike): Promise<{ accessToken: string; refreshToken: string }>;
  export async function refreshAccessToken(config: GoogleOAuthConfig, refreshToken: string, fetchImpl?: FetchLike): Promise<string>;
  export async function getAccountEmail(accessToken: string, fetchImpl?: FetchLike): Promise<string>;
  export async function getFolder(accessToken: string, folderId: string, fetchImpl?: FetchLike): Promise<{ id: string; name: string; mimeType: string } | null>;
  export interface DriveFile { id: string; name: string; mimeType: string; sizeBytes: number | null; md5Checksum: string | null; modifiedTime: string | null }
  export async function listFolderFiles(accessToken: string, folderId: string, fetchImpl?: FetchLike): Promise<DriveFile[]>;
  export async function downloadFile(accessToken: string, fileId: string, maxBytes: number, fetchImpl?: FetchLike): Promise<Buffer>;
  export async function revokeToken(token: string, fetchImpl?: FetchLike): Promise<void>;
  ```
  - `buildAuthorizationUrl` → `GOOGLE_AUTH_URL?` + `URLSearchParams({ client_id, redirect_uri, response_type: 'code', scope: GOOGLE_DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: codeChallenge, code_challenge_method: 'S256' })`.
  - `exchangeCode` → `POST GOOGLE_TOKEN_URL`, `Content-Type: application/x-www-form-urlencoded`, body `code, client_id, client_secret, redirect_uri, grant_type=authorization_code, code_verifier`. Non-2xx → `GoogleDriveError('HTTP_ERROR', \`Google token exchange failed with status ${status}\`)`. No `refresh_token` in JSON → `GoogleDriveError('NO_REFRESH_TOKEN', 'Google did not return a refresh token')`.
  - `refreshAccessToken` → same URL, `grant_type=refresh_token`. Status 400 with JSON `error === 'invalid_grant'` → `GoogleDriveError('INVALID_GRANT', 'Google Drive access was revoked — reconnect')`; other non-2xx → `HTTP_ERROR`.
  - `getAccountEmail` → `GET ${GOOGLE_DRIVE_API_BASE}/about?fields=user(emailAddress)`, `Authorization: Bearer <token>` → `user.emailAddress`.
  - `getFolder` → `folderId` must match `DRIVE_ID_PATTERN` else `null` without fetching; `GET /files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`; 404 → `null`; other non-2xx → `HTTP_ERROR`.
  - `listFolderFiles` → `folderId` fails `DRIVE_ID_PATTERN` → `throw new GoogleDriveError('HTTP_ERROR', 'Invalid Drive folder id')` **before any fetch** (it is interpolated into the `q` string). `q = \`'${folderId}' in parents and trashed = false and (mimeType = 'application/pdf' or mimeType = 'image/png' or mimeType = 'image/jpeg')\``; params `fields=nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)`, `orderBy=createdTime`, `pageSize=100`, `supportsAllDrives=true`, `includeItemsFromAllDrives=true`, `pageToken` while `nextPageToken` present. `size` is a string → `Number()` or `null`.
  - `downloadFile` → `GET /files/${fileId}?alt=media&supportsAllDrives=true`; `Content-Length` header > `maxBytes` → `TOO_LARGE` before reading the body; after `arrayBuffer()`, `byteLength > maxBytes` → `TOO_LARGE`.
  - `revokeToken` → `POST GOOGLE_REVOKE_URL` form `token=<token>`; swallow every error.
  - Every fetch passes `signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS)`. No error message ever includes a token or a response body.
- **Tests (`googleDriveClient.test.ts`, fake `fetchImpl`, global `fetch` spied to throw as in `extraction.test.ts`):**
  - `authorization URL requests offline drive.readonly access with S256 PKCE` → params `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, `scope=https://www.googleapis.com/auth/drive.readonly`, `state` echoed
  - `exchangeCode sends the code_verifier` → captured form body has `code_verifier` and `grant_type=authorization_code`
  - `exchangeCode without a refresh_token throws NO_REFRESH_TOKEN`
  - `refreshAccessToken maps invalid_grant to INVALID_GRANT`
  - `listFolderFiles follows nextPageToken across pages` → 2 pages, 3 files, `sizeBytes` numeric
  - `listFolderFiles rejects a q-injection folder id before fetching` → `"abcdefghij' or '1'='1"` → throws, `fetchImpl` not called
  - `downloadFile refuses a Content-Length above the limit` → `TOO_LARGE`, body never read
  - `parseFolderInput accepts ids and folder URLs` → `'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=sharing'` → `'1AbCdEfGhIjKlMn'`; `'https://drive.google.com/open?id=1AbCdEfGhIjKlMn'` → same; `'1AbCdEfGhIjKlMn'` → same; `'not a folder'` → `null`
- **Guardrails:** #4-analogue: the Drive `q` string is a query language — the id whitelist regex is the parameterization
- **Proof:** `npx vitest run src/__tests__/ap-flow/googleDriveClient.test.ts` green; `grep -c "db/connect" src/services/ap-flow/googleDriveClient.ts` prints `0`

### Step E4 — types, `driveConnectionService`, handlers, queue wiring

- **Depends on:** E2, E3, D1
- **Skill:** `new-module` (service + jobs)
- **Read first:** `server/src/queue/handlers/apFlowExtractHandler.ts`, `server/src/queue/worker.ts` (`HANDLERS`, `upsertJobScheduler`), `server/src/types/jobs.ts`, `server/src/scripts/verifyIntegrity.ts` (how a cross-org read is justified in a comment)
- **Files:** `types/ap-flow.ts`, `types/jobs.ts`, `queue/worker.ts` (edit); `services/ap-flow/driveConnectionService.ts`, `queue/handlers/apFlowDriveSweepHandler.ts`, `queue/handlers/apFlowDriveSyncHandler.ts` (new)
- **Contract:**
  - `types/ap-flow.ts`:
    ```ts
    export const AP_FLOW_DRIVE_CONNECTION_STATUSES = ['PENDING_AUTH', 'CONNECTED', 'NEEDS_REAUTH'] as const;
    export type ApFlowDriveConnectionStatus = (typeof AP_FLOW_DRIVE_CONNECTION_STATUSES)[number];
    export const AP_FLOW_DRIVE_CONNECTION_TRANSITIONS = {
      PENDING_AUTH: ['PENDING_AUTH', 'CONNECTED'],
      CONNECTED: ['PENDING_AUTH', 'NEEDS_REAUTH'],
      NEEDS_REAUTH: ['PENDING_AUTH'],
    } as const satisfies Record<ApFlowDriveConnectionStatus, readonly ApFlowDriveConnectionStatus[]>;
    export function canTransitionApFlowDriveConnection(from: ApFlowDriveConnectionStatus, to: ApFlowDriveConnectionStatus): boolean;
    export interface ApFlowDriveConnection {
      id: string;
      status: ApFlowDriveConnectionStatus;
      googleAccountEmail: string | null;
      folderId: string | null;
      folderName: string | null;
      lastSyncedAt: string | null;
      lastSyncError: string | null;
      importedFileCount: number;
      skippedFileCount: number;
      connectedBy: string;
      createdAt: string;
      updatedAt: string;
    }
    ```
    (The CHECK in migration 051 lists exactly these three statuses.)
  - `types/jobs.ts`: insert `'ap-flow-drive-sweep'`, `'ap-flow-drive-sync'` into `QUEUE_NAMES` directly after `'ap-flow-extract'`; payloads `'ap-flow-drive-sweep': Record<string, never>; 'ap-flow-drive-sync': { orgId: string; connectionId: string };`.
  - `worker.ts`: add both to `HANDLERS`; after the outbox scheduler: `await queues['ap-flow-drive-sweep'].upsertJobScheduler('ap-flow-drive-sweep-tick', { every: AP_FLOW_DRIVE_POLL_INTERVAL_MS }, { name: 'ap-flow-drive-sweep', data: {}, opts: { attempts: 1 } });`
  - `driveConnectionService.ts`:
    ```ts
    export interface DriveServiceDeps {
      fetchImpl?: FetchLike;
      oauth?: GoogleOAuthConfig;       // default from env
      encryptionKeyHex?: string;       // default env.INTEGRATION_ENCRYPTION_KEY
    }
    export function isDriveConfigured(deps?: DriveServiceDeps): boolean;   // clientId, clientSecret, redirectUri, key all non-empty
    export async function getConnection(orgId: string): Promise<ApFlowDriveConnection | null>;
    export async function startConnect(orgId: string, userId: string, deps?: DriveServiceDeps): Promise<{ authorizationUrl: string }>;
    export async function completeConnect(state: string, code: string, deps?: DriveServiceDeps): Promise<{ orgId: string }>;
    export async function setFolder(orgId: string, input: string, deps?: DriveServiceDeps): Promise<ApFlowDriveConnection>;
    export async function requestSync(orgId: string): Promise<void>;
    export async function disconnect(orgId: string, deps?: DriveServiceDeps): Promise<void>;
    export async function listConnectionsDueForSync(): Promise<{ orgId: string; connectionId: string }[]>;
    export async function syncConnection(orgId: string, connectionId: string, deps?: DriveServiceDeps): Promise<{ imported: number; skipped: number }>;
    ```
    - `getConnection`: columns listed explicitly (**never** `refresh_token_ciphertext`, `pkce_verifier_ciphertext`, `oauth_state_sha256`); `importedFileCount`/`skippedFileCount` via `count(*) FILTER (WHERE status = 'IMPORTED')` / `'SKIPPED'` from a `LEFT JOIN LATERAL` on `ap_flow_drive_files` scoped by `org_id` and `connection_id`.
    - `startConnect`: `!isDriveConfigured(deps)` → `ApiError(503, 'Google Drive is not configured on this server')`. `state = randomUrlToken()`, `verifier = randomUrlToken()`. `withTransaction`: `INSERT INTO ap_flow_drive_connections (org_id, status, oauth_state_sha256, pkce_verifier_ciphertext, oauth_state_expires_at, connected_by) VALUES ($1, 'PENDING_AUTH', $2, $3, now() + make_interval(mins => $4), $5) ON CONFLICT (org_id) DO UPDATE SET status = 'PENDING_AUTH', oauth_state_sha256 = EXCLUDED.oauth_state_sha256, pkce_verifier_ciphertext = EXCLUDED.pkce_verifier_ciphertext, oauth_state_expires_at = EXCLUDED.oauth_state_expires_at, connected_by = EXCLUDED.connected_by` with `$2 = sha256Hex(state)`, `$3 = encryptSecret(verifier, key)`, `$4 = AP_FLOW_DRIVE_OAUTH_STATE_TTL_MINUTES`. Return `buildAuthorizationUrl(oauth, state, pkceChallengeS256(verifier))`. (Every status may move to `PENDING_AUTH` per the transition table; assert it with `canTransitionApFlowDriveConnection` on the existing row read `FOR UPDATE` first.)
    - `completeConnect` — **claim first, network second, no transaction held across HTTP:**
      1. `withTransaction`: `UPDATE ap_flow_drive_connections SET oauth_state_sha256 = NULL, pkce_verifier_ciphertext = NULL, oauth_state_expires_at = NULL WHERE oauth_state_sha256 = $1 AND status = 'PENDING_AUTH' AND oauth_state_expires_at > now() RETURNING id, org_id, pkce_verifier_ciphertext` (rule-1 exception #1 comment here). No row → `ApiError(400, 'Invalid or expired authorization state')`.
      2. `verifier = decryptSecret(...)`; `{ accessToken, refreshToken } = await exchangeCode(oauth, code, verifier, fetchImpl)`; `email = await getAccountEmail(accessToken, fetchImpl)`. Any `GoogleDriveError` → `ApiError(502, 'Google rejected the authorization')` (row stays `PENDING_AUTH` with no state; the user clicks Connect again).
      3. `withTransaction`: `UPDATE ap_flow_drive_connections SET status = 'CONNECTED', refresh_token_ciphertext = $3, google_account_email = $4, last_sync_error = NULL WHERE org_id = $1 AND id = $2 AND status = 'PENDING_AUTH'` with `$3 = encryptSecret(refreshToken, key)`, `$4 = email.toLowerCase()` (rule 9). Return `{ orgId }`.
    - `setFolder`: row `FOR UPDATE` by `org_id`; none or `status !== 'CONNECTED'` → `ApiError(409, 'Connect Google Drive before choosing a folder')`. `folderId = parseFolderInput(input)` null → `ApiError(400, 'Enter a Google Drive folder link or ID')`. Access token via `refreshAccessToken` — on `INVALID_GRANT`: set `status = 'NEEDS_REAUTH'`, `last_sync_error = 'Google Drive access was revoked — reconnect'`, then `ApiError(409, 'Google Drive access was revoked — reconnect')`. `getFolder` null → `ApiError(404, 'Drive folder not found or not shared with the connected account')`; `mimeType !== 'application/vnd.google-apps.folder'` → `ApiError(422, 'That Drive item is not a folder')`. `UPDATE ... SET folder_id = $3, folder_name = $4 WHERE org_id = $1 AND id = $2`. Do the network calls **before** opening the write transaction; re-check `status = 'CONNECTED'` in the UPDATE's WHERE.
    - `requestSync`: none or not `CONNECTED` → `ApiError(409, 'Connect Google Drive before syncing')`; `folder_id` null → `ApiError(409, 'Choose a Drive folder before syncing')`. Then `enqueue('ap-flow-drive-sync', { orgId, connectionId: id }, { jobId: \`ap-flow-drive-sync-${id}-manual-${String(Date.now())}\` })`.
    - `disconnect`: `withTransaction` `DELETE FROM ap_flow_drive_connections WHERE org_id = $1 RETURNING refresh_token_ciphertext` → no row → `ApiError(404, 'Google Drive is not connected')`. After the transaction returns, if the ciphertext is non-null and the key is set, `await revokeToken(decryptSecret(...), fetchImpl)` inside a `try/catch` that only logs (post-COMMIT network is acceptable here: not financial, best-effort, the grant is already useless without the deleted ciphertext).
    - `listConnectionsDueForSync`: `SELECT org_id, id FROM ap_flow_drive_connections WHERE status = 'CONNECTED' AND folder_id IS NOT NULL ORDER BY id` (rule-1 exception #2 comment).
    - `syncConnection`:
      1. `SELECT status, folder_id, connected_by, refresh_token_ciphertext FROM ap_flow_drive_connections WHERE org_id = $1 AND id = $2`; missing, not `CONNECTED`, or no folder → `{ imported: 0, skipped: 0 }`.
      2. `accessToken = refreshAccessToken(...)`; `INVALID_GRANT` → `UPDATE ... SET status = 'NEEDS_REAUTH', last_sync_error = 'Google Drive access was revoked — reconnect' WHERE org_id = $1 AND id = $2 AND status = 'CONNECTED'` → return zeros.
      3. `files = listFolderFiles(...)`; `known = SELECT drive_file_id FROM ap_flow_drive_files WHERE org_id = $1 AND drive_file_id = ANY($2::text[])`; `pending = files.filter(not known).slice(0, AP_FLOW_DRIVE_MAX_FILES_PER_SYNC)`.
      4. For each (sequentially): `name = f.name.trim() === '' ? \`drive-${f.id}\` : f.name.slice(0, 255)`.
         - `f.sizeBytes !== null && f.sizeBytes > MAX_UPLOAD_BYTES` → record `SKIPPED`, `'File exceeds the 10 MB limit'`.
         - else `buffer = downloadFile(accessToken, f.id, MAX_UPLOAD_BYTES)`; `{ document } = apFlowDocumentService.captureFile(orgId, connected_by, { buffer, originalname: name })`; record `IMPORTED` with `document.id`.
         - catch `GoogleDriveError` `TOO_LARGE` → `SKIPPED`, `'File exceeds the 10 MB limit'`; catch `ApiError` 415/422 → `SKIPPED`, `err.message`; any other error → remember `err.message` as `lastError` and **write no row** (retried next run).
         Record = `INSERT INTO ap_flow_drive_files (org_id, connection_id, drive_file_id, name, mime_type, md5_checksum, drive_modified_at, status, skip_reason, ap_flow_document_id) VALUES (...) ON CONFLICT (org_id, drive_file_id) DO NOTHING`.
      5. `UPDATE ap_flow_drive_connections SET last_synced_at = now(), last_sync_error = $3 WHERE org_id = $1 AND id = $2` (`$3 = lastError?.slice(0, 1000) ?? null`).
  - `apFlowDriveSweepHandler.ts`: `handleApFlowDriveSweep(_payload: JobPayloads['ap-flow-drive-sweep'])` → for each due connection `enqueue('ap-flow-drive-sync', { orgId, connectionId }, { jobId: \`ap-flow-drive-sync-${connectionId}-${String(Math.floor(Date.now() / AP_FLOW_DRIVE_POLL_INTERVAL_MS))}\` })` — the time-bucket jobId makes a double sweep in one interval a no-op.
  - `apFlowDriveSyncHandler.ts`: `handleApFlowDriveSync(payload, deps?: DriveServiceDeps)` → `await driveConnectionService.syncConnection(payload.orgId, payload.connectionId, deps)`.
- **Guardrails:** #1 (two named exceptions only) · #5 no transaction open across a `fetch` · #9 email lowercased · #10 transitions via `canTransitionApFlowDriveConnection` · **token hygiene: no log line, error message, or API response includes a token, verifier, state, or ciphertext**
- **Proof:** `npm run typecheck`; `grep -nE "console\.(log|warn|error)\(.*(token|verifier|ciphertext)" -i src/services/ap-flow/driveConnectionService.ts` prints nothing; `npx vitest run src/__tests__/platform/queue.test.ts` green
- **If it fails:** `queue.test.ts` enumerating queues differently → read it, add the two names where it expects them; do not remove any assertion

### Step E5 — drive routes

- **Depends on:** E4
- **Skill:** `new-module` (controller + routes + mount)
- **Read first:** `server/src/controllers/ap-flow/apFlowDocumentController.ts`, `server/src/utils/queryParam.ts`
- **Files:** `schemas/ap-flow/driveSchema.ts`, `controllers/ap-flow/apFlowDriveController.ts`, `routes/ap-flow/driveRoutes.ts` (new); `routes/ap-flow/index.ts` (edit: `router.use('/drive', driveRoutes);`)
- **Contract:**
  `export const setDriveFolderSchema = z.object({ folder: z.string().trim().min(1).max(500) });`

  | Method | Path | Auth / roles | Success | Failures |
  |---|---|---|---|---|
  | GET | `/api/v1/ap-flow/drive` | `authenticate`, every member | `200 { success: true, connection: ApFlowDriveConnection \| null, configured: boolean }` | `401` |
  | POST | `/api/v1/ap-flow/drive/connect` | `requireRole('OWNER', 'ADMIN')` | `200 { success: true, authorizationUrl }` | `401`, `403`, `503 Google Drive is not configured on this server` |
  | GET | `/api/v1/ap-flow/drive/oauth/callback` | **no `authenticate`** | `302` → `${env.FRONTEND_URL}/app/ap-flow/settings?drive=connected` | always `302` → `...?drive=error` on `error` query param, missing `code`/`state`, or any thrown error. Never put Google's error text in the URL |
  | PUT | `/api/v1/ap-flow/drive/folder` | `requireRole('OWNER', 'ADMIN')` | `200 { success: true, connection }` | `400`, `401`, `403`, `404`, `409`, `422` (messages from E4) |
  | POST | `/api/v1/ap-flow/drive/sync` | `requireRole('OWNER', 'ADMIN', 'ACCOUNTANT')` | `202 { success: true, queued: true }` | `401`, `403`, `409` |
  | DELETE | `/api/v1/ap-flow/drive` | `requireRole('OWNER', 'ADMIN')` | `204` | `401`, `403`, `404 Google Drive is not connected` |

  `oauthCallback` reads `req.query.code`, `req.query.state`, `req.query.error` as strings only (`typeof === 'string'`), calls `completeConnect(state, code)`, and never calls `requireUser`.
- **Guardrails:** #2 · #1 `orgId` from `requireUser` on every route except the callback
- **Proof:** `npm run typecheck`; `grep -c "authenticate" src/routes/ap-flow/driveRoutes.ts` prints `5`

### Step E6 — Drive tests

- **Depends on:** E5
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ap-flow/pipeline.test.ts` (queue cleanup), `server/src/__tests__/helpers/factories.ts` (`buildTestPdf`)
- **Files:** `server/src/__tests__/ap-flow/driveIntake.test.ts` (new), `server/src/__tests__/ap-flow/apFlowConstraints.test.ts` (edit — add)
- **Contract:** a `deps` object `{ fetchImpl, oauth: { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/cb' }, encryptionKeyHex: 'a'.repeat(64) }`; `fetchImpl` is a small router over URL prefixes returning canned `Response`s (token → `{ access_token: 'at-1', refresh_token: 'rt-1' }`, `/about` → `{ user: { emailAddress: 'Owner@Example.com' } }`, `/files?` → a file list, `/files/<id>?alt=media` → the fixture bytes). Cases:
  - `GET /drive returns no connection and configured false on a fresh organization` (HTTP)
  - `POST /drive/connect returns 503 when Google Drive is not configured` (HTTP; test env has no Google vars)
  - `POST /drive/connect is refused for an ACCOUNTANT` → `403`
  - `startConnect stores only a hash of the state and an encrypted verifier` → `oauth_state_sha256 === sha256Hex(<state param from the returned URL>)`; `pkce_verifier_ciphertext` starts `v1.` and does not contain the URL's `code_challenge`
  - `completeConnect stores an encrypted refresh token and marks the connection CONNECTED` → `status = 'CONNECTED'`, `refresh_token_ciphertext !== 'rt-1'`, `decryptSecret(ciphertext, key) === 'rt-1'`, `google_account_email = 'owner@example.com'`, state columns all null
  - `an authorization state works only once` → second `completeConnect` → `400`
  - `an expired authorization state is rejected` → `UPDATE ... SET oauth_state_expires_at = now() - interval '1 minute'` then complete → `400`
  - `setFolder rejects a file that is not a folder` → `getFolder` returns `mimeType: 'application/pdf'` → `422`
  - `syncConnection imports each new file once across repeated runs` → list returns a PNG (sharp) + a PDF (`buildTestPdf`) → run 1 `{ imported: 2, skipped: 0 }`, run 2 `{ imported: 0, skipped: 0 }`; `ap_flow_documents` count 2; `ap_flow_drive_files` 2 rows `IMPORTED`
  - `a file over the size limit is SKIPPED and never downloaded` → `size: '20000000'` → skipped 1; no `alt=media` URL hit
  - `invalid_grant during sync marks the connection NEEDS_REAUTH` → token endpoint 400 `{ error: 'invalid_grant' }` → `status = 'NEEDS_REAUTH'`
  - `sync never writes outside the connection's organization` → `syncConnection(orgB, orgAConnectionId, deps)` → zeros, org A and org B `ap_flow_documents` counts unchanged (cross-tenant)
  - `GET /drive never returns token material` → `JSON.stringify(res.body)` contains none of `ciphertext`, `rt-1`, `refresh`, `verifier`, `state`
  - `the OAuth callback redirects to settings with drive=error on a bad state` (HTTP, unauthenticated) → `302`, `Location` = `${env.FRONTEND_URL}/app/ap-flow/settings?drive=error`
  - `the sweep enqueues one sync per due connection and dedupes within an interval` → call `handleApFlowDriveSweep({})` twice → `queues['ap-flow-drive-sync'].getJobCounts()` total 1
  - `apFlowConstraints.test.ts`: `a CONNECTED drive connection without a refresh token is rejected` → `23514` · `a drive file cannot reference another organization's AP-Flow document` → `23503` · `deleting an AP-Flow document nulls only ap_flow_document_id on its drive file` → row survives, `org_id` unchanged
- **Proof:** `npx vitest run src/__tests__/ap-flow src/__tests__/secretBox.test.ts src/__tests__/platform/queue.test.ts` green; then full `npm test`

### Step E7 — client settings page, blocker display, bill link

- **Depends on:** E5, C4, D3
- **Skill:** none (client)
- **Read first:** `client/src/Pages/ap-flow/ApFlowRoutes.tsx`, `ApFlowDocumentDetailPage.tsx`, `ApFlowReviewQueuePage.tsx`, `client/src/components/ConfirmDialog.tsx`, `client/src/utils/money.ts` (`parseCentsInput`, `formatCents`)
- **Files:** `client/src/services/fetchServices.ts`, `ApFlowRoutes.tsx`, `ApFlowDocumentsPage.tsx`, `ApFlowDocumentDetailPage.tsx`, `ApFlowReviewQueuePage.tsx` (edit); `client/src/Pages/ap-flow/ApFlowSettingsPage.tsx`, `client/src/__tests__/apFlowSettings.test.tsx` (new)
- **Contract:**
  - fetchServices (all via `apiFetch`, JSON bodies):
    ```ts
    export function getApFlowSettings(): Promise<{ success: boolean; settings: ApFlowSettings }>;                       // GET /ap-flow/settings
    export function updateApFlowSettings(body: { autoPostEnabled: boolean; autoPostMinConfidence: number; autoPostMaxTotalCents: number | null }): Promise<{ success: boolean; settings: ApFlowSettings }>; // PUT
    export function getApFlowDriveConnection(): Promise<{ success: boolean; connection: ApFlowDriveConnection | null; configured: boolean }>; // GET /ap-flow/drive
    export function startApFlowDriveConnect(): Promise<{ success: boolean; authorizationUrl: string }>;              // POST /ap-flow/drive/connect
    export function setApFlowDriveFolder(folder: string): Promise<{ success: boolean; connection: ApFlowDriveConnection }>; // PUT /ap-flow/drive/folder
    export function syncApFlowDrive(): Promise<{ success: boolean; queued: boolean }>;                                // POST /ap-flow/drive/sync
    export async function disconnectApFlowDrive(): Promise<void>;                                                      // DELETE /ap-flow/drive (copy deleteDocument's 204 handling)
    ```
    plus client `ApFlowSettings` / `ApFlowDriveConnection` types mirroring the server.
  - `ApFlowRoutes.tsx`: `<Route path="settings" element={<ApFlowSettingsPage />} />` next to `review`, before `:id`.
  - `ApFlowSettingsPage`:
    - **Auto-posting** card: checkbox `Post automatically when every check passes`; number input `Minimum confidence` (`min 0.5 max 1 step 0.01`); text input `Auto-post limit (base currency, blank for none)` parsed with `parseCentsInput` (invalid → inline error `Enter an amount like 1500.00`); `Save` → `updateApFlowSettings`; success text `Saved`. Explanatory line: `Documents that fail any check stay in the review queue with the reason shown.`
    - **Google Drive** card: when `configured === false` show `Google Drive intake is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and INTEGRATION_ENCRYPTION_KEY in server/.env.` and nothing else. Otherwise: status line (`Not connected` / `Waiting for Google authorization` / `Connected as <email>` / `Access revoked — reconnect`); `Connect Google Drive` (or `Reconnect`) → `startApFlowDriveConnect()` → `window.location.assign(authorizationUrl)`; when CONNECTED: folder text input (placeholder `Paste a Google Drive folder link`) + `Save folder`; `Sync now` (enabled only with a folder); `Last synced <toLocaleString()>`, `<importedFileCount> imported · <skippedFileCount> skipped`, `lastSyncError` in `status status--bad`; `Disconnect` behind `ConfirmDialog` (`Disconnect Google Drive? Files already imported stay in AP-Flow.`).
    - `useSearchParams`: `drive=connected` → banner `Google Drive connected — now choose a folder.`; `drive=error` → `Google Drive could not be connected. Try again.`
    - Buttons for OWNER/ADMIN-only actions: render them for everyone; a `403` shows the server's error message (matches how existing AP-Flow pages treat role errors — confirm in `ApFlowDocumentDetailPage.tsx` and copy that).
  - `ApFlowDocumentsPage` header: add `<Link to={\`${base}/settings\`} className="btn btn--ghost">Settings</Link>` beside `Review queue`.
  - `ApFlowDocumentDetailPage`: when `status === 'EXTRACTED'` and `autoPostBlockers.length > 0`, a panel titled `Why this wasn't posted automatically` listing each `message`. In the POSTED block: `Posted automatically` or `Posted by <name>` and, when `billId !== null`, `<Link to={\`/app/ledger-core/bills/${billId}\`}>View bill in LedgerCore</Link>`. Show `Due date` beside the invoice date.
  - `ApFlowReviewQueuePage`: new column `Auto-post` showing the first blocker's `message` (or `—`).
  - `apFlowSettings.test.tsx`: `shows the not-configured message when configured is false` · `saving auto-post settings sends integer cents for the limit` (type `1500.00` → `updateApFlowSettings` called with `autoPostMaxTotalCents: 150000`) · `Connect navigates to the authorization URL` (mock `window.location.assign`) · `drive=connected shows the choose-a-folder banner`
- **Proof:** client typecheck + `npm test` green
- **Owes:** paid in F2

---

## Slice F — The spine (non-negotiable, in this order)

### Step F1 — full test run + guardrail review

- **Depends on:** every step above
- **Skill:** `guardrail-review` over the full diff (`git diff main`)
- **Proof:** `cd server && npm run typecheck && npm test` green, count ≥ baseline + every new case above; `cd client && npm test` green; `npm run verify:integrity` exits 0 after `npm run db:reset && npm run migrate && npm run seed:demo`; the rule-16 grep from B4 prints nothing; `guardrail-review` reports no unaddressed finding
- **If it fails:** fix, re-run; two failures on the same finding → stop and report

### Step F2 — study notes (skill: `study-note`)

Verify each exists and is indexed in [study/README.md](../study/README.md) (index **and** coverage tracker):
- `study/architecture/llm-structured-extraction.md` — extended (A5)
- `study/postgresql/subledger-reconciliation-and-aging.md`, `study/typescript/branded-types-for-money.md`, `study/postgresql/migrations-and-schema-evolution.md`, `study/postgresql/transactions-isolation-pooling.md` — extended (B6)
- `study/architecture/confidence-gated-automation.md` — new (C6)
- `study/react/context-effects-and-data-fetching.md` — extended (D3)
- **New** `study/security-auth/oauth2-authorization-code-pkce.md`: authorization-code flow end to end; PKCE S256 and the code-interception attack it stops; `state` vs PKCE (CSRF vs interception); `access_type=offline` + `prompt=consent` and when Google omits `refresh_token`; storing a hash of `state` and claiming it single-use with `UPDATE … RETURNING`; why the callback is unauthenticated and still tenant-safe; never holding a DB transaction across an HTTP call; Google "Testing" publishing status expiring refresh tokens after 7 days (**mark as "verify against Google's current OAuth docs"**); rejected: service account (cannot prove folder ownership per tenant), `googleapis` SDK (rule 14). 6 Q&As.
- **New** `study/security-auth/encrypting-secrets-at-rest.md`: AES-256-GCM (nonce uniqueness, auth tag, what GCM nonce reuse breaks), versioned payload prefix for key rotation, key in env not DB, why the connections table is not audited (`to_jsonb` snapshot would persist ciphertext forever), rejected: hashing (refresh tokens must be recoverable), KMS/envelope encryption (right for production, not a local portfolio stack). 5 Q&As.
- `study/architecture/background-jobs-and-queues.md` — extend: sweep → fan-out, time-bucketed `jobId` dedupe, polling vs push webhooks and why polling here, idempotent ingestion keyed by `(org_id, drive_file_id)` plus content hash.

### Step F3 — docs-sync (skill: `docs-sync`)

- `docs/api.md` — AP-Flow section: `POST /documents/upload`, `/settings` (GET, PUT), `/drive` (6 routes) with the status tables above; posting now creates a bill (new 409/422 strings); new response fields `billId`, `autoPosted`, `autoPostBlockers`, `extraction.dueDate`.
- `docs/schema.md` — migrations 048–051, every column/constraint/index/trigger, the no-audit ruling for Drive tables, the rule-16 `bill_id` ruling.
- `docs/roadmap.md` — table row `**19 ✅ done**` "AP-Flow — automated intake: Claude/Gemini provider seam, posting as LedgerCore bills, confidence-gated auto-post, Google Drive folder intake"; rewrite line 30's Phase 19–23 sentence per §2; a `## Phase 19, as delivered` section recording D1–D5, the reversal of Phase 11's raw-journal posting and why (AP aging `reconciles`), test counts, and "Deliberately not built": Drive push notifications, Drive subfolders, per-org AI keys, OAuth app verification for production, auto-post re-evaluation after manual line edits, email/other cloud sources, deleting imported docs when removed from Drive.
- `docs/ap-flow.md` — posting section (bill, vendor find-or-create, tax allocation, due-date default), new "Automation" and "Intake sources" sections, providers, update "Not built" (duplicate-invoice detection now exists via `ux_bills_vendor_reference`).
- `docs/ledger-core.md` — bills can originate from AP-Flow; `createCapturedBillOnClient` / `approveBillOnClient` / `findOrCreateVendorByNameOnClient` as the exported boundary.
- `docs/development.md` — env table rows for all 8 new variables; a "Google Drive setup (optional)" subsection (Cloud project → enable Drive API → OAuth consent screen, add yourself as a test user → Web OAuth client → redirect URI → paste values → `openssl rand -hex 32`); confirm the dependency tables say **no package added in Phase 19**.
- `server/src/config/apps.ts` — AP-Flow `tagline: 'Invoice capture to a posted LedgerCore bill — automatic when confident, reviewed when not.'`; `skills` append `'Confidence-gated auto-posting'`, `'Google Drive intake'`. Run `npx vitest run src/__tests__/platform/apps.test.ts`; if it pins the old strings, update **only** those string literals.
- `CLAUDE.md` — change the State heading to Phase 19; add a Phase 19 one-liner; in rule 14 change "AP-Flow's vision extraction (Phase 10)" to "AP-Flow's vision extraction and classification (Phases 10, 19 — Anthropic SDK or Gemini over `fetch`)"; update test totals. Keep it an index — no detail.

### Step F4 — close the plan

- Delete `plans/phase-19-ap-flow-automated-intake.md`.
- Commit only when the user asks.

---

## 4. Risks & open questions

1. **Gemini API specifics are from knowledge, not verified today.** Model id `gemini-2.5-flash`, `responseSchema` OpenAPI-subset field names (`nullable`, uppercase types), `thinkingConfig.thinkingBudget: 0`, and the `inline_data` part shape all need confirming against Google's current docs before trusting the live path. The gated E2E case in A5 is the check; a 400/404 is a stop-and-report. If Google has since moved to a newer default model, only `AP_FLOW_GEMINI_MODEL`'s default changes.
2. **Gemini data use.** On Google's unpaid tier, prompts may be used to improve Google's products; the paid tier (which Cloud credits fund) says otherwise. AP-Flow only ever sends redacted pages, but the user should confirm which tier their key is on. Record this in `docs/development.md`.
3. **Google OAuth "Testing" mode** likely expires refresh tokens after 7 days for a `drive.readonly` app with an external user type, so connections will drop to `NEEDS_REAUTH` weekly until the app is verified. `drive.readonly` is a restricted scope, and production verification means a security assessment. Acceptable for a portfolio; stated in the study note, unverified here.
4. **The posting-path reversal (D2) changes Phase 11's delivered behaviour.** Existing POSTED rows (sandbox, dev DB) keep their raw journal entries and `bill_id IS NULL`, so a dev DB that already holds them will show `reconciles: false` until reseeded. The sandbox fixture's vendor/invoice could collide with a LedgerCore sandbox bill; B5 stops if it does.
5. **Vendor sprawl.** Find-or-create matches on `normalizeForMatching` only, so an OCR variant ("Cloudspan Infra") creates a second vendor. No fuzzy vendor merge is planned.
6. **Auto-post actor.** Auto-posts record `posted_by` / `approved_by` as the uploader, or for Drive the connecting user. If that user has since left the org, posting still succeeds, because the FK is only to `users`. No membership re-check is planned; flag it in the roadmap entry.
7. **Negative lines and credit notes cannot be auto-posted or posted at all** (`bill_lines.unit_price_cents >= 0`). They stay in the review queue with no way to post them from AP-Flow. Credit notes remain a documented gap.
8. **Unknown:** whether `queue.test.ts` or `apps.test.ts` pin exact lists or strings. E4 and F3 say how to handle each.

---

## 5. Definition of done

- Migrations 048–051 apply twice cleanly; `migrations.test.ts` green.
- Server `npm run typecheck` and `npm test` green, including every named case in A5, B2, B3, B5, C5, D2, E1, E3 and E6. Client `npm test` green, including D3 and E7. `npm run verify:integrity` passes after `seed:demo`.
- With `AP_FLOW_AI_PROVIDER=gemini` and a real key, a dropped invoice PDF goes `PENDING → PROCESSING → EXTRACTED`. With auto-post on and a known vendor, it then goes `→ POSTED`, a LedgerCore bill exists, AP aging `reconciles === true`, and the bill can be paid.
- With Drive configured, connecting, choosing a folder and adding a file imports it within one sweep, exactly once.
- Rule-16 grep clean. `guardrail-review` clean. Every study note in F2 is written and indexed. Docs in F3 are synced. `CLAUDE.md` is updated. This plan file is deleted.

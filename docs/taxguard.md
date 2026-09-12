# TaxGuard AI — App Spec & Build Ladder

**Slug:** `taxguard` · **Domain:** Compliance & AI Workflows · **Phase:** 16
**Status: Phase 16 done.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-16-as-delivered) for what was actually delivered.

TaxGuard AI is tax-law question answering grounded in real statute text, never model recall alone. An OWNER/ADMIN/ACCOUNTANT uploads a tax act PDF; it is parsed into citation-labelled sections and embedded in the background. Any member then asks a question and gets an answer the model was forced to ground in the retrieved sections, with an inline citation per numbered source. It creates no new financial document and posts nothing to the general ledger — this app reads no other app's tables at all.

**Gated on Phase 7** (background jobs — see [roadmap.md](roadmap.md), "Needs 7"). It also needs the platform Document Vault (Phase 9.5, for the uploaded PDF) and the `vector` PostgreSQL extension, which the stock `postgres:16` Docker image does not ship — see [Infrastructure](#infrastructure) below.

---

## Core technical capabilities

### A. Ingestion — parsing a tax act into citation-labelled chunks

A tax act is uploaded through the platform Document Vault (`POST /api/v1/documents`) first, exactly like any other file in this suite; `POST /taxguard/corpus` then takes that upload's `documentId` and creates a `PENDING` row. `documents` and `document_links` are **platform** tables (migration 030's own header says so explicitly) — reading them is not a rule-16 violation, and TaxGuard consumes them through `documentService.getDocumentById`/`openDocumentStream` rather than a direct query.

Once the row commits, `taxguard-embed` is enqueued (Phase 7's `bullmq` infrastructure). `handleTaxGuardEmbed` is the entire pipeline:

1. Extract the PDF's text via `pdfjs-dist`'s `getTextContent()`, page by page, honouring pdfjs's own `hasEOL` flag on each text run — without it, a multi-line page collapses to one line and the heading regex below can never find a second section.
2. Advance the row `PENDING → PARSING`.
3. Hand the joined text to `utils/taxActParse.ts`'s `parseTaxAct`, and replace the corpus document's chunks in one transaction.
4. Advance `PARSING → EMBEDDING`.
5. Embed every chunk (batched) through the injectable `EmbeddingsClient` seam, writing each vector back individually.
6. Advance `EMBEDDING → READY` with the final `chunk_count`.

A failure at any step calls `markFailed` and rethrows, so BullMQ retries and a terminal failure still reaches the dead-letter queue via the worker's existing `failed` listener. **`READY` and `FAILED` are both terminal** in `TAXGUARD_CORPUS_TRANSITIONS` — there is no in-place re-ingest. Re-adding the same `documentId` after a failed attempt is refused with `409` (`ux_taxguard_corpus_document`); the failed row must be deleted first.

### B. The pure parser — `utils/taxActParse.ts`

`parseTaxAct(rawText, { actLabel, maxTokens? })` is a **pure function** — no database import, no clock — unit-tested (10 hand-computed cases) without a running Postgres, the identical posture `fpaProjection.ts`, `forecasterBuild.ts`, `uniteconPvm.ts` and `boarddeckVariance.ts` each established. Its rules, exactly:

1. Line endings are normalised; runs of 3+ blank lines collapse to 2.
2. Text is split on a line-anchored heading regex matching `Section N`, `Sec. N`, or `S. N`, where `N` may carry a parenthesised subsection suffix (`80C(2)(a)`).
3. Text before the first heading is **discarded** as a title page or preamble — unless there is no heading anywhere in the document, in which case the whole thing becomes one chunk labelled with the act's own title rather than a section number.
4. A section's `citation` is `` `${actLabel}, Section ${sectionNumber}` ``; its `heading` is the trimmed text on the same line, or `null`.
5. A section whose estimated token count exceeds `maxTokens` (default 500) splits on paragraph boundaries into `(part N)`-suffixed chunks. A single paragraph that alone exceeds the ceiling is emitted whole, never split further.
6. `ordinal` is a 0-based counter running continuously across the whole document, never reset per section. An empty section body is dropped without consuming an ordinal.

**Documented limitation, not a bug:** the heading regex is tuned for Indian/UK-style statute drafting ("Section 80C(2)(a)"). US IRC-style headings ("§ 61(a)(1)") will not match and the whole document falls through to the single-chunk path in rule 3 — see [Not built](#not-built).

### C. Retrieval — `services/taxguard/retrievalService.ts`

`retrieve(orgId, queryText, jurisdiction, topK?, client?)` embeds the query text (via the same `embedTexts` seam ingestion uses, `inputType: 'query'`), then runs one parameterized query:

```sql
SELECT c.id, c.corpus_document_id, d.title AS corpus_document_title,
       c.citation, c.heading, c.content,
       1 - (c.embedding <=> $2::vector) AS score
  FROM taxguard_chunks c
  JOIN taxguard_corpus_documents d
    ON d.id = c.corpus_document_id AND d.org_id = c.org_id
 WHERE c.org_id = $1
   AND d.org_id = $1
   AND d.status = 'READY'
   AND d.jurisdiction = $3
   AND c.embedding IS NOT NULL
 ORDER BY c.embedding <=> $2::vector
 LIMIT $4
```

`org_id` appears on both sides of the join and in the join condition itself — deliberate redundancy, not sloppiness (guardrails rule 1). Results below `TAXGUARD_RETRIEVAL_MIN_SCORE` (0.25, a fixed cosine-similarity floor) are dropped as noise. `topK` defaults to `TAXGUARD_RETRIEVAL_TOP_K` (8), clamped to `1`–`25`.

An HNSW index (`vector_cosine_ops`) backs the `<=>` operator. It is **unfiltered by `org_id`** — pgvector has no native per-tenant partial ANN index — so the `WHERE org_id = $1` predicate above is a post-filter over the ANN candidate set, applied by Postgres after the index scan. Acceptable at this project's portfolio scale; noted rather than hidden.

### D. Answering — `services/taxguard/answerService.ts`

`answer(redactedQuestion, chunks, client?)` forces the model into a `record_answer` tool call — never free-form JSON, the identical `EXTRACTION_TOOL`/`ANSWER_TOOL` pattern AP-Flow's vision extraction established. The numbered retrieved chunks are the model's **only** permitted sources; the system prompt instructs it to cite every claim as `[n]` and never invent a section number outside the provided list.

`chunks.length === 0` short-circuits to `ApiError(422, 'No relevant source material found')` **before the model is ever called** — proven by a test asserting a stub answer client's call count stays at zero when no corpus matches. Citations are built by mapping each 1-based `cited_sources` index the model returned back to its source chunk; an out-of-range index is dropped silently rather than thrown.

### E. The ask pipeline and PII redaction — `services/taxguard/questionService.ts`

`ask(orgId, userId, input, deps?)`'s ordering is this phase's headline compliance claim:

1. `redactText(input.questionText)` runs **first** — a new export on the existing `utils/pii.ts`, beside `detectPii`. It walks `detectPii`'s already-sorted, already-merged spans and replaces each with a kind-labelled placeholder (`[REDACTED:CARD_NUMBER]`), the text counterpart of `redactPage`'s pixel compositing from Phase 10 (AP-Flow), added to the same shared file rather than forked into a second detector — `services/redactionService.ts` is image-only (`rasterize`/`redactPage`/`tesseractOcr`) and has no text path.
2. Retrieval and answering both run on the **redacted** text alone. Nothing derived from the raw `questionText` is permitted to reach either provider after step 1.
3. The row is inserted with the raw `questionText` (for the asker's own history, never transmitted) and the `redactedQuestion` (what actually reached the providers) both stored, so the two are separately inspectable.

`__tests__/taxguard/questions.test.ts` proves this ordering, not just states it: it seeds a question containing a Luhn-valid card number, captures the literal strings/bodies handed to a stubbed `EmbeddingsClient` and a stubbed `AnswerClient`, and asserts the number appears in neither — while the stored `question_text` still contains it and `redacted_question` does not.

**The honest limitation:** `utils/pii.ts`'s own header already records that its name detection is a label-anchored heuristic, not named-entity recognition — it reliably catches checksum-validated structured identifiers (card via Luhn, Aadhaar via Verhoeff, PAN, GSTIN, SSN) but will miss an unlabelled free-text name. **The claim this phase can honestly make is "the question is redacted before it leaves the process," never "no PII can reach the provider."**

Retrieval and answering are **synchronous** inside `POST /taxguard/questions` — unlike ingestion, there is no queue here. A vector search plus one model call is fast enough to run inline, and queuing it would add latency for no correctness benefit.

---

## Infrastructure

**`docker-compose.yml`'s `postgres` service runs `pgvector/pgvector:pg16`, not stock `postgres:16`.** The former is the latter plus the `vector` extension, built `FROM postgres:16`, so the existing `postgres-data` volume is binary-compatible — no data is lost by the swap. Migration `044_taxguard_pgvector.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`, its own file ahead of the tables, so a missing extension fails with a named error rather than a confusing "type vector does not exist" on a `CREATE TABLE`.

**The embeddings provider is Voyage AI (`voyage-3.5`, 1024 dimensions), called over the platform's own built-in `fetch`, not an installed SDK.** Anthropic ships no embeddings endpoint, and Voyage is its own documented recommendation. Calling it over `fetch` means **no new npm dependency** for embeddings at all — `embeddingService.ts` exports an injectable `EmbeddingsClient` seam exactly as `extractionService.ts`'s `VisionClient` does, so no test ever reaches the network, and swapping providers later touches only this one file. `VOYAGE_API_KEY` is optional, matching `ANTHROPIC_API_KEY`'s own posture: the server and worker both boot without it, and ingestion/answering return `503` only when actually attempted with no key configured.

**The answer model is `claude-sonnet-5` via `@anthropic-ai/sdk`**, already installed since Phase 10 (AP-Flow's vision extraction) — no new dependency here either.

The embedding dimension (1024) is fixed in the column type `vector(1024)` on `taxguard_chunks.embedding`. Changing it later is a new migration plus a full re-embed of every chunk, not a value to tune casually.

---

## The rule-16 boundary, in practice

`services/taxguard/` and `controllers/taxguard/` contain **zero SQL against any other app's tables** — proven structurally:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|payments|fiscal_periods|fpa_|forecaster_|unitecon_|ap_flow_|boarddeck_)" server/src/services/taxguard/ server/src/controllers/taxguard/
```

returns nothing. The **only** route into the platform anywhere in this app is `documentService.getDocumentById`/`openDocumentStream` — `documents`/`document_links` are platform tables, not another app's, so this is not a rule-16 violation, the identical reading AP-Flow relies on for its own `documents` FK.

`embeddingService.ts` and `answerService.ts` both touch **no database at all** — verified by grep, matching `extractionService.ts`'s own posture from Phase 10. `utils/taxActParse.ts` is pure — no `pool`, no `client.query`, no `db/connect` import.

---

## Build ladder

### Phase 16 — tax act parsing, RAG over pgvector, cited answers with question redaction

- [x] `config/apps.ts` — flip `taxguard` from `'planned'` to `'building'`
- [x] `docker-compose.yml` — swap `postgres:16` for `pgvector/pgvector:pg16`
- [x] `044_taxguard_pgvector.sql` — `CREATE EXTENSION IF NOT EXISTS vector`, its own migration ahead of the tables
- [x] `045_taxguard_corpus.sql` — `taxguard_corpus_documents`, `taxguard_chunks` (with `vector(1024)` and an HNSW index), no immutability trigger (rule 6 does not apply), no audit trigger on chunks (ingest volume)
- [x] `types/taxguard.ts` — `TAXGUARD_CORPUS_TRANSITIONS`/`canTransitionCorpus`, the one FSM this phase owns
- [x] `utils/taxActParse.ts` — the pure section-splitting parser, unit-tested (10 cases) without a database
- [x] `services/taxguard/embeddingService.ts` — the injectable `EmbeddingsClient` seam over Voyage AI via `fetch`, no new dependency
- [x] `services/taxguard/corpusService.ts` — zero SQL leak, org-scoped throughout, the enqueue strictly after `COMMIT`
- [x] `/api/v1/taxguard/corpus` — 5 routes
- [x] `queue/handlers/taxguardEmbedHandler.ts` — the `taxguard-embed` queue, PDF text extraction honouring pdfjs's own `hasEOL`, the full PENDING→READY|FAILED pipeline
- [x] `046_taxguard_questions.sql` — `taxguard_questions`, no FK on `retrieved_chunk_ids` (rule 8/16, the `document_links.entity_id` precedent), no status FSM (write-once)
- [x] `services/taxguard/retrievalService.ts` — the doubled `org_id` predicate, the cosine-similarity floor
- [x] `services/taxguard/answerService.ts` — the forced `record_answer` tool call, the zero-chunks-before-422 guard
- [x] `utils/pii.ts`'s `redactText` — the new export beside `detectPii`, proven by two new `pii.test.ts` cases
- [x] `services/taxguard/questionService.ts` — the ask pipeline, redaction strictly before retrieval and answering
- [x] `/api/v1/taxguard/questions` — 4 routes
- [x] Client: `TaxGuardCorpusPage` (status-polling, role-hidden Add/Delete), `TaxGuardCorpusDetailPage` (chunks in ordinal order), `TaxGuardAskPage` (the 422 empty state, the 503 not-configured state, citations as a numbered source list)
- [x] Cross-tenant isolation tests across all three modules — corpus, chunks, questions — every case asserting `404`, never `403`, plus a dedicated case proving retrieval never returns another org's chunks even when both organizations hold a `READY` corpus in the same jurisdiction
- [x] `taxguardConstraints.test.ts` — the database as the guardrail: raw SQL proves every CHECK, FK, unique index and cascade holds regardless of what wrote the row, including a wrong-dimension vector rejected by the column type itself

**Acceptance ✅ — verified.** 1370 server tests (1369 passed, 1 skipped — the same pre-existing gated E2E case BoardDeck's own total carried; 47 new), plus 234 client tests (8 new), all green. `npm run migrate` applies all three new migrations idempotently, twice, with no error and no second-run effect. `npm run verify:integrity` passes, unaffected by construction since TaxGuard posts nothing to the GL. The rule-16 `grep` above returns nothing. No test in the suite makes a network call or requires `VOYAGE_API_KEY`/`ANTHROPIC_API_KEY`.

**Not written for this phase: study notes.** Skipped at the user's direction — recorded as debt in [roadmap.md](roadmap.md#phase-16-as-delivered): pgvector and HNSW indexing, embedding dimensionality and the cosine operator, the RAG chunk/retrieve/cite pipeline, and the `fetch`-based injectable provider seam. The same wording Phases 12–15 used for their own skipped notes.

---

## Not built

**In-place re-ingest of a corpus document** — a re-ingest is a new row; the prior `FAILED` one must be deleted first (Section A). **US IRC-style section headings** ("§ 61(a)(1)") — the heading regex is tuned for Indian/UK-style drafting; an unmatched document falls through to the single-chunk path (Section B). **Cross-jurisdiction retrieval** in a single question — one `jurisdiction` per ask, never a blend. **Hybrid keyword+vector search** — cosine similarity alone, no `pg_trgm` fallback. **A reranking pass** over retrieved chunks — the top-K by raw cosine score, nothing more. **Streaming answers** — the full answer is returned in one response. **Answer feedback or rating** — a question's history is read-only once created. **Corpus sharing between organizations** — every corpus document and chunk is strictly `org_id`-scoped, with no cross-tenant visibility of any kind. **Chunk-level access control below `org_id`** — any member of an org sees every chunk in that org's corpus. **A measured retrieval-precision figure**, and therefore no "the answer is always grounded" claim — the honest claim is "retrieval-grounded answering implemented with citations," the same posture Phase 10 took on PII recall. **No "no PII reaches the provider" claim** — see Section E's honest limitation. No onboarding wizard — TaxGuard has none, matching FP&A Engine, AP-Flow, ForecasterPro, UnitEcon and BoardDeck Automator. No webhook event or outbox entry on any TaxGuard action.

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.

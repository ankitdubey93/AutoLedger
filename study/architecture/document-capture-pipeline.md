# Document capture pipeline: rasterize → OCR → redact → extract

> A fixed processing order that is itself a security property, not just a data flow — and why every real I/O boundary in it is an injectable seam.

**Category:** Architecture
**Introduced by:** Phase 10 — AP-Flow's document capture: turning a photo of a receipt into a structured, PII-safe draft
**Verified against:** BullMQ 6.x, Node 24

---

## Mechanism

The pipeline (`server/src/queue/handlers/apFlowExtractHandler.ts`) runs entirely inside a background job, never inside an HTTP request — OCR and a vision API call are both far too slow for a request/response cycle (this is exactly why Phase 7's job queue is a prerequisite for Phase 10). The steps, strictly ordered:

1. **`loadForProcessing`** — re-reads the document row from Postgres by `(orgId, apFlowDocumentId)`. The job payload itself carries only these two identifiers, never a data snapshot — this is deliberate (see below).
2. **`markProcessing`** — an atomic `SELECT ... FOR UPDATE` + conditional `UPDATE`, returning `false` if the document isn't in `PENDING`. This is the idempotency guard: BullMQ's at-least-once delivery guarantees a duplicate job **will** arrive eventually (a network blip during ack, a worker restart mid-job), and the second delivery must be a silent no-op, not a re-run or an error.
3. **`storageService.get` + rasterize** — the original bytes, converted to one PNG per page.
4. **OCR, per page** — local, via the injectable `OcrAdapter`.
5. **`redactPage`, per page** — PII masked, using that page's OCR words.
6. **`storageService.put`** — the *redacted* PNG is what gets persisted, at a new content-addressed hash. The original raster is never written to storage at all — it exists only in memory for the duration of the job.
7. **`extractFromPages`** — called only now, and only with the redacted buffers from step 6. This is the one line in the entire phase carrying a comment warning against changing it: passing the step-3 buffers here instead would silently defeat the whole feature while every test still passing green, because nothing about the code's *shape* would look wrong.
8. **`savePipelineResult`** — one transaction, persisting the new pages and the new extraction, and flipping status to `EXTRACTED`.

A `try/catch` wraps steps 3–8: on any failure, `markFailed` records the reason and the error is re-thrown, so BullMQ's retry/backoff takes over and a terminal failure still reaches the dead-letter queue through the worker's existing `'failed'` listener (Phase 7 machinery, untouched).

### Why the payload carries identifiers, not data

`{ orgId, apFlowDocumentId }` — nothing else. If the payload carried a snapshot of the document's state instead, a job sitting in a Redis queue for even a few seconds could act on data that's since changed (the document deleted, re-registered, or already reprocessed by a duplicate delivery). Re-reading from Postgres at the top of the handler means the handler can never act on stale information, and it means a payload in Redis — outside the transactional boundary Postgres provides — is never itself a copy of tenant data.

### Why every I/O boundary is injectable

```ts
handleApFlowExtract(payload, deps?: { ocr?: OcrAdapter; vision?: VisionClient })
```

Both `ocr` and `vision` default to the real implementations but can be swapped by a caller — which in this codebase means "a test." This is what makes the pipeline's own test suite hermetic: `redaction.test.ts` never invokes real tesseract (no 15MB language-pack download, no 30-second real OCR run in CI), and `extraction.test.ts`/`pipeline.test.ts` never make a real network call to Anthropic (no `ANTHROPIC_API_KEY` needed to run the suite at all). The seam is a plain function-typed parameter (`OcrAdapter = (png: Buffer) => Promise<OcrPageResult>`) and a narrow interface (`VisionClient`), not a mocking library or a DI container — dependency injection here is just "take the dependency as an argument."

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| A hosted OCR API instead of local tesseract | Simpler infra; but the image would have to leave the machine *before* redaction, which defeats the entire PII claim | Rejected — OCR must be local, by construction |
| Redact after the vision-model response instead of before the call | The unmasked image would already be sent; "redact the answer" is a fundamentally different, weaker claim than "redact the input" | Rejected |
| Mask PII on the client, before upload | Moves the trust boundary to the browser, which is easier to bypass and harder to audit than a server-side pipeline with a stored `redacted_regions` trail | Rejected |
| Process inline in the HTTP request | OCR + a vision call together routinely take seconds; blocking a request thread that long is a denial-of-service risk on its own, and there's no retry/backoff on a failed request | Rejected — this is exactly what the Phase 7 job queue exists for |

## Where it lives in this codebase

- `server/src/queue/handlers/apFlowExtractHandler.ts` — the orchestration and ordering
- `server/src/services/redactionService.ts` — steps 3–5 (`rasterize`, `tesseractOcr`, `redactPage`)
- `server/src/services/ap-flow/extractionService.ts` — step 7 (`extractFromPages`)
- `server/src/services/ap-flow/apFlowDocumentService.ts` — `loadForProcessing`, `markProcessing`, `savePipelineResult`, `markFailed`
- `server/src/__tests__/ap-flow/pipeline.test.ts` — case 5 is the acceptance criterion: it captures the exact bytes the stub vision client received and asserts they equal the bytes stored at `redacted_sha256`, never the rasterized original

## Gotchas

- **Passing the wrong buffer to `extractFromPages` is a silent failure mode.** `png: Buffer` and `redactedPng: Buffer` have the identical TypeScript type — nothing in the type system stops the bug the whole feature exists to prevent. The only real guardrail is the test that diffs the captured bytes against the stored redacted hash.
- **At-least-once delivery is not optional to handle.** `markProcessing` returning `false` on a non-`PENDING` document is not defensive programming — it is *required* correctness, because BullMQ's delivery guarantee is genuinely at-least-once, not exactly-once, and a duplicate job WILL eventually arrive under normal operation (not just under failure).
- **The `AsyncLocalStorage` audit actor does not cross the process boundary.** The worker is a separate OS process from the API server; the request-scoped actor/IP context that `applyAuditContext` publishes never reaches it, so every `audit_logs` row this pipeline writes carries a null actor. This is the same accepted limitation the outbox drain already has (Phase 7) — not new to this phase, but worth remembering when a reviewer asks "who did this?" about a row this handler wrote.
- **A crash between `COMMIT` and the queue enqueue is a real, accepted gap.** `createApFlowDocument` enqueues only *after* its transaction commits (not inside it) — enqueuing inside the transaction would risk firing a job for a row a subsequent rollback then erases. But because the enqueue is a separate Redis call outside that transaction, a process crash in the narrow window between commit and enqueue leaves a document visibly stuck at `PENDING` forever unless a human notices. This is accepted because nothing financial is at stake (Phase 10 posts nothing) and `POST /:id/reextract` is the user-visible repair — it is explicitly *not* treated as the kind of gap the transactional outbox (Phase 7) exists to close, because that mechanism is reserved for financial events where losing one silently is unacceptable.

## Interview Q&A

**Q: Why does OCR and vision extraction happen in a background job instead of the HTTP request that uploads the document?**
A: Both steps are slow — OCR can take several seconds per page, and a vision model call adds more latency on top, plus network variance. Blocking a request thread for that long is bad for throughput and a denial-of-service risk on its own. Running it as a background job also gets retry/backoff and a dead-letter queue for free from the existing job infrastructure, instead of the client having to implement its own retry logic against a slow synchronous endpoint.

**Q: Why does the job payload only carry IDs, not the data the job needs to process?**
A: Because a payload sitting in a Redis queue is outside the database's transactional guarantees — if it carried a data snapshot, that snapshot could go stale while the job waits to run (the row could be deleted, updated, or reprocessed by a duplicate delivery in the meantime). Re-reading from Postgres at the start of the handler means the handler always acts on current state, and a job payload never becomes an unscoped copy of tenant data living outside the database.

**Q: What does 'at-least-once delivery' actually mean here, and how do you handle a duplicate?**
A: It means the job queue guarantees a job runs at least once, but can run more than once under normal failure conditions (a worker crashing after processing but before acknowledging, for example). The handler protects against this with `markProcessing`, which does an atomic `SELECT ... FOR UPDATE` and only proceeds if the document is still `PENDING`; if a duplicate job finds the document already `PROCESSING` or `EXTRACTED`, it returns `false` and the handler exits as a no-op instead of reprocessing or erroring.

**Q: Why inject the OCR adapter and vision client instead of importing tesseract and the Anthropic SDK directly?**
A: Testability without a network dependency. If the handler imported those libraries directly, every test that exercises the pipeline would either need a real tesseract language pack downloaded (slow, and non-deterministic across environments) or a real API key and network call (slow, costs money, and can't run in CI without secrets). Taking them as optional parameters with sensible defaults means tests inject deterministic fakes and the pipeline's ordering and persistence logic gets fully exercised with zero network I/O.

**Q: What happens if the process crashes partway through the pipeline?**
A: Depends on where. Before `markProcessing` succeeds, nothing has changed and the job simply retries from the top. After `markProcessing` but before `savePipelineResult`'s transaction commits, the document is stuck showing `PROCESSING` — the job's `try/catch` didn't get to run `markFailed` because the *process itself* died, not just the async function. That's a real gap this design accepts; it would need either a job-level timeout that reclaims stuck jobs, or a manual `POST /:id/reextract` to force it back to `PENDING`. The database-level state itself is always consistent, because `savePipelineResult` is one transaction — you either get the full result or none of it, never a partial write.

**Q: Tell me about a design decision in this pipeline where you accepted an imperfect solution deliberately.**
A: The enqueue call in `createApFlowDocument` happens after the database transaction commits, not inside it, which means there's a small window where a process crash between commit and enqueue leaves a document permanently `PENDING` with no job ever fired for it. I considered writing an outbox-pattern event instead (the mechanism Phase 7 already has for exactly this class of problem), but decided against it here because nothing financial is at stake — the document is visibly stuck in a status a human or the `reextract` endpoint can recover from, unlike a missed webhook or a lost payment notification, where losing an event silently would be a real problem. It's a case where reaching for the "correct" heavyweight mechanism everywhere would be over-engineering for the actual failure cost.

## Follow-ups they'll dig into

- "How would you monitor for a document stuck in PENDING or PROCESSING?" — nothing here alerts on it; you'd need a periodic sweep (similar to the outbox drain's stale-delivery check) or a dashboard query.
- "What if rasterize succeeds but produces zero pages?" — not explicitly handled; `savePipelineResult` would persist zero page rows and `page_count: 0`, which the FSM still lets through to `EXTRACTED` — worth asking whether that should be a distinct failure case.
- "How do you keep the worker process itself from becoming a bottleneck under load?" — concurrency is set per-queue (`concurrency: 5` in `worker.ts`), not per-CPU; a real production tuning pass would need to measure actual OCR/vision latency under load.

## See also

- [pii-detection-and-redaction.md](../security-auth/pii-detection-and-redaction.md)
- [llm-structured-extraction.md](llm-structured-extraction.md)
- [background-jobs-and-queues.md](background-jobs-and-queues.md)

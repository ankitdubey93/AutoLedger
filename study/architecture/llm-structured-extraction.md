# Structured extraction from an LLM via forced tool use

> Getting a reliable, typed JSON object out of a model — not by asking nicely, but by making a malformed answer literally impossible to submit.

**Category:** Architecture
**Introduced by:** Phase 10 — AP-Flow's vision extraction: turning a redacted receipt image into structured fields (vendor, amounts, line items) the rest of the pipeline can trust. Extended by Phase 19 — a second provider (Gemini) behind the same interface
**Verified against:** `@anthropic-ai/sdk` 0.124.0. The Gemini REST shape (`responseMimeType`/`responseSchema`, the `inline_data` image-part shape) was confirmed live on 2026-09-14 against `generativelanguage` `v1beta` — the full production `GEMINI_EXTRACTION_SCHEMA` sent against a real redacted invoice page returned `HTTP 200` with a correct structured extraction. Model id is now pinned to `gemini-3.6-flash` (`gemini-2.5-flash`, the original default, was retired by Google — see "A pinned model id is a dependency with an expiry date" below). **Not verified:** the `gemini-2.5-*` branch of `geminiThinkingConfig` (`{ thinkingBudget: 0 }`) — the key used for this verification pass has no access to any `gemini-2.5-*` model (it doesn't appear in that key's `ListModels` response at all), so that branch is unit-tested for shape only, never proven against the real API. The gated live test in `modelClient.test.ts` (`AP_FLOW_GEMINI_E2E=1`) is the check, and it only ever exercises the current default model.

---

## Mechanism

### The three ways to ask a model for structured data, and why only one is reliable

1. **Free-form prompt, parse the response as JSON.** Ask the model to "respond with JSON," then `JSON.parse` whatever text comes back. Fragile: models routinely wrap JSON in explanatory prose ("Here's the extracted data: ```json ...```"), and `JSON.parse` throws on anything but exact valid JSON with nothing else around it.
2. **Regex or string-splitting over the response.** Strictly worse than (1) — even more brittle, and it gives up JSON's actual structural guarantees (nesting, typed arrays) for pattern matching over free text.
3. **Forced tool use.** Define a "tool" — really just a named JSON schema — and set `tool_choice: { type: 'tool', name: '<tool-name> }`, which instructs the API to require the model to call exactly that tool rather than respond in free text at all. The API itself validates the tool call's `input` against the declared JSON schema *before* returning the response; a `tool_use` content block is guaranteed to be present and schema-shaped, or the request fails at the API level instead of downstream in application code.

`extractionService.ts` uses approach 3: `EXTRACTION_TOOL` declares a `record_invoice` tool with an `input_schema` describing every field the pipeline needs (vendor name, invoice number, date, currency, subtotal/tax/total, line items, a confidence map), and the request sets `tool_choice: { type: 'tool', name: 'record_invoice' }`. This eliminates the "model wrapped its answer in prose" failure mode structurally — there is no code path where the answer *isn't* schema-shaped JSON, because the API contract itself enforces it.

### Two boundaries, two parses

Forcing the schema at the API level is not the same as trusting the content of that schema. `findToutUseBlock`'s output — the `input` field on the `tool_use` block — is typed `unknown` by the SDK, and this codebase re-parses it through `extractionToolInputSchema` (a zod schema) before touching it further. This is **parse, don't validate**, applied a second time at a second boundary: the SDK's own JSON-schema enforcement guarantees *shape* (this field is a string, that one's an array of objects with these keys), but it says nothing about whether the *values* make sense — a "date" field being schema-valid as a string doesn't mean it's actually `YYYY-MM-DD`, and a model can hallucinate a plausible-looking-but-wrong vendor name that's perfectly valid JSON. The zod re-parse is the same discipline this codebase already applies to every request body (`utils/parseBody.ts`) — the model's output is untrusted input, full stop, regardless of how structurally constrained the channel it arrived through is.

### Money crosses the boundary as strings, on purpose

The tool schema declares every amount field (`subtotal`, `tax`, `total`, each line item's `amount`) as a **decimal string** — `"450.00"`, not a JSON number `450.00`. This is the same rule this codebase applies everywhere money touches an untrusted boundary (`utils/money.ts`'s `parseMoneyText`, used for untrusted bank CSV text too): `JSON.parse` decodes a JSON number into an IEEE-754 double, and once a monetary amount has passed through a float even once, it can carry a representation error no amount of later care removes (`450.00 × 100` is not guaranteed to be exactly `45000` in floating point, and *which* values break depends on binary representability, not on the number "looking round"). Requiring the model to emit the amount as *text* and parsing it server-side with `parseMoneyText` — which does exact-string-to-`BigInt` arithmetic with no intermediate float — closes that gap at the one place it could otherwise sneak in silently.

### Confidence as a routing signal, not a truth value

`field_confidence` is a `Record<string, number>` the model itself produces, self-reporting how sure it is about each field. It's clamped to `[0, 1]` and non-numeric entries are dropped, but it is never treated as ground truth about correctness — it exists purely to route a human reviewer's attention (Phase 11's review queue colours low-confidence fields) toward the fields most likely to be wrong. A model can be confidently wrong; the value of self-reported confidence is statistical (low-confidence fields are wrong more often, in aggregate) not individually authoritative.

### Two providers, one seam (Phase 19)

`modelClient.ts` introduces `StructuredModelClient` — one interface (`generateStructured({ images, prompt, schema, maxTokens, timeoutMs })`) that both `extractionService.ts` and `mappingService.ts` call, with a concrete adapter per provider:

- **Anthropic** keeps the forced-tool-call shape described above: `tool_choice: { type: 'tool', name }`, and the schema is passed as JSON Schema (`input_schema`).
- **Gemini** has no tool-forcing primitive in the same sense; its equivalent is `generationConfig.responseMimeType: 'application/json'` plus `responseSchema` — a JSON-Schema-like but distinct **OpenAPI-subset** dialect (uppercase type names — `STRING`/`OBJECT`/`ARRAY` — and, critically, **no `additionalProperties`**). This is *constrained decoding*: the model's token sampling is restricted at generation time to only produce tokens consistent with the schema, which is a different mechanism from Anthropic's "validate the tool call after the fact," but gives the same practical guarantee — the response is guaranteed schema-shaped JSON, not merely prose that's hopefully parseable.

Both adapters are constructed from the same `StructuredSchema` value (`{ name, description, jsonSchema, geminiSchema }`) — one schema is authored twice, once per dialect, because the two providers' schema languages are incompatible (Anthropic's `additionalProperties: { type: 'number' }` open map for `field_confidence` has no Gemini equivalent, which is why the Gemini schema pins `field_confidence` to a fixed set of named properties instead of an open map).

Money stays a decimal string on both paths — the boundary rule above doesn't change because the provider changed; only the transport dialect for the schema differs, not the discipline for what crosses it.

### Disabling extended thinking — and why the shape of that config isn't fixed

Structured extraction from an image is a perception-and-formatting task, not a multi-step reasoning task, so paying thinking-token latency/cost on it buys nothing — the request explicitly disables Gemini's extended-thinking mode. What's non-obvious is that *how* you disable it depends on the model generation, and this codebase learned that the hard way (2026-09-14, see the subsection below for the incident):

- **Gemini 2.5** took `thinkingConfig: { thinkingBudget: 0 }` — an integer token *allowance*; `0` means "spend no tokens thinking."
- **Gemini 3.x** replaced that with `thinkingConfig: { thinkingLevel: 'low' }` — a coarse *enum* instead of a numeric budget. Critically, this isn't just a deprecation: at least one 3.x model (`gemini-3.6-flash`, confirmed live) **hard-rejects** the old `thinkingBudget` field with `400 INVALID_ARGUMENT` rather than silently ignoring it. A model-id swap alone, without also updating this field, trades one failure for another.

`modelClient.ts` exports `geminiThinkingConfig(model: string)` to handle both shapes from one call site: it branches on `model.startsWith('gemini-2.5')` — that family still gets `{ thinkingBudget: 0 }` for backward compatibility, everything else gets `{ thinkingLevel: 'low' }`. This is a discriminated union (`{ thinkingBudget: number } | { thinkingLevel: 'low' }`) resolved by a runtime check on the model string, not a compile-time choice — the model id itself is config, read from `CAPTURE_GEMINI_MODEL`, so the branch can't be resolved any earlier than request-construction time.

The cost of getting this wrong isn't just a 400 — it's silent waste when the wrong config is merely *tolerated* rather than rejected. A test call to `gemini-3.6-flash` with **no** `thinkingConfig` at all (thinking left at its default) used 289 total tokens — 274 of them pure "thoughts" tokens — to answer a two-word extraction. The same call with `thinkingLevel: 'low'` used 15 total tokens. Roughly 19x overhead, purely from extended thinking running on a task that structurally cannot benefit from it: the answer is fully determined by what's visible in the image, not by anything multi-step reasoning could add.

### A pinned model id is a dependency with an expiry date

This codebase pins exact model ids rather than tracking a floating alias (`AP_FLOW_VISION_MODEL = 'claude-sonnet-5'`, and now `CAPTURE_GEMINI_MODEL`'s default) — see the trade-off table below. Pinning has a real, scheduled cost, and this project paid it: `gemini-2.5-flash`, the shipped default, was retired by Google and started returning `404` ("no longer available to new users") for this project's API key. The trap is specific and worth naming precisely: **`ListModels` returning a model is not evidence that `generateContent` will serve it.** The retired id still appeared in the key's model listing the same day `generateContent` refused it — the two endpoints drifted independently, and only the one actually used at runtime (`generateContent`) revealed the problem.

This surfaced through a real user upload sitting `PENDING` in production, not through the test suite — worth being honest about why. `modelClient.test.ts`'s only case that reaches the real network is the gated live test (`AP_FLOW_GEMINI_E2E=1`); every other case in the file stubs `fetch` or the `MessagesClient` and asserts *shape*, never *liveness*. That's a deliberate, reasonable trade — a real network call in a suite that runs on every commit is slow, flaky, and metered — but the trade has a price: provider-side drift (a retired model, a changed request shape) is structurally invisible to a suite built this way, and stays invisible until someone actually makes a real call. A fully green 1451-test suite proved nothing at all about whether the shipped default model still existed, because nothing in the suite that ran routinely was capable of proving that.

It gets one layer worse: even the gated live test — the one case built for exactly this purpose — had its own bug hiding it further. The file's suite-wide `beforeEach` stubbed `globalThis.fetch` to throw for *every* case in the `describe` block, including the live one, so even force-enabling `AP_FLOW_GEMINI_E2E=1` never actually reached the network; the live case failed with `"no network in tests"` instead of a real provider response, indistinguishable at a glance from the suite's normal (intentional) behavior. Fixed with one line — `fetchSpy.mockRestore()` at the top of that specific case, before it does anything else — but it's the reason nobody caught the retirement earlier via the safety net that existed specifically to catch it: the net had a hole in it too, and nothing revealed that until someone actually pulled on it.

A third, independent layer surfaced only by actually running the complete suite for real (something the ~30-minute Postgres-backed run makes nobody do casually): `vitest.config.ts`'s test-environment override never pinned `CAPTURE_AI_PROVIDER`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` — only the database, secrets, Redis index, and storage root. A developer's real `.env` legitimately carries a live `CAPTURE_AI_PROVIDER=gemini` and a working key, because that's what running the app for real requires — and two tests elsewhere (`extraction.test.ts`, `mapping.test.ts`) asserted the behavior of an *unconfigured* provider (a `503`, a `NONE` classification) without pinning that config themselves. With a real key in scope, both silently started making real calls to a real model instead of exercising the fallback path they were written to test — one flaky (the model occasionally *did* classify nonsense text), one deterministic (a live call always succeeds, so it never falls through to `503`). Same root lesson as the two bugs above, one more level removed: a test suite's isolation from ambient environment state is itself something that has to be actively maintained, not assumed — and the way to find out it's leaking is the same way every layer of this incident was found: run the real thing, not the stub.

**The seam is provider selection, not a runtime negotiation** — `CAPTURE_AI_PROVIDER` is one env var, read once at startup via `resolveModelClient(purpose)`, not a per-request fallback chain. A Gemini outage doesn't automatically retry on Anthropic; that would double the number of code paths that need testing for one operational convenience this project doesn't need.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Forced tool use with a JSON schema | API-enforced structure; still needs a second parse for value-level trust, but eliminates the "unparseable response" failure class entirely | Chosen |
| Free-form prompt + `JSON.parse` | Simple to write; fails unpredictably whenever the model adds any surrounding text, which happens often enough in practice to be a real reliability problem | Rejected |
| Amounts as JSON numbers | One less parsing step; but reintroduces float imprecision at the exact boundary rule 3 exists to close | Rejected — decimal strings instead |
| Trusting `field_confidence` as ground truth | Would let a "high confidence" field skip review entirely | Rejected — it's a routing signal for Phase 11's reviewer UI, never an automatic accept/reject gate |
| A per-org provider choice (stored in the database) | Lets each tenant pick their own model | Rejected — an env var is one config surface, not a tenant-row secret-management problem; nothing in this app's design needs per-tenant model choice |
| Automatic fallback from one provider to the other on failure | Resilience against a single provider outage | Rejected — doubles the paths needing tests for an operational convenience a portfolio app doesn't need; a failed extraction already has a manual retry (`POST /:id/reextract`) |
| A third-party abstraction library (e.g. LangChain) over both providers | Less bespoke glue code | Rejected by rule 14 — no dependency before the phase that needs it, and the actual adapter code here is under 250 lines |
| A floating model alias (e.g. `gemini-flash-latest`) instead of a pinned id | Would have avoided the 2026-09-14 retirement outage entirely — an alias always resolves to something live | Rejected — the model's extraction behavior could then change under a live accounting app with zero diff and zero code review; for financial data extraction, a silent behavior change is a worse failure mode than a loud, diagnosable `404`. The accepted cost is exactly what happened: a pinned id will eventually need this kind of scheduled-maintenance swap |

## Where it lives in this codebase

- `server/src/services/capture/extractionService.ts` — `EXTRACTION_TOOL`, `GEMINI_EXTRACTION_SCHEMA`, `extractFromPages`, `validateArithmetic`
- `server/src/services/capture/mappingService.ts` — `CLASSIFICATION_TOOL`, `GEMINI_CLASSIFICATION_SCHEMA`, `classifyWithModel`
- `server/src/services/capture/modelClient.ts` — the provider seam: `StructuredModelClient`, `anthropicModelClient`, `geminiModelClient`, `resolveModelClient`, `geminiThinkingConfig` (the model-family-aware thinking-config branch), `readGeminiErrorStatus` (extracts only Google's error `status` enum for the 502 message, never the free-text error)
- `server/src/schemas/capture/extractionSchema.ts` — the zod re-parse of the model's structured output, provider-agnostic
- `server/src/utils/money.ts` — `parseMoneyText`, the chokepoint every extracted amount passes through
- `server/src/__tests__/capture/extraction.test.ts`, `modelClient.test.ts` — every case here injects a stub client or a fake `fetchImpl`; none reach the network

## Gotchas

- **API-level schema enforcement is not value-level trust.** A `tool_use` block passing the SDK's schema check only proves the shape is right; the zod re-parse and the amount parsing are what stand between a schema-valid-but-nonsensical model answer and the rest of the pipeline trusting it.
- **`extractFromPages` throwing `503` when unconfigured is a deliberate, non-obvious choice.** `ANTHROPIC_API_KEY` is optional at the environment level (the server and worker both have to boot without it, for the Docker-less local dev flow) — the alternative of making it required would break every existing test run and the whole dev setup. The tradeoff is that the "not configured" failure only surfaces when someone actually tries to extract, not at boot.
- **Money-as-string is only safe if *every* consumer respects it.** A well-intentioned refactor that changes a field from `string` to `number` "for convenience" reintroduces exactly the float bug this design closes — the type discipline (`amount: string` in the tool schema, never `number`) is load-bearing, not stylistic.
- **`validateArithmetic` flags, it never rejects.** A line-item sum that doesn't match the subtotal sets `arithmeticOk: false` and records a human-readable error, but the document still reaches `EXTRACTED` — Phase 10 posts nothing to the ledger, so there's nothing yet to protect by refusing the extraction outright; the contradiction is surfaced for a reviewer instead.

## Interview Q&A (Phase 19 additions)

**Q: You added a second LLM provider. What had to change, and what stayed the same?**
A: The interface each caller uses (`generateStructured`) and everything downstream of it — the zod re-parse, the decimal-string money discipline, `validateArithmetic` — stayed identical. What changed is a new adapter (`geminiModelClient`) implementing that interface over Gemini's REST API instead of Anthropic's SDK, plus a second copy of each schema written in Gemini's OpenAPI-subset dialect. The provider is chosen once, by an env var, at the point a client is constructed — nothing downstream knows or cares which provider produced the object it's holding.

**Q: Anthropic has forced tool use. Does Gemini have an equivalent, and if not, how do you get the same guarantee?**
A: Gemini's mechanism is different but achieves the same practical result through constrained decoding: `responseMimeType: 'application/json'` plus a `responseSchema` restricts what tokens the model can sample at generation time, so the output is guaranteed to conform to the schema rather than being validated after the fact. The user-visible guarantee — "this is schema-shaped JSON, not a rejected or malformed response" — is the same; the underlying mechanism (constrain-during-generation vs. validate-after-generation) differs.

**Q: Why does the Gemini schema define `field_confidence` as a fixed set of named fields instead of an open map, when the Anthropic version uses `additionalProperties`?**
A: Because Gemini's schema dialect (an OpenAPI subset) doesn't support `additionalProperties` at all — there's no way to say "any number of string keys, each mapping to a number." The two providers' schema languages aren't interchangeable even though both are loosely "JSON Schema-like," so the same logical shape has to be authored twice, once per dialect, and the Gemini version necessarily lists every field it wants a confidence score for by name.

**Q: Would you build automatic failover between the two providers?**
A: No, deliberately not for this project. Automatic failover roughly doubles the number of runtime paths that need testing (provider A fails mid-request → does the failover call use the same schema dialect correctly? what happens if both fail?) for a resilience property nothing here actually needs — a failed extraction already has a safe, visible failure mode (the document lands in `FAILED` with the error recorded, and `POST /:id/reextract` is the retry). If this were a production system serving real uninterruptible traffic, failover would be worth the complexity; as a single-tenant-at-a-time capture pipeline behind a job queue with retries, it isn't.

**Q: Your integration test suite is fully green, but the feature is broken in production. How does that happen, and what would you change?**
A: It happens exactly the way it happened here (2026-09-14): a real dependency the tests never actually exercise drifts out from under the code. `modelClient.test.ts` had 1451 sibling tests passing across the whole suite, every Gemini case stubbing `fetch` and asserting *shape* — the request has the right fields, the response gets parsed correctly — none of which can detect that the *provider itself* had stopped serving the pinned model id. The one case built to catch exactly that, the gated live test (`AP_FLOW_GEMINI_E2E=1`), wasn't run routinely — network calls in CI are slow, flaky, and metered, so gating it behind an explicit opt-in was a reasonable cost/reliability call, not negligence. But a safety net nobody runs is a safety net that doesn't exist in practice, and this incident had a second layer on top: even when someone *did* force-enable that gated test, it still couldn't reach the network, because the file's `beforeEach` stubbed `fetch` unconditionally for every case in the `describe` block, including the live one. What I'd change: a gated live check like this needs an explicit owner and a schedule it actually runs on (a periodic job, not "run it before you ship" as an unenforced convention) — the decision to gate it behind cost was correct, but a decision with no execution plan behind it isn't a mitigation, it's a comment in a test file.

**Q: You depend on a third-party model id in your code. Do you pin an exact version, or track a floating alias, and why?**
A: Pin the exact id — this codebase already did that for its Anthropic model (`AP_FLOW_VISION_MODEL = 'claude-sonnet-5'`) before this incident, and the same reasoning now applies to `CAPTURE_GEMINI_MODEL`. A floating alias like `gemini-flash-latest` would have sidestepped this specific outage — an alias always resolves to something currently live — but the trade is that the model's actual behavior could then change under a live accounting application with no diff, no code review, and no way to correlate a downstream extraction-quality regression back to "the provider changed something." For a system whose entire job is extracting financial figures accurately, a silent behavior change is a worse failure mode than a loud, immediately-diagnosable `404`. The honest framing of the trade: pinning doesn't avoid this kind of incident, it converts it from "silent and undiagnosable" into "loud and requires scheduled maintenance" — and that conversion is worth it here on purpose, not an oversight this incident exposed.

## Interview Q&A

**Q: How do you get reliable structured JSON out of an LLM instead of parsing free-form text?**
A: Force the model into a tool call rather than a free-text response. You define a tool with a JSON-schema-shaped `input_schema`, and set `tool_choice` to require that specific tool. The API validates the model's tool call against that schema before returning it, so you're guaranteed a schema-shaped result rather than having to hope the model's free-text response happens to be valid, unwrapped JSON.

**Q: Does forced tool use mean you can trust the extracted values without further validation?**
A: No — it guarantees *shape*, not correctness. The schema enforces that a field is present and has the right JSON type, but says nothing about whether the value is actually right; the model can still hallucinate a plausible-looking wrong value that's perfectly schema-valid. This project re-parses the tool's `input` through its own zod schema and treats every value as untrusted, exactly like a request body — parse, don't validate, applied a second time at what looks like an already-structured boundary.

**Q: Why does the extraction schema use decimal strings for money instead of JSON numbers?**
A: Because `JSON.parse` decodes a JSON number as an IEEE-754 double, and once a monetary value has been represented as a float even once, you can't rule out a representation error creeping in — `450.00 * 100` isn't guaranteed to equal exactly `45000` in floating point. Requiring the model to emit `"450.00"` as text and parsing it server-side with exact-arithmetic code (`BigInt`-based, no intermediate float) avoids ever letting a float touch a money value, which is the same rule this codebase enforces everywhere else money crosses an untrusted boundary.

**Q: What do you do with the model's self-reported confidence scores?**
A: Treat them as a routing signal, not a correctness guarantee. They're clamped into `[0, 1]` and used to tell a human reviewer where to look first — a low-confidence field is more likely to be wrong and deserves attention — but a high-confidence field isn't automatically trusted or auto-posted anywhere. A model can be confidently wrong, so the value of the score is statistical across many extractions, not a per-field truth claim.

**Q: How do you test code that calls an LLM without making real API calls in CI?**
A: The function that talks to the model takes an injectable client interface (`VisionClient`) as an optional parameter, defaulting to a real SDK-backed client only when none is supplied. Every test constructs a stub implementing that same narrow interface — returning a canned `tool_use` response — so the extraction logic, the amount parsing, and the arithmetic validation are all exercised with zero network calls and no API key needed to run the suite.

**Q: Why does an arithmetic mismatch (line items not summing to the subtotal) not get rejected outright?**
A: Because at this phase, the extraction is a draft — nothing has posted to the ledger yet, and posting logic is a separate, later phase. There's nothing financially at risk yet from an inconsistent extraction sitting in a draft table, so the more useful behavior is to flag the contradiction with a specific, human-readable message and let a reviewer see exactly what doesn't add up, rather than silently discarding a mostly-correct extraction over one bad field.

## Follow-ups they'll dig into

- "What if the model calls a different tool than the one you specified?" — `tool_choice` forces the specific named tool, so this shouldn't happen through normal API behavior, but the code still explicitly looks for a `type === 'tool_use'` block rather than assuming the first content block is always the right one.
- "How would you handle a model that's consistently wrong on a particular field?" — nothing here tracks per-field accuracy over time; that would need a feedback loop from Phase 11's human corrections back into either prompt tuning or a fallback heuristic.
- "What's your fallback if the vision API is down or rate-limited?" — the current design lets the error propagate and the document lands in `FAILED` with the error message recorded; `POST /:id/reextract` is the retry path, with no automatic backoff beyond what BullMQ's job retry already provides.

## See also

- [document-capture-pipeline.md](document-capture-pipeline.md)
- [runtime-validation-and-zod.md](../typescript/runtime-validation-and-zod.md)
- [branded-types-for-money.md](../typescript/branded-types-for-money.md)

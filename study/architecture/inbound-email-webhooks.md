# Inbound email webhooks

> Mail to a per-tenant address is turned into an authenticated-by-secret HTTP POST by a provider, recorded idempotently, and processed off the request path; the attachments are untrusted input.

**Category:** Architecture (with Node/Express and security notes)
**Introduced by:** Phase 43d — an email-in address for the bill inbox
**Verified against:** Node 22, Express 5, PostgreSQL 16, BullMQ 5, Vitest 4. Brevo's inbound-parsing behaviour is taken from its public docs (checked 2026-10-15) and has **not** been exercised against a real Brevo account — see "Gotchas".

---

## Mechanism

**MX to webhook.** We do not run a mail server. A receiving subdomain (`in.example.com`) has MX records pointing at the provider. The provider accepts the SMTP delivery, parses the MIME message, and POSTs JSON (sender, recipients, subject, attachment metadata with a *download token*) to a URL we registered. Our job begins at the HTTP request; SMTP, spam handling and MIME are the provider's.

**The address is the tenant key.** `<token>@<INBOUND_MAIL_DOMAIN>`, with the token 16 lowercase base32 characters from `crypto.randomBytes(10)` (80 bits, exactly 16 characters with no padding). An inbound message carries no session and no organization, so the token is how the organization is discovered. That makes the token lookup the one query in the phase without an `org_id` predicate (documented in the service header); every later statement is scoped by the discovered `org_id`. An unknown or rotated token is skipped silently, so the endpoint is not an oracle for which addresses exist. Rotation deactivates the row and inserts a new one in one transaction; a partial unique index `(org_id, purpose) WHERE is_active` guarantees at most one live address, and a deactivated token never routes again.

**Authenticating the webhook.** The provider documents no signature for inbound mail, so the credential is a secret path segment: `POST /api/v1/public/inbound-mail/brevo/:secret`, compared with `crypto.timingSafeEqual` against a 32+ character env secret. `timingSafeEqual` throws on unequal lengths, so the lengths are compared first (the length of the secret is not itself sensitive). A wrong secret and a disabled feature are the same `404`. After a valid secret the answer is `200` even if no recipient matched, so the provider does not retry forever; a structurally malformed payload (after a valid secret) is a `400`, which the provider may retry — acceptable, it is a provider bug, not ours. There is deliberately no rate limiter: a wrong secret costs one buffer comparison, and throttling a provider's retries only delays mail.

**Because the secret is in the URL, the URL must never be logged.** The `request completed` access-log line used to write the path verbatim, which would have written the webhook secret (and, already, every invitation/quote/statement link token) into the logs — a rule-11 breach. The middleware now replaces the value of any matched route param named `token` or `secret` with `[redacted]`. Capturing those params is non-trivial: Express reassigns `req.params` for every matched layer and **restores the outer value as it unwinds**, and the error middleware runs after that unwinding. By the time the response `finish` event fires, `req.params` is `{}`, so reading it there redacts nothing. The fix defines an accessor on `req.params` that records the credential params whenever Express assigns them. (The first attempt, snapshotting on `res.writeHead`, failed for exactly this reason: a `404` thrown from the handler is written by the error middleware, after the unwind.)

**Idempotent recording.** Providers deliver at least once. `inbound_messages` has `UNIQUE (org_id, provider, provider_message_id)`; the insert is `ON CONFLICT ON CONSTRAINT … DO NOTHING RETURNING id`, so a retry of the same webhook returns no row and enqueues nothing. The job id (`inbound-mail-<row id>`) is a second guard in the queue.

**Why processing is queued.** Downloading attachments and running them through capture (OCR, PII masking, a model call) takes seconds to minutes; the provider expects a fast `200` and will retry on a timeout, multiplying the work. So the webhook only records the row and enqueues `inbound-mail-process`; the worker does the slow part with 3 attempts and backoff. The job payload carries the attachment descriptors (`downloadToken`, name, type, length), because a worker cannot recover a download token from our database — we deliberately do not store them.

**Attachments are untrusted.** Only `application/pdf`, `image/png` and `image/jpeg` of at most `MAX_UPLOAD_BYTES` are eligible (the declared type is the sender's claim; capture sniffs the real bytes and rejects with an `ApiError`, which skips that attachment). The download uses a 15 s `AbortSignal.timeout`, rejects a non-200, and reads the body as a stream with a running byte count so a lying `Content-Length` cannot exhaust memory. A message with no eligible attachment ends `REJECTED`; one whose eligible attachments all fail to read as bills ends `REJECTED` with `No attachment could be read as a bill`; a mix is `PARTIAL`. An infrastructure failure (download, database) marks `FAILED` and rethrows so the queue retries. Files enter the bill inbox through `captureFile`, the same function a direct upload uses, so extraction, masking and metering are unchanged (rule 16: no capture table is touched).

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Provider webhook + secret path segment | No signature available; the secret is in the URL, so URL logging must be controlled | **Chosen** |
| Run our own SMTP server (`smtp-server`) | Own MX, TLS, spam, deliverability, a new dependency (rule 14) | Rejected |
| Poll a mailbox over IMAP | Credentials per tenant or shared mailbox, polling latency, a new dependency | Rejected |
| Process inside the webhook request | Provider times out and retries, multiplying OCR/model cost | Rejected |
| Store attachment bytes at webhook time | Provider download tokens expire; but the webhook then does heavy I/O | Rejected; download in the worker |
| HMAC signature header | Strongest, but Brevo documents none for inbound | Not available |

## Where it lives in this codebase

- `server/src/db/migrations/096_platform_inbound_mail.sql` — `inbound_mail_addresses`, `inbound_messages`, the idempotency constraint, the one-active-address partial index.
- `server/src/services/integrations/inboundMailService.ts` — address CRUD, `recordInboundBatch`, `processInboundMessage`.
- `server/src/services/integrations/brevoInbound.ts` — zod payload parsing, bounded streaming download.
- `server/src/controllers/integrations/inboundMailController.ts`, `server/src/routes/integrations/inboundMail.ts` — the public webhook and the three authenticated routes.
- `server/src/queue/handlers/inboundMailProcessHandler.ts` — the worker side.
- `server/src/middleware/requestContext.ts` — log redaction; `server/src/__tests__/logRedaction.test.ts`.

## Gotchas

- `timingSafeEqual` throws on different lengths; compare lengths first.
- Express restores `req.params` while unwinding — read it at `finish` and you get `{}`.
- A `200` to the provider means "stop retrying"; a `5xx` means "retry". Choose per failure class.
- The path secret can appear in the *provider's* logs and in proxy logs. Rotate `INBOUND_MAIL_WEBHOOK_SECRET` if exposed.
- Not verified against live Brevo: the attachment download currently uses the `api-key` header only; Brevo's reference also lists an OAuth bearer. If real downloads return 401 the code needs a plan update, not a workaround.
- A retried job can re-capture an attachment that already landed; capture records that as a visible `DUPLICATE` row for a human rather than hiding it.

## Interview Q&A

**Q: How does an email become a request to your API without you running a mail server?**
A: MX records on a receiving subdomain point at a provider, which accepts the SMTP delivery, parses the MIME and POSTs JSON to a webhook URL we registered. We only handle HTTP.

**Q: How do you authenticate a webhook that carries no signature?**
A: A long random secret in the URL path, compared in constant time with `timingSafeEqual`, with a wrong secret and a disabled feature both returning the same `404`. It is weaker than an HMAC, so the URL must be treated as a credential: never logged, rotatable.

**Q: Why did logging the request path leak the secret, and how did you fix it without reading `req.params` at `finish`?**
A: The access log wrote `originalUrl`, which contains the secret. Reading `req.params` at `finish` fails because Express restores the previous `params` object as the router stack unwinds, and error handlers run after that. An accessor on `req.params` records credential params as they are assigned, and the log substitutes `[redacted]`.

**Q: How do you make a webhook idempotent?**
A: Use the provider's message id as a natural key under a unique constraint and `INSERT … ON CONFLICT DO NOTHING RETURNING`; only a row that was actually inserted enqueues work. At-least-once delivery then produces exactly one message record.

**Q: Why enqueue instead of processing inside the handler?**
A: The slow work (download, OCR, a model call) exceeds the provider's response timeout, which triggers retries and duplicate cost. Record fast, answer `200`, process in a worker with its own retries.

**Q: What makes an email attachment untrusted, and what do you check?**
A: Type, size and content are all sender-controlled. We filter by declared type and size, bound the download by bytes read rather than by the declared length, time-limit it, and let the capture pipeline validate the real file; a content error skips that attachment while an infrastructure error retries.

**Q: Why is one query allowed to skip the `org_id` predicate?**
A: Because the token is how the tenant is found. It is an 80-bit random value with a global unique constraint, looked up only for active rows, and everything after it is scoped by the discovered `org_id`. Rotating invalidates it immediately.

## Follow-ups they'll dig into

- How would you add a signature check if the provider offered one? (HMAC over the raw body with a shared secret; needs the raw bytes, so a `verify` hook on the JSON parser for this route.)
- What if an attacker learns the address? (They can only add documents to the bill inbox for human review; a rotate retires it.)

## See also

- [background-jobs-and-queues.md](background-jobs-and-queues.md)
- [transactional-outbox.md](transactional-outbox.md)
- [payment-gateway-integration.md](payment-gateway-integration.md) — the other public webhook
- [document-capture-pipeline.md](document-capture-pipeline.md)
- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md)

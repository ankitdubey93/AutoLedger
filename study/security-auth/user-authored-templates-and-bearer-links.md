# User-Authored Templates & Bearer Links

> Letting customers' own users write the email your server sends is a code-injection surface, unless the "template language" can only *name* values you chose to expose. And a link that opens someone's account with no login is a password: generate it with real entropy, store only its hash, and make every failure look the same.

**Category:** Security & Auth
**Introduced by:** Phase 39b — statement email templates (`utils/placeholders.ts`) and the "Review and pay" link (`statement_sends`, `statementLinkService.ts`)
**Verified against:** Node 22 (`String.prototype.replace` with a global regex, `node:crypto`), PostgreSQL 16; behaviour pinned by `statementEmail.test.ts`

---

## Mechanism

### Placeholders, not a template engine

A template engine (Handlebars, EJS, Nunjucks, Jinja) evaluates *expressions*: property access, helpers, sometimes arbitrary code. When the template text comes from an untrusted author, that is **server-side template injection (SSTI)**. In engines that expose the runtime (EJS's `<%= %>` runs JavaScript; Jinja's `{{ ''.__class__… }}` walks Python objects), SSTI escalates to remote code execution. Even "logic-less" engines leak whatever object you pass as context.

`fillPlaceholders` has none of that surface:

- One regex, `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`: a name of letters, digits and underscores, nothing else.
- A **closed whitelist** (`STATEMENT_PLACEHOLDERS`) of eight names. The values are pre-computed **strings** (`balance_due: "USD 1,250.00"`), never objects, so nothing can be traversed.
- **Single pass.** `String.replace` with a global regex scans the *original* text once, and a replacement value is never re-scanned. A customer named `{{balance_due}}` is inserted literally, not expanded. A naive loop such as `while (text.includes('{{')) text = text.replace(…)` would expand it, which is template injection through *data* instead of the template.
- **Unknown names are rejected on save** (422, `unknownPlaceholders`) rather than silently left in, so an author sees a typo before a customer does.

### Escape once, at the last moment, for the right context

The filled subject and body are **plain text**, stored as-is in `email_outbox.template_data`. At render time the HTML part runs every paragraph through `esc()` (`& < > " '` → entities) and *then* turns `\n` into `<br>`. The order matters:

- escaping after inserting `<br>` would escape the `<br>` too;
- escaping before substitution would double-escape any value that is escaped again later.

The plain-text part is not escaped, because a text/plain body has no markup to inject into. One rule covers both attacks: a template author typing `<script>` and a customer *named* `<script>` both arrive as text.

### The link is a bearer token

The emailed link `…/statement/<token>` opens a customer's statement and lets them pay, with no session. So the token is a credential and gets credential treatment:

- **Entropy:** 32 bytes from `crypto.randomBytes` (CSPRNG), base64url. That is 256 bits, so guessing a live token is not a real attack.
- **At rest, only `SHA-256(token)`** (`statement_sends.token_hash`, `UNIQUE`). A database read leaks no usable link. A fast hash is correct here, unlike for passwords: the input is already high-entropy random, so there is no dictionary to slow down. (Passwords need a slow KDF because humans choose guessable inputs.)
- **In transit to the mailer:** the raw link sits in `email_outbox.secret_link`, AES-256-GCM-encrypted when a key is configured. A CHECK nulls it once the row is `SENT` or `FAILED` (Phase 38b).
- **Lookup is the only org-less query.** `WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`. The row it finds supplies the `org_id` that scopes every later read. Nothing in the request can choose the tenant.
- **Uniform failure.** Unknown, expired and revoked tokens all return the same `404 This statement link is not valid or has expired`, so the endpoint does not reveal whether a link ever existed.
- **Revocable, expiring, observable:** a 60-day expiry, `POST /statement-sends/:id/revoke`, and `last_viewed_at` shown to the sender.
- **Throttled including successes.** `publicLinkLimiter` uses `skipSuccessfulRequests: false`, unlike the login limiter, because a 200 is exactly what a token-guesser is looking for.
- **`Cache-Control: no-store`** on the view, so no shared cache keeps a copy of a bearer page.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Handlebars/Mustache for user templates | Familiar syntax, conditionals. But a dependency (rule 14), a context object to leak, and SSTI history | **Rejected** |
| Rich-text (HTML) editor for the body | Nicer emails. But stored user HTML must be sanitised (DOMPurify-class), email clients render inconsistently, and it creates a stored-XSS surface | **Rejected**: plain text, paragraphs from blank lines |
| Leave unknown `{{x}}` as literal text | Lenient. But typos reach customers | **Rejected**: 422 on save |
| Store the raw link token | Can re-send the same link later. But a DB leak is an account leak | **Rejected**: hash only, issue a new link per send |
| Signed JWT link (no DB row) | Stateless. But it can't be revoked before expiry, can't record `last_viewed_at`, and a key rotation kills every link | **Rejected**: an opaque token plus a row |

## Where it lives in this codebase

- `server/src/utils/placeholders.ts` — `STATEMENT_PLACEHOLDERS`, `fillPlaceholders`, `unknownPlaceholders`
- `server/src/services/accounting/statementEmailService.ts` — templates (default handling under a partial unique index), `placeholderValues`, `sendStatements` (send row + outbox row in one transaction)
- `server/src/services/mail/templates.ts` — `party_statement`: `esc` then `<br>`
- `server/src/services/accounting/statementLinkService.ts` — `resolveLiveSend`
- `server/src/middleware/rateLimit.ts` — `publicLinkLimiter`
- `server/src/db/migrations/085_ledger-core_statement_email.sql`

## Gotchas

- **Recursive substitution.** Re-scanning replaced output turns user *data* into template *code*. Use a single pass.
- **Escaping in the wrong place.** Escape at render, per output context (HTML vs text). Store neutral text.
- **Comparing tokens in the application.** Look up by hash with an index, which is equality inside the database. Don't fetch candidates and compare in JavaScript.
- **Different errors for "expired" and "unknown".** That is an existence oracle.
- **Rate-limiting only failures on a bearer endpoint.** Every hit on a live token is a success.

## Interview Q&A

**Q: Your users want to customise the emails your system sends. How do you avoid template injection?**
A: I don't give them a template language. I give them a fixed list of named placeholders whose values the server computes as plain strings. The substitution is one regex pass over the original text, so a value containing `{{…}}` is never re-expanded. Unknown names are rejected when the template is saved. The result is text, and the HTML email escapes it at render time, so neither the template author nor the data can inject markup. A real engine evaluates expressions over a context object, which is exactly the surface SSTI exploits.

**Q: Why is SHA-256 fine for the link token when you'd never use it for passwords?**
A: Slow password hashes exist because passwords come from a small, guessable space, so an attacker with the hash can try a dictionary. Our token is 256 random bits from a CSPRNG, and no dictionary covers that space. The hash only has to make a stolen database useless for opening links, and a fast one-way hash does that. Using bcrypt would add latency to every public request for no security gain.

**Q: How does an unauthenticated request get scoped to the right tenant?**
A: The token is the only input that can select a tenant. The single org-less query finds the send row by token hash, and that row's `org_id` scopes every query after it. Nothing in the path, query or body is ever read as an org id. Cross-tenant tests check that a token from org A only ever shows A's data, and that an intent belonging to org A can't be confirmed through org B's token.

**Q: A customer forwards the email. What's your exposure?**
A: Whoever has the link can see that one customer's statement and pay it. They can't see other customers, can't change anything, and can't learn the token's hash or other links. The mitigations are the 60-day expiry, revocation by the sender, and `last_viewed_at` to spot odd access. If that exposure were too much, the next step is a one-time code sent to the customer's email before showing the page, which adds friction.

## Follow-ups they'll dig into

- "Would you allow conditionals, like 'only show the overdue line if overdue > 0'?" (Add a fixed set of *server-computed* optional sentences as placeholders, not an expression language. The same principle holds: the author picks among values, never computes.)
- "What about the subject line? Can a value inject a header?" (A newline in a subject is a header-injection risk with raw SMTP. We send through Brevo's JSON API, which takes the subject as a JSON string, not raw headers. Stripping CR/LF from the subject would still be cheap hardening.)
- "Why not reuse the same link for every statement to a customer?" (A per-send token means revoking one email doesn't revoke all of them, each send has its own expiry and view tracking, and a leaked old link expires on its own.)

## See also

- [webhook-signing-and-ssrf.md](webhook-signing-and-ssrf.md) — the other place untrusted bytes are verified before use
- [oauth2-pkce-and-secrets-at-rest.md](oauth2-pkce-and-secrets-at-rest.md) — `randomUrlToken`, `sha256Hex`, and AES-GCM at rest
- [password-hashing-and-timing.md](password-hashing-and-timing.md) — why passwords are different
- [../architecture/transactional-outbox.md](../architecture/transactional-outbox.md) — the encrypted, self-clearing `secret_link`

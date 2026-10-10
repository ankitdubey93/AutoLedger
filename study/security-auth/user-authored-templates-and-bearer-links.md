# User-Authored Templates & Bearer Links

> Letting customers' own users write the email your server sends is a code-injection surface, unless the "template language" can only *name* values you chose to expose. And a link that opens someone's account with no login is a password: generate it with real entropy, store only its hash, and make every failure look the same.

**Category:** Security & Auth
**Introduced by:** Phase 39b — statement email templates (`utils/placeholders.ts`) and the "Review and pay" link (`statement_sends`, `statementLinkService.ts`). **Extended by Phase 40** — Xero-style `[Month]` placeholders across every document, one registry, a runtime legacy alias.
**Verified against:** Node 22.23 (ICU 78.2; `String.prototype.replace` with a global regex, `node:crypto`), PostgreSQL 16; behaviour pinned by `statementEmail.test.ts`, `placeholders.test.ts` (server and client) and `documentPlaceholders.test.ts`

---

## Mechanism

### Placeholders, not a template engine

A template engine (Handlebars, EJS, Nunjucks, Jinja) evaluates *expressions*: property access, helpers, sometimes arbitrary code. When the template text comes from an untrusted author, that is **server-side template injection (SSTI)**. In engines that expose the runtime (EJS's `<%= %>` runs JavaScript; Jinja's `{{ ''.__class__… }}` walks Python objects), SSTI escalates to remote code execution. Even "logic-less" engines leak whatever object you pass as context.

`fillPlaceholders` has none of that surface:

- One regex, `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`: a name of letters, digits and underscores, nothing else.
- A **closed whitelist** (`STATEMENT_PLACEHOLDERS`) of eight names. The values are pre-computed **strings** (`balance_due: "USD 1,250.00"`), never objects, so nothing can be traversed.
- **Single pass.** `String.replace` with a global regex scans the *original* text once, and a replacement value is never re-scanned. A customer named `{{balance_due}}` is inserted literally, not expanded. A naive loop such as `while (text.includes('{{')) text = text.replace(…)` would expand it, which is template injection through *data* instead of the template.
- **Unknown names are rejected on save** (422, `unknownPlaceholders`) rather than silently left in, so an author sees a typo before a customer does.

### Phase 40: one registry, many surfaces, two syntaxes, one pass

Phase 40 widened the same idea from eight statement-email names to Xero-style placeholders in invoices, bills, journals, notes, bank rules and both document templates. The safety properties above carry over unchanged. What changed is the shape of the whitelist and the grammar:

- **A registry, not a list.** `PLACEHOLDERS` holds one entry per value: canonical label (`Contact Name`), aliases (`organizationname`), the legacy snake name (`contact_name`), whether a ±n offset is allowed, and the **surfaces** it exists on (`INVOICE`, `BILL`, `JOURNAL`, `STATEMENT`, …). `fillPlaceholders(text, surface, ctx, mode)` resolves a name only if the registry offers it *on that surface*: `[Contact Name]` on a journal stays literal, because a journal has no contact.
- **One alternation regex, so still one pass.** `\[\s*([A-Za-z][A-Za-z ]{0,30}?)\s*(?:([+-])\s*(\d{1,3})\s*)?\]|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`. Both syntaxes are matched by the *same* `replace` call. Two sequential `replace` calls (brackets, then braces) would reintroduce the recursive-substitution bug: a customer named `{{balance_due}}` inserted by the first pass would be expanded by the second.
- **Unknown brackets stay literal; unknown braces are a 422.** That asymmetry is deliberate. Square brackets are ordinary prose ("see [attached]", "[draft]"), so refusing unknown ones would reject real text; the editor shows a non-blocking Levenshtein "did you mean [Month]?" hint instead. Double braces were always validated in Phase 39b, so an unknown one there is a typo, not prose, and stays refused.
- **Partial vs final fill.** Some values do not exist yet when text is first filled: a recurring DRAFT invoice has no number. `partial` mode leaves a known-but-valueless placeholder as written, to be filled later; `final` mode (issue, approve, send) replaces it with `''`, so no placeholder ever reaches a posted document or a sent email.
- **The legacy syntax is an alias at runtime, not a data migration.** Saved `{{contact_name}}` templates keep working because the engine maps legacy names to registry entries on the STATEMENT surface only. The alternative, an `UPDATE statement_email_templates SET body = regexp_replace(…)`, rewrites user-authored text in place: not additive under rule 13, not reversible, and it races an editor with the page open. The client offers a one-click "Convert" that the *user* saves.
- **Dates come from the document, and formatting from a table.** Every date placeholder is anchored on a `YYYY-MM-DD` document date with `Date.UTC` arithmetic, never "now", so neither timezone can move `[Month]`. Month names come from a hard-coded English table rather than `Intl`, because the browser and the server must agree byte-for-byte and ICU versions differ: Node 22's ICU 78 formats `en-GB` short September as `Sept`, older ICU as `Sep`. The table pins `Sept`, matching what the Phase 39b emails already printed. `[Week]` is the ISO-8601 week: take the Thursday of the date's Monday-based week; its year is the week-year, and the week number is `1 + floor((thursday − Jan 1 of that year) / 7 days)`. That is why `2027-01-01` is week 53 while `[Year]` says 2027.
- **An escape that survives two fills.** `[[Month]]` is a fourth alternation branch, matched before the name branch. A `final` fill writes it out as `[Month]`; a `partial` fill leaves it as `[[Month]]`. The asymmetry matters because recurring generation fills partially and issue fills again: unescaping on the first pass would hand the second pass a live `[Month]`.
- **Two engines, one fixture.** The editors preview unsaved text on every keystroke, so the client has a line-for-line mirror (`client/src/utils/placeholders.ts`). Drift is prevented by `client/src/__tests__/fixtures/placeholderCases.json`, which both suites run: the client imports it with Vite's `?raw`; the server reads it with `fs`, because Vite refuses to load files outside its root.

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

- `server/src/utils/placeholders.ts` — the `PLACEHOLDERS` registry, `fillPlaceholders`, `containsPlaceholders`, `unknownLegacyPlaceholders`, ISO-week and month-table date maths (Phase 40)
- `server/src/utils/placeholderFields.ts` — `fillField`: re-checks a column's length on the *filled* text and returns what its `*_template` column should hold
- `client/src/utils/placeholders.ts` — the client mirror plus `nearMisses` and `upgradeLegacy`; `client/src/__tests__/fixtures/placeholderCases.json` — the shared parity fixture
- `server/src/services/accounting/statementEmailService.ts` — templates (default handling under a partial unique index), `statementContext`, `sendStatements` (send row + outbox row in one transaction)
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
- **Two replace passes for two syntaxes.** That is recursive substitution again. Use one alternation regex.
- **`Intl` in code that two runtimes must agree on.** ICU data is versioned with the runtime; a server and a browser can format the same date differently. Use a table when output must match exactly.
- **Filling system text.** Journal descriptions like `Invoice INV-1 — <customer name>` are built by code from data; filling them would let a customer named `[Month]` expand. Only text a person typed for the purpose goes through the engine.

## Interview Q&A

**Q: Your users want to customise the emails your system sends. How do you avoid template injection?**
A: I don't give them a template language. I give them a fixed list of named placeholders whose values the server computes as plain strings. The substitution is one regex pass over the original text, so a value containing `{{…}}` is never re-expanded. Unknown names are rejected when the template is saved. The result is text, and the HTML email escapes it at render time, so neither the template author nor the data can inject markup. A real engine evaluates expressions over a context object, which is exactly the surface SSTI exploits.

**Q: Why is SHA-256 fine for the link token when you'd never use it for passwords?**
A: Slow password hashes exist because passwords come from a small, guessable space, so an attacker with the hash can try a dictionary. Our token is 256 random bits from a CSPRNG, and no dictionary covers that space. The hash only has to make a stolen database useless for opening links, and a fast one-way hash does that. Using bcrypt would add latency to every public request for no security gain.

**Q: How does an unauthenticated request get scoped to the right tenant?**
A: The token is the only input that can select a tenant. The single org-less query finds the send row by token hash, and that row's `org_id` scopes every query after it. Nothing in the path, query or body is ever read as an org id. Cross-tenant tests check that a token from org A only ever shows A's data, and that an intent belonging to org A can't be confirmed through org B's token.

**Q: A customer forwards the email. What's your exposure?**
A: Whoever has the link can see that one customer's statement and pay it. They can't see other customers, can't change anything, and can't learn the token's hash or other links. The mitigations are the 60-day expiry, revocation by the sender, and `last_viewed_at` to spot odd access. If that exposure were too much, the next step is a one-time code sent to the customer's email before showing the page, which adds friction.

**Q: Your template text supports `[Month]`, and you now have two syntaxes. How do you stop one syntax's output being expanded by the other?**
A: One regex with an alternation: brackets OR braces, and a single `String.replace` over the original text. The replacer decides per match which syntax it saw. Replacement values are never re-scanned, so a customer named `{{balance_due}}` or `[Month]` is inserted literally. Two sequential passes would be the classic recursive-substitution bug: data inserted by pass one becomes template code for pass two.

**Q: You changed the placeholder syntax. Existing customers have saved templates in the old one. Migration or alias?**
A: Alias. The engine still recognises the eight old `{{snake}}` names on the statement surface and maps them to the same values. A data migration would rewrite user-authored text in place, which isn't additive, isn't reversible, and races anyone editing with the page open. The UI offers a "Convert" button so users move over when they choose. Unknown `{{x}}` is still refused, so the old validation contract also holds.

**Q: Why not just use `Intl.DateTimeFormat` for "10 Oct 2026"?**
A: Because the same text is formatted on the server (stored on the document) and in the browser (previews and rendered templates), and they must agree exactly. `Intl` output depends on the ICU data bundled with each runtime: Node 22 with ICU 78 renders en-GB September as "Sept", other versions as "Sep". A twelve-entry month table can't drift, and a shared fixture run by both test suites would catch it if it did.

**Q: Week numbers — what does `[Week]` return on 1 January 2027, and why?**
A: 53. ISO-8601 weeks start on Monday, and week 1 is the week containing the year's first Thursday. 1 January 2027 is a Friday, so its week's Thursday is 31 December 2026, which makes it week 53 of 2026. `[Year]` still says 2027 because it's the calendar year, not the ISO week-year. That's documented rather than "fixed", because Xero behaves the same way.

## Follow-ups they'll dig into

- "Would you allow conditionals, like 'only show the overdue line if overdue > 0'?" (Add a fixed set of *server-computed* optional sentences as placeholders, not an expression language. The same principle holds: the author picks among values, never computes.)
- "What about the subject line? Can a value inject a header?" (A newline in a subject is a header-injection risk with raw SMTP. We send through Brevo's JSON API, which takes the subject as a JSON string, not raw headers. Stripping CR/LF from the subject would still be cheap hardening.)
- "Couldn't someone write `[Contact Name]` 400 times to blow up a 500-character column?" (Yes, and a long contact name can overflow honestly too. `fillField` re-checks the column limit on the filled text and refuses with a 422 naming the field, rolling back the whole issue. Truncating would silently corrupt a financial document.)
- "Why not reuse the same link for every statement to a customer?" (A per-send token means revoking one email doesn't revoke all of them, each send has its own expiry and view tracking, and a leaked old link expires on its own.)

## See also

- [webhook-signing-and-ssrf.md](webhook-signing-and-ssrf.md) — the other place untrusted bytes are verified before use
- [oauth2-pkce-and-secrets-at-rest.md](oauth2-pkce-and-secrets-at-rest.md) — `randomUrlToken`, `sha256Hex`, and AES-GCM at rest
- [password-hashing-and-timing.md](password-hashing-and-timing.md) — why passwords are different
- [../architecture/transactional-outbox.md](../architecture/transactional-outbox.md) — the encrypted, self-clearing `secret_link`

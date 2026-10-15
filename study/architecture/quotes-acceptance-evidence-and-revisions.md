# Quotes: non-posting documents, acceptance evidence and revision chains

> How a commercial offer is modelled so that it can never touch the ledger, can never change after the customer saw it, and leaves evidence of exactly what was accepted, by whom.

**Category:** Architecture · PostgreSQL · Security
**Introduced by:** Phase 41 — sales and purchase quotes with a public accept/decline link, converted manually into a draft invoice or bill
**Verified against:** PostgreSQL 16, Node 22, Express 5, Zod 4 (the `jsonb - text[]` operator and partial unique indexes are long-standing; checked against the PG 16 docs)

---

## Mechanism

**1. A document that does not post.** Every other sales/purchase document here (invoice, bill, credit note) creates a journal entry when it leaves DRAFT. A quote never does: `quoteService` imports no `journalService`, and conversion calls `invoiceService.createInvoiceOnClient` / `billService.createBillOnClient`, which create a **DRAFT** document on the same transaction. The GL effect happens later, through the existing issue/approve code. The test proves it by counting `journal_entries` + `ledger_lines` before sending, after acceptance and after conversion — the count never moves.

Why that is the right accounting: IFRS 15 / ASC 606 step 1 says a contract exists only when the parties have *approved* it — so an unaccepted quote is not a contract. Even an accepted one recognises no revenue until the performance obligation is satisfied (step 5), which the product records with the invoice. FX follows the same logic: IAS 21 measures a transaction at the spot rate on the *transaction* date, so a quote may show an "indicative" base total (`resolveRateOnClient`, which returns `null` instead of throwing when there is no rate) but nothing is frozen; the invoice calls `documentRateOnClient` for its own date.

**2. Freezing what was sent — a row-diff trigger.** Once a quote leaves DRAFT, `reject_sent_quote_mutation()` (BEFORE UPDATE OR DELETE) allows only the transitions in the FSM and compares the whole row with the status and event columns removed:

```sql
to_jsonb(NEW) - ARRAY['status','updated_at','accepted_at', …]
  IS DISTINCT FROM
to_jsonb(OLD) - ARRAY['status','updated_at','accepted_at', …]
```

`to_jsonb(record)` turns the row into a JSON object; `jsonb - text[]` deletes those keys; `IS DISTINCT FROM` treats NULL = NULL as equal. So *any* other column changing — money, party snapshot, terms, number, content hash — raises `0A000`, including columns added by future migrations (deny-by-default). A second trigger on `quote_lines` reads the parent's status and refuses inserts/updates/deletes unless it is DRAFT.

**3. Proving the code and the database agree.** Rule 10 says the FSM lives in one code table; the trigger is a second copy. `quoteConstraints.test.ts` inserts a quote directly in every status (INSERT is not guarded), attempts a raw `UPDATE … SET status = to` for all 8×8 pairs, and asserts "the database allowed it" equals `canTransitionQuote(from, to)`. That test caught a real gap while building: the first trigger let a DRAFT jump straight to ACCEPTED, because "a draft is freely editable" had been written as `RETURN NEW` before any status check.

**4. Tamper-evident acceptance.** At first send the service builds a canonical JSON of what the recipient will see — key order fixed by construction, because `JSON.stringify` preserves insertion order — and stores `sha256(content)` on the quote. The public page returns that hash; the accept request must send it back; the service compares it under the row lock. A quote that changed in between (it cannot, by the trigger — but a revision may have replaced the link target) is a 409, never a silent acceptance of something the signer did not see. The response row stores the hash it matched.

**5. Insert-only evidence and a race arbiter.** `quote_responses` has `reject_mutation()` on UPDATE/DELETE (the same function that guards `ledger_lines`) and `UNIQUE (org_id, quote_id)`. Two people answering at once — one accepting, one declining — both pass the service's `status = 'SENT'` check only if they read before either commits; the service also locks the quote `FOR UPDATE`, so in practice the second waits and then sees ACCEPTED. The unique constraint is the backstop that holds even if a future code path forgets the lock. The public-link test fires accept and decline concurrently and asserts exactly one `200` and one `409`.

**6. Revisions as a chain, not edits.** A sent quote is never edited; `reviseQuote` copies it into a new DRAFT with `supersedes_quote_id` pointing back, the same `root_quote_id`, and `revision + 1`. Constraints shape the chain:
- `ck_quotes_revision`: revision 1 ⇔ no predecessor.
- `UNIQUE (org_id, supersedes_quote_id)`: each version is revised at most once — the chain is linear.
- partial uniques `… (org_id, root_quote_id) WHERE status = 'DRAFT'` and `… WHERE status = 'SENT'`: at most one open draft and one live offer per chain.

Sending the revision inherits the number (`QU-000012 rev 2`), moves a SENT predecessor to SUPERSEDED and revokes its links — in that order, because the "one SENT per chain" index would otherwise reject the new SENT row. If the predecessor was *accepted* while the revision was being drafted, sending is refused: the customer has a contract on revision 1.

**7. Convert once, in the right direction.** `invoices.source_quote_id` has a partial unique index (`WHERE source_quote_id IS NOT NULL`) — a voided invoice still occupies it, so voiding never frees the quote. The FK is composite: `(org_id, source_quote_id, source_quote_direction) → quotes (org_id, id, direction)`, with a CHECK pinning the invoice side to `'SALES'`. That makes "a purchase quote became an invoice" unrepresentable, not merely unlikely. Deleting the draft invoice runs `revertConversionOnClient` in the delete's transaction, moving the quote CONVERTED → ACCEPTED.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Quote as a DRAFT invoice with a flag | No new tables, but every invoice query, report and trigger must learn to ignore it, and an "accepted quote" would be one keystroke from posting | Rejected |
| Two tables (`sales_quotes`, `purchase_quotes`) | Clean party FKs, but every service, route, page and test twice | Rejected — one table with `direction` and a party XOR CHECK |
| Edit a sent quote and log the diff | Simple UI, but the customer may have accepted the old figures; evidence would point at a row that changed | Rejected — revisions |
| A new number per revision | Gapless still, but the customer's reference changes every round | Rejected — same number, `revision` column, unique on both |
| E-signature provider (DocuSign etc.) | Strong evidence, but a dependency and a contract (rule 14) for a feature that needs "who agreed to what, when" | Deferred; typed name + ticked terms + IP/UA + content hash |
| Persisted EXPIRED only (sweep) | One source of truth, but a quote is wrongly acceptable until the sweep runs | Rejected — derive on read *and* re-check at accept; the sweep only records it |
| Auto-convert on acceptance | Fewer clicks, but creates documents without review and couples the public endpoint to invoice creation | Rejected by the user — manual "Convert" |

## Where it lives in this codebase

- `server/src/db/migrations/089_ledger-core_quotes.sql` — tables, the row-diff trigger, chain constraints, back-links
- `server/src/types/accounting.ts` — `QUOTE_TRANSITIONS`, `canTransitionQuote`, `effectiveQuoteStatus`
- `server/src/services/accounting/quoteStatusService.ts` — the one place a post-send status is written (separate so invoice/bill services can revert a conversion without an import cycle)
- `server/src/services/accounting/quoteService.ts` — `finalizeOnClient` (lock chain → number → hash → supersede → freeze), `respondOnClient`, `convertQuote`
- `server/src/services/accounting/publicQuoteService.ts` — token → org resolution, the public view, accept/decline
- `server/src/utils/documentTotals.ts` — one rounding rule for every priced document, so a quote's total equals its invoice's
- `client/src/Pages/sales/quotes/` — kind-config pages; `QuoteDocument` is shared by the app and the public page

## Gotchas

- **`to_jsonb` diffs are deny-by-default.** Adding a column later that *should* change after send (say, `last_reminded_at`) needs the trigger's exclusion list updated in a new migration — otherwise every reminder 0A000s.
- **Order inside the send transaction matters.** Supersede the old SENT row before setting the new one, or the partial unique index fires.
- **Lock order.** Send and revise both lock the whole chain `ORDER BY id FOR UPDATE` before anything else, so two transactions on one chain cannot deadlock.
- **"Valid until" is a date compared against the organization's "today"** (Phase 42; see below). Every other document in the codebase still uses UTC "today", so a quote and an invoice can disagree about what day it is near midnight. A product-wide move is its own phase.
- **Testing time-dependent rules in-process.** `vi.useFakeTimers({ toFake: ['Date'] })` moves the server's `new Date()` because supertest runs the app in the same process — but it also outdates the 15-minute access token, so the test must sign in again after the jump.
- **The public view must not leak.** It is a separate projection (`PublicQuoteView`) with no ids, accounts, IPs or user agents — not the internal object with fields deleted.

## Phase 42 additions

### Verified-email acceptance (not a qualified e-signature)

A bearer link proves possession of the link, not identity. When the org turns on `quote_acceptance_requires_code`, the signer types an email, the server emails a 6-digit code, and acceptance needs the code; the evidence row records `signer_email_verified`. This is *email-possession evidence*. It is **not** a qualified electronic signature (eIDAS QES), which needs a qualified trust-service provider, and the UI/docs must not call it one.

- **Generation:** `crypto.randomInt(0, 1_000_000)` padded to 6 digits — a CSPRNG with uniform output (never `Math.random`, never `% 1e6` over random bytes, which biases).
- **Storage:** only `sha256Hex(`${linkId}:${code}`)`. The link id acts as a per-link salt, so one precomputed table of the million possible codes does not serve all links. Honest caveat: with only 10^6 possibilities, a stolen hash can be brute-forced in milliseconds whatever the hash is, so the protection comes from the 10-minute expiry, the attempt cap and the fact that the code table is not exposed — a slow hash (bcrypt/argon2) would add little. The code travels in the outbox row's `data` and is never logged.
- **Comparison:** `timingSafeEqual` on equal-length buffers. A timing leak is nearly irrelevant for a 5-attempt code, but the rule costs nothing.
- **Attempt counters must survive a failed request.** If the wrong-guess increment ran inside the accept transaction, the 422 would roll it back and an attacker would get unlimited guesses. So the accept is two transactions: transaction 1 locks the newest live code `FOR UPDATE`, increments `attempts`, compares, and commits whether or not it matched; transaction 2 (the accept itself) re-locks, re-compares and sets `consumed_at`, so a code is single-use even under a concurrent double-submit.
- **Limits:** 5 attempts per code (also a CHECK `attempts BETWEEN 0 AND 5`), 10-minute TTL judged by the database's `now()` (so tests age the row with SQL; faking JS time does not move it), at most 5 codes per link per hour, counted under a `FOR UPDATE` lock on the `quote_links` row so concurrent requests cannot both read "4".
- A code issued to jane@x is not valid for bob@x: the lookup is keyed on `(link, signer_email)`.

### The organization's "today" with `Intl.DateTimeFormat`

`todayInZone(zone, now)` builds `new Intl.DateTimeFormat('en-US', { timeZone, year, month: '2-digit', day: '2-digit' })` and reads `formatToParts(now)` for year/month/day. Using `formatToParts` rather than parsing `format()` output avoids depending on locale-specific ordering and separators. The IANA zone database (via ICU, bundled in Node) handles DST and historical changes; a hand-rolled offset table would not. An unknown zone makes the constructor throw `RangeError`, which we catch and fall back to the UTC date; `PATCH /settings` rejects a new invalid zone with 400 using the same constructor as a validity probe. Test across extremes at one fixed instant: at 12:00Z it is already the 11th in `Pacific/Kiritimati` (UTC+14) and still the 10th in `Pacific/Pago_Pago` (UTC-11). The hourly expiry sweep selects a superset (`valid_until < utcToday + 1`) because no zone is more than 14 hours ahead, then each org applies its own date. Verified on Node 22.

### Server-side PDF with `pdfkit`

PDFKit is a pure-JavaScript library that streams a document: you create a `PDFDocument`, call drawing methods, `doc.on('data')` collects chunks, `end` fires when `doc.end()` completes; we wrap that in a Promise returning one `Buffer`. Layout is manual: A4, margin 50, a new page when `doc.y` passes a threshold before each line. Built-in Helvetica is one of the 14 standard PDF fonts, so nothing is embedded — but it uses WinAnsi encoding, so non-Latin text (Devanagari, CJK) does not render. That is a known, documented limit; fixing it means shipping and embedding a Unicode font file. Money is printed from integer cents with the currency **code** (not a symbol that Helvetica may lack). Text in the uncompressed stream is stored in kerned hex `TJ` arrays, so a unit test must decode those (a `visibleText()` helper) rather than grepping raw bytes; with `compress: true` (the default) the streams are Flate-compressed and not greppable at all.

Why not headless Chromium (Puppeteer) rendering the React page: it would reproduce the on-screen layout exactly and handle Unicode, but adds a ~150–400 MB browser binary, a process to manage per request, a cold-start cost, and a sandboxing surface (the browser would load our own HTML, but still). For a fixed-layout document of text and a table, a pure-JS writer is a smaller, faster, more auditable dependency — at the price of maintaining a second layout implementation next to `QuoteDocument.tsx`. Rule 14 applies: this is the phase that needs the dependency (`pdfkit@0.20.2`, `@types/pdfkit@0.17.6`). The PDF is not attached to emails (the outbox has no attachments); it is served with `Content-Disposition: attachment`, `no-store` and `nosniff`.

### Templates and the QUOTE placeholder surface

Quote email templates reuse the Phase 39b/40 machinery with a new surface `QUOTE` and four new keys. See [user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md).

## Interview Q&A

**Q: Why doesn't accepting a quote create a journal entry?**
A: Because nothing has happened that the books record yet. A quote is an offer; acceptance creates a contract (IFRS 15 / ASC 606 step 1), but revenue is recognised when the performance obligation is satisfied, which in this product is the invoice. Posting at acceptance would book revenue for work not done and would need reversing whenever the scope changes. So acceptance writes only evidence, and conversion creates a *draft* invoice that posts through the normal issue path, at the FX rate of its own date.

**Q: How do you guarantee a customer accepted exactly what they were shown?**
A: Three layers. The sent quote is immutable in the database — a BEFORE UPDATE trigger diffs `to_jsonb(NEW)` against `to_jsonb(OLD)` with only the status columns removed, so any content change raises. At send I store a SHA-256 of the canonical content; the public page returns it and the accept request must echo it, compared under a row lock. The response row is insert-only and stores the hash it matched. If a revision replaced the quote, the old link is revoked and returns 404.

**Q: Two people click Accept and Decline at the same moment. What happens?**
A: Each request locks the quote `FOR UPDATE`, so one waits; when it proceeds it re-reads the status, sees ACCEPTED (or DECLINED), and gets a 409. Independently, `quote_responses` has `UNIQUE (org_id, quote_id)`, so even a path that skipped the lock could not record two answers. I have a test that fires both concurrently and asserts one 200 and one 409, and exactly one row.

**Q: Why keep the state machine in code *and* in a trigger, and how do you stop them drifting?**
A: Code gives good error messages and is what developers read; the trigger protects against every other writer — a script, a future service, a bad migration. The risk is drift, so I test parity: insert a quote in each of the 8 statuses, attempt all 56 transitions with raw SQL, and assert the database's verdict equals `canTransitionQuote`. That test found a real bug — the trigger let DRAFT go straight to ACCEPTED.

**Q: How would you let a converted quote be invoiced in two instalments?**
A: Today `ux_invoices_source_quote` enforces one invoice per quote. Partial conversion would replace that with a quantity ledger: a `quote_line_conversions` table recording how much of each line each invoice consumed, a CHECK/deferred trigger that the sum never exceeds the quoted quantity, and a status like PARTIALLY_CONVERTED. The FSM, the delete-reverts-conversion rule and the tests would all change, which is why it was left out of scope deliberately.

**Q: Tell me about a time you avoided an import cycle in a service layer.**
A: Deleting a draft invoice that came from a quote has to put the quote back to ACCEPTED in the same transaction, so `invoiceService` needs quote logic — but `quoteService` already imports `invoiceService` to convert. I moved the one operation both need, the status writer, into a tiny `quoteStatusService` that imports only types. It also became the single place a post-send status is written, which is what rule 10 asks for anyway.

**Q: Why does verifying a 6-digit code need two transactions?**
A: Because the failed-guess counter has to outlive a failed request. If the increment were inside the accept transaction, the 422 for a wrong code would roll it back and an attacker could guess indefinitely. Transaction 1 increments `attempts` under `FOR UPDATE` and commits regardless of the outcome; transaction 2 is the real accept, which re-checks and consumes the code so it is single-use. The general lesson: anything whose purpose is to record a failure cannot live in the transaction that the failure aborts.

**Q: How do you compute "today" in an organization's timezone in Node?**
A: `Intl.DateTimeFormat` with the `timeZone` option and `formatToParts`, picking year, month and day parts. It uses the ICU/IANA database so DST is right; an invalid zone throws `RangeError`, which I catch to fall back to UTC and use as the validation probe on save. I test it at a fixed instant across UTC+14 and UTC−11, where the calendar date differs by a full day.

**Q: Why is a hashed 6-digit code still weakly protected, and why is that acceptable?**
A: There are only 10^6 codes, so if the hash leaked, any hash function falls to brute force in well under a second; salting by link id only defeats a shared precomputed table. The real defences are not storing anything exploitable in logs, a 10-minute life, 5 attempts per code, an hourly cap on codes per link, and one-time consumption. I would not claim bcrypt helps here.

**Q: Is that a qualified electronic signature?**
A: No. It evidences control of an inbox at a point in time, plus the typed name, consent, IP, user agent and content hash. A QES under eIDAS requires a qualified trust-service provider and certificate-based identification, which is a contract and legal decision, not code. It is explicitly unbuilt.

## Follow-ups they'll dig into

- What if the email with the link is forwarded? (Bearer token: anyone holding it can answer. Mitigations: expiry, revoke, one live link, evidence records who typed what; a stronger flow would require email verification of the signer.)
- How do you expire quotes reliably? (Derived on every read and re-checked at accept; the hourly sweep uses `FOR UPDATE SKIP LOCKED` per org so it never blocks a live acceptance.)
- Why store a party snapshot instead of joining the customer? (A renamed or re-addressed customer must not rewrite a quote they already accepted.)

## See also

- [document-lifecycle-fsm.md](document-lifecycle-fsm.md)
- [credit-and-debit-notes.md](credit-and-debit-notes.md)
- [gapless-numbering-and-counters.md](../postgresql/gapless-numbering-and-counters.md)
- [partial-unique-indexes.md](../postgresql/partial-unique-indexes.md)
- [composite-foreign-keys-for-tenancy.md](../postgresql/composite-foreign-keys-for-tenancy.md)
- [orders-partial-billing-and-deposits.md](orders-partial-billing-and-deposits.md)
- [user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md)

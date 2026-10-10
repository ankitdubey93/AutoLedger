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
- **"Valid until" is a date, compared against UTC today** — like every document in this codebase. A customer in UTC+10 sees it expire mid-morning their time. Org-timezone dates are a known gap.
- **Testing time-dependent rules in-process.** `vi.useFakeTimers({ toFake: ['Date'] })` moves the server's `new Date()` because supertest runs the app in the same process — but it also outdates the 15-minute access token, so the test must sign in again after the jump.
- **The public view must not leak.** It is a separate projection (`PublicQuoteView`) with no ids, accounts, IPs or user agents — not the internal object with fields deleted.

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
- [user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md)

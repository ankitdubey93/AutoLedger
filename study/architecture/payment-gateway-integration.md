# Payment Gateway Integration & Idempotent Settlement

> Taking a card payment is a distributed transaction across two systems that don't share a database: yours and the gateway's. The design question isn't "how do I call Stripe". It's who decides the amount, which side is the source of truth, and how to record the money exactly once when two callers report it, in any order, any number of times.

**Category:** Architecture
**Introduced by:** Phase 39c — "Review and pay" on an emailed customer statement (`services/accounting/onlinePaymentService.ts`, `services/payments/stripeClient.ts`, `Pages/public/StripePayPanel.tsx`)
**Verified against:**
- Node 22, PostgreSQL 16, `@stripe/stripe-js` 10 and `@stripe/react-stripe-js` 7.
- Stripe's PaymentIntents REST API pinned to `Stripe-Version: 2024-06-20`.
- Settlement behaviour is pinned by `onlinePayments.test.ts` against an in-memory fake Stripe. **The real-Stripe path has not been run in this repo yet.** The PaymentIntent field names used (`client_secret`, `status`, `amount`, `currency`, `last_payment_error.message`, `metadata`) are the documented ones, but confirm them with test keys before relying on them.

---

## Mechanism

### The PaymentIntent lifecycle

A **PaymentIntent** is Stripe's record of one attempt to collect one amount. It moves through these statuses:

- `requires_payment_method` — no card yet, or the last card was declined; `last_payment_error` says why;
- `requires_action` — 3-D Secure or a similar challenge;
- `processing`;
- then one of `succeeded` or `canceled`.

A declined card does **not** end the intent. The customer can try another card on the same intent, which is why a decline leaves our row `PENDING`.

### Who holds what

| Party | Holds | Never holds |
|---|---|---|
| Our server | the secret key (`sk_…`), the amounts, the invoice ↔ intent mapping | card numbers |
| Browser | the publishable key (`pk_…`) and one intent's `client_secret` | the secret key, the authority to set an amount |
| Stripe | card data, the intent's real status | our invoices |

### The flow

1. **Price on the server.** The customer ticks invoices. The browser sends **only invoice ids** (`startPayment`).
   - The server locks those invoices `FOR UPDATE` in sorted-id order (the same order `paymentService` uses, so concurrent receipts serialise rather than deadlock).
   - It computes each invoice's outstanding amount with the shared settlement SQL.
   - It commits a `PENDING` `online_payments` row plus its per-invoice lines.
2. **Create the intent, after COMMIT.** `POST /v1/payment_intents` happens outside the transaction, so a slow network never holds invoice row locks. It carries the row's id as the `Idempotency-Key`: Stripe replays the original response for a retried request with the same key instead of creating a second intent. Only the intent's `client_secret` goes back to the browser.
3. **Card entry happens inside Stripe's iframe.** `PaymentElement` renders a Stripe-hosted iframe, and `stripe.confirmPayment({ redirect: 'if_required' })` sends the card from that iframe to Stripe. Our JavaScript never sees a card number. That is what keeps the integration out of most PCI DSS scope: Stripe documents Elements integrations as eligible for the shortest self-assessment questionnaire, SAQ A.
4. **Settle from two directions.**
   - The browser, on success, calls `/confirm`.
   - Stripe, independently, POSTs `payment_intent.succeeded` to the webhook.
   - Either may arrive first, or only one may arrive at all (the tab closes; the webhook endpoint is down and Stripe retries for days). Both call the same `settleIntent(intentId)`.

### Why `settleIntent` is idempotent

```
pre-check: is this intent ours? still PENDING?      → 404 / return early, no network
retrieve the intent from Stripe                     → the source of truth for status and amount
BEGIN
  SELECT … FROM online_payments WHERE provider_intent_id = $1 FOR UPDATE
  status ≠ PENDING                                  → return it (a second caller lands here)
  intent canceled                                   → CANCELED
  intent not succeeded                              → stay PENDING (record the decline reason)
  amount/currency ≠ ours                            → NEEDS_REVIEW
  SAVEPOINT
    createPaymentOnClient(…)                        → the ordinary receipt journal, same transaction
    SET CONSTRAINTS ALL IMMEDIATE                   → run the payment's deferred checks now
  RELEASE / on failure ROLLBACK TO SAVEPOINT        → NEEDS_REVIEW with the reason
  status → RECORDED, payment_id = …
COMMIT
```

The **row lock** is what makes two concurrent callers safe. Under READ COMMITTED, the second `SELECT … FOR UPDATE` blocks until the first commits. It then re-evaluates the now-committed row, sees `RECORDED`, and returns without writing. `UNIQUE (provider, provider_intent_id)` guarantees there is only one row to lock.

**`SET CONSTRAINTS ALL IMMEDIATE` inside a savepoint.** A payment's "allocations complete" and "no over-allocation" checks are `DEFERRABLE INITIALLY DEFERRED` constraint triggers that normally fire at COMMIT. If one failed at COMMIT, it would take the whole transaction with it, including the `NEEDS_REVIEW` update we want to keep. Switching to `IMMEDIATE` makes PostgreSQL run every pending deferred check *during that statement*, so a failure surfaces inside the savepoint. Rolling back to the savepoint then discards only the attempted receipt.

### When the money can't be applied

The customer paid, but between pricing and settlement the invoice was paid by cheque, or voided, or the period closed, or today's FX rate is missing. Refusing is not an option, because Stripe already holds the money. Recording the payment against something else would be guessing. So the row goes to **`NEEDS_REVIEW`** with the error text, and the Payments page shows it: the customer was charged, the reference is `pi_…`, and someone must record it by hand or refund it in Stripe. The FSM (`ONLINE_PAYMENT_TRANSITIONS`) makes `RECORDED` and `NEEDS_REVIEW` terminal, so a later webhook retry can never move it again.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Browser sends the amount | Simple. But the customer controls the number that settles your invoices | **Rejected.** The server prices the invoice ids it is given |
| Stripe Checkout (hosted redirect page) | Least code, smallest PCI surface. But it leaves our page, and the user asked for the card form on the right-hand side of the statement | Rejected for UX; a reasonable fallback |
| Payment Element (iframe on our page) | Card stays in Stripe's iframe; we own the layout | **Chosen** |
| Stripe Node SDK on the server | Typed, handles retries. But a dependency for three calls (create, retrieve, verify) | **Rejected**: `fetch` + `node:crypto`, matching how Brevo, Gemini and Drive are called (guardrails rule 14) |
| Record the payment from the browser's "succeeded" alone | No webhook setup needed. But the browser can be closed, or lie | **Rejected**: both callers converge on one server-side re-read |
| Webhook only | One code path. But the customer waits on Stripe's delivery latency and our webhook reachability (none in local dev without `stripe listen`) | **Rejected**: both, made idempotent |
| Stripe Connect (each org its own Stripe account) | Real multi-merchant payouts. But onboarding, KYC, application fees | **Not built.** One platform account; the merchant name is the org name |

## Where it lives in this codebase

- `server/src/services/payments/stripeClient.ts` — `createPaymentIntent` (form-encoded, `Idempotency-Key`, pinned version), `retrievePaymentIntent`, `verifyWebhook`; `fetch` and config injectable through `StripeDeps`
- `server/src/services/accounting/onlinePaymentService.ts` — `startPayment`, `settleIntent`, `confirmFromLink`, `handleWebhook`, `paymentOptionsFor`, settings
- `server/src/db/migrations/086_ledger-core_online_payments.sql`:
  - `online_payments`: `UNIQUE (provider, provider_intent_id)` and `CHECK ((status = 'RECORDED') = (payment_id IS NOT NULL))`
  - `online_payment_invoices`
  - `ledger_online_payment_settings`
- `server/src/types/accounting.ts` — `ONLINE_PAYMENT_TRANSITIONS`
- `client/src/Pages/public/StripePayPanel.tsx` — two steps ("Continue to payment" prices the selection, then `PaymentElement` and `confirmPayment`); handles the 3-D Secure redirect return (`?payment_intent=`)
- `server/src/__tests__/accounting/onlinePayments.test.ts` — the race (`Promise.all` of webhook + confirm + settle → one payment), NEEDS_REVIEW, amount mismatch, decline, signature failures

## Gotchas

- **Calling the gateway inside the database transaction.** Holding invoice row locks across a network round-trip turns a Stripe slowdown into your own lock contention. Commit first, call Stripe second, and record failures as a state (`FAILED`).
- **No idempotency key on create.** A retried POST after a timeout makes a second intent, so the customer can end up charged twice.
- **Trusting the webhook body or the browser.** Both only *trigger* settlement. Re-read the intent.
- **A deferred constraint failing at COMMIT.** It rolls back your error-handling writes too. Force the checks inside a savepoint.
- **Zero-decimal currencies.** Stripe's `amount` is in the currency's minor unit: ¥500 is `500`, not `50000`. With no minor-unit table, `NON_TWO_DECIMAL` currencies (JPY, KRW, BHD, …) are refused rather than mis-charged by 100×.
- **Card authentication by redirect.** With `redirect: 'if_required'` most cards resolve in place, but some return through `return_url`. The page must settle from `?payment_intent=` on load, or the receipt waits for the webhook.

## Interview Q&A

**Q: Walk me through taking a card payment for some invoices without your server ever seeing the card.**
A: The browser sends only the invoice ids. The server locks those invoices, computes what is outstanding, commits a pending payment row, and then creates a Stripe PaymentIntent for that exact amount, using the row's id as the idempotency key. It returns only the intent's client secret. The card is entered in Stripe's Payment Element, which is an iframe on Stripe's origin, so our JavaScript never touches the number, and `confirmPayment` charges it. On success the browser asks the server to settle. Stripe's webhook asks the same thing independently. Settlement re-reads the intent from Stripe and records one ordinary receipt journal.

**Q: The webhook and the browser both report success at the same moment. How do you not record the payment twice?**
A: Both go through one function that takes a `SELECT … FOR UPDATE` on the payment row, found by its unique intent id. The first caller records the receipt and flips the status to RECORDED in the same transaction. The second blocks on the lock, then re-evaluates the committed row, sees RECORDED, and returns. Uniqueness gives a single row to lock, and the lock gives single execution. I tested exactly this with `Promise.all` of the webhook, the confirm and a direct settle, and asserted one payment.

**Q: The card was charged but the invoice was paid by cheque in the meantime. What happens?**
A: Recording the receipt would over-allocate the invoice, which a deferred constraint trigger rejects. I run that check early, inside a savepoint, using `SET CONSTRAINTS ALL IMMEDIATE`. Rolling back to the savepoint undoes just the attempted receipt, and the row moves to NEEDS_REVIEW with the reason. The money is real and already at Stripe, so the system must not hide it or guess where it goes. It surfaces on the Payments page with the Stripe reference, for a person to apply or refund.

**Q: Why an idempotency key if you already have the row lock?**
A: They protect different boundaries. The lock protects our database from our own concurrent callers. The idempotency key protects Stripe from our retries. If the create request times out after Stripe has processed it, a naive retry makes a second intent. With the same key, Stripe returns the first one.

**Q: When would you choose Stripe Checkout instead?**
A: When the payment page doesn't need to live inside your own UI. Checkout is a hosted redirect: less code, Stripe handles every payment method and its localisation, and the PCI surface is minimal. We needed the card form beside the invoice list on our own page, so we used the Payment Element. I'd still keep the server-side pricing and idempotent settlement either way.

**Q: Tell me about a time a first design was wrong here.**
A: My first `settleIntent` called Stripe before checking our own table. A test that sent a webhook for an intent that wasn't ours failed with a 502, because the fake Stripe answered "no such intent". It would have done the same for every event belonging to another integration on the same Stripe account. Moving an indexed "is this ours, and still pending?" read ahead of the network call fixed it, and it also saves a round trip on every duplicate event.

## Follow-ups they'll dig into

- "What if the webhook never arrives and the customer closed the tab?" (Today the row stays PENDING. The fix is a periodic sweep that re-reads PENDING intents older than N minutes. It's the same `settleIntent`, so it's safe to add.)
- "Refunds?" (Not built. A refund would be a new FSM state on the online payment and a reversing receipt, voiding the payment through `paymentService`, never an edit.)
- "How do you reconcile Stripe payouts to the bank?" (Card receipts land in a clearing asset account. A Stripe payout arrives on the bank statement as one line and is matched as a transfer from clearing to bank, with fees as an expense. This is standard clearing-account practice, not yet automated here.)
- "Multiple merchants?" (Stripe Connect: each org onboards its own account, and intents are created `on_behalf_of` it. That changes the KYC and liability story, and is why it was out of scope.)

## See also

- [../security-auth/webhook-signing-and-ssrf.md](../security-auth/webhook-signing-and-ssrf.md) — verifying Stripe's signature over the raw body
- [../postgresql/deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md) — the triggers `SET CONSTRAINTS ALL IMMEDIATE` runs early
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `FOR UPDATE` under READ COMMITTED and savepoints
- [transactional-outbox.md](transactional-outbox.md) — the same "commit first, call out second" discipline for email
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — one transition table per status column (rule 10)

# Fixed-width bank files and payment fraud controls

> Producing a file a bank will accept, and stopping the feature from becoming the easiest way to steal money.

**Category:** Architecture · Security
**Introduced by:** Phase 49g, ABA pay runs
**Verified against:** Node 22 `node:crypto`. The ABA layout was written from memory of the published format and **has not been uploaded to a real bank**.

---

## Mechanism

**A fixed-width format has no delimiters.** A field's meaning is its position. Every ABA record is exactly 120 characters:

| Record | Holds |
|---|---|
| `0` descriptive | Bank code, user name, six-digit APCA user ID, description, DDMMYY date |
| `1` detail | BSB, account (right-justified), transaction code, amount in cents (zero-padded), name, reference, trace account, remitter |
| `7` total | `999-999`, net, credit and debit totals, record count |

**One wrong width corrupts everything after it, and silently.** A name one character too long shifts the amount field, so the bytes still parse as a different amount, or get rejected wholesale. So every field goes through `left()`, `right()` or `zeros()`, which truncate or pad to exact width, and `record()` throws if a line isn't exactly 120 characters.

**Character set.** The format allows a small set, so input is upper-cased and anything else becomes a space. "Café" must not put a multi-byte character into a fixed-width field.

**Encryption with a masked read model.** An account number is written twice: AES-256-GCM ciphertext for the file, and the last three digits in plain for screens. Reads never decrypt. Only the file builder does, so most code can't leak the number because it never has it. The audit trigger copies the row, and it only ever sees ciphertext.

**Recording versus moving money.** Creating a pay run records payments in the ledger. The file moves nothing. The user uploads it to their bank, under the bank's own approval controls. The two can disagree, so the UI says so, and a voided payment drops out of a re-download because the file is built on request rather than stored.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Build the file on request | Always reflects voids, and no plaintext file sits on disk. Costs a decrypt per download | **Chosen** |
| Store the generated file | A stable artefact, but it's a file of everyone's bank details, and it goes stale after a void | Rejected |
| Mask in the API layer only | Simple, but every internal reader holds the full number | Rejected: masked at the storage model |
| Direct bank API | Better experience, but per-bank contracts and far more liability | Not now |
| A permission per action | Finer control, but changing where money goes and sending it are the same risk | One senior permission |

## Where it lives in this codebase

- `server/src/utils/abaFile.ts`: the format, pure
- `server/src/utils/secretBox.ts`: AES-256-GCM
- `server/src/services/accounting/payRunService.ts`: details, batches, file building
- `client/src/Pages/banking/PayRunPage.tsx`: the warnings

## Gotchas

- **A golden-file test proves stability, not correctness.** We assert exact bytes against a string written by hand from the format, which catches any width regression. It can't prove a bank agrees. Only a real upload can.
- **Supplier-bank-change fraud is the main threat.** Someone emails "we've changed banks", a clerk updates the record, and the next run pays a thief. Hence a senior permission, a history event per change, and a warning on any run within 7 days of a change, telling the user to confirm by phone using a number they already have.
- **All or nothing.** Half a pay run is worse than none, because the file and the ledger would disagree. One transaction holds every payment.
- **Rule 2 of secrets:** never put them in a log or an error. Validation messages here describe the format and never echo the number.

## Interview Q&A

**Q: How do you test a file format you can't validate against the real consumer?**
Three layers. A golden-file test on exact bytes catches regressions. Invariant tests check that every record has the right width and the totals match. Then an integration test checks the file against the ledger. All of that proves internal consistency, and I'd say plainly that it doesn't prove the bank accepts it. That takes a real test upload, and I'd track it as an open item rather than claim it works.

**Q: How would you store bank account numbers?**
Encrypted at rest with authenticated encryption, with the key outside the database. Keep a separate masked value for display, so screens never need to decrypt. Restrict decryption to the one code path that needs it. Never log it, and check the audit trail only captures ciphertext. A test asserts the plaintext isn't in the API response or audit rows.

**Q: Why not encrypt with a per-tenant key?**
It limits the blast radius of a leaked key, but adds key management and rotation per tenant. Here one key from the environment was proportionate to the data and the stage. For a production financial product I'd move to a KMS with envelope encryption, and I'd name that as known debt.

**Q: What's the risk in letting users edit a supplier's bank details?**
It's the most common payment fraud: the invoice is real, the account isn't. Technical controls can't verify the account belongs to the supplier, so the aim is to make a change visible and slow. Restrict who can do it, record it, and warn at the moment of payment. Dual approval would be the next step.

## Follow-ups

- "What if the upload fails halfway at the bank?" The bank treats a file as a unit and reports errors. The user voids what didn't go through, which then drops from any re-download.
- "Why is the description limited to 12 characters?" That's the field's width in the descriptive record.

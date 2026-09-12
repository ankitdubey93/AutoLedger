# The sandbox dataset

A 24-month B2B services business, used to demonstrate all seven AutoLedger apps. Load it with:

```bash
cd server && npm run seed:demo        # or the "Load sample data" card in the app
```

## Two rules govern every file here

**Dates are relative.** Every dated row carries a `monthOffset` (`-23`…`0`) and usually a `day` (`1`–`28`), resolved against an anchor month at load time. No absolute date appears in any fixture. An absolute-dated fixture rots: within a few months it drifts out of the cohort display window and out of the fiscal year, and it makes tests non-deterministic. Day is capped at 28 so no month is ever invalid.

**Money is a decimal string** — `"1450.00"`, never `1450.00` and never `145000`. It is parsed through `utils/money.ts`'s `parseMoneyText` at load, so no IEEE-754 double ever touches a cents value. Guardrail rule 3 applies at a file boundary exactly as it does at the HTTP boundary.

The one exception is an **FX rate**, which is not money: it is `NUMERIC(18,8)`, stays a string end to end, and must not be run through `parseMoneyText`.

## Nothing here bypasses the application

The seeder replays these fixtures through the same services the UI calls — `invoiceService.createInvoice`, `issueInvoice`, `billService.approveBill`, `paymentService.createPayment`, and so on. There are no raw `INSERT`s. That matters because the double-entry balance trigger, the posted-row immutability triggers, the status FSMs and the CDC audit trail *are* the product; data that bypassed them would prove nothing and would leave a ledger that `npm run verify:integrity` could not vouch for.

Consequently a seeded invoice is indistinguishable from a hand-entered one, and **posted rows are immutable once seeded**. Removing seeded financial records means deleting the organization, not unpicking the ledger.

## What each dataset demonstrates

| File | Demonstrates |
|---|---|
| `ledger-core/accounts.json` | Two extra revenue accounts on top of the 45-account default chart. PVM's product dimension *is* the revenue account, so two postable revenue accounts would give a two-line decomposition that proves very little; four is worth looking at. |
| `ledger-core/customers.json` | Twelve customers acquired across the window with real churn, driving the cohort matrix, LTV/CAC and PVM. Two bill in EUR/GBP. |
| `ledger-core/vendors.json` | Six vendors on a monthly bill schedule across cost-of-sales and opex, driving the P&L, AP aging and budget variance. |
| `ledger-core/fx-rates.json` | EUR→USD and GBP→USD for all 24 months, so realized gain/loss on settlement and period-end unrealized revaluation both have moving rates to work against. |
| `ledger-core/bank-import.json` | A matching *policy*, not a committed CSV — see below. |
| `ap-flow/documents.json` | Three supplier invoices: one posted to the GL, one waiting in the review queue with an unmapped line, one whose arithmetic does not reconcile. |
| `forecaster/plan.json` | A driver-based plan, headcount roles, and a zero-based budget approved and frozen. |
| `fpa-engine/model.json` | A linked 3-statement model with a Base and a Downside scenario, so comparison and cash runway have two curves. |
| `unitecon/settings.json` | Gross margin, the acquisition-cost account set, and four product lines. |
| `taxguard/sample-act.json` | A synthetic act written to match the parser's heading form. |

## Design notes worth knowing before you edit anything

**Cohorts.** `utils/uniteconCohort.ts` assigns a customer to the month of their earliest positive-revenue fact searched over *all* history, and a customer whose first such month precedes the display window is dropped entirely into `excludedPriorCustomers` rather than reassigned to a later cohort. So acquisitions are spread across offsets `-23`…`-2` rather than bunched at the start. Each customer's `monthly` array tapers and then ends — the array ending *is* the customer churning. Flatten those arrays and the retention matrix reads 100% everywhere.

**Foreign currency.** `pvmService` excludes non-base-currency `ISSUED` invoices and reports the count in `excludedForeignCurrencyInvoices`. Delta Labs (EUR) and Harborview (GBP) exist so the FX engine demos *and* so that honesty valve shows a non-zero number — surfacing what was left out is the behaviour being shown, not a defect.

**Bank reconciliation is a policy, not a CSV.** Bank lines must match payments whose amounts are computed from the customer and vendor schedules at load time, so a CSV with hard-coded amounts could never score against them — every line would fall into the unmatched pile and the 40/30/30 matcher would look broken rather than working. `bank-import.json` instead describes how to build the statement: mirror a fraction of real payments exactly, degrade the date and description on the rest, and add bank fees and interest that should never match anything. The seeder generates the CSV from the payments it actually created and feeds it to `importStatement`, so the real matching engine runs and produces real scores. `AUTO_MATCH_THRESHOLD` is 85; both outcomes have to exist or the approval queue is either empty or entirely full.

**Period close ordering.** Migration 016 refuses any posting into a `CLOSED` or `LOCKED` fiscal period, and a date covered by *no* period is open. So the seeder posts all 24 months of history first and generates and closes periods last. One month is left open holding a DRAFT invoice and an unmatched bank line, so a BoardDeck close run against it comes back `BLOCKED` while an earlier clean month comes back `READY`.

**The two AI-dependent apps seed without an API key.** AP-Flow does not re-run the capture pipeline; the seeder calls `savePipelineResult` with the canned extractions, which lands a genuinely `EXTRACTED` document with no key and no worker. TaxGuard's corpus row is created and left `PENDING`: embedding needs a provider, and a `READY` row with no chunks is rejected by `chk_taxguard_corpus_ready` anyway. Neither app fakes a state it has not reached.

**Audit volume.** Registering an organization already writes ~46 audit rows from the default chart seed alone, and a 20-line journal entry writes 21. A full load writes tens of thousands of `audit_logs` rows. That is accepted at portfolio scale; `audit_logs` retention and partitioning are deliberately not built.

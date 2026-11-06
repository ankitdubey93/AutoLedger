# The Australian edition (Phase 49)

An organization with `organizations.region = 'AU'` gets GST, BAS and Australian formats. A `GENERIC` organization behaves as if none of this existed. Region is one column selecting a jurisdiction pack, not a module: there is one engine, and the pack in `server/src/config/taxPacks/au.ts` contributes the rules.

> **AutoLedger prepares a BAS; it does not lodge one, and it is not tax advice.** The user enters the figures in ATO Online or passes them to their agent. A registered BAS agent or tax accountant should review the code mapping before real use.

## Build status

| Slice | Scope | State |
|---|---|---|
| 49a | Region, GST settings, Australian chart, organization calendar, DD/MM/YYYY | ✅ |
| 49b | GST codes and tax-inclusive pricing | ✅ |
| 49c | GST on bank lines and journals | ✅ |
| 49d | BAS engine and workflow | ✅ |
| 49e | Tax invoices | ✅ |
| 49f | ABN tools and capture | ✅ |
| 49g | Bank details, ABA files, bank CSV presets | ✅ |
| 49h | TPAR | ✅ |
| 49i | Australian demo and walkthrough | ✅ |

## Becoming Australian

Two paths, one function (`regionService.activateAustraliaOnClient`):

- **The setup wizard's country step.** Australia presets AUD, a 1 July year start, a zone and GST settings. It runs in the onboarding transaction.
- **Settings → Country & GST**, for an organization that already exists.

| Rule | Why |
|---|---|
| Base currency must be AUD. An organization with postings in another currency gets `409` and cannot switch; one with no postings is moved to AUD | A BAS is reported in Australian dollars, and base currency is immutable once ledger lines exist |
| The chart change is additive and idempotent: accounts `1185`, `2150`, `2162`, `2164` are added, and four default names change only if still the default | Existing codes are load-bearing for reports and system roles, so this also works for an organization that has posted |
| The financial year is not changed for an existing organization | Closed periods may already depend on it. The wizard presets July for a new one |
| Leaving keeps the added accounts and renames | They may carry postings |

## GST settings

`gst_settings` has a row only for an AU organization.

| Field | Values | Rule behind it |
|---|---|---|
| `registered` | boolean | Registration is required at $75,000 GST turnover, or $150,000 for a non-profit |
| `basis` | `CASH`, `ACCRUAL` | Cash is available under $10 million aggregated turnover, or when income tax is accounted for on a cash basis |
| `bas_cycle` | `QUARTERLY`, `MONTHLY` | Monthly is required at $20 million GST turnover or more, or when the ATO directs it |
| `bas_method` | `SIMPLER`, `FULL` | Simpler BAS (G1, 1A, 1B) applies under $10 million GST turnover. Full adds G2, G3, G10, G11 |
| `time_zone` | One of seven `Australia/*` zones | See below |

The organization declares these. AutoLedger does not test turnover against the thresholds.

## "Today" for an Australian organization

At 9am in Sydney the UTC date is still yesterday, and on the first day of a quarter that is the wrong BAS period. So for an AU organization:

- The server's `regionToday` / `regionTodayOnClient` use `gst_settings.time_zone`. It covers default report ranges, aging, statements, the dashboard, online payment dates, and inventory's "not in the future" check, which would otherwise refuse today's date on an Australian morning.
- The client's `orgToday()` and `orgNow()` (`utils/date.ts`) do the same, and `formatDate` shows DD/MM/YYYY whatever the browser's locale.

A `GENERIC` organization keeps UTC exactly as before, even if it set a timezone for quotes.

**Known limits, deliberately left on UTC:**

- A document's displayed paid/overdue status, and the "overdue" list filter, can lag by up to 11 hours.
- Background sweeps (recurring runs, quote expiry, invoice reminders) decide what is due on the UTC date. Documents they create carry their scheduled date, so nothing lands in the wrong period.
- Inventory's lot-expiry window on the dashboard uses the database's `CURRENT_DATE`.

## GST codes

A closed catalogue in `config/taxPacks/au.ts`, served by `GET /tax-codes`, with the same list in a database CHECK (migration `107`). Not org-editable, because a BAS mapping edited by mistake would misstate a return.

| Code | Meaning | Rate | Worksheet |
|---|---|---|---|
| `S_GST` | GST on sales | 10% | G1 |
| `S_EXPORT` | GST-free exports | 0 | G1, G2 |
| `S_FREE` | GST-free sales | 0 | G1, G3 |
| `S_INPUT_TAXED` | Input-taxed sales | 0 | G1, G4 |
| `S_EXCLUDED` | BAS excluded | 0 | None |
| `P_GST` | GST on purchases | 10% | G11 |
| `P_CAP_GST` | GST on capital purchases | 10% | G10 |
| `P_FREE` | GST-free purchases | 0 | G11, G14 |
| `P_CAP_FREE` | GST-free capital purchases | 0 | G10, G14 |
| `P_INPUT_TAXED` | Purchases for input-taxed sales, no credit | 0 | G11, G13 |
| `P_PRIVATE` | Private or non-deductible, no credit | 0 | G11, G15 |
| `P_EXCLUDED` | BAS excluded | 0 | None |

`taxCodeService.prepareTaxOnClient` is the one place a line's GST is decided, before totals:

- **Which code:** what was sent, else the item's default, else the account's, else the region's. An unregistered organization only gets BAS-excluded codes.
- **Which rate:** always the code's. A rate the client sends is ignored, so a line can't be "GST-free" at 10%.
- **Snapshot:** the line stores `tax_code` and `tax_rate_bp`, so a later catalogue change can't alter history.
- **Posting:** issue and approve refuse an uncoded line, which can only be a draft from before the organization became Australian.
- **Deposits:** exempt. They are a 0% liability movement, because GST on advances is not built.

### Tax-inclusive pricing

`tax_mode` on the document header: `EXCLUSIVE` or `INCLUSIVE`. Inclusive tax is `gross × rate ÷ (10000 + rate)`, which at 10% is divide-by-11, and net is the remainder, so net + tax always equals what is paid. `unit_price_cents` stores the price as typed. A shared fixture (`lineTaxCases.json`) holds the client preview and the server to the same arithmetic.

The mode travels with the document through quote revision, quote and order conversion, recurring runs and credit or debit notes. Without that, a gross price would silently become a net one on the next document.

**Known limits:** a line left on "Default" previews the region's rate, while the server may apply an item or account default, and the saved document is what counts. A CSV import has no tax-inclusive option, and its preview shows the region's rate for a line with no code.

## GST on bank lines and journals

Money that moves without a document still carries GST. A bank line, bank rule or manual journal line with a code treats its amount as **GST-inclusive**, posts the net to the chosen account and the GST to the GST account, and writes a row to the insert-only `journal_tax_details` (migration `108`).

| Path | No code given |
|---|---|
| Bank line, bank rule | The account's default on its normal side, else no GST. A refund is always a deliberate choice |
| Manual journal line | No GST. An account default is ignored, because most manual journals are accruals and adjustments |

`sign` is +1 on the code's normal side (a sale credited, a purchase debited) and -1 for a refund the other way, such as money back from a supplier. A reversal gets no detail row of its own: the BAS will read `journal_entries.reverses_entry_id` and produce the opposite event on the reversal's date.

## The BAS

`gstEventService.loadGstEvents` is the one stream of signed GST events, for documents and journals. `utils/basWorksheet.ts` turns events into labels, purely. `basService` owns the return.

### The worksheet

| Label | Holds |
|---|---|
| G1 | Sales including GST, every reported sales code |
| G2, G3, G4 | Exports, other GST-free, input-taxed |
| G5, G6, G8, G9 | G2+G3+G4; G1−G5; G6+G7; G8÷11 |
| G7, G18 | Notes against an earlier period, plus manual adjustments |
| G10, G11 | Capital and non-capital purchases including GST |
| G13, G14, G15 | Input-taxed related; no GST in the price; private or non-deductible |
| G12, G16, G17, G19, G20 | G10+G11; G13+G14+G15; G12−G16; G17+G18; G19÷11 |
| 1A, 1B | The actual GST on the events plus adjustments |

**1A and 1B come from actual tax, not from G9 and G20.** That is the ATO's accounts method and the one that ties to the GL. G9 and G20 stay as a cross-check, with a warning when they differ by more than $1.

Simpler BAS reports G1, 1A, 1B. Full adds G2, G3, G10, G11. The whole worksheet is always computed and exported as a record. Reported amounts are whole dollars with cents dropped; **the rounding direction must be confirmed against the ATO.**

### Attribution

- **Accruals:** the document's posting date, with `entryDate` allowing a late bill to post into an open period. Voids are opposite-signed events on the void's date.
- **Cash:** `line × settled(to) ÷ total − line × settled(before) ÷ total`. Being cumulative, a fully paid document always sums to exactly its tax, and a voided payment comes out negative with no special case. A note counts by its applied amount, so an invoice cleared by a note nets to nil.
- **Journals:** when posted, on either basis. A reversal mirrors its original on its own date.

**A note against an earlier period** goes to G7 or G18 on accruals, keeping its tax in 1A or 1B, rather than reducing this period's G1. On a cash basis it reduces G1. **Confirm both treatments with a BAS agent.**

### Lifecycle

| State | What happens |
|---|---|
| `DRAFT` | Computes live. Holds W1, W2, T7 and manual adjustments. Basis, method and cycle were frozen at creation |
| `FINALISED` | Labels and events are stored, never recomputed. The months covered close, and a note allocation dated inside is refused, since it posts no journal for the period trigger to catch. Reopening discards the snapshot and reopens the months |
| `LODGED` | Immutable by service and by database trigger. Correct errors on a later return |

**Recording lodgment posts one journal** (`source_type 'bas_return'`), dated when lodged since the period itself is closed: DR GST collected, CR GST paid, DR 2162 for W2, DR 1185 for the instalment, CR 2150 ATO Clearing for the whole-dollar net, with the cents to `6830 Rounding`. Paying the ATO is then a bank line to 2150. On a cash basis 2140 and 1180 keep the GST on unpaid documents, which belongs to a later return.

**A manual adjustment names the account for the other side of its GST**, so the GST accounts stay reconciled. A reason is required.

**Reconciliation:** GL movement on the GST account (excluding clearing journals) = reported + GST on unpaid documents as it moved over the period. What's left is shown, and is normally a journal posted straight to a GST account.

### Known limits

- W2 clears account 2162, so payroll journals must credit that account, not 2160.
- Finalising closes months before computing, on one transaction, so a posting that starts afterwards is refused. A posting already in flight when the close commits can still land: the same small race the fiscal-period close has always had.
- A financial year not starting on the 1st of a month can't finalise, because a fiscal period would straddle the BAS.
- Warnings, not calculations: GST on deposits, and lines from before the organization became Australian.
- Due dates are the standard ones. Agent programs and online-lodgment extensions are not calculated.

## Tax invoices

**The seller is frozen at issue.** `invoices` and `credit_notes` gain `seller_abn`, `seller_legal_name` and `seller_gst_registered` (migration `110`), written in the same transaction that issues the document. Read live, a later ABN change would rewrite every invoice already sent. The existing immutability trigger then protects them. The ABN is `organizations.tax_number`, shown as "ABN" for an AU organization.

| Registered | Invoice title | Credit note title | Shows |
|---|---|---|---|
| Yes | Tax Invoice | Adjustment Note | ABN, GST row, "Total includes GST of $X", and for a note the reason and original invoice |
| No | Invoice | Credit Note | ABN if known, no GST row |

An unregistered seller's document must never say Tax Invoice, because it would mislead the buyer into claiming a credit. For an AU organization this overrides the template's `documentTitle`.

Lines with a price that includes GST show the amount the buyer pays. Dates are DD/MM/YYYY. The buyer's name always appears, which covers the identity requirement at $1,000 or more; their ABN shows when known.

Quote PDFs stay titled as quotes, since a quote is not a tax invoice, and gain the ABN, the GST label and AU dates. The public invoice page follows suit. A `GENERIC` organization's PDF is byte-for-byte what it was, which a test holds.

**A missing ABN is a warning on the draft, not a refusal.** Blocking issue would stop a business invoicing over a settings field; **confirm whether that is the right call.**

**Exact tax invoice and adjustment note wording must be checked against the ATO.**

## ABN tools

`utils/abn.ts` runs the ABR's mod-89 check, verified against the ABR's worked example. A checksum proves a number is well formed, not that anyone holds it.

| Where | Rule |
|---|---|
| The organization | Must be a valid ABN, since its tax invoices print it |
| Customers and vendors | Eleven digits must be valid, and are stored as `51 824 753 556`. Anything else is a foreign tax number and stays free text |
| A bill for a vendor with no ABN | A warning that tax may have to be withheld. Nothing is calculated |

**ABN Lookup** (`GET /abn/:abn`) is optional and off unless `ABR_GUID` is set. It is tested against a fake and **has never called the real service**. Without a GUID the forms link to the public register.

CSV imports of customers and vendors do not run this check.

## The bill inbox

**A captured bill is approved the moment it posts, so nothing may guess at its GST.** `utils/capturedGst.ts` decides, in order:

1. What a reviewer chose per line.
2. GST the receipt printed per line, if it adds up to the document's GST.
3. No GST on the receipt: every line `P_FREE`.
4. GST that only fits every line being taxable, within rounding: every line `P_GST`.
5. Otherwise the receipt is mixed and is **refused with a reason**, by hand and by auto-post, until a person chooses codes on the review screen.

An unregistered business claims nothing, so the GST becomes part of the cost. A receipt whose lines already include GST is recognised when they sum to the total. It is not recognised when a printed subtotal contradicts them, because the arithmetic check runs without knowing the region.

**Vendors match by ABN before name**, only when the ABN read from the page passes the checksum, and a new vendor keeps it. **An ABN is not masked** before an image goes to the model, since the model has to read it. **A tax file number is masked**, but only when labelled, because about 1 in 11 random nine-digit numbers pass its checksum and masking those would black out invoice numbers.

The extraction prompt asks every organization's documents for a supplier number and per-line tax. The fields are optional and ignored for a `GENERIC` organization.

## Pay runs and ABA files

**Banking → Pay run** selects approved expenses and creates one payment per vendor through the ordinary payment path, all or nothing on one transaction (migration `112`). Then it produces an ABA file. **No money moves until the user uploads that file to their bank**, and a pay run they abandon needs its payments voided. A voided payment drops out of a re-download, since the file is built on request.

`utils/abaFile.ts` writes records of exactly 120 characters, CRLF-ended: descriptive (0), detail (1, code `50`), and total (7). An optional balancing debit (code `13`) is set per bank account, because banks differ. Characters outside the format's set are stripped rather than breaking the fixed width.

**The layout comes from the published format as recalled during the build, and has not been uploaded to a real bank. Do a test upload before relying on it.**

| Bank details | |
|---|---|
| Account numbers | Encrypted with `utils/secretBox.ts`, returned only as the last three digits, and absent from audit rows as plaintext. Saving needs `INTEGRATION_ENCRYPTION_KEY`, otherwise `503` |
| Permission | `payments.export_aba` covers changing bank details and producing files, deliberately senior |
| Fraud controls | Each change to a supplier's details writes a history event. A pay run warns about any changed in the last 7 days, and tells the user to confirm by phone |
| Currency | AUD only |

**Bank statement presets** for CBA, ANZ, Westpac and NAB fill the column mapping and date format on the import screen, and add a header row for a bank whose export has none. **Written from memory of published examples, not real exports.** Banks change these, so the mapping stays visible and editable.

## TPAR

**BAS → TPAR** reports amounts paid in a financial year to vendors flagged `tpar_reportable` (migration `113`). It is always on a cash basis, whatever the GST basis, because the report is of payments made. It reads the same event stream as the BAS, so a part-paid bill counts for what was paid and a debit note reduces it. Recording it as lodged is refused while a contractor lacks a valid ABN or an address, and stores the rows as they stood. It is due 28 August.

**Known limits, to confirm with an agent:**

- Flagging is per vendor, so a materials-only bill from a flagged contractor counts. The page says to check these.
- Payment through a bank-line journal, with no bill, has no vendor, so it isn't counted.
- The TPAR e-lodgment file is not built. The figures are entered through ATO Online.
- Lines coded `P_EXCLUDED` are not counted.

## Demo and walkthrough

`npm run seed:demo -- --region au` builds Wattle & Ash Bakehouse through the API: two quarters, every GST code that matters, an inclusive invoice, credit and debit notes against earlier periods, bank-line GST, a bank rule, a pay run, PAYG, TPAR, one lodged BAS and one draft. [walkthrough/australia/README.md](../walkthrough/australia/README.md) has the transactions, the answers worked by hand on both bases, and things to try. `auDemo.test.ts` proves the product reaches those figures through its API, and that the GST accounts clear to zero after lodging.

The bill inbox isn't replayed, because capture needs a real vision model; `gstCapture.test.ts` covers it. The USD walkthrough is untouched.

## Not built in this edition

Direct SBR lodgment and Digital Service Provider registration, payroll, Single Touch Payroll and super, annual GST returns and GST instalments, FBT, fuel tax credits, wine and luxury car tax labels, GST on advances, partial-use apportionment, bad-debt write-off, BAS revision after lodgment, the TPAR e-lodgment file, and Australian data hosting.

## Sources

The ATO's pages refused automated fetching during the build, so the figures above come from ATO search summaries and must be checked against the live pages before real use.

- [GST reporting methods](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/goods-and-services-tax-gst/gst-reporting-methods)
- [Choosing an accounting method](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method)
- [Registering for GST](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst)
- [Quarterly GST reporting](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/quarterly-gst-reporting)

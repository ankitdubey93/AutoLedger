# The Australian edition (Phase 49)

An organization with `organizations.region = 'AU'` gets GST, BAS and Australian formats. A `GENERIC` organization behaves as if none of this existed. Region is one column selecting a jurisdiction pack, not a module: there is one engine, and the pack in `server/src/config/taxPacks/au.ts` contributes the rules.

> **AutoLedger prepares a BAS; it does not lodge one, and it is not tax advice.** The user enters the figures in ATO Online or passes them to their agent. A registered BAS agent or tax accountant should review the code mapping before real use.

## Build status

| Slice | Scope | State |
|---|---|---|
| 49a | Region, GST settings, Australian chart, organization calendar, DD/MM/YYYY | ✅ |
| 49b | GST codes and tax-inclusive pricing | ✅ |
| 49c | GST on bank lines and journals | Not built |
| 49d | BAS engine and workflow | Not built |
| 49e | Tax invoices | Not built |
| 49f | ABN tools and capture | Not built |
| 49g | Bank details, ABA files, bank CSV presets | Not built |
| 49h | TPAR | Not built |
| 49i | Australian demo and walkthrough | Not built |

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

## Not built in this edition

Direct SBR lodgment and Digital Service Provider registration, payroll, Single Touch Payroll and super, annual GST returns and GST instalments, FBT, fuel tax credits, wine and luxury car tax labels, GST on advances, partial-use apportionment, bad-debt write-off, BAS revision after lodgment, the TPAR e-lodgment file, and Australian data hosting.

## Sources

The ATO's pages refused automated fetching during the build, so the figures above come from ATO search summaries and must be checked against the live pages before real use.

- [GST reporting methods](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/goods-and-services-tax-gst/gst-reporting-methods)
- [Choosing an accounting method](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method)
- [Registering for GST](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst)
- [Quarterly GST reporting](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/lodging-your-bas-or-annual-gst-return/options-for-reporting-and-paying-gst/quarterly-gst-reporting)

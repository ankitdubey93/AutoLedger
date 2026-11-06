# Jurisdiction packs and the organization's calendar

> One engine with country rules as data, selected per tenant, and why "today" is a per-tenant question rather than a clock reading.

**Category:** Architecture
**Introduced by:** Phase 49a, the Australian edition's foundation
**Verified against:** Node 22 `Intl.DateTimeFormat`, PostgreSQL 16, React 19. Exact zone offsets below are for June 2026.

---

## Mechanism

**A region is one column.** `organizations.region` is `GENERIC` or `AU`. Rules live in `config/taxPacks/au.ts` as data. Code asks "does this tenant have the pack?" at a small number of seams: a route guard, a nav filter, and the services that need a rule.

**Three gates, each doing a different job:**

| Gate | Where | Answers |
|---|---|---|
| `requirePermission` | Route | May this member do it? |
| `requireRegion('AU')` | Route, after the permission | Does this feature exist for this tenant? |
| `item.region` in the nav | Client | Should we show the door? Display only |

The guard reads the database per request instead of trusting the token. An access token lives 15 minutes, so a region stored in it could stay stale after a switch. The same reasoning applies to permissions since Phase 38c.

**A date is not an instant.** An instant is a point on the timeline. A calendar date only exists relative to a zone. `new Date().toISOString().slice(0, 10)` answers "what date is it in UTC?", which is a real question, just not the one a Sydney bookkeeper is asking.

At `2026-06-30T14:30:00Z`:

| Zone | Offset in June | Calendar date | BAS quarter |
|---|---|---|---|
| UTC | +00:00 | 30 June | Apr–Jun |
| Australia/Sydney | +10:00 | 1 July | Jul–Sep |
| Australia/Perth | +08:00 | 30 June (22:30) | Apr–Jun |

So the same instant falls in different tax periods for two Australian businesses. That is why the zone is stored per organization.

**How the zone conversion works.** `Intl.DateTimeFormat(locale, { timeZone }).formatToParts(now)` asks the runtime's bundled IANA database. We pick out `year`, `month` and `day` by part type rather than parsing a formatted string, because locale decides the order. No offset table exists in our code, so daylight-saving changes and rule updates arrive with the runtime.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| A `region` column plus data packs | One codebase, and the second country is not a rewrite. Needs discipline at the seams | **Chosen** |
| Overload `organization_profiles.country_code` | No migration, but a postal address would switch on a tax engine. A New Zealand business with a Sydney office would break | Rejected |
| A per-org feature flag table | Flexible, but tax rules are one bundle. You can't sensibly have BAS without GST codes | Rejected |
| A fork or a separate deployment per country | Total isolation, and every bug fix happens twice | Rejected |
| Change "today" for everyone | Simplest code, but it moves existing organizations' report defaults and breaks "a generic organization is unchanged" | Rejected; gated on region |
| Store `time_zone` only on `ledger_settings` | One place, but that row means "onboarded", and its fiscal columns are `NOT NULL` | Rejected; found by a failing test |

**A chart change that is additive.** Replacing the chart would have required "no postings yet". Adding new codes and renaming only while an account still has its default name is idempotent, keeps a name the customer chose, and keeps working after postings exist.

## Where it lives in this codebase

- `server/src/config/regions.ts`, `server/src/config/taxPacks/au.ts`: the pack as data
- `server/src/services/accounting/regionService.ts`: activation, `regionTodayOnClient`
- `server/src/middleware/region.ts`: `requireRegion`
- `client/src/utils/date.ts`: `configureOrgCalendar`, `orgToday`, `orgNow`, `formatDate`
- `client/src/context/LedgerSettingsContext.tsx`: keeps the module-level calendar current
- `client/src/components/layout/nav.ts`: `visibleNavGroups(can, region)`

## Gotchas

- **Module state set during render.** `formatDate` is called from hundreds of plain functions, so threading a zone through props was not realistic. `LedgerSettingsProvider` sets a module variable during render. That is safe only because the write is idempotent and derived from state, and because it is reset while loading so one organization's calendar can't reach the next.
- **Only UTC sites needed the fix.** Many document forms already used local getters (`getFullYear`), which are correct for someone sitting in Australia. The sweep changed the UTC ones.
- **Check-then-act on currency.** "Is the base currency AUD, or are there no lines?" followed by a write can race a first posting. The check locks the organization row with `FOR NO KEY UPDATE`, which serialises with other changes without conflicting with the `FOR KEY SHARE` that child-table foreign keys take. `FOR UPDATE` would stall all posting.
- **Editing an applied migration.** The runner's checksum guard catches it, even for a test database. A migration that has never left your machine may be corrected, but its row and table must be removed from that database by hand.

## Interview Q&A

**Q: How would you add a second country to a single-country product?**
Separate what is universal from what is local. Double-entry, documents and tenancy are universal. Tax rates, form labels, due dates and invoice wording are local, so they become data selected by a per-tenant region. A second country is then a new pack and a new set of tests rather than a rewrite. The test for whether the seam is right is that an existing tenant's behaviour does not change at all.

**Q: Why not use the customer's address to decide their tax rules?**
Because the two answer different questions. An address says where to send mail. A tax registration is a legal status the business declares. A business can have a foreign address and an Australian registration, and an address edit must never change how its tax is calculated.

**Q: What is wrong with `new Date().toISOString().slice(0, 10)`?**
Nothing, if you want the UTC date. Used as "today" for a user, it is wrong for part of every day anywhere away from UTC. In Sydney it reports yesterday until 10 or 11am. For an accounting product that matters: a default posting date can fall in the previous period, and a "not in the future" check can reject today.

**Q: How do you get a calendar date in a zone without a date library?**
`Intl.DateTimeFormat` with `timeZone`, then `formatToParts`, then pick the year, month and day by type. Don't parse the formatted string, because part order depends on locale. The runtime carries the IANA database, so daylight-saving rules are not your code's problem. Invalid zones throw a `RangeError`, so validate on input.

**Q: Why store a calendar date as a string or `DATE` instead of a timestamp?**
A posting date is a business fact, "the 1st of July", and must not move when viewed from another zone. A timestamp plus a zone conversion can shift it by a day. Parse date-only strings by hand or as explicit UTC, since `new Date('2026-09-03')` is UTC midnight and reads as the day before anywhere west of UTC.

**Q: Why re-read the region from the database per request when it could be in the JWT?**
Tokens are valid until they expire, so a claim in one can't be revoked. A region or permission change would be ignored for up to 15 minutes. The cost is one indexed query, which is cheap against a request that will run several anyway. Identity belongs in the token, while mutable authorization facts belong in the database.

## Phase 49b: tax codes and tax-inclusive arithmetic

**A closed catalogue instead of a table.** Twelve GST codes live in `config/taxPacks/au.ts`, with the same list in a database CHECK. A `tax_codes` table would invite per-tenant editing, and a BAS mapping someone edited by mistake misstates a tax return. The cost is that adding a code takes a migration, which is the review we want for a change in tax law.

**Snapshot, not a foreign key.** A posted line stores `tax_code` and `tax_rate_bp`. If the rate changes, old documents must still show the rate they were issued at, so a live lookup would be wrong.

**The server decides the rate.** The client sends a code and any rate it sends is ignored. Otherwise a crafted request could label a line "GST-free" and charge 10%.

**Dividing by 11.** With a price `g` that includes tax at rate `r`:

```
net = g / (1 + r)
tax = g - net = g * r / (1 + r)
```

In basis points with `r = 1000`, `tax = g * 1000 / 11000 = g / 11`. We compute tax with rounding, then derive net by subtraction, never by rounding both. Rounding each independently can make `net + tax` differ from `g` by a cent. With subtraction it can't, and the database's `total = subtotal + tax` CHECK holds.

Example: $19.99 inclusive gives tax = 1999 / 11 = 181.7, rounded to 182, so net is 1817.

**A mode is a property of the document, and must travel.** `unit_price_cents` stores what was typed, so 11000 means $110 net in one mode and $100 net in the other. Any path that copies lines without the mode silently overcharges by 10%. Quote revision, conversion, recurring runs and notes all carry it, and one test walks the whole chain.

**Q: Why not store all prices net and convert at display?**
Because the printed price would then have to be recomputed, and a rounded net can't always reproduce the gross. $19.99 inclusive is 1817 net, and 1817 × 1.1 is 1998.7, which rounds to $19.99 here but not for every price and quantity. A customer who was quoted $19.99 must be charged exactly that. Storing what was typed, with the mode, keeps the number the customer agreed to.

**Q: How do you keep a calculation identical on client and server without sharing code?**
A shared JSON fixture that both test suites run. The client's preview and the server's arithmetic are separate functions in separate packages, and the fixture fails whichever one drifts. Only the server's result is ever stored, so a drift would be a display bug and not a money bug, but it would still confuse a user.

## Phase 49f: checksums and refusing to guess

**A checksum proves form, not existence.** The ABN check catches a mistyped digit. It says nothing about whether anyone holds that number, which takes a register lookup. So we validate on every write and keep the lookup optional.

**A checksum's strength decides how far to trust it alone.** The ABN's mod-89 check passes about 1 in 89 random numbers, on an 11-digit field that's rarely anything else. A tax file number's mod-11 check passes about 1 in 11 random 9-digit numbers, and invoice numbers are often 9 digits. So masking TFNs by checksum alone would black out invoice numbers, and we require a label as well. The cost is that an unlabelled TFN isn't masked, which is the same honest limit the rest of the masking has.

**Automation should refuse rather than guess when a wrong answer is silent.** A captured bill posts immediately. Spreading GST across every line would produce a plausible total and a wrong tax return, and nobody would notice. So the decision function has an explicit "I can't tell" outcome, and that blocks auto-post with a reason a person can act on.

**Q: How would you design an AI extraction feature that feeds a financial record?**
Treat the model's output as untrusted input, the same as a request body. Validate its format, cross-check it against the document's own arithmetic, and only let it through automatically when the numbers corroborate each other. Where they don't, route to a person with a specific reason. A misread ABN that fails its checksum should fall back to the name, and never create a vendor keyed on a wrong number.

## Follow-ups

- "What about a tenant who operates in several zones?" We store one zone per organization, because a BAS is per entity. The user's own display zone would be a separate concern, and audit timestamps stay instants.
- "How do you keep the same rule on client and server?" Prefer one source: the client asks the server for the catalogue. Where a pure calculation must run in both, a shared JSON fixture keeps them in parity, as with `computeDueDate`.

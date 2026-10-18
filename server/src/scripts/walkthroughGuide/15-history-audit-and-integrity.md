# History, audit and integrity

Three layers record what happened: the History & notes panel on each record, the organization-wide audit trail
captured by the database, and the integrity checks you run from the command line. Reading is safe in the demo;
adding notes is harmless anywhere.

## 1. History and notes on a record

**Where:** any record page, for example **Sales** → **Invoices** (`/invoices`)

**Do this:**
1. Open {{doc:I16}} and scroll to `History & notes`; click it to expand.
2. Type into `Add a note for your team` and click **Add note**.
3. Repeat on an expense, a credit note, a quote, a sales or purchase order, a manual journal, and a customer or
   vendor account page.
4. For bank lines open **Banking** → **Bank lines** and the **History** tab.

**You should see:** a dated list of what happened (created, issued, paid, voided) with who did it, and your note
marked `Note`; `System` for automatic actions such as a recurring run.

**Try to break it:**
- Open a record as a member without the edit permission (guide 02) → the note box is absent but the history is readable.
- Look for a way to delete or edit a note → none; history is append-only.

- [ ] Done

## 2. Audit trail

**Where:** **Settings** → **Audit** → **Audit trail** (`/settings/audit`)

**Do this:**
1. Open **Settings**, then **Audit trail** in the **Audit** card.
2. Filter by **Area**, **Table** (for example `invoices`), **Member** and **Operation** (`INSERT`, `UPDATE`,
   `DELETE`); click `Clear`.
3. Open an `UPDATE` row to see **Field**, **Before** and **After**.
4. Make a change in the scratch organization (rename a customer) and find it here.

**You should see:** **When**, **Area**, **Table**, **Operation**, **Changed**, **Actor** and **IP** per row, with
field-level before and after values for updates.

**Try to break it:**
- Open the audit trail as a viewer or accountant (guide 02) → `Only an owner or admin can view the audit trail.`
- Filter to a table with no changes → `No audit entries match these filters.`

- [ ] Done

## 3. User activity

**Where:** **Settings** → **Audit** → **User activity** (`/settings/user-activity`)

**Do this:**
1. Open **User activity** in the **Audit** card.
2. Sign in once with a wrong password (guide 01), then reload this page.

**You should see:** per member their **Role**, **Last sign-in**, **Failed sign-ins (30 days)** and **Changes
(30 days)**.

**Try to break it:**
- Open the page as a non-admin → `Only an owner or admin can view member activity.`

- [ ] Done

## 4. Integrity checks

**Where:** a terminal in `server/`

**Do this:**
1. Run `cd server && npm run verify:integrity`.
2. Read the result line for each check.

**You should see:** all seven checks pass, including that every journal entry balances, that the subledgers tie to
the receivable, payable and inventory control accounts, and that stock movements reconcile with the ledger.

**Try to break it:**
- Run it after posting, voiding and importing in a scratch organization → it still passes; every correction in
  the product posts a reversing entry rather than editing history.

- [ ] Done

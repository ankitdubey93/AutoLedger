# Imports

Nine kinds of CSV import share one wizard: choose a kind, upload, map columns, stage, fix what is wrong, commit.
Sample files are in the walkthrough folder (`accounts.csv`, `customers.csv`, `vendors.csv`, `products.csv`,
`stock-items.csv`, `invoices-month-6.csv`, `bills-month-6.csv`, `payroll-month-6.csv`). Committing posts to the
ledger, so use a scratch organization and import in the order of the checklist.

## 1. The wizard

**Where:** **Accounting** → **Imports** (`/migration-imports`)

**Do this:**
1. **⚠ scratch org** — open **Imports** and read `Migration checklist`.
2. Click **New import**.
3. Under `What are you importing?` choose `Chart of accounts`.
4. Click **Download template**, then choose your own file (`walkthrough/accounts.csv`) under **CSV file**.
5. Click **Review column mapping** and read how each column was matched; keep the defaults.
6. Click **Stage import**.
7. On the staged import read the **Preview**, filter rows with `Filter by status`, then click **Commit** and confirm
   with **Commit**.

**You should see:** every row staged, good and bad (`Valid`, `Invalid`, `Excluded`); after committing, the import is
`Committed`, the accounts exist in **Chart of accounts**, and the checklist entry shows a tick.

**Try to break it:**
- Leave a **Name** blank in a copy of the file → that row is `Invalid`, **Commit** is disabled and the page says `Fix 1 invalid row first.`; the server would answer `Fix 1 invalid row(s) before committing`.
- Commit an import twice (a second tab, or the API) → `This import has already been committed`.
- Upload a file with only headers → `The file contains no data rows`.
- Upload a chart file with no name column → staging is refused with a 422 that names the column the file lacks.

- [ ] Done

## 2. Parties and products

**Where:** **Accounting** → **Imports** (`/migration-imports`)

**Do this:**
1. **⚠ scratch org** — import `customers.csv` as `Customers` and `vendors.csv` as `Vendors`. (Each list page also has
   an Import button.)
2. Import `products.csv` as `Products & services`.
3. Import `stock-items.csv` as `Inventory items & opening stock` (inventory is set up on first use).
4. Edit a cell in the staged table and save the row; click **Exclude** on a row, then **Include**.
5. Import the same file again.

**You should see:** the second import of a party merges into the existing one by email, then name, and fills only
blank fields; a tracked item's opening stock arrives as an opening receipt through inventory, never by touching the
tables directly.

**Try to break it:**
- Pick `Date format in your file` wrongly for a file with dates → the row shows as `Invalid`.
- Stage a file over the row cap → `This file has N data rows; one import takes at most 5000 — split it into smaller files`.

- [ ] Done

## 3. Opening balances

**Where:** **Settings** → **Accounting** → **Conversion balances** (`/settings/conversion-balances`)

**Do this:**
1. **⚠ scratch org** — open **Settings**, then **Conversion balances**, and set the **Conversion date**.
2. Open **Imports**, choose `Opening balances`, download the template, fill `*Code`, `Debit` and `Credit` for your
   cash, equipment and equity accounts, and stage it.
3. Read the **Preview**: if the trial balance does not balance, a plug to opening balance equity is shown.
4. Commit.

**You should see:** one journal entry dated on the conversion date; `This trial balance is already in balance — no
plug will be posted.` when it balances.

**Try to break it:**
- Include the receivables account {{account:1120}} → the row is refused (receivables, payables, retained earnings and inventory come in as open invoices, bills and opening stock).
- Commit a second opening-balance import → `This organization already has a committed opening-balance import`.

- [ ] Done

## 4. Documents and journals

**Where:** **Accounting** → **Imports** (`/migration-imports`)

**Do this:**
1. **⚠ scratch org** — with customers, vendors and accounts imported, import `invoices-month-6.csv` as
   `Open invoices`. On the staged import choose `Import as drafts` or `Import and post` (then pick
   `Each document's own date` or `On this date`), and click **Commit**.
2. Import `bills-month-6.csv` as `Open expenses (bills)` the same way.
3. Import `payroll-month-6.csv` as `Other journals (optional)`; rows group by journal number.
4. Stage invoices again but tick `These are open items from before my conversion date (conversion mode)`.
5. Open a committed import and try **Delete import** (it is only offered before committing).

**You should see:** drafts created without numbers or postings, or posted documents with their imported numbers
kept; conversion mode posts open items to `3400 Opening Balance Equity` on the conversion date so nothing is counted twice.

**Try to break it:**
- Use conversion mode with a tax rate or a product on the line → the row is refused (tax must be 0, products cannot be used).
- Import a journal that does not balance or touches the receivables account → the whole journal is `Invalid`.
- Delete a committed import → there is no **Delete import**; the server says `A committed import cannot be deleted`.

- [ ] Done

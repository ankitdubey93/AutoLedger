# Chart of accounts and system accounts

The demo's chart is the default chart plus the accounts the walkthrough added by form ({{account:1115}} and
{{account:6150}}).

## 1. Read the chart

**Where:** **Accounting** → **Chart of accounts** (`/accounts`)

**Do this:**
1. Open **Chart of accounts** in the sidebar.
2. Collapse and expand a header account with its arrow button.
3. Hover a header account (marked `header`), then click a postable account such as {{account:1110}}.

**You should see:** accounts grouped by type (Asset, Liability, Equity, Revenue, Expense) with balances, and a count
(for example `NN accounts`) beside the **New account** button. Header accounts roll up their children and have no ledger of their own
(`Header accounts roll up their children and have no ledger of their own` on hover); postable accounts link to
their ledger.

**Try to break it:**
- Click a header account → nothing opens; only postable accounts are links.
- Open the **Type** select on **New account** → only Asset, Liability, Equity, Revenue and Expense are offered, never a sixth.

- [ ] Done

## 2. Create an account

**Where:** **Accounting** → **Chart of accounts** (`/accounts`)

**Do this:**
1. **⚠ scratch org** — click **New account**.
2. Enter **Code** `6130` and **Name** `Marketing & Advertising`.
3. Leave **Type** as `Expense`, choose a **Parent**, and keep **Can be posted to** ticked.
4. Click **Create account**.

**You should see:** the account in the tree under its parent, with a zero balance. For an Asset the form also offers
**Bank account** (`None` or `Bank account`); for a Liability it offers **Credit card**; for balance-sheet types it
offers **Cash flow category** and **Balance sheet class** (both default to `Automatic`).

**Try to break it:**
- Create a second account with code `6130` → `Account code already exists`.
- Choose a **Parent** of a different type → `Parent account must have the same type`.
- Untick **Can be posted to** → the account becomes a header and later refuses journal lines.

- [ ] Done

## 3. The account ledger

**Where:** **Accounting** → **Chart of accounts** → an account (`/accounts`)

**Do this:**
1. Click {{account:1110}} in the tree.
2. Read **Opening balance**, **Total debits**, **Total credits** and **Closing balance**.
3. Set **From** to {{date:3:1}} and **To** to {{date:3:28}}; the filter is stored in the address bar.
4. Click **Clear**.
5. Click a row's link to open the journal entry that posted it.

**You should see:** a running **Balance** column; with a date range the **Opening balance** row carries the balance
before **From**, and closing balance = opening + debits − credits for a debit-normal account.

**Try to break it:**
- Pick a range with no postings → `No activity in this period.`
- Open a ledger with a made-up id → `Account not found.`

- [ ] Done

## 4. System accounts

**Where:** **Accounting** → **Chart of accounts** (`/accounts`)

**Do this:**
1. Find {{account:1120}}, {{account:2100}}, {{account:2140}} and {{account:4910}} in the tree.
2. Hover the **System** badge beside each one.

**You should see:** a **System** badge on every account the product posts to by itself (receivables, payables,
sales and purchase tax, retained earnings, FX gains and losses, rounding, deposits and the inventory accounts). The
hover text reads `System account: Accounts Receivable. It can be renamed but not retired.` (with the account's role
in place of `Accounts Receivable`).

**Try to break it:**
- Look for a **System** badge on {{account:6150}} or {{account:1110}} → none; the first was created by hand and the
  second is an ordinary cash account.

- [ ] Done

## 5. Rename, retire and reactivate

**Where:** **Settings** → **Accounting** → **Chart of accounts** (`/settings/chart`)

**Do this:**
1. **⚠ scratch org** — open **Settings**, then **Chart of accounts** in the **Accounting** card.
2. Click **Rename** next to the account you created in section 2, change the name and click **Save** (or **Cancel**).
3. Click **Retire**, then **Activate**.

**You should see:** each row shows `Active` or `Retired`; a retired account stays in the chart and keeps its history
(`accounts are never deleted`), but no longer appears in account pickers. **Add account** at the top of each type opens
the same form as section 2.

**Try to break it:**
- Look at **Retire** on {{account:1120}} → it is disabled with `System accounts cannot be retired or flagged as bank accounts`;
  the server refuses with `Accounts Receivable is a system account and cannot be retired`.
- Rename {{account:1120}} → allowed; a system account can be renamed but not retired.

- [ ] Done

## 6. Bank and credit-card marks

**Where:** **Settings** → **Accounting** → **Chart of accounts** (`/settings/chart`)

**Do this:**
1. **⚠ scratch org** — on an Asset account you created, click **Mark as bank**.
2. On a Liability account you created, click **Mark as credit card**.
3. Click **Unmark bank** and **Unmark credit card** to undo.

**You should see:** the toggle label flips to **Unmark bank** or **Unmark credit card**; marked accounts appear in
bank pickers (payments, statement import) and are closed to manual journals.

**Try to break it:**
- Look for **Mark as bank** on {{account:1120}} → disabled with `System accounts cannot be retired or flagged as bank accounts`; the server
  refuses with `Accounts Receivable is a system account and cannot be a bank or credit card account`.
- Look for the toggle on an Expense account → it is not offered (the server refuses a bank mark on anything but an
  Asset with `Only an Asset account can be a bank account`).

- [ ] Done

## 7. Cash flow category and balance-sheet class

**Where:** **Settings** → **Accounting** → **Chart of accounts** (`/settings/chart`)

**Do this:**
1. **⚠ scratch org** — on an Asset account use the **Cash flow category** select (`Automatic`, `Cash`, `Operating`,
   `Investing`, `Financing`).
2. Use the **Balance sheet class** select (`Automatic`, `Current`, `Non-current`).

**You should see:** the choice saved at once. These two attributes only steer reports: the cash flow statement
(guide 14) and the current / non-current split used by the business snapshot ratios.

**Try to break it:**
- Look for either select on a Revenue or Expense account → absent; the server refuses with
  `Only balance-sheet accounts have a cash flow category`.

- [ ] Done

## 8. Manual journals refuse control and bank accounts

**Where:** **Accounting** → **Manual journals** (`/manual-journals`)

**Do this:**
1. **⚠ scratch org** — click **New journal**.
2. Enter any **Narration**, then add two lines: debit {{account:1110}}, credit any Revenue account, for `100.00`.
3. Click **Post**.
4. Change the debit account to {{account:1120}} and click **Post** again.

**You should see:** the page footer reads `Bank, credit card, receivable, payable and inventory accounts can't take
manual journals — use Banking, invoices, bills or Inventory.`

**Try to break it:**
- Post a line to {{account:1110}} → `Account 1110 is a bank account — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal`.
- Post a line to {{account:1120}} → `Account 1120 is the receivable control account — post to it through an invoice or a payment, not a journal entry`.

- [ ] Done

## 9. Conversion balances

**Where:** **Settings** → **Accounting** → **Conversion balances** (`/settings/conversion-balances`)

**Do this:**
1. **⚠ scratch org** — open **Conversion balances**.
2. Set **Conversion date** and click **Save date**.
3. Under **Opening balances** click **Load chart**, enter debits and credits against accounts (use **Add row** for more),
   and watch the footer.
4. Click **Save and review**.

**You should see:** `Saved.` for the date; the footer shows `Balanced` once debits equal credits; **Save and review**
stages an opening-balance import you confirm on the next page (guide 12). Retained earnings and the AR / AP control
accounts are not listed; they open from real documents.

**Try to break it:**
- Make debits differ from credits → the footer shows `Out of balance by …` and **Save and review** stays disabled.
- Type three decimals → `Amounts take at most two decimal places.`
- Put a debit and a credit on the same row → `A row carries a debit or a credit, not both.`

- [ ] Done

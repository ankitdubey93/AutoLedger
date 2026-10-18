# Banking

Import bank statements, settle each line against an invoice or bill (or by journal entry), automate the routine
lines with rules, and check that the bank and the books agree. The walkthrough's statements are ready-made files in
`walkthrough/statements/`:

| File | Bank format | Date format |
|---|---|---|
| `month-1-northwind-ISO.csv` | Northwind | `ISO` |
| `month-2-meridian-DMY.csv` | Meridian | `DMY` |
| `month-3-cascade-MDY.csv` | Cascade | `MDY` |

Importing, matching and deleting lines all change the books, so use a scratch organization. The demo already has all
seven months reconciled. In a scratch organization the lines have nothing to match until you also enter the matching
invoices and bills (guide 06 and 07) — importing alone is still a fine test of parsing, duplicates and deletion.

## 1. Import a statement

**Where:** **Banking** → **Import statement** (`/bank/import`)

**Do this:**
1. **⚠ scratch org** — open **Import statement**.
2. Choose **Bank account** {{account:1110}}.
3. Under **Statement file (CSV)** choose `walkthrough/statements/month-1-northwind-ISO.csv`; set **Date format** to
   `ISO — 2026-03-09`.
4. Open `Column mapping (optional)` and look at **Date column**, **Description column**, **Amount column**,
   **Reference column**, **Debit column** and **Credit column**; leave them blank so the headers are detected.
5. Type a **Statement closing balance (optional)** and the **as of** date from the last line of the file.
6. Click **Import statement**.
7. Repeat with `month-2-meridian-DMY.csv` and **Date format** `Day/Month/Year — 09/03/2026`, then
   `month-3-cascade-MDY.csv` with `Month/Day/Year — 03/09/2026`.

**You should see:** a summary such as `Imported N lines, skipped 0 duplicates.` with how many lines got a suggested
match and how many are ready for one-click accept, a link `Review the approval queue →`, and the file under
`Recent statements`.

**Try to break it:**
- Import the same file again → `Imported 0 lines, skipped … duplicates.`; nothing doubles up.
- Import a file whose date column does not parse (wrong **Date format**) → `Import failed: … row(s) could not be parsed (…)`.
- Import a file with only a header → `The file contains no transaction rows`.
- Pick a header account or a non-asset account for **Bank account** → `Account … is a header account and cannot be posted to` or `Account … is not an Asset account`.
- Type `abc` as the closing balance → `Enter the closing balance like 1250.00 or -80.50`.
- Set a mapped column name that is not in the file → `Column "…" is not in the file`.

- [ ] Done

## 2. Settle lines

**Where:** **Banking** → **Bank lines** (`/bank`)

**Do this:**
1. **⚠ scratch org** — open **Bank lines**. The tabs are **Unreconciled**, **Reconciled**, **Ignored**, **Deleted**
   and **History**; type into **Search** (`Description or reference`).
2. On a line with suggestions click its `suggestion(s)` button, read the score and reasons, then click **Accept**
   (a strong match) or **Match** (a weaker one) and confirm with **Match**.
3. On a line with no suggestion click **Rescore**.
4. On a fee or interest line click **Post journal**, pick an account from `Select an account…`, optionally edit the
   description (it accepts placeholders — try the picker), and click **Post**.
5. After posting, click `Create a rule from this line` (section 4).
6. On a line that is not a business transaction (a transfer to savings) click **Ignore**, then **Un-ignore**.
7. On a reconciled line click **Unmatch** and confirm with **Unmatch**.

**You should see:** a matched line moves to **Reconciled** and a payment now exists against the invoice or bill;
**Post journal** shows `Journal entry posted` and a **View entry** link; money in debits the bank account and money
out credits it, with the other side on the account you picked. **Unmatch** voids the payment (or reverses the
journal) and returns the line to **Unreconciled**.

**Try to break it:**
- Click **Post** with no account → `Choose an account first`.
- Post a journal back to the bank account the line came from → `The journal entry cannot post back to the same bank account`.
- Post a journal to {{account:1120}} → `Account 1120 is the receivable control account — post to it through an invoice or a payment, not a journal entry`.
- Ignore a line, then try to match it → `This bank line is ignored — un-ignore it first`.
- Un-ignore a line that is not ignored → `This bank line is not ignored`.
- Look for a suggestion on a euro invoice → none is ever offered, because statements are in the base currency; recording the
  receipt by hand is the only way (guide 11). A base-currency line forced onto a foreign document is refused with `A base-currency bank line cannot settle a foreign-currency document`.
- Match a deposit to a bill → `A deposit can only be matched to an invoice`.

- [ ] Done

## 3. Delete and restore lines

**Where:** **Banking** → **Bank lines** (`/bank`)

**Do this:**
1. **⚠ scratch org** — on **Unreconciled**, tick the checkbox of two lines; `2 selected` appears.
2. Click **Delete selected**, type a **Reason (optional)** and confirm with **Delete**.
3. Open the **Deleted** tab and click **Restore** on one line.
4. Open the **History** tab and read the entries (who, what, when).
5. Open **Import statement**, find the statement under `Recent statements` and click **Delete statement**, then
   **Delete**.

**You should see:** deleted lines leave the queue and show in **Deleted**; restoring puts the line back in
**Unreconciled**; **History** records each delete, restore and statement delete with the actor. **Delete statement** removes only unreconciled lines and
keeps the import record.

**Try to break it:**
- Re-import the statement after deleting lines → the lines stay deleted and the summary says `… previously deleted lines were skipped — restore them from the Deleted tab`.
- Delete a statement that has reconciled or ignored lines → `This statement has reconciled or ignored lines — unmatch or unignore them first`.
- Try to delete a reconciled line (the checkbox is not offered; the server also refuses) → `Only unreconciled lines can be deleted — unmatch or unignore first`.
- Restore a line that was never deleted → `This bank line is not deleted`.

- [ ] Done

## 4. Bank rules

**Where:** **Banking** → **Bank rules** (`/bank/rules`)

**Do this:**
1. **⚠ scratch org** — click **New rule**.
2. Fill **Priority**, **Name**, **Direction** (`Any`, `In` or `Out`), **Memo contains** (for example `SERVICE CHARGE`),
   optional **Min amount** and **Max amount**, optional **Bank account (optional)**, **Posts to** (the account the other side lands on) and **Description (optional)** (try `Bank fee [Month]` with the placeholder picker), then click
   **Create rule**.
3. Click **Apply to unmatched lines**.
4. Click **Deactivate** on the rule, then **Reactivate**.
5. Import a second statement with the same memo; the rule settles it as the file is imported.

**You should see:** the rule in the table with **Priority**, **Memo contains**, **Direction**, **Amount range**,
**Posts to** and **Status**; `Settled 1 line(s)` after applying, and the import summary reads `… settled by bank rules.`
Each rule posts a real journal entry, the same as **Post journal**. A document suggestion at or above the
auto-match score always wins over a rule.

**Try to break it:**
- Enter `abc` as **Min amount** → `Enter amounts like 450 or 450.50`.
- Enter a **Min amount** above the **Max amount** → `Min amount cannot be more than max amount`.
- Leave **Name**, **Memo contains** or **Posts to** empty → **Create rule** stays disabled.
- Apply when nothing matches → `Settled 0 line(s)`; no entry is posted.

- [ ] Done

## 5. Reconciliation

**Where:** **Banking** → **Reconciliation** (`/bank/reconciliation`)

**Do this:**
1. In the demo open **Reconciliation**.
2. Choose **Account** {{account:1110}} and set **As of** to the last day of {{month:7}}.
3. Read `The bank and the books agree` (or `Difference of …`), then **GL balance**, **Statement balance**,
   **Difference** and **Unmatched lines**.
4. Click the **Unmatched lines** tile.
5. In a scratch organization with a closing balance entered at import, read `Statement's own closing balance as of …`
   and `Difference from imported lines`.

**You should see:** the **GL balance** (the ledger's balance of the account), the **Statement balance** (the sum of the
imported lines) and their **Difference**, plus the count and total of unmatched lines. The page says it is a completeness check, not a correctness proof: a gap means a cash
movement was never imported.

**Try to break it:**
- In a scratch organization import a statement but post nothing → **Difference** is not zero and `The bank and the books agree` does not appear.
- Delete a line (section 3) and reload → the unmatched total falls, and the difference changes with it; restore the
  line to bring it back. (The page itself has no separate deleted-lines count; use the **Deleted** tab.)

- [ ] Done

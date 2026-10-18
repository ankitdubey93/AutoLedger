# Manual journals, repeating journals and the general journal

In the demo, 2026-09-03 holds a posted journal for the plasma cutter, a voided bonus accrual and a repeating
insurance amortisation. Do the posting steps in a scratch organization.

## 1. The manual journals list

**Where:** **Accounting** → **Manual journals** (`/manual-journals`)

**Do this:**
1. Open **Manual journals** in the sidebar.
2. Click each status tab: **All**, **Draft**, **Posted**, **Voided**, **Repeating**.
3. On a list tab set **From** and **To**, then type in **Search narration**.
4. On **Repeating** tick **Active only**.

**You should see:** counts beside the first four tabs (for example `Posted (n)`); each row shows **Date**,
**Narration**, **Status**, **Origin** (`Manual`, `Repeating` or `Imported`) and **Amount**. The voided bonus accrual
sits under **Voided** with its status struck through.

**Try to break it:**
- Search for text that matches nothing → no rows are listed; clear **Search narration** and they return.
- Look for an invoice's posting on this list → absent; it is on the **General journal** report (section 8), not here.

- [ ] Done

## 2. Draft, save and post a journal

**Where:** **Accounting** → **Manual journals** → **New journal** opens **New manual journal** (`/manual-journals/new`)

**Do this:**
1. **⚠ scratch org** — click **New journal**.
2. Set **Date**, type **Narration** `Accrued rent [Month]`, and watch the `Preview:` line under it.
3. Fill two lines: **Description**, **Account**, **Debit** on the first and **Credit** on the second, the same amount.
4. Click **Save draft**.
5. On the draft's page click **Post**.

**You should see:** the footer reads `Balanced` once debits equal credits; the preview fills `[Month]` with the month of
**Date**; after step 5 the journal is **Posted** with a **View ledger entry** link and its lines in the trial balance.
The `Save & add another` button (not shown while editing) posts and then clears narration and lines but keeps the date.

**Try to break it:**
- Make debits and credits differ on the form → `Out of balance by …` appears and the form's **Post** stays disabled.
- Save that unbalanced journal as a draft, then click **Post** on its page → `Journal is unbalanced: debits …, credits …`.
- Post a journal dated 2026-03-15 → `The fiscal period covering 2026-03-15 is closed; reopen it or post to an open period`.

- [ ] Done

## 3. Insert a placeholder

**Where:** **Accounting** → **Manual journals** → **New journal** opens **New manual journal** (`/manual-journals/new`)

**Do this:**
1. **⚠ scratch org** — click **New journal** and place the cursor in **Narration**.
2. Click **Insert placeholder** and choose `Next month`.
3. Change **Date** to a date in another month.

**You should see:** the token (`[Month+1]`) inserted at the cursor and the `Preview:` line showing the month after
the one **Date** falls in; it updates as you change the date. The placeholder is replaced by real text when the
journal is posted, so no `[Month]` is ever stored on a posted journal.

**Try to break it:**
- Write `[[Month]]` → the preview shows a literal `[Month]` (the double brackets escape it).

- [ ] Done

## 4. Edit and delete a draft

**Where:** **Accounting** → **Manual journals** → a draft (`/manual-journals`)

**Do this:**
1. **⚠ scratch org** — open a draft from the **Draft** tab.
2. Click **Edit**, change an amount, click **Save draft**.
3. Click **Delete** and confirm with **Delete draft**.

**You should see:** the edit page titled `Edit draft journal`; after the delete the journal is gone and nothing in the
ledger changed (`Nothing has been posted, so nothing in the ledger changes.`).

**Try to break it:**
- Open the edit address of a posted journal (its page address with `/edit` added) → `This journal is POSTED and can't
  be edited.`
- A posted journal has no **Delete** button at all.

- [ ] Done

## 5. Void a posted journal

**Where:** **Accounting** → **Manual journals** → a posted journal (`/manual-journals`)

**Do this:**
1. **⚠ scratch org** — open a posted journal.
2. Click **Void**, optionally enter **Void date**, and confirm with **Void journal**.
3. Click **View reversal**.

**You should see:** the status changes to **Voided**; a reversing entry is posted (`A reversing entry is posted. The
original stays in the ledger.`) with debits and credits swapped, so the trial balance shows the amount on both sides.
**Copy** is offered on a voided journal to start a corrected one.

**Try to break it:**
- Void the same journal again → the button is gone; the server refuses with `Entry has already been reversed`.
- Void a journal whose date falls in a closed period with no **Void date** → `The fiscal period covering … is closed;
  reopen it or post to an open period`; enter a **Void date** in an open period to proceed.

- [ ] Done

## 6. Copy a journal and make it recurring

**Where:** **Accounting** → **Manual journals** → a posted journal (`/manual-journals`)

**Do this:**
1. **⚠ scratch org** — on a posted journal click **Copy**.
2. Check the page is titled `New manual journal (copy)` with lines pre-filled, then click **Save draft**.
3. Back on the original posted journal click **Make recurring** and complete the dialog.

**You should see:** the copy as a new draft; the dialog creates a schedule you can find under **Recurring** (section 7).

**Try to break it:**
- Look for **Make recurring** on a draft or voided journal → not offered; only a posted journal can be a template.

- [ ] Done

## 7. Repeating journals and schedules

**Where:** **Accounting** → **Manual journals** → **New repeating journal** (`/manual-journals/repeating/new`), then
**Accounting** → **Recurring** (`/recurring`)

**Do this:**
1. **⚠ scratch org** — click **New repeating journal**.
2. Enter **Name** `Insurance amortisation`, **Narration** `Insurance — [Month]`, **First date**, **Repeats** `Monthly`,
   **Every (count)** `1`, an optional **End date (optional)**, and tick **Reverse on the 1st of the next month** only if
   you want the auto-reversal. Fill the lines and click **Save repeating journal**.
3. Open **Recurring**, filter with the **Journals** tab, and open the schedule.
4. Click **Run now**, then **Pause**, **Resume**, and finally **End** (confirm with **End schedule**).

**You should see:** nothing posts until a run; **Run now** posts the journal dated at the next run date and the
**Runs (newest first)** table lists it with its **Document** link. **Next run will read** shows the narration with
placeholders filled for the next date.

**Try to break it:**
- Click **Run now** on a paused or ended schedule → the button is disabled.
- After **End** the schedule offers no **Resume**: the confirmation warns `This cannot be undone.`
- Set **End date (optional)** before **First date** → the server refuses with `endDate must not be before startDate` and saves nothing.

- [ ] Done

## 8. General journal and journal pages

**Where:** **Reports** → **General journal** (`/reports/general-journal`)

**Do this:**
1. Open **General journal** in the sidebar.
2. Filter with **From**, **To**, **Account** and **Search description**; click **Clear filters**.
3. Click the **View entry** icon on a row.
4. On the entry's page, find **Open manual journal**, **Reverse**, **Void journal** or **Make recurring** (which of
   them appear depends on what posted the entry).

**You should see:** every posting in the books, whatever document made it, with a status of `Posted`, `Reversed` or
`Reversal`. An entry created by a manual journal offers **Void journal** and **Open manual journal**.

**Try to break it:**
- Open the entry of an **invoice** (posted by a document) → there is no **Reverse** button; the server refuses a
  direct reversal with `This entry was posted by a invoice document — correct it from that document instead`.
  Void the invoice instead (guide 06).
- Open a reversal entry → no **Reverse** either; the server says `A reversing entry cannot itself be reversed`.

- [ ] Done

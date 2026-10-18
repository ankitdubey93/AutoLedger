# Fiscal periods and closing

A period can be open, closed or locked. Closing stops new postings dated inside it and can be undone; locking is
permanent. Locking cannot be reversed, so do all of this in a scratch organization. The demo has period 6 closed
and nothing locked.

## 1. Generate, close, reopen and lock

**Where:** **Accounting** → **Fiscal periods** (`/fiscal-periods`)

**Do this:**
1. **⚠ scratch org** — open **Fiscal periods**. If it is empty click `Generate periods for this fiscal year`.
2. Click **Close** on the first period; the status becomes `Closed`.
3. Click **Reopen** on it; the status returns to `Open`.
4. Click **Close** again, then **Lock** and confirm with **Lock period**.
5. In the demo (read only) look at the **Entries** and **Closed by** columns.

**You should see:** a table of **Period**, **Range**, **Entries**, **Status**, **Closed by** and **Actions**; a locked
period shows `Locked — permanent` with no actions.

**Try to break it:**
- Post a manual journal dated inside a closed period → `The fiscal period covering … is closed; reopen it or post to an open period`.
- Look for **Reopen** on a locked period → not offered; the server says `Cannot reopen a locked period`.
- Close a period twice → `Cannot close a closed period`.
- Generate periods when they already exist → `A fiscal period already overlaps this fiscal year`.

- [ ] Done

# Setup

1. Register a **fresh** organization — any name, base currency **USD**. Registration seeds the default 47-account chart automatically. Complete the setup wizard that follows (base currency **USD**). On its optional inventory step, choose the **Manufacturing** profile now, or **Skip for now** and set inventory up later, at the start of month 5, under **Settings → Inventory → Industry template** (choose **Manufacturing** there too). Either way, inventory must be set up before month 5's stock items are imported: that profile creates the `SPR` (Stores & spares) category the file uses.
2. Add one account, `4300 Interest Income`. Either import `accounts.csv` (kind **Chart of accounts**), which is one row — `4300 Interest Income` — or create it by hand under **Accounting → Chart of accounts** with the table below:

   | Field | Value |
   |---|---|
   | Code | `4300` |
   | Name | Interest Income |
   | Type | Revenue |
   | Parent | `4000 Revenue` |
   | Postable | Yes |

3. Do **not** run the opening-balance importer into this organization — the scenario assumes zero opening cash, and an import would add balances this pack's answer key does not account for.

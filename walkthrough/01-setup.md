# Setup

1. Register a **fresh** organization — any name, base currency **USD**. Registration seeds the default 45-account chart automatically. On the next screen, choose at least **LedgerCore** and click **Continue**.
2. Go to **Accounts** and create one new account:

   | Field | Value |
   |---|---|
   | Code | `4300` |
   | Name | Interest Income |
   | Type | Revenue |
   | Parent | `4000 Revenue` |
   | Postable | Yes |

3. Do **not** run the sandbox demo loader or the opening-balance importer into this organization — the scenario assumes zero opening cash, and both of those would add balances this pack's answer key does not account for.

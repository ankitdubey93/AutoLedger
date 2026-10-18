# Dashboard and navigation

## 1. The dashboard

**Where:** **Overview** → **Dashboard** (`/`)

**Do this:**
1. Sign in to the demo organization and open **Dashboard**.
2. Read the tiles in order: **Assets**, **Liabilities**, **Equity**, **Cash**.
3. Read **Accounting equation**, then the **This fiscal year** and **This month** panels (**Revenue**, **Expenses**,
   **Net income**).
4. Read **Invoices owed to you** and **Expenses you need to pay**, then **Last 6 months** and **Recent entries**.

**You should see:** the figures of the answer key for the latest month: `Assets` equals `Liabilities` plus `Equity`
plus earnings, and the footer line reads `Debits equal credits exactly.` Each owed panel splits into
**Awaiting payment** and **Overdue**; **Expenses you need to pay** also has **To review** (bills entered but not yet approved).

**Try to break it:**
- Click **Overdue** under **Invoices owed to you** → the invoice list opens already filtered to issued, overdue
  invoices; its total matches the **Overdue** figure on the dashboard.
- Open a fresh organization's dashboard → the tiles show zero and **Recent entries** says `No activity yet.`; the
  **Cash** tile says `No cash account configured — set one in Settings.` until the wizard's cash account is chosen.

- [ ] Done

## 2. Business health

**Where:** **Overview** → **Dashboard** (`/`), the **Business health** row

**Do this:**
1. Scroll to **Business health**.
2. Read the four tiles: **Gross margin (YTD)**, **Current ratio**, **Debt to equity**, **Working capital**.
3. Click **View business snapshot →** to open the full report (guide 14).

**You should see:** a percentage for **Gross margin (YTD)**, a multiple such as `1.40×` for each ratio, and a `As at …`
date under **Working capital**.

**Try to break it:**
- Open the dashboard as a member without the `View dashboard and reports` permission (guide 02, section 9) → the row
  is absent and the dashboard shows `Where you can go` links instead.
- A ratio whose denominator is zero or negative shows `—` instead of a number; hovering explains why
  (`Not available: the denominator is zero.`).

- [ ] Done

## 3. The setup checklist

**Where:** **Overview** → **Dashboard** (`/`), the **Finish setting up** card

**Do this:**
1. **⚠ scratch org** — in a new organization, finish the wizard (guide 02, section 2) and open the dashboard.
2. Find **Finish setting up**; click **Set up** next to `Inventory (optional)`.

**You should see:** `Accounting setup` marked `Complete` and `Inventory (optional)` marked `Not started`; the card
disappears once every task is complete.

**Try to break it:**
- In a fresh organization click **Skip for now** in the wizard → the dashboard shows `Setup was skipped. Some features
  need it.` with **Finish setup**, and pages that need the settings send you back to the wizard.

- [ ] Done

## 4. The New menu

**Where:** top bar, **New** button

**Do this:**
1. Click **New** (it sits at the top of the sidebar and is hidden while the sidebar is collapsed).
2. Click each entry in turn: **Quote**, **Sales order**, **Invoice**, **Purchase quote**, **Purchase order**,
   **Expense**, **Upload a bill**, **Journal entry**, **Customer**, **Vendor**, **Product or service**,
   **Tracked product**, **Account**.

**You should see:** each entry opens the matching creation page or the list with its form open
(for example **Customer** opens `/customers?new=1`).

**Try to break it:**
- Sign in as a `VIEWER` (guide 02, section 10) → the **New** button is gone entirely; entries your role cannot create
  are removed one by one for other roles.

- [ ] Done

## 5. Command palette

**Where:** top bar, **Search or jump to…**

**Do this:**
1. Press `Ctrl+K` (or `⌘K` on a Mac), or click **Search or jump to…**.
2. Type `trial` and press `Enter`.
3. Reopen it, type `Reports` — the group name also matches — and use the arrow keys to move.
4. Press `Esc`.

**You should see:** a list of every sidebar page plus **Account settings**; typing narrows it; `Enter` opens the
page and the palette closes.

**Try to break it:**
- Type `xyzzy` → `No matches.`
- As a member who cannot view a page (for example a `VIEWER` searching for `Fiscal periods`) → the page is absent
  from the results, exactly as it is absent from the sidebar.

- [ ] Done

## 6. Theme

**Where:** top bar, **Change theme**

**Do this:**
1. Click **Change theme**.
2. Choose **Dark**, then **Light**, then **System**.
3. Reload the page.

**You should see:** the whole app switches at once and your choice survives the reload without a flash of the other
theme. **System** follows your operating system's setting.

**Try to break it:**
- Choose **Dark**, reload and watch the first paint → no flash of light colours (the theme is applied before React
  loads).

- [ ] Done

## 7. Sidebar: collapse and mobile drawer

**Where:** sidebar, **Collapse sidebar**

**Do this:**
1. Click **Collapse sidebar** at the bottom of the sidebar.
2. Hover an icon; click an icon to navigate.
3. Click the same button (now just an arrow icon) to restore it.
4. Narrow the browser window below 768px.
5. Click **Open menu** in the top bar, pick a page, then reopen it and click **Close menu**.

**You should see:** the collapsed rail keeps icons only, with each label as a hover title; below 768px the sidebar is
replaced by a drawer that closes after you navigate.

**Try to break it:**
- Reload while collapsed → the rail stays collapsed.
- At phone width, tap outside the drawer → it closes without navigating.

- [ ] Done

## 8. The user and organization menus

**Where:** top bar, right side

**Do this:**
1. Open the user menu and read its entries: **Account settings**, **Organization settings**, **Sign out**.
2. Click **Organization settings** (it opens **Settings**, `/settings`), then each card's links.
3. Click **Sign out**.

**You should see:** **Settings** groups every setting in the product into **Organization**, **Accounting**,
**Sales**, **Inventory**, **Bill inbox**, **Connections** and **Audit** cards; signing out returns you to the
sign-in page.

**Try to break it:**
- Press the browser's Back button after **Sign out** → you stay on the sign-in page; protected pages redirect to it.

- [ ] Done

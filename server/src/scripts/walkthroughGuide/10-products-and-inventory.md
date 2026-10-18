# Products and inventory

Products & services are what invoices and expenses sell and buy. A product can also **Track inventory**: bills then
add stock at their cost, invoices issue it at the moving-average cost and book cost of goods sold, and every stock
movement posts to the ledger. Everything here posts, so use a scratch organization. The first time you track
inventory in an organization, inventory is set up silently.

## 1. Products and services

**Where:** **Products & inventory** → **Products & services** (`/products`)

**Do this:**
1. **⚠ scratch org** — open **Products & services** and click `New product or service`.
2. Choose `Service`, fill **Name** and **Code**, then under `I sell this` set **Sale price**, **Tax %** and
   **Revenue account**, and click **Create**.
3. Click `New product or service` again, choose `Product (goods you buy or sell)`, tick **Track inventory**, and
   fill both `I purchase this` (**Purchase price**, **Tax %**, **Expense account**) and `I sell this`.
4. Under **Quantity**, **Unit cost** and **As of** enter an opening stock of `10` units and click **Create**.
5. Use the tabs `Services`, `Non-inventory`, `Inventory` and `Fixed assets` and **Search**; click the **On hand**
   header to sort.
6. Click **Edit** on a row, change a price, and click **Save**.
7. On an untracked product click **Edit**, tick **Track inventory** and save: tracking starts from now only.
8. On a tracked product click `Open stock item`.
9. On a new invoice or expense, open a line's **Item** dropdown and choose `＋ New product or service…`; the dialog
   creates it and uses it on the line (**Create and use**).

**You should see:** the **On hand** column on tracked products, a `Inventory` type, and — after opening stock — a
opening-stock journal that debits {{account:1140}}. Untracked products show no quantity.

**Try to break it:**
- Type `12.5x` as a price → `Prices must be amounts like 12.50`.
- Type `150` as a tax rate → `Tax rates must be a percentage between 0 and 100`.
- Type `0` as the opening quantity → `Opening quantity must be a number above zero`.
- Give an opening quantity but no unit cost and no purchase price → `Enter a unit cost for the opening stock, or a purchase price`.
- Edit a product's code → the field is locked (`A code cannot change once created`).
- Choose `Service` → **Track inventory** disappears.

- [ ] Done

## 2. Stock on hand, receive, issue, adjust

**Where:** **Products & inventory** → **Stock movements** (`/inventory/movements`)

**Do this:**
1. **⚠ scratch org** — open **Stock on hand** and find the tracked product; use **Search**, **Category**, **Item type**,
   **Tracking**, `Low stock only` and `Show inactive`.
2. Open **Stock movements**. On the **Receive** tab choose **Date**, a **Location**, the reason under
   `Why is this stock arriving?` (`Opening stock` or `Found in a count`), search an item, enter **Quantity** and
   **Unit cost**, and click **Post**.
3. On the **Issue** tab pick the item and **Quantity**; leave `Charge to expense account` on
   `Inventory adjustments (default)` or choose an expense account; click **Post**.
4. On the **Adjust** tab enter a **Reason**, choose **Direction** `IN` or `OUT`, and click **Post**.
5. On the **Transfer** tab choose **From** and **To** locations (section 4) and click **Post**.
6. Open the item (`Open stock item`) and read **On hand**, **Movement history** (with `Bill`, `Invoice` or
   `Posted to ledger` links) and the running quantity.
7. Sell it: issue an invoice with that product (guide 06). Receive more by approving an expense with it (guide 07).

**You should see:** each posted movement gives a journal (receive debits inventory; issue debits the expense account
or cost of sales and credits inventory) and the movement history shows running quantity and value. An invoice line
issues stock at the moving-average cost and adds Dr cost of sales / Cr inventory to the same entry.

**Try to break it:**
- Issue more than is on hand → `Insufficient stock for item … at location …`.
- Date a movement in the future → `Movement date cannot be in the future`.
- Transfer to the same location → `Transfer needs two different locations`.
- Void an expense whose received stock you have already sold → `Stock received on this bill has since been issued: only … remain at location …`.
- Adjust OUT below zero → `Insufficient stock for item … at location …`.
- Receive into an inactive location → `Location is inactive`.

- [ ] Done

## 3. Serial and lot items

**Where:** **Products & inventory** → **Stock on hand** (`/inventory/items`)

**Do this:**
1. **⚠ scratch org** — open **Stock on hand** and click **New item**.
2. Fill **Name** and choose a **Category**, **Unit of measure**, **Tracking** `SERIAL`, and an item code under
   `Generate from scheme` or `Enter manually`; set **Sale price**, **Purchase price**, **Sales tax %** and
   **Purchase tax %**, then click **Create item**.
3. Open **Stock movements**, **Receive**, choose the serial item, type three serial numbers into
   **Serial numbers (one per line)**, enter a **Unit cost (fallback)**, and click **Post**.
4. Open the item. In **Serials** click **Hold** on an available serial, **Release** it, then **Book** it (add a
   **Note (optional)**, confirm with **Book**).
5. Create a second item with **Tracking** `LOT`; receive it with a **Lot number**, **Manufactured** and
   **Expires** date; issue from it by choosing the **Lot**.

**You should see:** each serial with its **Status** (`AVAILABLE`, `ON_HOLD`, `BOOKED`, `ISSUED`), **Location** and
**Cost**; a lot item lists **Lots** with **Expires** and **On hand**. A serial moves through a fixed set of
statuses; a serial that has left stock cannot be held.

**Try to break it:**
- Receive a serial number that is already in stock → `Serial … is already in stock`.
- Issue or transfer a serial that is `ON_HOLD` → `Serial … is on hold`.
- Issue a serial that already left → `Serial … is not in stock`.
- Receive a lot item without a lot → `Lot-tracked item … needs a lot`.
- Receive a serial item with fewer serials than units → `Serial-tracked item … needs one serial per unit`.
- Put a serial or lot item on an invoice line → `Line 1: item … is serial-tracked — lot/serial selection on invoice and bill lines is not supported yet; record it in Inventory`.

- [ ] Done

## 4. Locations

**Where:** **Products & inventory** → **Locations** (`/inventory/locations`)

**Do this:**
1. **⚠ scratch org** — open **Locations**.
2. Under `New location` fill **Code** (for example `WH2`), **Name**, **Inside** (`Top level` or a parent) and
   **Kind**, then click **Add location**.
3. Choose `Default location for invoices and bills` from the dropdown at the top.
4. Click **Deactivate** on a location, then **Activate**; click `Print label` on one.

**You should see:** the location tree with a **Status** column; with a default location set, invoice and expense
lines need no location choice. Without a default, each stock line asks for one.

**Try to break it:**
- Reuse an existing location **Code** → `Location code already exists`.
- Receive stock into a deactivated location → `Location is inactive`.
- Put a stocked product on an invoice line with no default location → `Choose a stock location for line 1`.

- [ ] Done

## 5. Catalogue and item codes

**Where:** **Settings** → **Inventory** → **Catalogue** (`/settings/inventory`)

**Do this:**
1. **⚠ scratch org** — open **Settings**, then **Catalogue** in the **Inventory** card.
2. Under `Units of measure` add a unit with **Code**, **Name** and **Decimal places** and click **Add unit**.
3. Under `Categories` add a category with a **Category code**, **Category name**, **Item type**, **Default tracking**,
   **Default unit** and **Parent category**, and click **Add category**.
4. Choose a category; under `Custom fields` pick `Item fields` or `Serial fields` and fill **Field key**,
   **Field label**, **Field type**, optional **Required**, and click **Add field**.
5. Open **Item codes** in the same card: use the builder buttons `Category`, `Year (YYYY)`, `Year (YY)`,
   `Attribute…` and `Sequence…`, watch the **Pattern** and its preview, type a **Scheme name**, tick
   **Make default**, and click **Save**.
6. Click **Make default** on another saved scheme; click `Use this` on a preset.

**You should see:** the new field on the item form for that category; new items with a generated code from the
default scheme, with the sequence counting up without gaps.

**Try to break it:**
- Add a unit with a duplicate **Code** → `Unit of measure code already exists`.
- Add a category with a duplicate code → `Category code already exists`.
- Save a pattern containing a token the grammar does not know → `Invalid code pattern: …` followed by the reason.
- Save a second scheme with an existing **Scheme name** → `Code scheme name already exists`.
- Set a custom field **Required**, then create an item without it → `Invalid attributes: Attribute "<label>" is required`.
- Create an item with a code that exists → `Item code already exists`.

- [ ] Done

## 6. Labels and lookup

**Where:** **Products & inventory** → **Labels** (`/inventory/labels`)

**Do this:**
1. **⚠ scratch org** — open **Labels**, type into `Search items or locations`, and add an item and a location.
2. Set **Copies**, choose a label **Size** (`Small 38 × 25 mm`, `Medium 50 × 30 mm`, `Large 100 × 50 mm`), click
   **Generate**, then **Print**.
3. Scan or open the QR code with a phone camera (it carries only a route and an id).
4. Open **Lookup**, type an exact item code, lot number, serial number or location code under `Scan or type a code`
   and press Enter.

**You should see:** a printable sheet of labels with QR codes; **Lookup** opens the matching item or location
directly, or lists several matches to choose from.

**Try to break it:**
- Look up a code that does not exist → `Nothing matches …`.
- Scan a serial or lot label whose record does not exist (an address ending in a made-up id) → `This label belongs to nothing in your organization.` with a **Back to lookup** link.

- [ ] Done

## 7. Valuation and the ledger

**Where:** **Products & inventory** → **Valuation** (`/inventory/valuation`)

**Do this:**
1. In the demo open **Valuation**.
2. Read the banner (`Stock ties to the general ledger.`) and the table of **Account**, **Stock value**,
   **General ledger**, **Difference** and **Action**.
3. **⚠ scratch org** — click **Edit** on a tracked product, open `Inventory accounts`, change **Inventory asset account**
   to another asset account, and click **Save**.
4. Return to **Valuation**: if value now sits on an old account, a section `Value on an old account` offers
   **Move to current accounts**.
5. If an inventory item was created without a product, `Items not linked to Products & Services` offers **Link all**.
6. If the ledger and stock still differ, click **True up** and confirm with **True up**.
7. Open **Settings** → **Financial** and find `Inventory accounting`: **Inventory**, **Cost of sales** and
   **Inventory adjustments** each have an `AccountSelect`.

**You should see:** a tied account has no **Action**; **Move to current accounts** posts a value-only reclass pair
(stock quantity is untouched); **True up** posts a journal dated today that moves the ledger to the stock value,
never the reverse, and leaves the entries that caused the difference in place. Changing the default inventory
account moves existing stock value to it with a journal dated today.

**Try to break it:**
- Post a manual journal line to {{account:1140}} → `Account 1140 is an inventory control account — its balance comes from stock movements. Record stock through bills, invoices or Inventory, or reconcile it under Inventory → Valuat…` (the message continues).
- Run `cd server && npm run verify:integrity` after all this → the stock-versus-ledger check still passes.

- [ ] Done

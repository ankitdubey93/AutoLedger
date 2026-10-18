# Bill inbox

Upload a vendor bill or receipt and the product reads it for you: local OCR, personal data masked in the page image
before anything leaves the machine, then a vision model extracts the fields. The result waits in a review queue and
becomes a real expense when you post it.

This guide is optional. Extraction needs a vision-model key (`ANTHROPIC_API_KEY`, or `CAPTURE_AI_PROVIDER=gemini`
with `GEMINI_API_KEY`) in `server/.env`, with the server and the worker restarted (see the README). Without a key
uploads still work, but extraction cannot run and the server answers `Vision extraction is not configured (ANTHROPIC_API_KEY is unset)`
(or `GEMINI_API_KEY` for Gemini). Posting a document changes the books, so do the posting steps in a scratch
organization.

## 1. Upload a bill

**Where:** **Purchases** → **Bill inbox** (`/inbox`)

**Needs:** a vision-model key as described above, and the worker running (`./dev.sh` starts it).

**Do this:**
1. **⚠ scratch org** — open **Bill inbox**.
2. Click **Choose files** and pick a PDF, PNG or JPEG invoice (up to 10 MB), or drag it onto the dashed area.
3. Watch the file's line change from `Uploading…` to `Captured`.
4. Use **Status** to filter the list; the document moves through `Pending`, `Processing` and `Extracted`.
5. Alternatively pick a file already in the vault from `Choose a vault document…` and click **Capture**.

**You should see:** a row with the **Filename**, its **Status**, **Posting**, **Pages** and **Captured** time, and a
**View** link. The upload panel says PDF, PNG and JPEG only.

**Try to break it:**
- Upload a `.txt` file (choose `All files` in the file picker if it hides it) → the line shows `Unsupported file type. Allowed: PDF, PNG, JPEG`.
- Upload the same file twice → both uploads say `Captured`, but the second row appears with the status
  `Possible duplicate` and no extraction runs for it (section 3).
- Capture a vault document that is already in the inbox → `This document is already in the bill inbox`.

- [ ] Done

## 2. Review and post

**Where:** **Purchases** → **Review queue** (`/inbox/review`)

**Do this:**
1. **⚠ scratch org** — open **Review queue** (documents with the most attention needed come first) and click
   **Review** on a row. Alternatively click **View** in the inbox list.
2. On the document page read the **Vendor**, **Invoice number**, **Invoice date**, **Due date**, **Currency**,
   **Subtotal**, **Tax** and **Total** with their confidence percentages, and the line items.
3. Open the `Redacted preview — this is the image sent to the model` and check that personal data is masked.
4. Pick an account for every line item that has none.
5. Click **Post to ledger** and confirm with **Post**.
6. Open the posted document and follow **View expense** (or **View journal entry**).

**You should see:** `Posted to the ledger` with a link to the new expense, which is a real approved expense in
Purchases, and a **Source document hash at posting**. The model-calls panel shows tokens, latency and cost for each
call.

**Try to break it:**
- Post a document with a line that has no account → the button is blocked with `Every line item needs an account before this can be posted.`
- Post a document whose extraction has no invoice number → `This document needs an invoice number before it can be posted`.
- Post a document whose lines and tax do not add up → `Extraction totals do not reconcile — re-extract before posting` (the page flags `Arithmetic does not check out`).
- Post a bill whose invoice number you already entered for that vendor → `A bill with this invoice number already exists for this vendor`.
- Open a document address with a made-up id → `Document not found.`

- [ ] Done

## 3. Re-extract and duplicates

**Where:** **Purchases** → **Bill inbox** → a document (`/inbox`)

**Do this:**
1. **⚠ scratch org** — open the `Possible duplicate` row from section 1.
2. Read `This file's content matches an earlier capture`, then click `Not a duplicate — process it` and confirm
   with **Process it**.
3. On an `Extracted` document click **Re-extract** and confirm with **Re-extract**.

**You should see:** the duplicate moves into the normal pipeline and is extracted like any other capture; a
re-extraction replaces the previous extraction, including any account choices you made.

**Try to break it:**
- Re-extract a document that is already posted → there is no **Re-extract**; the server refuses with `Cannot re-extract a document in status POSTED`.
- Edit a line item on a posted document → `Cannot edit line items on a document in status POSTED`.

- [ ] Done

## 4. Auto-post and AI usage

**Where:** **Settings** → **Bill inbox** → **Auto-post** (`/settings/inbox`)

**Do this:**
1. **⚠ scratch org** — open **Settings**, then **Auto-post** in the **Bill inbox** card.
2. Tick `Post automatically when every check passes`, set **Minimum confidence** and **Auto-post limit (base currency, blank for none)**, and click **Save**.
3. Upload a clean invoice (section 1).
4. Open **AI usage** (the link on the **Bill inbox** page) and read the totals.

**You should see:** `Saved`; a document that passes every check posts itself and says `Posted automatically`; one
that fails any check stays in the review queue with `Why this wasn't posted automatically`. **AI usage** shows
**Calls**, **Input tokens**, **Output tokens**, **Total tokens** and **Cost**, by model, by purpose and by day. A
model with no verified price shows its real tokens and no cost rather than an invented one.

**Try to break it:**
- Enter `0.2` as **Minimum confidence** → `Minimum confidence must be between 0.5 and 1`.
- Enter `abc` as the limit → `Enter an amount like 1500.00, or leave it blank for no limit`.

- [ ] Done

## 5. Email bills in

**Where:** **Settings** → **Bill inbox** → **Auto-post** (`/settings/inbox`)

**Needs:** `INBOUND_MAIL=brevo`, `INBOUND_MAIL_DOMAIN` and `INBOUND_MAIL_WEBHOOK_SECRET` in `server/.env`, a Brevo
inbound-parsing route pointing at the server, and a restart of the server and the worker. This is the part of the
guide least likely to work on a laptop; skip it if you cannot receive public webhooks.

**Do this:**
1. Open **Auto-post** and find the card `Email bills in`.
2. Click **Copy** to copy the organization's address.
3. Forward a vendor bill (PDF, PNG or JPEG attachment) to it.
4. Click **Generate new address** and confirm with **Generate new address**.

**You should see:** the forwarded attachment arrives in the bill inbox like a direct upload, and the recent-emails
table lists it with a **Status** of `Received`, `Imported`, `Partly imported`, `Rejected` or `Failed`. With the
feature off the card has no address.

**Try to break it:**
- Send mail to the old address after generating a new one → it is no longer accepted (the dialog warns
  `The current address will stop working.`).
- Forward a message with only a `.txt` attachment → no document appears in the inbox; the message is listed in the table but not as `Imported`.

- [ ] Done

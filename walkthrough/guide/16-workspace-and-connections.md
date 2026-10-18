# Workspace and connections

The document vault, outbound webhooks, Google Drive folder intake and the organization's email settings.

## 1. Document vault

**Where:** **Workspace** → **Documents** (`/documents`)

**Do this:**
1. **⚠ scratch org** — open **Documents**.
2. Choose a PDF, PNG, JPEG or CSV with the file picker at the top of the page.
3. Filter by **Area** and **Record type**.
4. Click **Download** and open the file.
5. Attach the file to an invoice or expense with `Choose from Documents` under **Attachments** (guides 06 and 07), then
   return to the vault.
6. Click **Delete** on an unattached file and confirm with **Delete**.

**You should see:** **Filename**, **Type**, **Size**, **Uploaded by**, **Uploaded** and an **Attachments** count; a
file with attachments shows a greyed `Delete` that says `Detach from all records before deleting`.

**Try to break it:**
- Upload a `.txt` file → `Unsupported file type. Allowed: PDF, PNG, JPEG, CSV`.
- Delete a file that is still attached (through the API) → `Detach this document from every record before deleting it`.
- Attach the same file to the same record twice → `This document is already attached to that record`.

- [ ] Done

## 2. Webhooks

**Where:** **Settings** → **Connections** → **Webhooks** (`/settings/webhooks`)

**Needs:** the worker running (`./dev.sh` starts it) and a receiver reachable at a public `https` URL, for example a
free request-bucket service. The server refuses `localhost` and private addresses, so a local `nc -lk` listener
cannot be used.

**Do this:**
1. **⚠ scratch org** — open **Webhooks** and click **New endpoint**.
2. Type a **Label** and your receiver's **URL**, tick events under **Events** (for example `Invoice issued`), and click
   **Create endpoint**.
3. Copy the secret shown, then click `I've stored it`.
4. Issue an invoice (guide 06). Open **Webhook deliveries** (`/settings/webhooks/deliveries`) and filter by
   **Endpoint**, **Status** and **Event**.
5. On a `Failed` delivery click **Retry** and confirm with **Retry**.
6. Back on **Webhooks** click **Rotate secret**, confirm with **Rotate**, and store the new one; then **Deactivate**
   and **Reactivate** the endpoint.

**You should see:** a delivery per event with **Attempts** and the response **Code**; the receiver sees headers
`X-AutoLedger-Event` and `X-AutoLedger-Signature`.

**Try to break it:**
- Use `ftp://example.com/hook` → `Webhook URL must use https`.
- Use `http://localhost:9999/hook` → `Webhook URL must not target a private host`.
- Use a URL with a user name and password → `Webhook URL must not contain credentials`.
- Create a second endpoint with the same URL → `A webhook endpoint with this URL already exists`.
- Open **Webhooks** as a non-admin → `Only an owner or admin can manage webhooks.`

- [ ] Done

## 3. Google Drive (optional)

**Where:** **Settings** → **Connections** → **Google Drive** (`/settings/connections`)

**Needs:** `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` in `server/.env` (see the README),
the server and worker restarted, and a Drive folder shared with the service account.

**Do this:**
1. **⚠ scratch org** — open **Connections**. Without the variables the page says `Google Drive intake is not configured on this server.`
2. Click **Copy** to copy the service-account address, share a Drive folder with it, then click
   `Connect with service account`.
3. Under `Watched folders` choose what is in the folder: `Vendor bills (bill inbox)` or `Bank statements (banking)`
   (then pick the **Bank account** and **Statement date format**), paste the folder link, and click **Add folder**.
4. Drop a PDF invoice into the folder and click **Sync now**.
5. Click **Remove** on the folder and **Disconnect** the connection.

**You should see:** the file appears in the bill inbox (guide 08) or the bank lines (guide 09) within about a minute,
imported once only.

**Try to break it:**
- Click **Add folder** with an empty link → `Paste a Google Drive folder link or ID`.
- Choose `Bank statements (banking)` with no account → `Choose the bank account this folder's statements belong to`.

- [ ] Done

## 4. Organization email

**Where:** **Settings** → **Organization** → **Email** (`/settings/email`)

**Do this:**
1. Open **Settings**, then **Email** in the **Organization** card.
2. Set **Sender name** and **Reply-to address**, then click **Save**.
3. Invite a member (guide 02) or email a statement (guide 06) and read the message in Mailpit or the worker log.

**You should see:** `Saved.`, and a line saying how mail is delivered (`Emails are delivered through Brevo.`,
`Development: emails are caught by the local Mailpit inbox, not delivered.` or `Development: emails are written to
the server log, not delivered.`).

**Try to break it:**
- Open the page as a non-admin → `Email settings are managed by owners and admins.`
- Enter an invalid address as **Reply-to address** → the save is refused with the server's validation message.

- [ ] Done

# Sign in and account

Everything that belongs to you, whichever organization is active. Organization settings are in guide 02.

## 1. Sign in

**Where:** **Sign in** page (`/login`)

**Do this:**
1. Open `http://localhost:5173/login` while signed out.
2. If the **Explore the demo company** card is shown, click **Open the demo**.
3. Otherwise type `demo@autoledger.dev` into **Email**, `autoledger-demo` into **Password**, and click **Sign in**.

**You should see:** the dashboard for Harbor Point Fabrication. The top bar shows the organization name, and signing
in again opens the organization you used last.

**Try to break it:**
- Sign in with a wrong password → the form shows `Invalid email or password`, the same message for an unknown email.
- Open `/invoices` while signed out → you are sent to the sign-in page and, after signing in, back to `/invoices`.

- [ ] Done

## 2. Register a new organization

**Where:** **Create your organization** page (`/register`)

**Do this:**
1. Sign out, then open `/register` (the **Create one** link on the sign-in page).
2. Fill **Organization name**, **Your name**, **Email** and **Password**, then click **Create account**.

**You should see:** you are signed in as the owner of a new, empty organization and the setup wizard opens
(guide 02, section 2).

**Try to break it:**
- Use a password shorter than 8 characters → the browser refuses the field (the page says "At least 8 characters.").
- Register with an email that already has an account → the page shows `An account with that email already exists` and creates nothing.

- [ ] Done

## 3. Reset a forgotten password

**Where:** **Sign in** page → **Forgot password?** opens **Reset your password** (`/forgot-password`)

**Needs:** with the default `MAIL_TRANSPORT=log` the reset link is written to the worker's log (the worker sends
email). Set `MAIL_TRANSPORT=mailpit` to read it at `http://localhost:8025` instead.

**Do this:**
1. On the sign-in page click **Forgot password?**.
2. Enter the email of an account you created in section 2 and click **Send reset link**.
3. Copy the `/reset-password?token=…` link from the worker log (or the Mailpit message) into the browser.
4. Enter **New password** and **Confirm new password**, then click **Set new password**.
5. Click **Sign in with your new password**.

**You should see:** `Check your email` after step 2 (the same text whether or not the address has an account), then
`Password updated`. Every device that was signed in is signed out.

**Try to break it:**
- Open the same reset link a second time → `This reset link is invalid or has already been used`, with a
  **Request a new link** link.
- Type two different passwords → `The two passwords do not match`, nothing is saved.
- Open `/reset-password` with no token → `The reset link is missing its token.`

- [ ] Done

## 4. Verify your email

**Where:** the banner above every page, then **Account settings** → **Profile** (`/account`)

**Needs:** the same mail setup as section 3 to read the verification link.

**Do this:**
1. While signed in as an account whose email is not verified, find the banner `Please verify … — we sent you a link.`
2. Click **Resend it** (it opens the **Profile** tab), then click **Send verification email**.
3. Open the link from the log or Mailpit and click **Verify my email**.

**You should see:** `Verification email sent — check your inbox.`, then `Your email is verified.` and the banner
disappears. The **Profile** tab shows **Email verified**.

**Try to break it:**
- Open the verification link a second time → `This verification link is invalid or has already been used`.
- Click **Dismiss** on the banner and reload → the banner stays hidden for the browser session only.

- [ ] Done

## 5. Profile and sign-in email

**Where:** **Account settings** → **Profile** (`/account`)

**Do this:**
1. Open the user menu in the top bar and choose **Account settings**.
2. Change **Name** and click **Save**.
3. Click **Change email**, enter **New email** and **Current password**, then click **Send confirmation link**.
4. Open the link from the log or Mailpit and click **Confirm new email**.

**You should see:** `Saved.` after step 2; after step 3 `We sent a confirmation link to …` and your sign-in email stays
as it was until step 4; afterwards `Your sign-in email has been changed.`

**Try to break it:**
- Enter a wrong **Current password** in step 3 → `Your current password is incorrect` and no email is sent.
- Enter your current address as **New email** → `That is already your sign-in email`.
- Open the confirmation link twice → `This link is invalid or has already been used`.

- [ ] Done

## 6. Change your password

**Where:** **Account settings** → **Password** (`/account?tab=password`)

**Do this:**
1. Open the **Password** tab.
2. Enter **Current password**, **New password** and **Confirm new password**, then click **Change password**.

**You should see:** a success message; every other device you are signed in on is signed out.

**Try to break it:**
- Type two different new passwords → `The two new passwords do not match.` and nothing is sent.
- Enter a wrong **Current password** → `Your current password is incorrect` and the password is unchanged.
- Reuse your current password as the new one → `Choose a password different from your current one`.

- [ ] Done

## 7. Email notifications

**Where:** **Account settings** → **Notifications** (`/account?tab=notifications`)

**Do this:**
1. Open the **Notifications** tab.
2. Toggle each of **Bills awaiting approval**, **Invitations accepted** and **Quotes accepted or declined**.
3. Reload the page.

**You should see:** the page notes it applies to every organization you belong to and that security emails are always
sent; your toggles are still set after the reload.

**Try to break it:**
- Look for a switch for password-reset or verification emails → there is none; security emails cannot be turned off.

- [ ] Done

## 8. Sessions and sign-in history

**Where:** **Account settings** → **Sessions** (`/account?tab=sessions`)

**Do this:**
1. Sign in to the same account in a private window so there are two sessions.
2. In the first window open the **Sessions** tab. The current one is tagged **This device**.
3. Click **Sign out** next to the other session, or **Sign out of all other sessions**.
4. Scroll to **Recent sign-ins**.

**You should see:** the other session disappears from the list; **Recent sign-ins** lists `Signed in`, `Signed out`
and `Session revoked` events with time and address.

**Try to break it:**
- Sign out of a different browser's session, then use that browser → once its short-lived access token expires its
  refresh is refused and it is sent to the sign-in page with `This session was signed out` (**Refresh now** under **Token details (developer)** forces
  the refresh).
- Sign out and enter a wrong password three times, then sign in correctly → **Recent sign-ins** shows three
  `Failed sign-in` entries.

- [ ] Done

## 9. Service status

**Where:** **Account settings** → **Status** (`/account?tab=system`)

**Do this:**
1. Open the **Status** tab.

**You should see:** `All systems operational`, the database latency, how long the API has been up and its version.

**Try to break it:**
- Stop the server (Ctrl-C the `./dev.sh` server process) and reload the tab → `Could not reach the service: …`.

- [ ] Done

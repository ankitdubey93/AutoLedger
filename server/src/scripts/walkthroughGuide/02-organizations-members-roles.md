# Organizations, members and roles

Every organization is a separate set of books. Nothing crosses between them.

## 1. Add an organization

**Where:** organization menu in the top bar → **Add organization** opens **Add an organization** (`/organizations/new`)

**Do this:**
1. Click the organization name at the right of the top bar.
2. Choose **Add organization**.
3. Enter **Organization name** and click **Create and set up**.

**You should see:** the new organization becomes the active one and its setup wizard opens (section 2). The menu now
lists both organizations, each with your role in it.

**Try to break it:**
- Click **Cancel** on the form → nothing is created.
- Keep adding organizations → after a few the server refuses with `You can own at most … organizations`.

- [ ] Done

## 2. The setup wizard

**Where:** **Set up AutoLedger** (`/onboarding`), shown automatically for a new organization

**Do this:**
1. On **Workspace**, check **Organization name**, optionally add **Legal name (optional)**, pick **Industry**, click
   **Next**.
2. On **Financial year**, choose **Base currency**, **Fiscal year starts in**, **Day**, **Books start date** and
   **Cash account for the dashboard**, click **Next**.
3. On **Review**, check the summary and click **Finish**.

**You should see:** the dashboard of the new organization, with a **Finish setting up** card until the optional
inventory step is done. **Skip for now** leaves a banner `Setup was skipped. Some features need it.` with a
**Finish setup** link.

**Try to break it:**
- Open `/invoices` in a new organization before finishing setup → you are sent back to the wizard.

- [ ] Done

## 3. Switch and list organizations

**Where:** **Account settings** → **Organizations** (`/account?tab=organizations`)

**Do this:**
1. Open the organization menu and choose another organization row (shown as `name · role`).
2. Open the menu again and choose **Manage organizations**.

**You should see:** the top bar changes to that organization and every list reloads with its data. The
**Your organizations** table shows each organization with **Your role**, **Joined** and a **Current** tag on the active one; the
other rows have **Switch**.

**Try to break it:**
- Sign out and back in → you land in the organization you used last.

- [ ] Done

## 4. Leave an organization

**Where:** **Account settings** → **Organizations** (`/account?tab=organizations`)

**Do this:**
1. Create a scratch organization (section 1) so you have at least two.
2. On **Your organizations** make the scratch organization current, then click **Leave**.
3. Confirm with **Leave organization**.

**You should see:** you lose access to that organization straight away and the other organization becomes current.

**Try to break it:**
- Try to leave your only organization → **Leave** is disabled with the hint `You cannot leave your only organization`
  (the server refuses with `This is your only organization — create or join another before leaving it`).

- [ ] Done

## 5. Organization general settings

**Where:** **Settings** → **Organization** → **General** (`/settings/general`)

**Do this:**
1. Open **Settings** from the sidebar, then the **General** link in the **Organization** card.
2. Change **Organization name**, **Legal name**, **Industry**, **Tax registration number** or
   **Business registration number**, then click **Save**.

**You should see:** `Saved.` and the new name in the top bar. **Base currency** is shown for reference.

**Try to break it:**
- As a `VIEWER` (section 10) open `/settings/general` and click **Save** → `This action needs the "Change organization and accounting settings" permission.`

- [ ] Done

## 6. Invite a member

**Where:** **Settings** → **Organization** → **Members & invitations** opens **Members** (`/settings/members`)

**Needs:** with the default `MAIL_TRANSPORT=log` no email arrives; copy the link from the page instead.

**Do this:**
1. Open **Members & invitations**.
2. Under **Invite someone** enter **Email**, choose **Role**, and click **Create invitation**.
3. Click **Copy** next to **Invitation link**.

**You should see:** `Invitation emailed to …` with the link (shown only once). The invitation appears under
**Pending invitation** with its **Role**, **Invited by** and **Expires** (7 days).

**Try to break it:**
- Invite an address that is already a member → `… is already a member of this organization`.
- Invite the same address twice → `… already has a pending invitation — revoke it to send a new one`.
- Click **Revoke** on a pending invitation, then open its link → `This invitation has been revoked`.

- [ ] Done

## 7. Accept an invitation

**Where:** the invitation link (`/invite/:token`)

**Do this:**
1. Open the copied link in a private window.
2. Either click **Sign in** (if the invited email already has an account) or **New to AutoLedger? Create an account**.
3. Signed in as the invited address, click the button labelled `Join` followed by the organization's name.

**You should see:** you are now a member with the invited role, and the organization appears in your organization
menu. The inviter gets an `Invitations accepted` email if they enabled it (guide 01, section 7).

**Try to break it:**
- Open the link while signed in as a different email → the page says it was sent to the other address and offers
  **Sign out**; the server refuses with `This invitation was sent to … — sign in with that address to accept it`.
- Open the same link after joining → `This invitation has already been used`.

- [ ] Done

## 8. Change a role and remove a member

**Where:** **Settings** → **Organization** → **Members & invitations** opens **Members** (`/settings/members`)

**Do this:**
1. In the **Members** table change the role select of another member (its label is `Role for <email>`).
2. In their private window, click any page.
3. Back as the owner, click **Remove** on that member and confirm.

**You should see:** the new role applies on the member's very next click, with no sign-out. After removal their next
request is refused and the organization disappears from their menu.

**Try to break it:**
- As the only owner, look at your own row → there is no **Remove** and the role is locked; trying through the
  server gives `An organization must keep at least one owner — make someone else an owner first`.
- Demote the only other owner while you are the only one left → the same refusal.

- [ ] Done

## 9. Custom roles

**Where:** **Settings** → **Organization** → **Roles & permissions** (`/settings/roles`)

**Do this:**
1. Click **New role**.
2. Enter **Role name**, optionally **Start from** `Viewer (read only)`.
3. Tick extra permissions in the groups below (for example `View invoices`), then click **Create role**.
4. On **Members & invitations** give a member that role.

**You should see:** the role under **Custom roles** with its permission and member counts; **Built-in roles** shows
the four fixed ones. The member's sidebar loses every entry their role cannot view.

**Try to break it:**
- Save a role with no permissions → `A role needs at least one permission`.
- As a non-owner try to tick a permission you do not hold → the box is disabled with `you don't have this`; owner-only
  permissions are disabled with `owner only`.
- **Delete** a role that still has members → the button is disabled with `Give its members another role first`.

- [ ] Done

## 10. A viewer cannot act

**Where:** **Expenses** (`/expenses`)

**Do this:**
1. **⚠ scratch org** — as owner create an expense, click **Submit for review**.
2. Give a second user the built-in `VIEWER` role (section 6) and sign in as them in a private window.
3. Open `/expenses` and then that expense.

**You should see:** the viewer can read the expense but the page has no **Approve**, no **Submit for review**, no
**Void**; the **New** menu in the top bar is absent.

**Try to break it:**
- As the viewer, open `/expenses/new` and try to save a draft → `This action needs the "Create, edit and submit expenses" permission.`
- Remove the viewer from the organization while their tab is open, then click anything in it → `You are no longer a member of this organization`.
- Open `/settings/members` as the viewer → `Your role (VIEWER) does not include viewing members.`

- [ ] Done

## 11. Organizations never see each other's data

**Where:** **Invoices** (`/invoices`)

**Do this:**
1. In the demo organization open any invoice and copy its URL from the address bar.
2. Switch to a different organization through the organization menu.
3. Paste the copied URL.

**You should see:** `Invoice not found.` — the other organization's invoice does not exist there.

**Try to break it:**
- Change the id in the URL to garbage → the same `Invoice not found.`
- Look for the demo's customers in the scratch organization → the list is empty.

- [ ] Done

# Derived system-account roles vs a stored flag

> A "system account" (receivable, payable, rounding…) is a role computed from configuration at read time, not a column on the account, so the badge and the lock can never disagree with where postings actually go.

**Category:** Architecture · PostgreSQL
**Introduced by:** Phase 46a — protecting the accounts the system posts to from being retired, and showing which ones they are
**Verified against:** PostgreSQL 16, Node 22, TypeScript strict. Xero comparison is from its public help documentation as I understand it; treat the exact list of Xero system accounts and which of their properties are editable as unverified.

---

## Mechanism

**The problem.** Postings go to accounts chosen by resolvers: "use the settings column if set, otherwise the account with the default code" (for example AR is `ledger_invoice_settings.receivable_account_id`, else code `1120`). We wanted to (a) mark those accounts in the chart and (b) refuse to retire them, because a retired account breaks the next posting.

**Derived, not stored.** `config/systemAccounts.ts` is a registry of 16 roles. Each role has a `defaultCode` and an optional settings column. `systemAccountService.resolveSystemAccountsOnClient` runs two org-scoped queries:

1. One read of the 13 settings columns, joining `organizations` to `ledger_settings` and `ledger_invoice_settings`. The two LEFT JOINs mean an org with no settings row still yields one row of NULLs.
2. One read of `accounts WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR code = ANY($3::text[]))`, covering configured ids and default codes in a single round trip.

Per role it picks the configured id if non-null, else the default-code account, else null. `rolesForAccountsOnClient` inverts that map (accountId to roles, in registry order). Two roles can land on the same account: `OPENING_BALANCE` and `STOCK_OPENING` both default to `3400`, so one account can carry two roles. The error message joins labels: "Historical adjustment and Opening stock is a system account and cannot be retired".

**The lock.** `accountService.updateAccount` looks up the account's derived roles and, if there is any, refuses `isActive: false` and a bank/credit-card flag with a 422. Renaming, description and parent stay allowed. Settings writes (`updateSettings`, `updateInvoiceSettings`) call `assertActiveAccountsOnClient` so a role can't be pointed at an account that is already retired. Remapping moves the role: once receivable points at a new account, `1120` holds no role and can be retired, and the new account is locked.

**Why a stored flag drifts.** A column such as `accounts.system_role = 'RECEIVABLE'` is a second copy of a fact that already lives in the settings table. The two copies change in different places (the settings PATCH vs. whatever maintains the flag), in different transactions, and by different code paths (imports, the seeder, future resolvers). Any miss leaves the badge on the wrong account while postings go to another, and the lock then protects the wrong account. Derived state has one source of truth. See [derived-vs-stored-state.md](derived-vs-stored-state.md) for the same argument applied to settlement.

**The parity test is the proof.** Deriving is only correct if the registry computes the same answer as the code that actually posts. `systemAccounts.test.ts` calls the real resolvers on one transaction client (`invoiceService.resolvePostingAccounts`, `resolveApPostingAccountsOnClient`, `resolveInventoryPostingAccountsOnClient`, `paymentService.resolveControlAccount`, `depositService.resolveDepositAccountsOnClient`) and asserts they equal the registry's answer, both on the default chart and after remapping through the API. It deliberately did not rewrite the roughly twelve existing resolvers to call the registry; the test pins the two implementations together instead. A mismatch is a finding about a resolver, never a reason to edit the registry to match.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Stored `accounts.system_role` column | Cheap to read, one migration. Duplicates the settings fact; drifts on remap; needs a backfill and a hand-maintained write path | Rejected |
| Derived roles + service-layer lock (chosen) | Two extra queries per account list or update; zero drift; no migration for the roles themselves | Chosen |
| DB trigger refusing `is_active = false` on a system account | Enforced for any writer | Rejected: the trigger would have to re-implement the settings-or-default-code resolution in plpgsql, a third copy of the rule |
| Rewrite every resolver to call one shared function | Single implementation | Rejected for this phase: wide blast radius across posting code; the parity test gets most of the safety |
| Fixed, non-remappable system accounts (Xero's model) | Simplest; no resolution logic | Rejected: this product already lets settings remap FX, inventory and deposit accounts |

Rule references: [guardrails.md](../../docs/guardrails.md) rule 2 (the logic lives in `services/`), rule 12 (roles are not a sixth account type), rule 13 (nothing here edits an applied migration; the only migration is seeding `6830 Rounding`).

## Where it lives in this codebase

- `server/src/config/systemAccounts.ts` — the 16-role registry (`as const satisfies readonly SystemAccountRoleDef[]`), `SystemAccountRole` derived as a union from it.
- `server/src/services/accounting/systemAccountService.ts` — `resolveSystemAccountsOnClient`, `rolesForAccountsOnClient`, `listSystemAccounts`, `assertActiveAccountsOnClient`.
- `server/src/services/accounting/accountService.ts` — `updateAccount` (the lock) and `systemRoles` decoration on every `Account` returned.
- `server/src/services/accounting/settingsService.ts`, `invoiceSettingsService.ts` — retired-account refusal on remap.
- `GET /api/v1/accounts/system` — one row per role with its effective account.
- `server/src/__tests__/accounting/systemAccounts.test.ts` — parity, lock and cross-tenant tests.
- `client/src/components/ui/SystemAccountBadge.tsx`, `Pages/settings/FinancialSettingsPage.tsx` — the badge and the "System accounts" panel.

## Gotchas

- **Check-then-act.** The lock reads roles, then writes. A concurrent settings remap between the read and the UPDATE could in principle let a just-demoted or just-promoted account slip through for one request. Posting to a retired account fails loudly (422), so the cost is a refused posting, not silent corruption; a row lock on the settings row would close the window if it mattered.
- **A role can resolve to nothing.** If neither the setting nor the default code exists (an imported chart without `1140`), the role is null and the view says "Not set up". No account is locked for it.
- **The resolvers don't all agree on edge cases.** The inventory resolver also returns null on a type mismatch; the registry does not check type. The parity test only uses valid accounts, so it proves agreement on valid configuration, not on every malformed one.
- **Two settings columns aren't remappable via the API.** `payable_account_id` and `tax_input_account_id` aren't in `updateSettings`' column map, so `remappable: false` is true to the code, but they still resolve from the column if set directly.
- **Two roles on one account.** Don't assume one label per account; join them.
- **Lock is service-level.** A raw SQL `UPDATE accounts SET is_active = false` bypasses it. That is the deliberate cost of not using a trigger.

## Interview Q&A

**Q: Why not add a `system_role` column to `accounts`?**
A: It would duplicate a fact the settings table already holds. Users can remap which account is the receivable account, so the column has to be rewritten in the same transaction as every remap, by every code path that touches settings, imports and seeders included. Miss one and the badge and lock point at an account postings no longer use. Deriving the role from the settings-or-default-code rule on read has one source of truth and nothing to backfill.

**Q: How do you know the derived roles match what the posting code actually does?**
A: A parity test. It runs the real posting resolvers on one transaction client and compares their output with the registry for every role, on a fresh org and after remapping receivable and unrealized FX through the real API. We did not refactor the resolvers to share code; the test pins two implementations together, which is cheaper and safer than touching posting paths, at the cost that a new resolver needs a new parity case.

**Q: Why enforce the lock in the service rather than a database trigger?**
A: The rule is "the account this org's settings currently point at, or the default-code account if unset". A trigger would need to replicate that resolution across 13 settings columns in plpgsql, a third copy of the logic that would silently diverge. The trade-off is that direct SQL can bypass the check; in this codebase all writes go through services (rule 2), and the invariants that must hold against any writer, such as double-entry balance and posted-row immutability, remain in triggers.

**Q: How does a system account differ from Xero's?**
A: As I understand Xero's documentation, its system accounts (receivable, payable, retained earnings, rounding, historical adjustment, realised/unrealised currency gains and others) are fixed by the product, and can't be deleted or archived. Ours are remappable for most roles, so "which account is the system account" is itself configuration, and the lock has to follow the configuration. That is the reason the roles are derived. I wouldn't quote exact Xero behaviour without checking its docs.

**Q: What happens if the user remaps receivable to a new account?**
A: Next read, the new account carries the RECEIVABLE role and is locked; `1120` carries none and can be retired. No data migration happens. Existing posted journals aren't affected because ledger lines reference account ids, and retiring only blocks new postings.

**Q: Tell me about a time you had to decide between storing and deriving a value.**
A: For Phase 46a I weighed a `system_role` column against computing it. The deciding fact was that settings already let users move FX, inventory and deposit accounts, so a stored flag would need to follow every remap. I derived it and wrote a parity test against five real resolvers. The same reasoning is why invoice settlement is derived from allocation rows rather than stored.

## Follow-ups they'll dig into

- What does listing accounts cost now? Two extra queries per list or update, independent of chart size, since the role lookup is by org, not per account. Could be cached per request.
- What if two requests race, one remapping and one retiring? See the check-then-act gotcha; the failure mode is a refused posting, and a `FOR UPDATE` on the settings row would serialise them.
- Why is a registry `as const satisfies` and not an enum or table? The role union type is derived from the data, so adding a role is one edit and the compiler flags the typed `Record<SystemAccountSettingColumn, …>` map if a column is missing.

## See also

- [derived-vs-stored-state.md](derived-vs-stored-state.md)
- [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md)
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md)

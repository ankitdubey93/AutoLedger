# Recording failed logins

> A failed sign-in is evidence that must survive the very transaction that rejects it, and the code that records it must never be able to make the rejection worse.

**Category:** Security · PostgreSQL · Node/Express
**Introduced by:** Phase 46d — sign-in history and per-member activity
**Verified against:** Node 22, PostgreSQL 16, `pg` pool

---

## Mechanism

`authService.login` runs inside one transaction: `BEGIN`, look the user up, compare the password, issue a session, `COMMIT`. A wrong password throws `ApiError(401)`; the `catch` issues `ROLLBACK` and rethrows. Anything INSERTed on that transaction's client before the throw is rolled back with it. So a `FAILED` row written on the client would vanish exactly when it matters.

The fix is ordering and connection choice: the success event is written on the transaction's client (it should commit or roll back with the session it describes), but the failure event is written **after** `ROLLBACK`, on the pool, which takes a different connection and autocommits. The user id found during the lookup is hoisted into a variable above the `try` so the `catch` can still name the account (or `null` for an unknown email).

The logging function swallows its own errors. If the `INSERT` fails (disk, constraint, pool exhaustion), the error is logged and the original `401` is rethrown unchanged. Otherwise an unavailable audit table would turn "wrong password" into a 500, which both breaks login and tells an attacker something.

**Timing.** The unknown-email path already runs a bcrypt compare against a dummy hash so both failure paths cost about the same. The extra pool INSERT happens on both (known user, wrong password; unknown user), so it adds the same latency to each and does not reopen an enumeration oracle.

**Append-only without blocking cascades.** The table is protected by a `BEFORE UPDATE` row trigger only. A `BEFORE DELETE` trigger would fire during the `ON DELETE CASCADE` from `users` or `organizations` and refuse it, so deleting a user would fail. Hard `DELETE` is therefore possible at the SQL level and relied on only for cascades; no service deletes rows. (Contrast `document_history` in Phase 46c, which refuses both and consequently blocks hard deletion of an org with history.)

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Write `FAILED` on the login client | Rolled back with the 401 | Rejected: loses the data |
| Skip the transaction on the failure path | Restructures login; success path still needs one | Rejected |
| Write after `ROLLBACK` on the pool, swallow errors | One extra autocommitted INSERT on failure | **Chosen** |
| Reuse `audit_logs` (CDC) | `users` and `refresh_tokens` are deliberately unaudited; failures change no row | Rejected |
| Log files only | Not queryable per member | Rejected |

## Where it lives in this codebase

- `server/src/services/loginEventService.ts` — `recordLoginEventOnClient`, `recordLoginEvent` (never throws), `listMyLoginEvents`, `listMemberActivity`.
- `server/src/services/authService.ts` — hooks in `login`, `logout`, `changePassword`, `resetPassword`, `revokeSession`, `revokeOtherSessions`.
- `server/src/db/migrations/102_platform_login_events.sql`.

## Gotchas

- Write the failure after `ROLLBACK`, not before, and never inside the `try`.
- Store nothing secret: no password, no token, only the lowercased email (rule 9), IP and user agent, truncated to the CHECK limits.
- **Enumeration risk in what is shown.** A user sees only their own events. A manager sees, per member of their organization, a last-sign-in time scoped to that organization, a change count scoped to that organization, and a failed-sign-in count for the member's account. Failed attempts carry no organization (the attacker has not authenticated), so that count cannot be org-scoped; it is shown only for people who are members, so it reveals nothing about non-members and nothing about other organizations' data. It does tell a manager the account is being guessed at, which is arguably the point. Never expose a lookup by arbitrary email: that would confirm which addresses exist.
- Failed rows for unknown emails accumulate and are attacker-controlled input (length-capped by CHECKs); retention is not built.

## Interview Q&A

**Q: Why is a failed login written outside the login transaction?**
A: The transaction is rolled back when the password is wrong, and a row inserted on its connection would roll back too. Writing after the `ROLLBACK` on a separate pool connection autocommits it, so the attempt is kept.

**Q: Why must the logging call never throw?**
A: It runs on a path whose job is to return a 401. If the INSERT failing replaced that with a 500, an outage in the log table would break sign-in and change the observable behaviour. Log the logging error and rethrow the original.

**Q: Why an UPDATE-only immutability trigger?**
A: A `BEFORE DELETE` row trigger also runs for rows removed by `ON DELETE CASCADE`, so it would stop users and organizations from being deleted. Blocking UPDATE protects the evidence's content; DELETE stays available for cascades, and no application code deletes.

**Q: How do you avoid a user-enumeration oracle in failed-login handling?**
A: Same message and same work for known and unknown emails (compare against a dummy hash), the extra write happens on both paths, and no endpoint looks events up by an arbitrary email.

**Q: A manager's activity view counts a member's failed sign-ins without an organization filter. Is that a tenant leak?**
A: No. Tenant isolation protects data owned by an organization. A failed sign-in has no organization and belongs to the identity; the query is still keyed by membership of the caller's org (`organization_members.org_id = $1`), so only accounts in that organization appear, and the counts reveal no other organization's rows. The org-scoped columns (last sign-in, changes) do carry `org_id` predicates.

**Q: Why did the success event go on the transaction client but the failure on the pool?**
A: Success should be atomic with the session it describes; if issuing the session fails, there was no sign-in. Failure has no transaction left to join and must outlive the rollback.

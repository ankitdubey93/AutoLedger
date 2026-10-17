# Soft delete under an immutability trigger

> How AutoLedger lets a user "delete" a bank statement line without ever running a SQL `DELETE` on a table whose trigger forbids it.

**Category:** PostgreSQL
**Introduced by:** Phase 46e — deleting unreconciled bank lines (migration `103`)
**Verified against:** PostgreSQL 16.15, Node 22

---

## Mechanism

`bank_transactions` carries `reject_bank_transaction_mutation()`, a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger. On `DELETE` it raises `0A000`. On `UPDATE` it compares two jsonb documents:

```sql
to_jsonb(NEW) - 'status' - 'matched_payment_id' - ...  IS DISTINCT FROM  to_jsonb(OLD) - 'status' - 'matched_payment_id' - ...
```

`to_jsonb(row)` turns the whole row into one object keyed by column name. Subtracting a key removes it. If the two remaining objects differ, some column outside the allowed list changed, and the trigger raises. This is a deny-by-default design: a column added to the table later is protected automatically, because it is not in the exempt list.

The soft delete therefore needs two things in migration 103. First, a status value (`DELETED`) admitted by a rewritten CHECK. Second, the three new columns (`deleted_at`, `deleted_by`, `delete_reason`) added to **both** subtraction chains, since the function writes the exempt list twice (once per side of `IS DISTINCT FROM`). Forgetting one side would make every delete look like a mutation of a protected column. The `DELETE` refusal stays word for word, so a real `DELETE` still fails; test case 12 proves it and case 13 proves that `UPDATE ... SET description` is still refused (the carve-out is narrow).

A CHECK ties the status to the audit columns: `(status = 'DELETED') = (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)`, and a reason may only exist on a deleted row. The row cannot say "deleted" without saying who and when.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Hard `DELETE` | Loses the fact that the bank said this; the trigger forbids it; re-import would silently bring it back | Rejected (rule 6) |
| `deleted_at IS NOT NULL` only, status untouched | Two sources of truth for lifecycle; every query must remember `deleted_at IS NULL` | Rejected (rule 10: one FSM) |
| **Status `DELETED` + audit columns** | Goes through the existing transition table; default list filters one value | Chosen |
| Partial unique index `WHERE status <> 'DELETED'` | Would let the same statement row be re-imported next to its deleted twin | Rejected |

**The dedupe UNIQUE stays whole.** `UNIQUE (org_id, dedupe_hash)` is unchanged, so a deleted line still occupies its hash. Re-importing the statement hits `ON CONFLICT DO NOTHING` and skips it. That is user decision 4: deleted means "I do not want this", not "forget it exists". The import counts the subset of skipped rows that are deleted (`previouslyDeletedCount`) so the user is told to restore from the Deleted tab rather than wondering where the lines went.

**Lock order for multi-row deletes.** `deleteTransactionsOnClient` runs `SELECT ... WHERE id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`. Two concurrent deletes touching overlapping sets acquire locks in the same global order, so neither can hold B while waiting for A. Unsorted, the planner might lock in different orders and deadlock (`40P01`).

**Why `DELETED -> UNMATCHED` forced a narrower rule in `setIgnored`.** The FSM has one transition table: `UNMATCHED -> {MATCHED, IGNORED, DELETED}`, `MATCHED/IGNORED/DELETED -> UNMATCHED`. Restore is `DELETED -> UNMATCHED`. But `unignore` also targets `UNMATCHED`, so the FSM alone would let `unignore` restore a deleted line. The service layers `if (!ignored && row.status !== 'IGNORED') throw 409` on top: the FSM answers "may this edge exist", the verb answers "is this the right verb for the source state".

## Where it lives in this codebase

- `server/src/db/migrations/103_ledger-core_bank_transaction_delete.sql` — columns, FK, both CHECKs, the widened trigger
- `server/src/services/accounting/bankMatchService.ts` — `deleteTransactionsOnClient`, `deleteTransactions`, `restoreTransaction`, `setIgnored`
- `server/src/services/accounting/bankImportService.ts` — `deleteImport` and `previouslyDeletedCount`
- `server/src/services/accounting/reportService.ts` — reconciliation excludes `DELETED` from the statement side
- `server/src/__tests__/accounting/bankLineDelete.test.ts`

## Gotchas

- A deleted line must be excluded from every total that sums statement lines, or the reconciliation difference moves when someone deletes a duplicate. The report filter is `status NOT IN ('IGNORED','DELETED')`.
- `deleted_by` is `ON DELETE SET NULL` but the CHECK demands it be non-null on a deleted row, so hard-deleting that user would fail. No production path deletes users, but a future account-deletion feature must handle it.
- Suggestions are derived data; they are removed on delete and regenerated on restore.
- Each state change writes a `document_history` event on the same client in the same transaction, so history cannot disagree with the status.
- Deleting a whole statement deletes only its lines, never the import row; a matched or ignored line blocks it with `409`.

## Interview Q&A

**Q: Your table has a trigger that forbids DELETE. How do users delete rows?**
A: They do not. "Delete" is a state transition to `DELETED` recorded with who, when and why. The trigger still refuses real deletes; its UPDATE carve-out was widened by exactly three columns.

**Q: How does a jsonb-diff immutability trigger work, and why is it safer than listing protected columns?**
A: It compares `to_jsonb(NEW)` and `to_jsonb(OLD)` after removing an allow-list of keys. Any change outside the allow-list raises. New columns are protected by default, whereas a deny-list of protected columns fails open when someone adds a column.

**Q: Why not a partial unique index excluding deleted rows?**
A: It would allow the same bank row to be re-imported alongside the deleted one. Keeping the unique constraint whole makes the deletion durable against re-imports, and the import reports how many skipped rows were previously deleted.

**Q: How do you prevent deadlocks when deleting many rows at once?**
A: Lock the rows in a deterministic order (`ORDER BY id FOR UPDATE`) in one statement before updating. All transactions then acquire locks in the same sequence.

**Q: Two verbs share a target state in your FSM. What goes wrong and how did you fix it?**
A: `unignore` and `restore` both go to `UNMATCHED`; the FSM permits `DELETED -> UNMATCHED`, so `unignore` could restore. We keep one transition table for edges and add a per-verb source-state check.

**Q: Why CHECK that status and audit columns agree?**
A: So the database rejects an impossible row (deleted with no actor or timestamp). A bug in one service cannot produce it.

## Follow-ups they'll dig into

- What if the user who deleted a line is removed? (The CHECK/`SET NULL` conflict above.)
- What would change if deleted lines had to be purged after N years? (A privileged job with a deliberate, audited trigger bypass.)

## See also

- [append-only-audit-trails](../architecture/append-only-audit-trails.md)
- [transactions-isolation-pooling](transactions-isolation-pooling.md)

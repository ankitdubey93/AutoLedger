import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import * as accountService from './accountService.js';
import type { AccountType, MigrationCommitPreview, MigrationImportRow } from '../../types/ledger-core.js';

/**
 * Chart-of-accounts import — the validate and commit halves, delegated to
 * by `migrationImportService.ts`. See that file's header comment for the
 * shape this is deliberately the inverse of Phase 6's bank import.
 *
 * Commit matches on `code`: an unknown code is created (parents resolved by
 * parent *code*, depth-first, the same technique `accountService.seedDefaultChart`
 * uses), a known code merges `name`/`description` only — never `code` or
 * `type`, which `updateAccountSchema` already refuses for a live account.
 */

/**
 * Per-row validation. Every statement carries `org_id = $n` (rule 1); this
 * runs on the caller's already-open transaction client.
 */
export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const { rows: existingRows } = await client.query<{ code: string; type: string }>(
    'SELECT code, type FROM accounts WHERE org_id = $1',
    [orgId],
  );
  const existingTypeByCode = new Map(existingRows.map((r) => [r.code, r.type]));

  const codeCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.accountCode === null) continue;
    codeCounts.set(row.accountCode, (codeCounts.get(row.accountCode) ?? 0) + 1);
  }

  const rowByCode = new Map(rows.filter((r) => r.accountCode !== null).map((r) => [r.accountCode as string, r]));

  /** Walks the parent chain among this file's own rows, detecting a cycle. */
  function formsCycle(startCode: string): boolean {
    const seen = new Set<string>();
    let cursor: string | null = startCode;
    while (cursor !== null) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      const current = rowByCode.get(cursor);
      cursor = current?.parentCode ?? null;
      // A parent outside this file (an existing org account) cannot
      // participate in a cycle this file introduces.
      if (cursor !== null && !rowByCode.has(cursor)) return false;
    }
    return false;
  }

  return rows.map((row) => {
    const errors: string[] = [];

    if (row.accountCode === null) {
      errors.push('account code is required');
    } else if ((codeCounts.get(row.accountCode) ?? 0) > 1) {
      errors.push(`duplicate account code "${row.accountCode}" in this file`);
    }

    if (row.accountName === null) errors.push('account name is required');

    if (row.accountType === null) {
      errors.push(`unknown account type "${row.raw.accountType ?? ''}"`);
    }

    if (row.parentCode !== null) {
      const parentInFile = rowByCode.get(row.parentCode);
      const parentExistingType = existingTypeByCode.get(row.parentCode);
      if (parentInFile === undefined && parentExistingType === undefined) {
        errors.push(`parent code "${row.parentCode}" does not exist`);
      } else {
        const parentType = parentExistingType ?? parentInFile?.accountType ?? null;
        if (parentType !== null && row.accountType !== null && parentType !== row.accountType) {
          errors.push(`parent "${row.parentCode}" is a ${parentType} account, not ${row.accountType}`);
        }
      }

      if (row.accountCode !== null && formsCycle(row.accountCode)) {
        errors.push(`parent code "${row.parentCode}" forms a cycle`);
      }
    }

    if (row.accountCode !== null && row.accountType !== null) {
      const existingType = existingTypeByCode.get(row.accountCode);
      if (existingType !== undefined && existingType !== row.accountType) {
        errors.push(`account ${row.accountCode} already exists as ${existingType}, not ${row.accountType}`);
      }
    }

    return { rowId: row.id, errors };
  });
}

export async function preview(
  client: PoolClient,
  orgId: string,
  importId: string,
): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ status: string; error_count: number }>(
    'SELECT status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');

  const { rows: rowRows } = await client.query<{ account_code: string | null }>(
    "SELECT account_code FROM migration_import_rows WHERE org_id = $1 AND import_id = $2 AND status = 'VALID'",
    [orgId, importId],
  );
  const { rows: existingRows } = await client.query<{ code: string }>(
    'SELECT code FROM accounts WHERE org_id = $1',
    [orgId],
  );
  const existingCodes = new Set(existingRows.map((r) => r.code));

  let accountsToCreate = 0;
  let accountsToMerge = 0;
  for (const row of rowRows) {
    if (row.account_code === null) continue;
    if (existingCodes.has(row.account_code)) accountsToMerge += 1;
    else accountsToCreate += 1;
  }

  return {
    kind: 'CHART_OF_ACCOUNTS',
    canCommit: imp.status === 'VALIDATED',
    blockingErrorCount: imp.error_count,
    accountsToCreate,
    accountsToMerge,
    totalDebitCents: 0,
    totalCreditCents: 0,
    plugCents: 0,
    plugAccountCode: '3400',
    entryDate: null,
  };
}

interface CommitRowRow {
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  parent_code: string | null;
  description: string | null;
  status: string;
}

/**
 * All-or-nothing. Runs on the caller's transaction — no BEGIN/COMMIT here.
 * `migrationImportService.commit` guarantees the import is VALIDATED before
 * calling this, so every remaining row here is VALID or EXCLUDED.
 */
export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
): Promise<{ created: number; merged: number }> {
  const { rows: importRows } = await client.query<{ created_by: string }>(
    'SELECT created_by FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const createdBy = importRows[0]?.created_by;
  if (createdBy === undefined) throw new ApiError(404, 'Migration import not found');

  const { rows: rowRows } = await client.query<CommitRowRow>(
    `SELECT account_code, account_name, account_type, parent_code, description, status
       FROM migration_import_rows
      WHERE org_id = $1 AND import_id = $2 AND status = 'VALID'
      ORDER BY row_number ASC`,
    [orgId, importId],
  );

  const { rows: existingRows } = await client.query<{ id: string; code: string }>(
    'SELECT id, code FROM accounts WHERE org_id = $1',
    [orgId],
  );
  const resolvedIdByCode = new Map(existingRows.map((r) => [r.code, r.id]));

  const pending = new Map(rowRows.map((r) => [r.account_code as string, r]));
  let created = 0;
  let merged = 0;

  // Repeated passes: each pass commits every row whose parent is already
  // resolvable (null, an existing account, or a code committed in an
  // earlier pass). validateRows already proved there is no cycle and no
  // dangling parent among VALID rows, so this always converges.
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (r) => r.parent_code === null || resolvedIdByCode.has(r.parent_code),
    );
    if (ready.length === 0) {
      throw new Error('Chart import commit could not resolve the remaining parent codes');
    }

    for (const row of ready) {
      const code = row.account_code as string;
      const parentId = row.parent_code === null ? null : (resolvedIdByCode.get(row.parent_code) ?? null);
      const existingId = resolvedIdByCode.get(code);

      if (existingId === undefined) {
        const account = await accountService.createAccountOnClient(client, orgId, createdBy, {
          code,
          name: row.account_name as string,
          type: row.account_type as AccountType,
          parentId,
          isPostable: true,
          description: row.description,
        });
        resolvedIdByCode.set(code, account.id);
        created += 1;
      } else {
        await client.query('UPDATE accounts SET name = $1, description = $2 WHERE org_id = $3 AND code = $4', [
          row.account_name,
          row.description,
          orgId,
          code,
        ]);
        merged += 1;
      }
      pending.delete(code);
    }
  }

  // A CHART_OF_ACCOUNTS import carries no journal_entry_id — migration 029's
  // chk_migration_imports_entry_kind CHECK forbids one outside OPENING_BALANCES
  // — but status and committed_at still move, exactly as the opening-balance
  // importer's own commit does. COMMITTED is terminal for this import row
  // (MIGRATION_IMPORT_TRANSITIONS), same as any other import; "a chart import
  // may be committed any number of times" (docs/roadmap.md) means as
  // separate import rows over time — an incremental correction file is a new
  // upload, not a re-commit of this one — and nothing here guards against a
  // second SEPARATE chart import merging the same codes again, unlike the
  // opening-balance importer's one-committed-per-org partial unique index.
  await client.query(
    "UPDATE migration_imports SET status = 'COMMITTED', committed_at = now() WHERE id = $1 AND org_id = $2",
    [importId, orgId],
  );

  return { created, merged };
}

import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import * as journalService from './journalService.js';
import type { MigrationCommitPreview, MigrationImportRow } from '../../types/ledger-core.js';

/**
 * Opening-balance import — the validate and commit halves, delegated to by
 * `migrationImportService.ts`.
 *
 * Posts exactly ONE journal entry through `journalService.createEntryOnClient`
 * at `ledger_settings.books_start_date`, `source_type = 'opening_balance'` —
 * never a direct `ledger_lines` write, so the period guard and the balance
 * triggers apply unchanged (guardrails rule 5, rule 16). Every line is base
 * currency: a foreign opening balance needs a frozen rate on a document that
 * does not exist yet, which is out of scope.
 *
 * Three refusals close ways the books could quietly start out lying: 3200
 * Retained Earnings (derived, never posted), and the AR/AP control accounts
 * (built from invoices/bills, not a lump import).
 */

interface RefusedAccounts {
  retainedEarningsId: string | null;
  receivableAccountId: string | null;
  payableAccountId: string | null;
}

async function loadRefusedAccounts(client: PoolClient, orgId: string): Promise<RefusedAccounts> {
  const { rows: accountRows } = await client.query<{ id: string; code: string }>(
    "SELECT id, code FROM accounts WHERE org_id = $1 AND code IN ('3200', '1120', '2100')",
    [orgId],
  );
  const idByCode = new Map(accountRows.map((r) => [r.code, r.id]));

  const { rows: invoiceSettingsRows } = await client.query<{ receivable_account_id: string | null }>(
    'SELECT receivable_account_id FROM ledger_invoice_settings WHERE org_id = $1',
    [orgId],
  );
  const { rows: settingsRows } = await client.query<{ payable_account_id: string | null }>(
    'SELECT payable_account_id FROM ledger_settings WHERE org_id = $1',
    [orgId],
  );

  return {
    retainedEarningsId: idByCode.get('3200') ?? null,
    receivableAccountId: invoiceSettingsRows[0]?.receivable_account_id ?? idByCode.get('1120') ?? null,
    payableAccountId: settingsRows[0]?.payable_account_id ?? idByCode.get('2100') ?? null,
  };
}

/**
 * Per-row validation. Every statement carries `org_id = $n` (rule 1); this
 * runs on the caller's already-open transaction client.
 */
export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const refused = await loadRefusedAccounts(client, orgId);

  const { rows: accountRows } = await client.query<{
    id: string;
    code: string;
    is_postable: boolean;
    is_active: boolean;
  }>('SELECT id, code, is_postable, is_active FROM accounts WHERE org_id = $1', [orgId]);
  const accountByCode = new Map(accountRows.map((r) => [r.code, r]));

  const codeCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.accountCode === null) continue;
    codeCounts.set(row.accountCode, (codeCounts.get(row.accountCode) ?? 0) + 1);
  }

  return rows.map((row) => {
    const errors: string[] = [];

    if (row.accountCode === null) {
      errors.push('account code is required');
      return { rowId: row.id, errors };
    }

    if ((codeCounts.get(row.accountCode) ?? 0) > 1) {
      errors.push(`duplicate account code "${row.accountCode}" in this file`);
    }

    const account = accountByCode.get(row.accountCode);
    if (account === undefined) {
      errors.push(`account code "${row.accountCode}" does not exist — import the chart first`);
    } else {
      if (!account.is_postable) {
        errors.push(`account ${row.accountCode} is a header account and cannot be posted to`);
      }
      if (!account.is_active) {
        errors.push(`account ${row.accountCode} is inactive`);
      }
      if (refused.retainedEarningsId !== null && account.id === refused.retainedEarningsId) {
        errors.push(
          '3200 Retained Earnings is derived from revenue and expense, never posted — put a prior-year profit in 3400 Opening Balance Equity',
        );
      }
      if (refused.receivableAccountId !== null && account.id === refused.receivableAccountId) {
        errors.push(
          'the receivable control account is built from invoices — migrate open items through /ledger-core/invoices, not here',
        );
      }
      if (refused.payableAccountId !== null && account.id === refused.payableAccountId) {
        errors.push(
          'the payable control account is built from bills — migrate open items through /ledger-core/bills, not here',
        );
      }
    }

    const debit = row.debitCents ?? 0;
    const credit = row.creditCents ?? 0;
    if (debit === 0 && credit === 0) {
      errors.push('row has no amount');
    } else if (debit > 0 && credit > 0) {
      errors.push('a row has one side, not both');
    }

    return { rowId: row.id, errors };
  });
}

interface CommitConfig {
  booksStartDate: string;
  plugAccountId: string;
}

async function loadCommitConfig(client: PoolClient, orgId: string): Promise<CommitConfig> {
  const { rows: settingsRows } = await client.query<{ books_start_date: string | null }>(
    'SELECT books_start_date FROM ledger_settings WHERE org_id = $1',
    [orgId],
  );
  const booksStartDate = settingsRows[0]?.books_start_date;
  if (booksStartDate === undefined || booksStartDate === null) {
    throw new ApiError(409, 'Complete LedgerCore onboarding before importing opening balances');
  }

  const { rows: accountRows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE org_id = $1 AND code = '3400'",
    [orgId],
  );
  const plugAccountId = accountRows[0]?.id;
  if (plugAccountId === undefined) {
    throw new ApiError(409, 'Account 3400 Opening Balance Equity is missing — run migrations');
  }

  return { booksStartDate, plugAccountId };
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

  const { rows: rowRows } = await client.query<{ debit_cents: string | null; credit_cents: string | null }>(
    "SELECT debit_cents, credit_cents FROM migration_import_rows WHERE org_id = $1 AND import_id = $2 AND status = 'VALID'",
    [orgId, importId],
  );

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  for (const row of rowRows) {
    totalDebitCents += row.debit_cents === null ? 0 : Number(row.debit_cents);
    totalCreditCents += row.credit_cents === null ? 0 : Number(row.credit_cents);
  }
  const plugCents = totalDebitCents - totalCreditCents;

  // Preview still works before onboarding, or before 3400 exists — it just
  // cannot show an entry date. commitOnClient enforces both for real.
  let entryDate: string | null = null;
  try {
    entryDate = (await loadCommitConfig(client, orgId)).booksStartDate;
  } catch {
    entryDate = null;
  }

  return {
    kind: 'OPENING_BALANCES',
    canCommit: imp.status === 'VALIDATED',
    blockingErrorCount: imp.error_count,
    accountsToCreate: 0,
    accountsToMerge: 0,
    totalDebitCents,
    totalCreditCents,
    plugCents,
    plugAccountCode: '3400',
    entryDate,
  };
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
  createdBy: string,
): Promise<{ journalEntryId: string; plugCents: number }> {
  const config = await loadCommitConfig(client, orgId);

  const { rows: importRows } = await client.query<{ file_name: string }>(
    'SELECT file_name FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const fileName = importRows[0]?.file_name;
  if (fileName === undefined) throw new ApiError(404, 'Migration import not found');

  const { rows: lineRows } = await client.query<{
    account_code: string;
    debit_cents: string | null;
    credit_cents: string | null;
    account_id: string | null;
  }>(
    `SELECT r.account_code, r.debit_cents, r.credit_cents, a.id AS account_id
       FROM migration_import_rows r
       LEFT JOIN accounts a ON a.org_id = r.org_id AND a.code = r.account_code
      WHERE r.org_id = $1 AND r.import_id = $2 AND r.status = 'VALID'
      ORDER BY r.row_number ASC`,
    [orgId, importId],
  );

  const lines: { accountId: string; debitCents: number; creditCents: number }[] = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  for (const row of lineRows) {
    if (row.account_id === null) {
      // Unreachable given validateRows' checks at the point of validation —
      // fails loudly rather than silently dropping a line if it ever happens.
      throw new Error(`Migration import commit: account code "${row.account_code}" no longer resolves`);
    }
    const debitCents = row.debit_cents === null ? 0 : Number(row.debit_cents);
    const creditCents = row.credit_cents === null ? 0 : Number(row.credit_cents);
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;
    lines.push({ accountId: row.account_id, debitCents, creditCents });
  }

  // One imbalance-as-plug computation, no direction-specific sign branch
  // beyond choosing which side of the plug line to fill — the same shape
  // paymentService.createPaymentOnClient uses for realized FX.
  const plugCents = totalDebitCents - totalCreditCents;
  if (plugCents > 0) {
    lines.push({ accountId: config.plugAccountId, debitCents: 0, creditCents: plugCents });
  } else if (plugCents < 0) {
    lines.push({ accountId: config.plugAccountId, debitCents: -plugCents, creditCents: 0 });
  }

  const entryId = await journalService.createEntryOnClient(client, orgId, createdBy, {
    entryDate: config.booksStartDate,
    description: `Opening balances imported from ${fileName}`,
    sourceType: 'opening_balance',
    sourceId: importId,
    lines,
  });

  // A second commit for this organization is refused by
  // ux_migration_imports_one_committed_opening (23505) — the index is the
  // guarantee, this UPDATE is only the wording migrationImportService.commit
  // maps the error to (guardrails rule 6: correct via a reversing entry,
  // never by re-importing).
  await client.query(
    `UPDATE migration_imports SET journal_entry_id = $1, status = 'COMMITTED', committed_at = now()
      WHERE id = $2 AND org_id = $3`,
    [entryId, importId, orgId],
  );

  return { journalEntryId: entryId, plugCents };
}

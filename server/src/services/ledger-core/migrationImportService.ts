import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseMoneyText } from '../../utils/money.js';
import { parseCsv, type CsvTable } from '../../utils/csv.js';
import { normalizeForMatching } from '../../utils/matchScore.js';
import * as chartImportService from './chartImportService.js';
import * as openingBalanceImportService from './openingBalanceImportService.js';
import {
  canTransitionMigrationImport,
  isAccountType,
  type AccountType,
  type MigrationImport,
  type MigrationImportKind,
  type MigrationImportRow,
  type MigrationRowStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore's staged migration importers — a business moving off another
 * system's way in (Phase 9b).
 *
 * DELIBERATELY THE INVERSE of `bankImportService`: that one aborts the
 * entire file on the first bad row and writes live rows immediately. This
 * one stages every row, good and bad, with per-row errors and per-row
 * fixes, and separates validation from commit — because a partially-wrong
 * chart export is normal on a first try, and discovering one error per
 * re-upload is a bad workflow.
 *
 * There is no `dateFormat` and no `columnMap`, unlike bank import: neither
 * importer has a date column, and column resolution is by header synonym
 * only. Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1).
 */

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

// ------------------------------------------------------------- column maps

const CODE_SYNONYMS = ['code', 'account code', 'account', 'account number', 'gl code'];
const NAME_SYNONYMS = ['name', 'account name', 'description', 'title'];
const TYPE_SYNONYMS = ['type', 'account type', 'category'];
const PARENT_SYNONYMS = ['parent', 'parent code', 'parent account'];
const DESCRIPTION_SYNONYMS = ['notes', 'memo', 'long description'];
const DEBIT_SYNONYMS = ['debit', 'dr', 'debit amount'];
const CREDIT_SYNONYMS = ['credit', 'cr', 'credit amount'];
const AMOUNT_SYNONYMS = ['amount', 'balance', 'opening balance'];

interface ResolvedColumns {
  codeIdx: number;
  nameIdx: number | null;
  typeIdx: number | null;
  parentIdx: number | null;
  descriptionIdx: number | null;
  debitIdx: number | null;
  creditIdx: number | null;
  amountIdx: number | null;
}

function findColumnBySynonyms(headers: string[], synonyms: string[]): number | null {
  const normalizedHeaders = headers.map(normalizeForMatching);
  for (const synonym of synonyms) {
    const idx = normalizedHeaders.indexOf(synonym);
    if (idx !== -1) return idx;
  }
  return null;
}

function resolveColumns(headers: string[], kind: MigrationImportKind): ResolvedColumns {
  const codeIdx = findColumnBySynonyms(headers, CODE_SYNONYMS);
  if (codeIdx === null) throw new ApiError(422, 'Could not find an account code column in the file');
  const nameIdx = findColumnBySynonyms(headers, NAME_SYNONYMS);

  if (kind === 'CHART_OF_ACCOUNTS') {
    const typeIdx = findColumnBySynonyms(headers, TYPE_SYNONYMS);
    if (typeIdx === null) throw new ApiError(422, 'Could not find an account type column in the file');
    const parentIdx = findColumnBySynonyms(headers, PARENT_SYNONYMS);
    const descriptionIdx = findColumnBySynonyms(headers, DESCRIPTION_SYNONYMS);
    return {
      codeIdx,
      nameIdx,
      typeIdx,
      parentIdx,
      descriptionIdx,
      debitIdx: null,
      creditIdx: null,
      amountIdx: null,
    };
  }

  const debitIdx = findColumnBySynonyms(headers, DEBIT_SYNONYMS);
  const creditIdx = findColumnBySynonyms(headers, CREDIT_SYNONYMS);
  const amountIdx = findColumnBySynonyms(headers, AMOUNT_SYNONYMS);
  if (amountIdx === null && (debitIdx === null || creditIdx === null)) {
    throw new ApiError(422, 'Could not find an amount column, or a debit/credit pair, in the file');
  }
  return { codeIdx, nameIdx, typeIdx: null, parentIdx: null, descriptionIdx: null, debitIdx, creditIdx, amountIdx };
}

// ------------------------------------------------------- account type alias

const ACCOUNT_TYPE_ALIASES: Record<string, AccountType> = {
  asset: 'Asset',
  assets: 'Asset',
  liability: 'Liability',
  liabilities: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  income: 'Revenue',
  sales: 'Revenue',
  expense: 'Expense',
  expenses: 'Expense',
  'cost of goods sold': 'Expense',
  cogs: 'Expense',
};

function normalizeAccountType(raw: string): AccountType | null {
  const key = raw.trim().toLowerCase();
  const candidate = ACCOUNT_TYPE_ALIASES[key];
  return candidate !== undefined && isAccountType(candidate) ? candidate : null;
}

// ---------------------------------------------------------------- row parsing

interface StagedRowInput {
  rowNumber: number;
  raw: Record<string, string>;
  accountCode: string | null;
  accountName: string | null;
  accountType: AccountType | null;
  parentCode: string | null;
  description: string | null;
  debitCents: number | null;
  creditCents: number | null;
}

function parseChartRow(cells: string[], columns: ResolvedColumns, rowNumber: number): StagedRowInput {
  const codeRaw = (cells[columns.codeIdx] ?? '').trim();
  const nameRaw = columns.nameIdx !== null ? (cells[columns.nameIdx] ?? '').trim() : '';
  const typeRaw = columns.typeIdx !== null ? (cells[columns.typeIdx] ?? '').trim() : '';
  const parentRaw = columns.parentIdx !== null ? (cells[columns.parentIdx] ?? '').trim() : '';
  const descriptionRaw = columns.descriptionIdx !== null ? (cells[columns.descriptionIdx] ?? '').trim() : '';

  return {
    rowNumber,
    raw: {
      accountCode: codeRaw,
      accountName: nameRaw,
      accountType: typeRaw,
      parentCode: parentRaw,
      description: descriptionRaw,
    },
    accountCode: codeRaw === '' ? null : codeRaw.slice(0, 20),
    accountName: nameRaw === '' ? null : nameRaw.slice(0, 120),
    accountType: typeRaw === '' ? null : normalizeAccountType(typeRaw),
    parentCode: parentRaw === '' ? null : parentRaw.slice(0, 20),
    description: descriptionRaw === '' ? null : descriptionRaw.slice(0, 500),
    debitCents: null,
    creditCents: null,
  };
}

function parseOpeningRow(cells: string[], columns: ResolvedColumns, rowNumber: number): StagedRowInput {
  const codeRaw = (cells[columns.codeIdx] ?? '').trim();
  const nameRaw = columns.nameIdx !== null ? (cells[columns.nameIdx] ?? '').trim() : '';

  let debitCents: number | null = null;
  let creditCents: number | null = null;
  let debitRaw = '';
  let creditRaw = '';

  if (columns.amountIdx !== null) {
    debitRaw = (cells[columns.amountIdx] ?? '').trim();
    creditRaw = debitRaw;
    try {
      const amount = parseMoneyText(debitRaw);
      if (amount >= 0) {
        debitCents = amount;
        creditCents = 0;
      } else {
        debitCents = 0;
        creditCents = -amount;
      }
    } catch {
      // Left null — validateRows reports the parse failure against `raw`.
    }
  } else if (columns.debitIdx !== null && columns.creditIdx !== null) {
    debitRaw = (cells[columns.debitIdx] ?? '').trim();
    creditRaw = (cells[columns.creditIdx] ?? '').trim();
    try {
      debitCents = parseMoneyText(debitRaw);
    } catch {
      debitCents = null;
    }
    try {
      creditCents = parseMoneyText(creditRaw);
    } catch {
      creditCents = null;
    }
  }

  return {
    rowNumber,
    raw: { accountCode: codeRaw, accountName: nameRaw, debit: debitRaw, credit: creditRaw },
    accountCode: codeRaw === '' ? null : codeRaw.slice(0, 20),
    accountName: nameRaw === '' ? null : nameRaw.slice(0, 120),
    accountType: null,
    parentCode: null,
    description: null,
    debitCents,
    creditCents,
  };
}

function parseRows(table: CsvTable, columns: ResolvedColumns, kind: MigrationImportKind): StagedRowInput[] {
  return table.rows.map((cells, index) => {
    // 1-based, header row counted — matches bankImportService's convention.
    const rowNumber = index + 2;
    return kind === 'CHART_OF_ACCOUNTS'
      ? parseChartRow(cells, columns, rowNumber)
      : parseOpeningRow(cells, columns, rowNumber);
  });
}

// ---------------------------------------------------------------- row mapping

interface ImportRow {
  id: string;
  kind: string;
  status: string;
  file_name: string;
  delimiter: string;
  row_count: number;
  error_count: number;
  valid_count: string;
  excluded_count: string;
  journal_entry_id: string | null;
  committed_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
}

const IMPORT_SELECT = `SELECT i.id, i.kind, i.status, i.file_name, i.delimiter, i.row_count, i.error_count,
                               (SELECT count(*) FROM migration_import_rows r
                                 WHERE r.org_id = i.org_id AND r.import_id = i.id AND r.status = 'VALID') AS valid_count,
                               (SELECT count(*) FROM migration_import_rows r
                                 WHERE r.org_id = i.org_id AND r.import_id = i.id AND r.status = 'EXCLUDED') AS excluded_count,
                               i.journal_entry_id, i.committed_at,
                               i.created_by, u.name AS created_by_name, i.created_at
                          FROM migration_imports i
                          LEFT JOIN users u ON u.id = i.created_by`;

function toImport(row: ImportRow): MigrationImport {
  if (row.kind !== 'CHART_OF_ACCOUNTS' && row.kind !== 'OPENING_BALANCES') {
    throw new Error(`Unknown migration import kind "${row.kind}"`);
  }
  if (row.status !== 'DRAFT' && row.status !== 'VALIDATED' && row.status !== 'COMMITTED') {
    throw new Error(`Unknown migration import status "${row.status}"`);
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    fileName: row.file_name,
    delimiter: row.delimiter,
    rowCount: row.row_count,
    errorCount: row.error_count,
    validCount: Number(row.valid_count),
    excludedCount: Number(row.excluded_count),
    journalEntryId: row.journal_entry_id,
    committedAt: row.committed_at === null ? null : row.committed_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

interface RowRow {
  id: string;
  row_number: number;
  raw: Record<string, string>;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  parent_code: string | null;
  description: string | null;
  debit_cents: string | null;
  credit_cents: string | null;
  errors: string[];
  status: string;
}

function toRow(row: RowRow): MigrationImportRow {
  const accountType =
    row.account_type === null
      ? null
      : isAccountType(row.account_type)
        ? row.account_type
        : (() => {
            throw new Error(`Unknown account type "${row.account_type}" on migration row ${row.id}`);
          })();
  const status: MigrationRowStatus =
    row.status === 'VALID' || row.status === 'INVALID' || row.status === 'EXCLUDED'
      ? row.status
      : (() => {
          throw new Error(`Unknown migration row status "${row.status}"`);
        })();

  return {
    id: row.id,
    rowNumber: row.row_number,
    raw: row.raw,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType,
    parentCode: row.parent_code,
    description: row.description,
    debitCents: row.debit_cents === null ? null : Number(row.debit_cents),
    creditCents: row.credit_cents === null ? null : Number(row.credit_cents),
    errors: row.errors,
    status,
  };
}

const ROW_COLUMNS = `id, row_number, raw, account_code, account_name, account_type, parent_code,
                     description, debit_cents, credit_cents, errors, status`;

// ---------------------------------------------------------------------- reads

export async function getImportById(orgId: string, id: string): Promise<MigrationImport> {
  const { rows } = await pool.query<ImportRow>(`${IMPORT_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Migration import not found');
  return toImport(row);
}

export interface ListImportsOptions {
  page: number;
  limit: number;
  kind: MigrationImportKind | null;
}

export async function listImports(
  orgId: string,
  options: ListImportsOptions,
): Promise<{ imports: MigrationImport[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const clauses = ['i.org_id = $1'];
  const values: unknown[] = [orgId];
  if (options.kind !== null) {
    values.push(options.kind);
    clauses.push(`i.kind = $${String(values.length)}`);
  }
  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM migration_imports i WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const { rows } = await pool.query<ImportRow>(
    `${IMPORT_SELECT}
      WHERE ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { imports: rows.map(toImport), totalCount };
}

async function assertImportExists(orgId: string, importId: string): Promise<MigrationImport> {
  return getImportById(orgId, importId);
}

/**
 * Like `getImportById`, but reads on the caller's own transaction client
 * instead of `pool` — required inside a still-open transaction, where a
 * `pool.query` would run on a different connection and, under READ
 * COMMITTED, not yet see this transaction's own uncommitted writes
 * (guardrails rule 5).
 */
async function getImportByIdOnClient(client: PoolClient, orgId: string, id: string): Promise<MigrationImport> {
  const { rows } = await client.query<ImportRow>(`${IMPORT_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [id, orgId]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Migration import not found');
  return toImport(row);
}

export interface ListRowsOptions {
  page: number;
  limit: number;
  status: MigrationRowStatus | null;
}

export async function listRows(
  orgId: string,
  importId: string,
  options: ListRowsOptions,
): Promise<{ rows: MigrationImportRow[]; totalCount: number }> {
  await assertImportExists(orgId, importId);

  const offset = (options.page - 1) * options.limit;
  const clauses = ['org_id = $1', 'import_id = $2'];
  const values: unknown[] = [orgId, importId];
  if (options.status !== null) {
    values.push(options.status);
    clauses.push(`status = $${String(values.length)}`);
  }
  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM migration_import_rows WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const { rows } = await pool.query<RowRow>(
    `SELECT ${ROW_COLUMNS} FROM migration_import_rows
      WHERE ${where}
      ORDER BY row_number ASC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { rows: rows.map(toRow), totalCount };
}

// --------------------------------------------------------------------- writes

/**
 * Re-runs the kind's validator over every staged (non-EXCLUDED) row, updates
 * each row's `errors`/`status`, and updates the import's `error_count` and
 * `status`. Shared by `createImport` (initial staging) and `patchRow`/
 * `revalidate` (after a fix) so the two never disagree about what counts as
 * valid. Runs on the caller's transaction client — no BEGIN/COMMIT here.
 */
async function revalidateOnClient(client: PoolClient, orgId: string, importId: string): Promise<MigrationImport> {
  const { rows: importRows } = await client.query<{ kind: string; status: string }>(
    'SELECT kind, status FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const importRowRaw = importRows[0];
  if (importRowRaw === undefined) throw new ApiError(404, 'Migration import not found');
  if (importRowRaw.status !== 'DRAFT' && importRowRaw.status !== 'VALIDATED' && importRowRaw.status !== 'COMMITTED') {
    throw new Error(`Unknown migration import status "${importRowRaw.status}"`);
  }
  // Extracted into a local const rather than read back from `importRowRaw.status`
  // later: TS invalidates narrowing on an object PROPERTY across an intervening
  // `await`, but a local variable's narrowed literal type survives it.
  const importKind = importRowRaw.kind;
  const importStatus = importRowRaw.status;
  if (importStatus === 'COMMITTED') {
    throw new ApiError(409, 'This import has already been committed');
  }

  const { rows: rowRows } = await client.query<RowRow>(
    `SELECT ${ROW_COLUMNS} FROM migration_import_rows
      WHERE org_id = $1 AND import_id = $2 AND status <> 'EXCLUDED'
      ORDER BY row_number ASC`,
    [orgId, importId],
  );
  const stagedRows = rowRows.map(toRow);

  const validator =
    importKind === 'CHART_OF_ACCOUNTS' ? chartImportService.validateRows : openingBalanceImportService.validateRows;
  const results = await validator(client, orgId, stagedRows);
  const errorsByRowId = new Map(results.map((r) => [r.rowId, r.errors]));

  let errorCount = 0;
  for (const row of stagedRows) {
    const errors = errorsByRowId.get(row.id) ?? [];
    const status: MigrationRowStatus = errors.length === 0 ? 'VALID' : 'INVALID';
    if (status === 'INVALID') errorCount += 1;
    await client.query('UPDATE migration_import_rows SET errors = $1, status = $2 WHERE id = $3 AND org_id = $4', [
      errors,
      status,
      row.id,
      orgId,
    ]);
  }

  const targetStatus = errorCount === 0 ? 'VALIDATED' : 'DRAFT';
  if (targetStatus !== importStatus && !canTransitionMigrationImport(importStatus, targetStatus)) {
    // Unreachable given the CHECK constraint's status set and the two
    // branches above, but fails loudly rather than silently if it ever is.
    throw new ApiError(409, `Cannot move import from ${importStatus} to ${targetStatus}`);
  }

  await client.query('UPDATE migration_imports SET error_count = $1, status = $2 WHERE id = $3 AND org_id = $4', [
    errorCount,
    targetStatus,
    importId,
    orgId,
  ]);

  return getImportByIdOnClient(client, orgId, importId);
}

export interface CreateImportInput {
  kind: MigrationImportKind;
  fileName: string;
  content: string;
}

export async function createImport(
  orgId: string,
  createdBy: string,
  input: CreateImportInput,
): Promise<{ import: MigrationImport; rows: MigrationImportRow[] }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const table = parseCsv(input.content);
    const columns = resolveColumns(table.headers, input.kind);
    const parsed = parseRows(table, columns, input.kind);

    if (parsed.length === 0) {
      throw new ApiError(422, 'The file contains no data rows');
    }

    const { rows: importRows } = await client.query<{ id: string }>(
      `INSERT INTO migration_imports (org_id, kind, file_name, delimiter, row_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [orgId, input.kind, input.fileName, table.delimiter, parsed.length, createdBy],
    );
    const importId = importRows[0]?.id;
    if (importId === undefined) throw new Error('no import id');

    await client.query(
      `INSERT INTO migration_import_rows
         (org_id, import_id, row_number, raw, account_code, account_name, account_type, parent_code,
          description, debit_cents, credit_cents)
       SELECT $1, $2, v.row_number, v.raw::jsonb, v.account_code, v.account_name, v.account_type,
              v.parent_code, v.description, v.debit_cents, v.credit_cents
         FROM unnest(
                $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                $10::bigint[], $11::bigint[]
              ) AS v(row_number, raw, account_code, account_name, account_type, parent_code, description,
                      debit_cents, credit_cents)`,
      [
        orgId,
        importId,
        parsed.map((r) => r.rowNumber),
        parsed.map((r) => JSON.stringify(r.raw)),
        parsed.map((r) => r.accountCode),
        parsed.map((r) => r.accountName),
        parsed.map((r) => r.accountType),
        parsed.map((r) => r.parentCode),
        parsed.map((r) => r.description),
        parsed.map((r) => r.debitCents),
        parsed.map((r) => r.creditCents),
      ],
    );

    const importResult = await revalidateOnClient(client, orgId, importId);
    const { rows: stagedRows } = await client.query<RowRow>(
      `SELECT ${ROW_COLUMNS} FROM migration_import_rows WHERE org_id = $1 AND import_id = $2 ORDER BY row_number ASC`,
      [orgId, importId],
    );

    await client.query('COMMIT');
    return { import: importResult, rows: stagedRows.map(toRow) };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    throw err;
  } finally {
    client.release();
  }
}

export interface PatchRowInput {
  accountCode?: string | undefined;
  accountName?: string | undefined;
  accountType?: AccountType | undefined;
  parentCode?: string | null | undefined;
  description?: string | null | undefined;
  debitCents?: number | undefined;
  creditCents?: number | undefined;
  status?: 'VALID' | 'EXCLUDED' | undefined;
}

/** Applies one row fix, then re-validates the whole import. Refused on COMMITTED. */
export async function patchRow(
  orgId: string,
  importId: string,
  rowId: string,
  input: PatchRowInput,
): Promise<{ import: MigrationImport; row: MigrationImportRow }> {
  return withTransaction(async (client) => {
    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM migration_imports WHERE id = $1 AND org_id = $2',
      [importId, orgId],
    );
    const importStatus = statusRows[0]?.status;
    if (importStatus === undefined) throw new ApiError(404, 'Migration import not found');
    if (importStatus === 'COMMITTED') throw new ApiError(409, 'This import has already been committed');

    // Column names come from this frozen map, never from the request — rule 4
    // forbids interpolating an identifier a caller could influence.
    const COLUMNS = {
      accountCode: 'account_code',
      accountName: 'account_name',
      accountType: 'account_type',
      parentCode: 'parent_code',
      description: 'description',
      debitCents: 'debit_cents',
      creditCents: 'credit_cents',
      status: 'status',
    } as const;

    const assignments: string[] = [];
    const values: unknown[] = [rowId, orgId, importId];

    for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
    }

    if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

    // A manual status override to EXCLUDED must clear any stale errors — the
    // CHECK constraint only forbids VALID-with-errors, but a leftover error
    // list on an excluded row is misleading, not dangerous, so this is a
    // courtesy rather than a guardrail.
    if (input.status === 'EXCLUDED') assignments.push('errors = \'{}\'');

    const { rows } = await client.query<{ id: string }>(
      `UPDATE migration_import_rows SET ${assignments.join(', ')}
        WHERE id = $1 AND org_id = $2 AND import_id = $3
        RETURNING id`,
      values,
    );
    if (rows[0] === undefined) throw new ApiError(404, 'Migration import row not found');

    const updatedImport = await revalidateOnClient(client, orgId, importId);

    const { rows: rowRows } = await client.query<RowRow>(
      `SELECT ${ROW_COLUMNS} FROM migration_import_rows WHERE id = $1 AND org_id = $2`,
      [rowId, orgId],
    );
    const rowRow = rowRows[0];
    if (rowRow === undefined) throw new ApiError(404, 'Migration import row not found');

    return { import: updatedImport, row: toRow(rowRow) };
  });
}

/** Re-runs the kind's validator over every staged row. DRAFT -> VALIDATED when zero errors. */
export async function revalidate(orgId: string, importId: string): Promise<MigrationImport> {
  return withTransaction((client) => revalidateOnClient(client, orgId, importId));
}

/** Deletes a non-committed import (rows cascade). A COMMITTED import is refused. */
export async function deleteImport(orgId: string, importId: string): Promise<void> {
  const imp = await getImportById(orgId, importId);
  if (imp.status === 'COMMITTED') throw new ApiError(409, 'A committed import cannot be deleted');

  await withTransaction((client) =>
    client.query('DELETE FROM migration_imports WHERE id = $1 AND org_id = $2', [importId, orgId]),
  );
}

/** Read-only preview of what commit will do, delegated by kind. */
export async function preview(orgId: string, importId: string) {
  const imp = await getImportById(orgId, importId);
  return withTransaction((client) => {
    const previewer =
      imp.kind === 'CHART_OF_ACCOUNTS' ? chartImportService.preview : openingBalanceImportService.preview;
    return previewer(client, orgId, importId);
  });
}

export type CommitResult =
  | { kind: 'CHART_OF_ACCOUNTS'; createdCount: number; mergedCount: number }
  | { kind: 'OPENING_BALANCES'; journalEntryId: string; plugCents: number };

/** Commits a VALIDATED import, delegated by kind. All-or-nothing. */
export async function commit(
  orgId: string,
  createdBy: string,
  importId: string,
): Promise<{ import: MigrationImport; result: CommitResult }> {
  const imp = await getImportById(orgId, importId);
  if (imp.status !== 'VALIDATED') {
    throw new ApiError(409, `Fix ${String(imp.errorCount)} invalid row(s) before committing`);
  }

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    let result: CommitResult;
    if (imp.kind === 'CHART_OF_ACCOUNTS') {
      const { created, merged } = await chartImportService.commitOnClient(client, orgId, importId);
      result = { kind: 'CHART_OF_ACCOUNTS', createdCount: created, mergedCount: merged };
    } else {
      const { journalEntryId, plugCents } = await openingBalanceImportService.commitOnClient(
        client,
        orgId,
        importId,
        createdBy,
      );
      result = { kind: 'OPENING_BALANCES', journalEntryId, plugCents };
    }

    await client.query('COMMIT');
    return { import: await getImportById(orgId, importId), result };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_migration_imports_one_committed_opening') {
      throw new ApiError(409, 'This organization already has a committed opening-balance import');
    }
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw new ApiError(422, 'A referenced account does not exist');
    }
    throw err;
  } finally {
    client.release();
  }
}

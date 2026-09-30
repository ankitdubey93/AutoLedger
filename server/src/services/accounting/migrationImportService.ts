import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCsv } from '../../utils/csv.js';
import { isDateFormat, type DateFormat } from '../../utils/dateParse.js';
import { parseImportCell, suggestDateFormat } from '../../utils/importValues.js';
import { compactHeader, findMissingRequired, resolveColumnIndexes } from '../../utils/importColumns.js';
import { MAX_IMPORT_ROWS } from '../../config/constants.js';
import { getImportKind } from './importKinds.js';
import { importDateFormatOnClient } from './importRowStore.js';
import {
  canTransitionMigrationImport,
  isAccountType,
  isMigrationImportKind,
  type AccountType,
  type MigrationCommitResult,
  type MigrationImport,
  type MigrationImportInspection,
  type MigrationImportStatus,
  type MigrationImportKind,
  type MigrationImportRow,
  type MigrationRowStatus,
} from '../../types/accounting.js';

/**
 * Accounting's staged migration importers — a business moving off another
 * system's way in (Phase 9b).
 *
 * DELIBERATELY THE INVERSE of `bankImportService`: that one aborts the
 * entire file on the first bad row and writes live rows immediately. This
 * one stages every row, good and bad, with per-row errors and per-row
 * fixes, and separates validation from commit — because a partially-wrong
 * chart export is normal on a first try, and discovering one error per
 * re-upload is a bad workflow.
 *
 * Column resolution goes through the kind registry (`importKinds.ts`): the
 * template header, then synonyms, unless the caller supplies a `columnMap`
 * (column key -> file header) that overrides the automatic match. A data-storage
 * kind (Phase 36b) parses typed cells into `data` using the import's
 * `dateFormat`. Every function takes `orgId` first and every statement carries an
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
  column_map: Record<string, string | null> | null;
  result: MigrationCommitResult | null;
  date_format: string;
}

const IMPORT_SELECT = `SELECT i.id, i.kind, i.status, i.file_name, i.delimiter, i.row_count, i.error_count,
                               (SELECT count(*) FROM migration_import_rows r
                                 WHERE r.org_id = i.org_id AND r.import_id = i.id AND r.status = 'VALID') AS valid_count,
                               (SELECT count(*) FROM migration_import_rows r
                                 WHERE r.org_id = i.org_id AND r.import_id = i.id AND r.status = 'EXCLUDED') AS excluded_count,
                               i.journal_entry_id, i.committed_at,
                               i.created_by, u.name AS created_by_name, i.created_at,
                               i.column_map, i.result,
                               COALESCE(i.options->>'dateFormat', 'ISO') AS date_format
                          FROM migration_imports i
                          LEFT JOIN users u ON u.id = i.created_by`;

function toImport(row: ImportRow): MigrationImport {
  if (!isMigrationImportKind(row.kind)) {
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
    columnMap: row.column_map,
    result: row.result,
    dateFormat: isDateFormat(row.date_format) ? row.date_format : 'ISO',
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
  party_name: string | null;
  party_email: string | null;
  party_phone: string | null;
  party_address: string | null;
  party_tax_number: string | null;
  party_payment_terms: string | null;
  party_notes: string | null;
  errors: string[];
  status: string;
  data: Record<string, string | number | null> | null;
  group_key: string | null;
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
    partyName: row.party_name,
    partyEmail: row.party_email,
    partyPhone: row.party_phone,
    partyAddress: row.party_address,
    partyTaxNumber: row.party_tax_number,
    partyPaymentTerms: row.party_payment_terms,
    partyNotes: row.party_notes,
    errors: row.errors,
    status,
    values: row.data ?? {},
    groupKey: row.group_key,
  };
}

const ROW_COLUMNS = `id, row_number, raw, account_code, account_name, account_type, parent_code,
                     description, debit_cents, credit_cents,
                     party_name, party_email, party_phone, party_address, party_tax_number,
                     party_payment_terms, party_notes, errors, status, data, group_key`;

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
  status: MigrationImportStatus | null;
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
  if (options.status !== null) {
    values.push(options.status);
    clauses.push(`i.status = $${String(values.length)}`);
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

  if (!isMigrationImportKind(importKind)) {
    throw new Error(`Unknown migration import kind "${importKind}"`);
  }
  const results = await getImportKind(importKind).validateRows(client, orgId, stagedRows);
  const errorsByRowId = new Map(results.map((r) => [r.rowId, r.errors]));

  let errorCount = 0;
  const rowStatuses: MigrationRowStatus[] = [];
  for (const row of stagedRows) {
    const errors = errorsByRowId.get(row.id) ?? [];
    const status: MigrationRowStatus = errors.length === 0 ? 'VALID' : 'INVALID';
    if (status === 'INVALID') errorCount += 1;
    rowStatuses.push(status);
  }

  if (stagedRows.length > 0) {
    await client.query(
      `UPDATE migration_import_rows AS r
          SET errors = ARRAY(SELECT jsonb_array_elements_text(v.errors_json::jsonb)),
              status = v.status
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS v(id, errors_json, status)
        WHERE r.id = v.id AND r.org_id = $4 AND r.import_id = $5`,
      [
        stagedRows.map((r) => r.id),
        stagedRows.map((r) => JSON.stringify(errorsByRowId.get(r.id) ?? [])),
        rowStatuses,
        orgId,
        importId,
      ],
    );
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
  columnMap: Record<string, string | null> | null;
  dateFormat: DateFormat;
}

/** Shared by `createImport` and `inspectImport`: parse, cap rows, resolve columns. */
function parseAndResolve(input: { kind: MigrationImportKind; content: string; columnMap: Record<string, string | null> | null }) {
  const def = getImportKind(input.kind);
  const table = parseCsv(input.content);
  if (table.rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(
      422,
      `This file has ${String(table.rows.length)} data rows; one import takes at most ${String(MAX_IMPORT_ROWS)} — split it into smaller files`,
    );
  }
  const columns = resolveColumnIndexes(table.headers, def.columns, input.columnMap ?? null, def.label);
  return { def, table, columns };
}

/**
 * Reads a file and reports how its headers would resolve — without touching
 * the database, and without rejecting a missing required column (the wizard's
 * mapping step fixes that).
 */
export function inspectImport(input: { kind: MigrationImportKind; content: string }): MigrationImportInspection {
  const { def, table, columns } = parseAndResolve({ ...input, columnMap: null });
  const missingRequired = findMissingRequired(def.columns, def.requiredOneOf, columns);
  const suggestedMap: Record<string, string | null> = {};
  for (const col of def.columns) {
    const idx = columns[col.key];
    suggestedMap[col.key] = idx === null || idx === undefined ? null : (table.headers[idx] ?? null);
  }
  const templateCompacts = new Set(def.columns.map((col) => compactHeader(col.header)));
  let suggestedDateFormat: DateFormat | null = null;
  const dateIdxs = def.columns
    .filter((col) => col.type === 'date')
    .map((col) => columns[col.key])
    .filter((idx): idx is number => idx !== null && idx !== undefined);
  if (def.columns.some((col) => col.type === 'date')) {
    const samples: string[] = [];
    for (const cells of table.rows) {
      for (const idx of dateIdxs) {
        const text = (cells[idx] ?? '').trim();
        if (text !== '') samples.push(text);
      }
    }
    suggestedDateFormat = suggestDateFormat(samples);
  }
  return {
    kind: input.kind,
    headers: table.headers,
    delimiter: table.delimiter,
    rowCount: table.rows.length,
    sampleRows: table.rows.slice(0, 5),
    suggestedMap,
    missingRequired,
    exactMatch: missingRequired.length === 0 && table.headers.every((h) => templateCompacts.has(compactHeader(h))),
    suggestedDateFormat,
  };
}

export async function createImport(
  orgId: string,
  createdBy: string,
  input: CreateImportInput,
): Promise<{ import: MigrationImport; rows: MigrationImportRow[] }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { def, table, columns } = parseAndResolve(input);
    const missing = findMissingRequired(def.columns, def.requiredOneOf, columns);
    const firstMissing = missing[0];
    if (firstMissing !== undefined) {
      const label = def.columns.find((c) => c.key === firstMissing)?.label ?? firstMissing;
      throw new ApiError(422, def.missingMessages[firstMissing] ?? `Could not find a "${label}" column in the file`);
    }
    const parsed = table.rows.map((cells, i) => def.parseRow(cells, columns, i + 2, { dateFormat: input.dateFormat }));

    if (parsed.length === 0) {
      throw new ApiError(422, 'The file contains no data rows');
    }

    const { rows: importRows } = await client.query<{ id: string }>(
      `INSERT INTO migration_imports (org_id, kind, file_name, delimiter, row_count, created_by, column_map, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, jsonb_build_object('dateFormat', $8::text))
       RETURNING id`,
      [
        orgId,
        input.kind,
        input.fileName,
        table.delimiter,
        parsed.length,
        createdBy,
        input.columnMap === null ? null : JSON.stringify(input.columnMap),
        input.dateFormat,
      ],
    );
    const importId = importRows[0]?.id;
    if (importId === undefined) throw new Error('no import id');

    await client.query(
      `INSERT INTO migration_import_rows
         (org_id, import_id, row_number, raw, account_code, account_name, account_type, parent_code,
          description, debit_cents, credit_cents,
          party_name, party_email, party_phone, party_address, party_tax_number, party_payment_terms, party_notes, data, group_key)
       SELECT $1, $2, v.row_number, v.raw::jsonb, v.account_code, v.account_name, v.account_type,
              v.parent_code, v.description, v.debit_cents, v.credit_cents,
              v.party_name, v.party_email, v.party_phone, v.party_address, v.party_tax_number,
              v.party_payment_terms, v.party_notes,
              v.data::jsonb, v.group_key
         FROM unnest(
                $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                $10::bigint[], $11::bigint[],
                $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[],
                $19::text[], $20::text[]
              ) AS v(row_number, raw, account_code, account_name, account_type, parent_code, description,
                      debit_cents, credit_cents,
                      party_name, party_email, party_phone, party_address, party_tax_number,
                      party_payment_terms, party_notes, data, group_key)`,
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
        parsed.map((r) => r.partyName),
        parsed.map((r) => r.partyEmail),
        parsed.map((r) => r.partyPhone),
        parsed.map((r) => r.partyAddress),
        parsed.map((r) => r.partyTaxNumber),
        parsed.map((r) => r.partyPaymentTerms),
        parsed.map((r) => r.partyNotes),
        parsed.map((r) => (r.data === null ? null : JSON.stringify(r.data))),
        parsed.map((r) => r.groupKey),
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
  /** CUSTOMERS and VENDORS only. */
  partyName?: string | undefined;
  partyEmail?: string | null | undefined;
  partyPhone?: string | null | undefined;
  partyAddress?: string | null | undefined;
  partyTaxNumber?: string | null | undefined;
  partyPaymentTerms?: string | null | undefined;
  partyNotes?: string | null | undefined;
  status?: 'VALID' | 'EXCLUDED' | undefined;
  /** storage:'data' kinds: column key -> new cell text. */
  values?: Record<string, string | null> | undefined;
}

/** Applies one row fix, then re-validates the whole import. Refused on COMMITTED. */
export async function patchRow(
  orgId: string,
  importId: string,
  rowId: string,
  input: PatchRowInput,
): Promise<{ import: MigrationImport; row: MigrationImportRow }> {
  return withTransaction(async (client) => {
    const { rows: statusRows } = await client.query<{ status: string; kind: string }>(
      'SELECT status, kind FROM migration_imports WHERE id = $1 AND org_id = $2',
      [importId, orgId],
    );
    const importStatus = statusRows[0]?.status;
    const importKind = statusRows[0]?.kind;
    if (importStatus === undefined || importKind === undefined) throw new ApiError(404, 'Migration import not found');
    if (importStatus === 'COMMITTED') throw new ApiError(409, 'This import has already been committed');
    if (!isMigrationImportKind(importKind)) throw new Error(`Unknown migration import kind "${importKind}"`);
    const def = getImportKind(importKind);

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
      partyName: 'party_name',
      partyEmail: 'party_email',
      partyPhone: 'party_phone',
      partyAddress: 'party_address',
      partyTaxNumber: 'party_tax_number',
      partyPaymentTerms: 'party_payment_terms',
      partyNotes: 'party_notes',
      status: 'status',
    } as const;

    const assignments: string[] = [];
    const values: unknown[] = [rowId, orgId, importId];

    const legacyKeys = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter(
      (key) => key !== 'status' && input[key] !== undefined,
    );
    if (def.storage === 'data' && legacyKeys.length > 0) {
      throw new ApiError(400, 'Edit this import with "values"');
    }
    if (def.storage === 'typed' && input.values !== undefined) {
      throw new ApiError(400, 'This import kind does not take "values"');
    }

    for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
    }

    if (input.values !== undefined) {
      const dateFormat = await importDateFormatOnClient(client, orgId, importId);
      const rawPatch: Record<string, string> = {};
      const dataPatch: Record<string, string | number | null> = {};
      for (const [key, text] of Object.entries(input.values)) {
        const col = def.columns.find((c) => c.key === key);
        if (col === undefined) throw new ApiError(400, `Unknown field "${key}"`);
        rawPatch[key] = text ?? '';
        const parsed = parseImportCell(col, text ?? '', dateFormat);
        dataPatch[key] = parsed.ok ? parsed.value : null;
      }
      values.push(JSON.stringify(dataPatch));
      assignments.push(`data = COALESCE(data, '{}'::jsonb) || $${String(values.length)}::jsonb`);
      values.push(JSON.stringify(rawPatch));
      assignments.push(`raw = raw || $${String(values.length)}::jsonb`);
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
  return withTransaction((client) => getImportKind(imp.kind).preview(client, orgId, importId));
}

export type CommitResult = MigrationCommitResult;

/** Commits a VALIDATED import, delegated by kind. All-or-nothing. */
export async function commit(
  orgId: string,
  createdBy: string,
  importId: string,
): Promise<{ import: MigrationImport; result: CommitResult }> {
  // Pre-transaction reads (rule 5): the kind, and whatever its prepareCommit
  // needs from the pool. Nothing below BEGIN may touch `pool`.
  const kindRow = await getImportById(orgId, importId);
  const def = getImportKind(kindRow.kind);
  const context = (await def.prepareCommit?.(orgId)) ?? { inventoryProfile: null };

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: lockedRows } = await client.query<{ kind: string; status: string; error_count: number }>(
      'SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [importId, orgId],
    );
    const locked = lockedRows[0];
    if (locked === undefined) throw new ApiError(404, 'Migration import not found');
    if (locked.status === 'COMMITTED') {
      throw new ApiError(409, 'This import has already been committed');
    }
    if (locked.status !== 'VALIDATED') {
      throw new ApiError(409, `Fix ${String(locked.error_count)} invalid row(s) before committing`);
    }
    if (!isMigrationImportKind(locked.kind)) {
      throw new Error(`Unknown migration import kind "${locked.kind}"`);
    }
    if (locked.kind !== kindRow.kind) throw new Error('import kind changed');

    // A data kind's rows can go stale between validation and commit (an account
    // deactivated, a code taken), so they are re-validated under the lock.
    if (def.storage === 'data') {
      const { rows: rowRows } = await client.query<RowRow>(
        `SELECT ${ROW_COLUMNS} FROM migration_import_rows
          WHERE org_id = $1 AND import_id = $2 AND status <> 'EXCLUDED'
          ORDER BY row_number ASC`,
        [orgId, importId],
      );
      const results = await def.validateRows(client, orgId, rowRows.map(toRow));
      const invalid = results.filter((r) => r.errors.length > 0).length;
      if (invalid > 0) {
        throw new ApiError(
          409,
          `${String(invalid)} row(s) became invalid since validation — re-validate to see them`,
        );
      }
    }

    const result = await def.commitOnClient(client, orgId, importId, createdBy, context);

    await client.query('UPDATE migration_imports SET result = $1::jsonb WHERE id = $2 AND org_id = $3', [
      JSON.stringify(result),
      importId,
      orgId,
    ]);

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

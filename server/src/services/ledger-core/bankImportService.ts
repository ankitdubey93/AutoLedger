import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents, parseMoneyText } from '../../utils/money.js';
import { parseCsv, type CsvTable } from '../../utils/csv.js';
import { parseFlexibleDate, type DateFormat } from '../../utils/dateParse.js';
import { AUTO_MATCH_THRESHOLD, normalizeForMatching } from '../../utils/matchScore.js';
import { emitEvent } from '../outboxService.js';
import * as bankMatchService from './bankMatchService.js';
import type { BankStatementImport } from '../../types/ledger-core.js';

/**
 * LedgerCore bank statement ingestion.
 *
 * A CSV arrives as a JSON string field, not a multipart upload — file
 * storage belongs to Phase 10, not here. Re-importing the same statement is
 * idempotent via `UNIQUE (org_id, dedupe_hash)` on `bank_transactions`; see
 * study/postgresql/idempotent-ingestion-and-dedupe-hashes.md.
 */

const PG_RAISE_EXCEPTION = 'P0001';
const UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the import';
  }
  return 'Database rejected the import';
}

// ------------------------------------------------------------- column maps

const DATE_SYNONYMS = ['date', 'transaction date', 'txn date', 'posting date', 'value date', 'booking date'];
const DESCRIPTION_SYNONYMS = ['description', 'narrative', 'details', 'memo', 'particulars', 'payee', 'transaction'];
const AMOUNT_SYNONYMS = ['amount', 'value', 'transaction amount'];
const DEBIT_SYNONYMS = ['debit', 'withdrawal', 'money out', 'paid out', 'dr'];
const CREDIT_SYNONYMS = ['credit', 'deposit', 'money in', 'paid in', 'cr'];
const REFERENCE_SYNONYMS = ['reference', 'ref', 'transaction reference', 'cheque number', 'check number'];

export interface ColumnMapInput {
  date: string;
  description: string;
  amount: string | null;
  debit: string | null;
  credit: string | null;
  reference: string | null;
}

interface ResolvedColumns {
  dateIdx: number;
  descriptionIdx: number;
  amountIdx: number | null;
  debitIdx: number | null;
  creditIdx: number | null;
  referenceIdx: number | null;
}

function findColumnBySynonyms(headers: string[], synonyms: string[]): number | null {
  const normalizedHeaders = headers.map(normalizeForMatching);
  for (const synonym of synonyms) {
    const idx = normalizedHeaders.indexOf(synonym);
    if (idx !== -1) return idx;
  }
  return null;
}

function findColumnByName(headers: string[], name: string): number {
  const target = name.trim().toLowerCase();
  const idx = headers.findIndex((h) => h.trim().toLowerCase() === target);
  if (idx === -1) throw new ApiError(422, `Column "${name}" is not in the file`);
  return idx;
}

function resolveColumns(headers: string[], columnMap: ColumnMapInput | null): ResolvedColumns {
  if (columnMap !== null) {
    return {
      dateIdx: findColumnByName(headers, columnMap.date),
      descriptionIdx: findColumnByName(headers, columnMap.description),
      amountIdx: columnMap.amount !== null ? findColumnByName(headers, columnMap.amount) : null,
      debitIdx: columnMap.debit !== null ? findColumnByName(headers, columnMap.debit) : null,
      creditIdx: columnMap.credit !== null ? findColumnByName(headers, columnMap.credit) : null,
      referenceIdx: columnMap.reference !== null ? findColumnByName(headers, columnMap.reference) : null,
    };
  }

  const dateIdx = findColumnBySynonyms(headers, DATE_SYNONYMS);
  const descriptionIdx = findColumnBySynonyms(headers, DESCRIPTION_SYNONYMS);
  if (dateIdx === null) throw new ApiError(422, 'Could not find a date column in the file');
  if (descriptionIdx === null) throw new ApiError(422, 'Could not find a description column in the file');

  const amountIdx = findColumnBySynonyms(headers, AMOUNT_SYNONYMS);
  const debitIdx = findColumnBySynonyms(headers, DEBIT_SYNONYMS);
  const creditIdx = findColumnBySynonyms(headers, CREDIT_SYNONYMS);
  if (amountIdx === null && (debitIdx === null || creditIdx === null)) {
    throw new ApiError(422, 'Could not find an amount column, or a debit/credit pair, in the file');
  }
  const referenceIdx = findColumnBySynonyms(headers, REFERENCE_SYNONYMS);

  return { dateIdx, descriptionIdx, amountIdx, debitIdx, creditIdx, referenceIdx };
}

// ------------------------------------------------------------- row parsing

interface ParsedRow {
  txnDate: string;
  description: string;
  externalReference: string | null;
  amountCents: number;
}

function parseRows(
  table: CsvTable,
  columns: ResolvedColumns,
  dateFormat: DateFormat,
): { valid: ParsedRow[]; errors: string[] } {
  const valid: ParsedRow[] = [];
  const errors: string[] = [];

  table.rows.forEach((cells, index) => {
    // 1-based, header row counted.
    const rowNumber = index + 2;

    const dateRaw = cells[columns.dateIdx] ?? '';
    const parsedDate = parseFlexibleDate(dateRaw, dateFormat);
    if (parsedDate === null) {
      errors.push(`row ${String(rowNumber)}: unparseable date "${dateRaw}"`);
      return;
    }

    let amountCents: number;
    try {
      if (columns.amountIdx !== null) {
        amountCents = parseMoneyText(cells[columns.amountIdx] ?? '');
      } else if (columns.debitIdx !== null && columns.creditIdx !== null) {
        const debit = parseMoneyText(cells[columns.debitIdx] ?? '');
        const credit = parseMoneyText(cells[columns.creditIdx] ?? '');
        amountCents = credit - debit;
      } else {
        // Unreachable — resolveColumns guarantees one of the two shapes.
        throw new ApiError(422, 'No amount column resolved');
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'unparseable amount';
      errors.push(`row ${String(rowNumber)}: ${message}`);
      return;
    }

    if (amountCents === 0) {
      errors.push(`row ${String(rowNumber)}: amount is zero`);
      return;
    }

    const description = (cells[columns.descriptionIdx] ?? '').trim().slice(0, 500);
    const referenceRaw = columns.referenceIdx !== null ? (cells[columns.referenceIdx] ?? '').trim() : '';
    const externalReference = referenceRaw === '' ? null : referenceRaw.slice(0, 100);

    valid.push({ txnDate: parsedDate, description, externalReference, amountCents });
  });

  return { valid, errors };
}

/**
 * Content-addressed dedupe hash per row, folding in an occurrence ordinal
 * among rows sharing the identical tuple within this same file — without
 * it, two genuinely identical lines in one statement would collide with
 * each other and only one would survive.
 */
function computeDedupeHashes(orgId: string, accountId: string, rows: ParsedRow[]): string[] {
  const occurrenceCounts = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.txnDate}|${String(row.amountCents)}|${normalizeForMatching(row.description)}|${row.externalReference ?? ''}`;
    const occurrence = occurrenceCounts.get(key) ?? 0;
    occurrenceCounts.set(key, occurrence + 1);
    const seed = `${orgId}|${accountId}|${key}|${String(occurrence)}`;
    return createHash('sha256').update(seed).digest('hex');
  });
}

// ---------------------------------------------------------------- row mapping

interface ImportRow {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  file_name: string;
  date_format: string;
  delimiter: string;
  row_count: number;
  imported_count: number;
  duplicate_count: number;
  earliest_date: string | null;
  latest_date: string | null;
  closing_balance_cents: string | null;
  closing_balance_on: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
}

const IMPORT_SELECT = `SELECT i.id, i.account_id, a.code AS account_code, a.name AS account_name,
                               i.file_name, i.date_format, i.delimiter, i.row_count, i.imported_count, i.duplicate_count,
                               i.earliest_date, i.latest_date, i.closing_balance_cents, i.closing_balance_on,
                               i.created_by, u.name AS created_by_name, i.created_at
                          FROM bank_statement_imports i
                          JOIN accounts a ON a.id = i.account_id AND a.org_id = i.org_id
                          LEFT JOIN users u ON u.id = i.created_by`;

function toImport(row: ImportRow): BankStatementImport {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    fileName: row.file_name,
    dateFormat: row.date_format,
    delimiter: row.delimiter,
    rowCount: row.row_count,
    importedCount: row.imported_count,
    duplicateCount: row.duplicate_count,
    earliestDate: row.earliest_date,
    latestDate: row.latest_date,
    closingBalanceCents: row.closing_balance_cents === null ? null : parseCents(row.closing_balance_cents),
    closingBalanceOn: row.closing_balance_on,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------- reads

export async function getImportById(orgId: string, id: string): Promise<BankStatementImport> {
  const { rows } = await pool.query<ImportRow>(`${IMPORT_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Bank statement import not found');
  return toImport(row);
}

export interface ListImportsOptions {
  page: number;
  limit: number;
  accountId: string | null;
}

export async function listImports(
  orgId: string,
  options: ListImportsOptions,
): Promise<{ imports: BankStatementImport[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const clauses = ['i.org_id = $1'];
  const values: unknown[] = [orgId];
  if (options.accountId !== null) {
    values.push(options.accountId);
    clauses.push(`i.account_id = $${String(values.length)}`);
  }
  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM bank_statement_imports i WHERE ${where}`,
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

// --------------------------------------------------------------------- writes

export interface ImportStatementInput {
  accountId: string;
  fileName: string;
  content: string;
  dateFormat: DateFormat;
  columnMap: ColumnMapInput | null;
  closingBalanceCents: number | null;
  closingBalanceOn: string | null;
}

export interface ImportStatementResult {
  import: BankStatementImport;
  /** Lines whose dedupe_hash was already present, and were therefore skipped. */
  duplicateCount: number;
  /** Newly inserted lines. */
  importedCount: number;
  /** Newly inserted lines that got at least one suggestion. */
  suggestedCount: number;
  /** Newly inserted lines with a suggestion scoring >= AUTO_MATCH_THRESHOLD. */
  autoMatchableCount: number;
}

export async function importStatement(
  orgId: string,
  createdBy: string,
  input: ImportStatementInput,
): Promise<ImportStatementResult> {
  const client: PoolClient = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const currencyCode = orgRows[0]?.base_currency.trim();
    if (currencyCode === undefined) throw new ApiError(404, 'Organization not found');

    const { rows: accountRows } = await client.query<{
      id: string;
      code: string;
      is_postable: boolean;
      type: string;
    }>('SELECT id, code, is_postable, type FROM accounts WHERE id = $1 AND org_id = $2', [
      input.accountId,
      orgId,
    ]);
    const account = accountRows[0];
    if (account === undefined) throw new ApiError(422, 'Bank account not found');
    if (!account.is_postable) {
      throw new ApiError(422, `Account ${account.code} is a header account and cannot be posted to`);
    }
    if (account.type !== 'Asset') {
      throw new ApiError(422, `Account ${account.code} is not an Asset account`);
    }

    const table = parseCsv(input.content);
    const columns = resolveColumns(table.headers, input.columnMap);
    const { valid, errors } = parseRows(table, columns, input.dateFormat);

    if (errors.length > 0) {
      const shown = errors.slice(0, 3);
      const suffix = errors.length > 3 ? `; and ${String(errors.length - 3)} more` : '';
      throw new ApiError(
        422,
        `Import failed: ${String(errors.length)} row(s) could not be parsed (${shown.join('; ')}${suffix})`,
      );
    }

    if (valid.length === 0) {
      throw new ApiError(422, 'The file contains no transaction rows');
    }

    const dedupeHashes = computeDedupeHashes(orgId, input.accountId, valid);

    const sortedDates = valid.map((r) => r.txnDate).slice().sort();
    const earliestDate = sortedDates[0] ?? null;
    const latestDate = sortedDates[sortedDates.length - 1] ?? null;

    const { rows: importRows } = await client.query<{ id: string }>(
      `INSERT INTO bank_statement_imports
         (org_id, account_id, file_name, date_format, delimiter, row_count, earliest_date, latest_date,
          closing_balance_cents, closing_balance_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        orgId,
        input.accountId,
        input.fileName,
        input.dateFormat,
        table.delimiter,
        valid.length,
        earliestDate,
        latestDate,
        input.closingBalanceCents,
        input.closingBalanceOn,
        createdBy,
      ],
    );
    const importId = importRows[0]?.id;
    if (importId === undefined) throw new Error('no import id');

    const { rows: insertedRows } = await client.query<{
      id: string;
      txn_date: string;
      description: string;
      external_reference: string | null;
      amount_cents: string;
    }>(
      `INSERT INTO bank_transactions
         (org_id, import_id, account_id, txn_date, description, external_reference,
          currency_code, amount_cents, dedupe_hash)
       SELECT $1, $2, $3, v.txn_date, v.description, v.external_reference, $4, v.amount_cents, v.dedupe_hash
         FROM unnest($5::date[], $6::text[], $7::text[], $8::bigint[], $9::text[])
              AS v(txn_date, description, external_reference, amount_cents, dedupe_hash)
       ON CONFLICT (org_id, dedupe_hash) DO NOTHING
       RETURNING id, txn_date, description, external_reference, amount_cents`,
      [
        orgId,
        importId,
        input.accountId,
        currencyCode,
        valid.map((r) => r.txnDate),
        valid.map((r) => r.description),
        valid.map((r) => r.externalReference),
        valid.map((r) => r.amountCents),
        dedupeHashes,
      ],
    );

    const importedCount = insertedRows.length;
    const duplicateCount = valid.length - importedCount;

    await client.query(
      'UPDATE bank_statement_imports SET imported_count = $1, duplicate_count = $2 WHERE id = $3 AND org_id = $4',
      [importedCount, duplicateCount, importId, orgId],
    );

    const insertedIds = insertedRows.map((r) => r.id);
    await bankMatchService.generateSuggestionsOnClient(client, orgId, insertedIds);

    // AUTO_MATCH_THRESHOLD is our own compile-time constant, not request
    // input, so interpolating it here is safe — the same reasoning
    // paymentService.allocatedCentsSubquery gives for its alias arguments.
    const { rows: summaryRows } = await client.query<{ suggested: string; auto_matchable: string }>(
      `SELECT count(DISTINCT bank_transaction_id) FILTER (WHERE true) AS suggested,
              count(DISTINCT bank_transaction_id) FILTER (WHERE score >= ${String(AUTO_MATCH_THRESHOLD)}) AS auto_matchable
         FROM bank_match_suggestions
        WHERE org_id = $1 AND bank_transaction_id = ANY($2::uuid[])`,
      [orgId, insertedIds],
    );
    const suggestedCount = Number(summaryRows[0]?.suggested ?? '0');
    const autoMatchableCount = Number(summaryRows[0]?.auto_matchable ?? '0');

    // The roadmap's named webhook example — "an unallocated transaction
    // above a configured threshold reaching the ledger". Only rows actually
    // inserted (never a re-imported duplicate) can trigger it, and 0 means
    // disabled.
    const { rows: thresholdRows } = await client.query<{ unmatched_alert_threshold_cents: string }>(
      'SELECT unmatched_alert_threshold_cents FROM ledger_settings WHERE org_id = $1',
      [orgId],
    );
    const thresholdCents = parseCents(thresholdRows[0]?.unmatched_alert_threshold_cents ?? '0');

    if (thresholdCents > 0) {
      for (const row of insertedRows) {
        const amountCents = parseCents(row.amount_cents);
        // Signed: a large outflow matters as much as a large inflow.
        if (Math.abs(amountCents) >= thresholdCents) {
          await emitEvent(client, orgId, 'ledger-core', 'bank.large_unmatched', {
            bankTransactionId: row.id,
            importId,
            accountId: input.accountId,
            txnDate: row.txn_date,
            currencyCode,
            amountCents,
            description: row.description,
            externalReference: row.external_reference,
            thresholdCents,
          });
        }
      }
    }

    await client.query('COMMIT');
    return {
      import: await getImportById(orgId, importId),
      importedCount,
      duplicateCount,
      suggestedCount,
      autoMatchableCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    if (pgErrorCode(err) === UNIQUE_VIOLATION) {
      throw new ApiError(409, 'That statement is already being imported');
    }
    throw err;
  } finally {
    client.release();
  }
}

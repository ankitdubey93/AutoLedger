import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import { cents, formatCents } from '../../utils/money.js';
import type {
  MigrationCommitPreview,
  MigrationCommitResult,
  MigrationImportRow,
} from '../../types/accounting.js';
import { dataRowParseErrors } from './importRowParsers.js';
import {
  importDateFormatForRowOnClient,
  loadDataRowsOnClient,
  markCommittedOnClient,
} from './importRowStore.js';
import { accountCodeError, loadAccountsByCodeOnClient } from './importAccountLookup.js';
import { JOURNAL_COLUMNS, journalGroupKey } from './importJournalColumns.js';
import { createEntryOnClient, listControlAccountsOnClient } from './journalService.js';
import { periodStatusOnClient } from './fiscalPeriodService.js';

/**
 * Manual-journal import (Phase 36c) — the validate, preview and commit halves
 * for the grouped `JOURNALS` kind. Many CSV rows are one journal entry: rows
 * group by `JournalNumber`, or by Date + Narration (Xero-style) when there is
 * no number. Each entry is validated as a whole and posted through
 * `createEntryOnClient` with `source_type 'migration_import'`. Every lookup is
 * org-scoped (rule 1) and runs on the caller's client (rule 5); amounts are
 * integer cents (rule 3); an entry must balance here, in `createEntryOnClient`
 * and in the deferred DB trigger (rule 7).
 */

type Values = Readonly<Record<string, string | number | null>>;

interface LineRow {
  id: string;
  rowNumber: number;
  values: Values;
  raw: Readonly<Record<string, string>>;
  groupKey: string | null;
}

interface Group {
  rows: LineRow[];
  numbered: boolean;
}

interface Side {
  debitCents: number;
  creditCents: number;
}

function text(values: Values, key: string): string | null {
  const v = values[key];
  return typeof v === 'string' ? v : null;
}

function num(values: Values, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' ? v : null;
}

function uniq(list: (string | null)[]): string[] {
  return [...new Set(list.filter((v): v is string => v !== null))];
}

/** Groups in first-row order; a row with a null key is its own group. */
function groupRows(rows: readonly LineRow[]): Group[] {
  const byKey = new Map<string, Group>();
  const out: Group[] = [];
  for (const row of rows) {
    const key = row.groupKey;
    if (key === null) {
      out.push({ rows: [row], numbered: false });
      continue;
    }
    let group = byKey.get(key);
    if (group === undefined) {
      group = { rows: [], numbered: key.startsWith('N:') };
      byKey.set(key, group);
      out.push(group);
    }
    group.rows.push(row);
  }
  return out;
}

function groupLabel(first: LineRow): string {
  const number = text(first.values, 'journalNumber');
  if (number !== null) return `journal ${number}`;
  const date = (first.raw['date'] ?? '').trim();
  const narration = (first.raw['narration'] ?? '').trim();
  return `journal dated ${date} "${narration}"`;
}

/** The row's debit/credit split, or null when the row does not carry exactly one valid side. */
function sideOf(values: Values): Side | null {
  const amount = num(values, 'amount');
  if (amount !== null) {
    if (amount === 0) return null;
    return amount > 0 ? { debitCents: amount, creditCents: 0 } : { debitCents: 0, creditCents: -amount };
  }
  const debit = num(values, 'debit') ?? 0;
  const credit = num(values, 'credit') ?? 0;
  if ((debit > 0) === (credit > 0)) return null;
  return { debitCents: debit, creditCents: credit };
}

function toLineRow(r: { id: string; rowNumber: number; values: Values; raw: Readonly<Record<string, string>> }): LineRow {
  return { id: r.id, rowNumber: r.rowNumber, values: r.values, raw: r.raw, groupKey: journalGroupKey(r.values, r.raw) };
}

export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const first = rows[0];
  const dateFormat = first ? await importDateFormatForRowOnClient(client, orgId, first.id) : 'ISO';
  const accounts = await loadAccountsByCodeOnClient(
    client,
    orgId,
    uniq(rows.map((r) => text(r.values, 'accountCode'))),
  );
  const controls = await listControlAccountsOnClient(client, orgId);
  const periodCache = new Map<string, Awaited<ReturnType<typeof periodStatusOnClient>>>();

  const lines: LineRow[] = rows.map((r) => ({
    id: r.id,
    rowNumber: r.rowNumber,
    values: r.values,
    raw: r.raw,
    groupKey: r.groupKey,
  }));
  const errorsById = new Map<string, string[]>();
  const sideById = new Map<string, Side | null>();

  for (const row of lines) {
    const errors = dataRowParseErrors(JOURNAL_COLUMNS, row.raw, dateFormat);
    const hasRaw = (key: string): boolean => (row.raw[key] ?? '').trim() !== '';
    const required: [string, string, string][] = [
      ['date', 'Date is required', 'date'],
      ['narration', 'Narration is required', 'narration'],
      ['accountCode', 'Account code is required', 'accountCode'],
    ];
    for (const [key, message] of required) {
      // A cell with text that failed to parse already has its own error.
      if (text(row.values, key) === null && !hasRaw(key)) errors.push(message);
    }

    const unparsedAmount = ['debit', 'credit', 'amount'].some(
      (key) => hasRaw(key) && row.values[key] === null,
    );
    const amount = num(row.values, 'amount');
    let resolved = !unparsedAmount;
    if (amount !== null) {
      if (amount === 0) {
        errors.push('A line needs a non-zero amount');
        resolved = false;
      }
    } else {
      const debit = num(row.values, 'debit') ?? 0;
      const credit = num(row.values, 'credit') ?? 0;
      if (debit > 0 && credit > 0) {
        errors.push('A line has either a debit or a credit, not both');
        resolved = false;
      } else if (debit <= 0 && credit <= 0) {
        if (!unparsedAmount) errors.push('A line needs a debit or a credit amount');
        resolved = false;
      }
    }
    sideById.set(row.id, resolved ? sideOf(row.values) : null);

    const code = text(row.values, 'accountCode');
    if (code !== null) {
      const account = accounts.get(code);
      const err = accountCodeError('AccountCode', code, account, ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);
      if (err !== null) errors.push(err);
      else if (account !== undefined) {
        const control = controls.get(account.id);
        if (control !== undefined) errors.push(control);
      }
    }
    errorsById.set(row.id, errors);
  }

  for (const group of groupRows(lines)) {
    const head = group.rows[0];
    if (head === undefined) continue;
    const label = groupLabel(head);
    const groupErrors: string[] = [];

    if (group.rows.length < 2) {
      groupErrors.push(`The ${label} has only one line — an entry needs at least two`);
    }

    if (group.numbered) {
      for (const row of group.rows.slice(1)) {
        const rowErrors = errorsById.get(row.id);
        if (rowErrors === undefined) continue;
        for (const key of ['date', 'narration'] as const) {
          const a = row.values[key];
          const b = head.values[key];
          if (a !== null && a !== undefined && b !== null && b !== undefined && a !== b) {
            rowErrors.push(
              `${key === 'date' ? 'Date' : 'Narration'} differs from row ${String(head.rowNumber)} (${head.raw[key] ?? ''}) — every line of ${label} must match`,
            );
          }
        }
      }
    }

    const sides = group.rows.map((r) => sideById.get(r.id) ?? null);
    if (sides.every((s): s is Side => s !== null)) {
      let d = 0;
      let c = 0;
      for (const s of sides) {
        d += s.debitCents;
        c += s.creditCents;
      }
      if (d !== c) {
        groupErrors.push(`The ${label} does not balance: debits ${formatCents(cents(d))}, credits ${formatCents(cents(c))}`);
      }
    }

    const date = text(head.values, 'date');
    if (date !== null) {
      if (!periodCache.has(date)) periodCache.set(date, await periodStatusOnClient(client, orgId, date));
      const status = periodCache.get(date);
      if (status === 'CLOSED' || status === 'LOCKED') {
        groupErrors.push(`The fiscal period covering ${date} is ${status.toLowerCase()}; reopen it or change the date`);
      }
    }

    for (const row of group.rows) errorsById.get(row.id)?.push(...groupErrors);
  }

  return lines.map((row) => ({ rowId: row.id, errors: errorsById.get(row.id) ?? [] }));
}

export async function preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ status: string; error_count: number }>(
    'SELECT status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');

  const rows = (await loadDataRowsOnClient(client, orgId, importId)).map(toLineRow);
  const groups = groupRows(rows);
  let totalDebits = 0;
  for (const row of rows) totalDebits += sideOf(row.values)?.debitCents ?? 0;

  const { rows: settings } = await client.query<{ books_start: string | null }>(
    "SELECT to_char(books_start_date, 'YYYY-MM-DD') AS books_start FROM ledger_settings WHERE org_id = $1",
    [orgId],
  );
  const booksStart = settings[0]?.books_start ?? null;
  const warnings: string[] = [];
  if (booksStart !== null) {
    const early = groups.filter((g) => {
      const d = g.rows[0] === undefined ? null : text(g.rows[0].values, 'date');
      return d !== null && d < booksStart;
    }).length;
    if (early > 0) {
      warnings.push(`${String(early)} journal(s) are dated before your conversion date (${booksStart}) — they post into the period before it.`);
    }
  }

  return {
    kind: 'JOURNALS',
    canCommit: imp.error_count === 0 && imp.status === 'VALIDATED',
    blockingErrorCount: imp.error_count,
    accountsToCreate: 0,
    accountsToMerge: 0,
    totalDebitCents: 0,
    totalCreditCents: 0,
    plugCents: 0,
    plugAccountCode: '',
    entryDate: null,
    partiesToCreate: 0,
    partiesToMerge: 0,
    summary: [
      { label: 'Journal entries to post', value: groups.length, format: 'count' },
      { label: 'Lines', value: rows.length, format: 'count' },
      { label: 'Total debits', value: totalDebits, format: 'money' },
    ],
    warnings,
  };
}

export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  createdBy: string,
  _context?: unknown,
): Promise<Extract<MigrationCommitResult, { kind: 'JOURNALS' }>> {
  const rows = (await loadDataRowsOnClient(client, orgId, importId)).map(toLineRow);
  const accounts = await loadAccountsByCodeOnClient(
    client,
    orgId,
    uniq(rows.map((r) => text(r.values, 'accountCode'))),
  );

  let entryCount = 0;
  let lineCount = 0;
  for (const group of groupRows(rows)) {
    const head = group.rows[0];
    const last = group.rows[group.rows.length - 1];
    if (head === undefined || last === undefined) continue;
    const label = groupLabel(head);
    const rowSpan = `rows ${String(head.rowNumber)}–${String(last.rowNumber)}`;
    const date = text(head.values, 'date');
    const narration = text(head.values, 'narration');
    if (date === null || narration === null) {
      throw new ApiError(409, `The ${label} (${rowSpan}): date and narration are required`);
    }

    const lines = group.rows.map((row) => {
      const code = text(row.values, 'accountCode');
      const accountId = code === null ? undefined : accounts.get(code)?.id;
      const side = sideOf(row.values);
      if (accountId === undefined || side === null) {
        throw new ApiError(409, `The ${label} (${rowSpan}): row ${String(row.rowNumber)} is not postable`);
      }
      return { accountId, debitCents: side.debitCents, creditCents: side.creditCents };
    });

    try {
      await createEntryOnClient(client, orgId, createdBy, {
        entryDate: date,
        description: narration,
        sourceType: 'migration_import',
        sourceId: importId,
        lines,
      });
    } catch (err) {
      if (err instanceof ApiError) throw new ApiError(err.status, `The ${label} (${rowSpan}): ${err.message}`);
      throw err;
    }
    entryCount += 1;
    lineCount += lines.length;
  }

  await markCommittedOnClient(client, orgId, importId);
  return { kind: 'JOURNALS', entryCount, lineCount };
}

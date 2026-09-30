import { parseMoneyText } from '../../utils/money.js';
import { parseImportCell } from '../../utils/importValues.js';
import type { DateFormat } from '../../utils/dateParse.js';
import { isAccountType, type AccountType, type ImportColumnDef } from '../../types/accounting.js';

/**
 * Row parsers for the staged migration importers (Phase 9b, rekeyed in Phase 36).
 * Each parser reads cells through a column-KEY -> index map, so the same parser
 * serves a file whose columns were found by synonym or mapped by the user.
 */

export interface StagedRowInput {
  rowNumber: number;
  raw: Record<string, string>;
  accountCode: string | null;
  accountName: string | null;
  accountType: AccountType | null;
  parentCode: string | null;
  description: string | null;
  debitCents: number | null;
  creditCents: number | null;
  /** CUSTOMERS and VENDORS only. */
  partyName: string | null;
  partyEmail: string | null;
  partyPhone: string | null;
  partyAddress: string | null;
  partyTaxNumber: string | null;
  partyPaymentTerms: string | null;
  partyNotes: string | null;
  /** storage:'data' kinds only: parsed cell values by column key. */
  data: Record<string, string | number | null> | null;
  groupKey: string | null;
}

export type ResolvedImportColumns = Readonly<Record<string, number | null>>;

const NULL_PARTY_FIELDS = {
  partyName: null,
  partyEmail: null,
  partyPhone: null,
  partyAddress: null,
  partyTaxNumber: null,
  partyPaymentTerms: null,
  partyNotes: null,
} as const;

const ACCOUNT_TYPE_ALIASES: Record<string, AccountType> = {
  // Asset
  asset: 'Asset',
  assets: 'Asset',
  bank: 'Asset',
  'current asset': 'Asset',
  'current assets': 'Asset',
  'fixed asset': 'Asset',
  'fixed assets': 'Asset',
  'non-current asset': 'Asset',
  'non current asset': 'Asset',
  inventory: 'Asset',
  prepayment: 'Asset',
  'accounts receivable': 'Asset',
  'accounts receivable (a/r)': 'Asset',
  'other current asset': 'Asset',
  'other current assets': 'Asset',
  'other asset': 'Asset',
  'other assets': 'Asset',
  // Liability
  liability: 'Liability',
  liabilities: 'Liability',
  'current liability': 'Liability',
  'current liabilities': 'Liability',
  'non-current liability': 'Liability',
  'non current liability': 'Liability',
  'term liability': 'Liability',
  'long term liability': 'Liability',
  'long term liabilities': 'Liability',
  'accounts payable': 'Liability',
  'accounts payable (a/p)': 'Liability',
  'credit card': 'Liability',
  'other current liability': 'Liability',
  'other current liabilities': 'Liability',
  // Equity
  equity: 'Equity',
  // Revenue
  revenue: 'Revenue',
  income: 'Revenue',
  sales: 'Revenue',
  'other income': 'Revenue',
  // Expense
  expense: 'Expense',
  expenses: 'Expense',
  'direct costs': 'Expense',
  overhead: 'Expense',
  overheads: 'Expense',
  depreciation: 'Expense',
  'cost of goods sold': 'Expense',
  cogs: 'Expense',
  'cost of sales': 'Expense',
  'other expense': 'Expense',
};

export function normalizeAccountType(raw: string): AccountType | null {
  const key = raw.trim().toLowerCase();
  const candidate = ACCOUNT_TYPE_ALIASES[key];
  return candidate !== undefined && isAccountType(candidate) ? candidate : null;
}

/** Trimmed cell text for a column key; '' when unmapped or absent. */
function cellText(cells: readonly string[], columns: ResolvedImportColumns, key: string): string {
  const idx = columns[key];
  if (idx === null || idx === undefined) return '';
  return (cells[idx] ?? '').trim();
}

export function parseChartRow(
  cells: readonly string[],
  columns: ResolvedImportColumns,
  rowNumber: number,
): StagedRowInput {
  const codeRaw = cellText(cells, columns, 'code');
  const nameRaw = cellText(cells, columns, 'name');
  const typeRaw = cellText(cells, columns, 'type');
  const parentRaw = cellText(cells, columns, 'parent');
  const descriptionRaw = cellText(cells, columns, 'description');

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
    ...NULL_PARTY_FIELDS,
    data: null,
    groupKey: null,
  };
}

export function parseOpeningRow(
  cells: readonly string[],
  columns: ResolvedImportColumns,
  rowNumber: number,
): StagedRowInput {
  const codeRaw = cellText(cells, columns, 'code');
  const nameRaw = cellText(cells, columns, 'name');

  let debitCents: number | null = null;
  let creditCents: number | null = null;
  let debitRaw = '';
  let creditRaw = '';

  if (columns['amount'] != null) {
    debitRaw = cellText(cells, columns, 'amount');
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
  } else if (columns['debit'] != null && columns['credit'] != null) {
    debitRaw = cellText(cells, columns, 'debit');
    creditRaw = cellText(cells, columns, 'credit');
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
    ...NULL_PARTY_FIELDS,
    data: null,
    groupKey: null,
  };
}

/**
 * Trims each cell and truncates to the target column's limit, matching
 * `parseChartRow`'s idiom; the untruncated originals live in `raw` so
 * `validateRows` can report against exactly what the file contained.
 */
export function parsePartyRow(
  cells: readonly string[],
  columns: ResolvedImportColumns,
  rowNumber: number,
): StagedRowInput {
  const nameRaw = cellText(cells, columns, 'partyName');
  const emailRaw = cellText(cells, columns, 'partyEmail');
  const phoneRaw = cellText(cells, columns, 'partyPhone');
  const addressRaw = cellText(cells, columns, 'partyAddress');
  const taxNumberRaw = cellText(cells, columns, 'partyTaxNumber');
  const paymentTermsRaw = cellText(cells, columns, 'partyPaymentTerms');
  const notesRaw = cellText(cells, columns, 'partyNotes');

  return {
    rowNumber,
    raw: {
      name: nameRaw,
      email: emailRaw,
      phone: phoneRaw,
      address: addressRaw,
      taxNumber: taxNumberRaw,
      paymentTerms: paymentTermsRaw,
      notes: notesRaw,
    },
    accountCode: null,
    accountName: null,
    accountType: null,
    parentCode: null,
    description: null,
    debitCents: null,
    creditCents: null,
    partyName: nameRaw === '' ? null : nameRaw.slice(0, 200),
    partyEmail: emailRaw === '' ? null : emailRaw.slice(0, 254),
    partyPhone: phoneRaw === '' ? null : phoneRaw.slice(0, 40),
    partyAddress: addressRaw === '' ? null : addressRaw.slice(0, 500),
    partyTaxNumber: taxNumberRaw === '' ? null : taxNumberRaw.slice(0, 64),
    partyPaymentTerms: paymentTermsRaw === '' ? null : paymentTermsRaw.slice(0, 500),
    partyNotes: notesRaw === '' ? null : notesRaw.slice(0, 1000),
    data: null,
    groupKey: null,
  };
}

/** Generic parser for storage:'data' kinds: raw[key] = trimmed cell text; data[key] = parsed value (null on '' or parse failure). */
export function parseDataRow(
  columns: readonly ImportColumnDef[],
  cells: readonly string[],
  resolved: ResolvedImportColumns,
  rowNumber: number,
  dateFormat: DateFormat,
): StagedRowInput {
  const raw: Record<string, string> = {};
  const data: Record<string, string | number | null> = {};
  for (const col of columns) {
    const text = cellText(cells, resolved, col.key);
    raw[col.key] = text;
    const parsed = parseImportCell(col, text, dateFormat);
    data[col.key] = parsed.ok ? parsed.value : null;
  }
  return {
    rowNumber,
    raw,
    accountCode: null,
    accountName: null,
    accountType: null,
    parentCode: null,
    description: null,
    debitCents: null,
    creditCents: null,
    ...NULL_PARTY_FIELDS,
    data,
    groupKey: null,
  };
}

/** Parse errors for one data row, in column order: for each column whose raw text is non-empty and whose parseImportCell result is not ok, its error. */
export function dataRowParseErrors(
  columns: readonly ImportColumnDef[],
  raw: Readonly<Record<string, string>>,
  dateFormat: DateFormat,
): string[] {
  const errors: string[] = [];
  for (const col of columns) {
    const text = (raw[col.key] ?? '').trim();
    if (text === '') continue;
    const parsed = parseImportCell(col, text, dateFormat);
    if (!parsed.ok) errors.push(parsed.error);
  }
  return errors;
}

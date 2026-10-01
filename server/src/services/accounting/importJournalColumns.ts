import type { ImportColumnDef, ImportEditFieldDef } from '../../types/accounting.js';

/**
 * Column and edit-field definitions for the `JOURNALS` import kind (Phase 36c),
 * plus the group key that ties rows into one entry. Kept apart from the
 * registry so `journalImportService` can read its own columns without
 * importing `importKinds.ts` (which imports the service — a cycle).
 */

export const JOURNAL_COLUMNS: readonly ImportColumnDef[] = [
  {
    key: 'journalNumber',
    header: 'JournalNumber',
    label: 'Journal number',
    required: false,
    synonyms: ['journal number', 'journal no', 'journal', 'entry number', 'entry no', 'journal id', 'reference', 'ref'],
    note: 'Rows with the same number form one entry. Blank: rows with the same Date and Narration are grouped, as in Xero. The number only groups rows — the entry gets its own reference.',
    example: 'J-001',
    inTemplate: true,
    type: 'text',
    maxLength: 40,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'date',
    header: '*Date',
    label: 'Date',
    required: true,
    synonyms: ['date', 'journal date', 'entry date', 'transaction date'],
    note: 'Every line of an entry must have the same date, in an open period.',
    example: '2026-06-30',
    inTemplate: true,
    type: 'date',
    maxLength: null,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'narration',
    header: '*Narration',
    label: 'Narration',
    required: true,
    synonyms: ['narration', 'journal narration', 'memo', 'journal description'],
    note: "Every line of an entry must have the same narration. It becomes the entry's description.",
    example: 'June accruals',
    inTemplate: true,
    type: 'text',
    maxLength: 500,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'accountCode',
    header: '*AccountCode',
    label: 'Account code',
    required: true,
    synonyms: ['account code', 'account', 'code', 'gl code', 'account number'],
    note: 'Any postable account except receivable, payable and inventory control accounts.',
    example: '6100',
    inTemplate: true,
    type: 'text',
    maxLength: 20,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'debit',
    header: 'Debit',
    label: 'Debit',
    required: false,
    synonyms: ['debit', 'dr', 'debit amount'],
    note: 'Use Debit and Credit, or one signed Amount column.',
    example: '1200.00',
    inTemplate: true,
    type: 'money',
    maxLength: null,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'credit',
    header: 'Credit',
    label: 'Credit',
    required: false,
    synonyms: ['credit', 'cr', 'credit amount'],
    note: 'Leave blank on a debit line.',
    example: '',
    inTemplate: true,
    type: 'money',
    maxLength: null,
    enumAliases: null,
    enumLabels: null,
  },
  {
    key: 'amount',
    header: 'Amount',
    label: 'Signed amount',
    required: false,
    synonyms: ['amount', 'line amount', 'net amount'],
    note: 'Instead of Debit and Credit: positive is a debit, negative a credit.',
    example: '1200.00',
    inTemplate: false,
    type: 'signedMoney',
    maxLength: null,
    enumAliases: null,
    enumLabels: null,
  },
];

export const JOURNAL_EDIT_FIELDS: readonly ImportEditFieldDef[] = JOURNAL_COLUMNS.map((col) => ({
  key: col.key,
  label: col.label,
  input: 'text',
  maxLength: col.maxLength,
  nullable: !['date', 'narration', 'accountCode'].includes(col.key),
  options: null,
}));

function str(v: string | number | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 'N:' + upper(journalNumber) when set; else 'D:' + (ISO date value ?? raw date text) + '|' + lower(narration text).slice(0, 200). Null only when all three are blank. */
export function journalGroupKey(
  values: Readonly<Record<string, string | number | null>>,
  raw: Readonly<Record<string, string>>,
): string | null {
  const number = str(values['journalNumber']) || (raw['journalNumber'] ?? '').trim();
  if (number !== '') return `N:${number.toUpperCase().slice(0, 200)}`;
  const date = str(values['date']) || (raw['date'] ?? '').trim().slice(0, 15);
  const narration = (str(values['narration']) || (raw['narration'] ?? '').trim()).toLowerCase().slice(0, 200);
  if (date === '' && narration === '') return null;
  return `D:${date}|${narration}`;
}

import type { DateFormat } from '../../services/fetchServices';

/**
 * Phase 49g — how Australia's major banks lay out a CSV export. Written from
 * memory of published examples rather than real exports, and banks change them,
 * so a preset only fills in the column mapping, which stays visible and editable.
 *
 * `headers` is set for a bank whose file has no header row: the names are added
 * to the first line so the import can find its columns.
 */
export interface BankPreset {
  id: string;
  label: string;
  dateFormat: DateFormat;
  headers: readonly string[] | null;
  columns: { date: string; description: string; amount: string; debit: string; credit: string; reference: string };
}

export const BANK_PRESETS: readonly BankPreset[] = [
  {
    id: 'CBA',
    label: 'Commonwealth Bank',
    dateFormat: 'DMY',
    headers: ['Date', 'Amount', 'Description', 'Balance'],
    columns: { date: 'Date', description: 'Description', amount: 'Amount', debit: '', credit: '', reference: '' },
  },
  {
    id: 'ANZ',
    label: 'ANZ',
    dateFormat: 'DMY',
    headers: ['Date', 'Amount', 'Description'],
    columns: { date: 'Date', description: 'Description', amount: 'Amount', debit: '', credit: '', reference: '' },
  },
  {
    id: 'WBC',
    label: 'Westpac',
    dateFormat: 'DMY',
    headers: null,
    columns: { date: 'Date', description: 'Narrative', amount: '', debit: 'Debit Amount', credit: 'Credit Amount', reference: '' },
  },
  {
    id: 'NAB',
    label: 'NAB',
    dateFormat: 'DMY',
    headers: null,
    columns: { date: 'Date', description: 'Transaction Details', amount: 'Amount', debit: '', credit: '', reference: '' },
  },
];

/** Adds the header row a preset needs, unless the file already starts with one. */
export function withPresetHeader(content: string, preset: BankPreset | null): string {
  if (preset?.headers === null || preset === null) return content;
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.toLowerCase().includes(preset.columns.date.toLowerCase())) return content;
  return `${preset.headers.join(',')}\n${content}`;
}

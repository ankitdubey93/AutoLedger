import type { MigrationImportKind } from '../../../services/fetchServices';

export interface ImportGuide {
  intro: string;
  steps: string[];
  rules: string[];
}

export interface MigrationStep {
  key: string;
  label: string;
  hint: string;
  to: string;
  kind: MigrationImportKind | null;
}

export const MIGRATION_STEPS: MigrationStep[] = [
  {
    key: 'conversion-date',
    label: 'Set your conversion date',
    hint: 'The day your AutoLedger books start. Opening balances post on this date.',
    to: '/settings/conversion-balances',
    kind: null,
  },
  {
    key: 'chart',
    label: 'Chart of accounts',
    hint: 'Your account codes, before anything that refers to them.',
    to: '/migration-imports/new?kind=CHART_OF_ACCOUNTS',
    kind: 'CHART_OF_ACCOUNTS',
  },
  {
    key: 'customers',
    label: 'Customers',
    hint: 'Everyone you invoice.',
    to: '/migration-imports/new?kind=CUSTOMERS',
    kind: 'CUSTOMERS',
  },
  {
    key: 'vendors',
    label: 'Vendors',
    hint: 'Everyone who bills you.',
    to: '/migration-imports/new?kind=VENDORS',
    kind: 'VENDORS',
  },
  {
    key: 'opening',
    label: 'Opening balances',
    hint: 'Your trial balance on the conversion date, without receivables, payables or inventory.',
    to: '/migration-imports/new?kind=OPENING_BALANCES',
    kind: 'OPENING_BALANCES',
  },
];

export const IMPORT_GUIDES: Record<MigrationImportKind, ImportGuide> = {
  CHART_OF_ACCOUNTS: {
    intro: 'Bring your own account codes and names, or add accounts in bulk.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'A code that already exists updates that account\'s name and description; it is never duplicated.',
      'Type must be Asset, Liability, Equity, Revenue or Expense — common Xero and QuickBooks type names are converted for you.',
      'A parent must already exist or be in the same file, and have the same type.',
      'Import your chart before customers, products, balances or documents that refer to account codes.',
    ],
  },
  OPENING_BALANCES: {
    intro: 'Your trial balance on the conversion date — the balances you carry over from your old system.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'Balances post as one journal entry on your conversion date (Settings → Conversion balances).',
      'Any difference between debits and credits is posted to 3400 Opening Balance Equity and shown before you commit.',
      'Retained earnings, Accounts Receivable, Accounts Payable and inventory accounts are refused — bring those in as open invoices, bills and opening stock so each one is tracked.',
      'Only one opening-balance import can ever be committed. Prefer typing them in? Use Settings → Conversion balances.',
    ],
  },
  CUSTOMERS: {
    intro: 'Add your customer list in one go.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'A customer is matched by email, then by name. A match only fills in details that are blank — it never overwrites what you already have.',
      'Names and emails must be unique within the file.',
      'Import customers before open invoices that name them.',
    ],
  },
  VENDORS: {
    intro: 'Add your vendor list in one go.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'A vendor is matched by email, then by name. A match only fills in details that are blank — it never overwrites what you already have.',
      'Names and emails must be unique within the file.',
      'Payment terms are free text, e.g. "Net 30".',
      'Import vendors before bills that name them.',
    ],
  },
};

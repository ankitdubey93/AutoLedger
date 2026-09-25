import type { MigrationImportKind } from '../../services/fetchServices';

/**
 * A downloadable CSV template per import kind (Phase 24) — the header row
 * the staged importer's column-synonym matching accepts, plus one worked
 * example row. Static text, no server round trip: the importer's own
 * synonym matching (`migrationImportService.ts`) is the source of truth for
 * what a column name means, and this list is kept in sync with it by hand.
 */

export interface ImportTemplate {
  kind: MigrationImportKind;
  label: string;
  /** Required columns, in the order the template writes them. */
  columns: { header: string; required: boolean; note: string }[];
  /** One fully worked example row. */
  sampleRow: string[];
}

export const IMPORT_TEMPLATES: Record<MigrationImportKind, ImportTemplate> = {
  CHART_OF_ACCOUNTS: {
    kind: 'CHART_OF_ACCOUNTS',
    label: 'Chart of accounts',
    columns: [
      { header: 'Code', required: true, note: 'Also accepted: Account Code, Account, Account Number, GL Code' },
      { header: 'Name', required: true, note: 'Also accepted: Account Name, Description, Title' },
      { header: 'Type', required: true, note: 'Asset, Liability, Equity, Revenue or Expense. Also accepted: Account Type, Category' },
      { header: 'Parent', required: false, note: "The parent account's own code. Also accepted: Parent Code, Parent Account" },
    ],
    sampleRow: ['4100', 'Product Revenue', 'Revenue', '4000'],
  },
  OPENING_BALANCES: {
    kind: 'OPENING_BALANCES',
    label: 'Opening balances',
    columns: [
      { header: 'Code', required: true, note: 'The existing account code. Also accepted: Account Code, Account' },
      { header: 'Debit', required: false, note: 'Either Debit + Credit, or a single signed Amount column' },
      { header: 'Credit', required: false, note: 'Either Debit + Credit, or a single signed Amount column' },
    ],
    sampleRow: ['1110', '50000.00', '0.00'],
  },
  CUSTOMERS: {
    kind: 'CUSTOMERS',
    label: 'Customers',
    columns: [
      { header: 'Name', required: true, note: 'Also accepted: Customer, Company, Display Name, Customer Name, Company Name. Up to 200 characters' },
      { header: 'Email', required: false, note: 'Up to 254 characters' },
      { header: 'Phone', required: false, note: 'Also accepted: Telephone, Mobile. Up to 40 characters' },
      { header: 'Billing Address', required: false, note: 'Also accepted: Address, Street. Up to 500 characters' },
      { header: 'Tax Number', required: false, note: 'Also accepted: Tax ID, VAT, GST, GSTIN, ABN, EIN. Up to 64 characters' },
      { header: 'Notes', required: false, note: 'Also accepted: Memo, Comment. Up to 1000 characters' },
    ],
    sampleRow: ['Northwind Traders', 'ap@northwind.test', '555-0100', '1 Main St', 'TAX-1', 'Migrated from prior system'],
  },
  VENDORS: {
    kind: 'VENDORS',
    label: 'Vendors',
    columns: [
      { header: 'Name', required: true, note: 'Also accepted: Vendor, Supplier, Company, Display Name, Vendor Name, Company Name. Up to 200 characters' },
      { header: 'Email', required: false, note: 'Up to 254 characters' },
      { header: 'Phone', required: false, note: 'Also accepted: Telephone, Mobile. Up to 40 characters' },
      { header: 'Billing Address', required: false, note: 'Also accepted: Address, Street. Up to 500 characters' },
      { header: 'Tax Number', required: false, note: 'Also accepted: Tax ID, VAT, GST, GSTIN, ABN, EIN. Up to 64 characters' },
      { header: 'Payment Terms', required: false, note: 'Also accepted: Terms, Payment Term. Up to 500 characters' },
      { header: 'Notes', required: false, note: 'Also accepted: Memo, Comment. Up to 1000 characters' },
    ],
    sampleRow: ['Acme Supplies', 'ap@acme.test', '555-0200', '2 Elm St', 'TAX-2', 'Net 30', 'Migrated from prior system'],
  },
};

/**
 * CSV-quotes a single field — wraps in double quotes and doubles any embedded
 * quote whenever the value contains a comma, quote or newline. Exported so
 * `ConversionBalancesPage` (Phase 30) can build its own CSV body with the same
 * quoting rule rather than writing a second escaper.
 */
export function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function templateCsv(kind: MigrationImportKind): string {
  const template = IMPORT_TEMPLATES[kind];
  const header = template.columns.map((c) => csvField(c.header)).join(',');
  const row = template.sampleRow.map(csvField).join(',');
  return `${header}\n${row}\n`;
}

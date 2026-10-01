import type { ImportColumnDef, ImportEditFieldDef } from '../../types/accounting.js';

/**
 * Column and edit-field definitions for the `INVOICES` and `BILLS` import kinds
 * (Phase 36d), plus the group keys that tie rows into one document. Kept apart
 * from the registry so the services can read their own columns without
 * importing `importKinds.ts` (which imports them — a cycle).
 */

type DocSide = 'SALES' | 'PURCHASES';

interface ColSpec {
  key: string;
  header: string;
  label: string;
  required: boolean;
  type: ImportColumnDef['type'];
  maxLength: number | null;
  synonyms: readonly string[];
  note: string;
  example: string;
}

function col(spec: ColSpec): ImportColumnDef {
  return {
    key: spec.key,
    header: spec.header,
    label: spec.label,
    required: spec.required,
    synonyms: spec.synonyms,
    note: spec.note,
    example: spec.example,
    inTemplate: true,
    type: spec.type,
    maxLength: spec.maxLength,
    enumAliases: null,
    enumLabels: null,
  };
}

function buildColumns(side: DocSide): readonly ImportColumnDef[] {
  const sales = side === 'SALES';
  const party = sales ? 'customer' : 'vendor';
  const parties = sales ? 'customers' : 'vendors';
  const doc = sales ? 'invoice' : 'expense';
  return [
    col({
      key: 'contactName',
      header: '*ContactName',
      label: sales ? 'Customer' : 'Vendor',
      required: true,
      type: 'text',
      maxLength: 200,
      synonyms: ['contact name', 'contact', 'customer', 'customer name', 'client', 'vendor', 'vendor name', 'supplier', 'name'],
      note: `An existing ${party}, matched by name. Import ${parties} first.`,
      example: sales ? 'Northwind Traders' : 'Acme Supplies',
    }),
    col({
      key: 'emailAddress',
      header: 'EmailAddress',
      label: 'Email',
      required: false,
      type: 'text',
      maxLength: 254,
      synonyms: ['email address', 'email'],
      note: `Only needed when two ${parties} share a name.`,
      example: '',
    }),
    col({
      key: 'invoiceNumber',
      header: sales ? 'InvoiceNumber' : '*InvoiceNumber',
      label: sales ? 'Invoice number' : "Vendor's invoice number",
      required: !sales,
      type: 'text',
      maxLength: sales ? 40 : 100,
      synonyms: sales
        ? ['invoice number', 'invoice no', 'invoice #', 'number', 'invoice']
        : ['invoice number', 'invoice no', 'invoice #', 'number', 'invoice', 'reference', 'bill number', 'vendor reference', 'supplier invoice number'],
      note: sales
        ? 'Rows with the same number form one invoice, and the invoice keeps this number. Blank: each row is its own invoice, numbered from your sequence when posted.'
        : "The vendor's own invoice number. Rows with the same vendor and number form one expense.",
      example: sales ? 'INV-0042' : 'SUP-881',
    }),
    col({
      key: 'invoiceDate',
      header: '*InvoiceDate',
      label: 'Date',
      required: true,
      type: 'date',
      maxLength: null,
      synonyms: sales ? ['invoice date', 'date', 'issue date'] : ['invoice date', 'date', 'issue date', 'bill date'],
      note: '',
      example: '2026-06-15',
    }),
    col({
      key: 'dueDate',
      header: 'DueDate',
      label: 'Due date',
      required: false,
      type: 'date',
      maxLength: null,
      synonyms: ['due date', 'due'],
      note: 'Blank: worked out from PaymentTerms.',
      example: '2026-07-15',
    }),
    col({
      key: 'paymentTerms',
      header: 'PaymentTerms',
      label: 'Payment terms',
      required: false,
      type: 'text',
      maxLength: 60,
      synonyms: ['payment terms', 'terms'],
      note: 'A payment term\'s code or name, such as NET30 or "Net 30". Needed when DueDate is blank.',
      example: '',
    }),
    col({
      key: 'currency',
      header: 'Currency',
      label: 'Currency',
      required: false,
      type: 'text',
      maxLength: 3,
      synonyms: ['currency', 'currency code'],
      note: 'Blank: your base currency.',
      example: '',
    }),
    col({
      key: 'notes',
      header: 'Reference',
      label: 'Reference',
      required: false,
      type: 'text',
      maxLength: 1000,
      synonyms: ['reference', 'notes', 'memo'],
      note: `Stored as the ${doc}'s notes.`,
      example: 'PO 7781',
    }),
    col({
      key: 'itemCode',
      header: 'ItemCode',
      label: 'Item code',
      required: false,
      type: 'text',
      maxLength: 40,
      synonyms: ['item code', 'inventory item code', 'product code', 'sku', 'item'],
      note: 'Optional. Fills a blank description, price, account and tax rate from the product.',
      example: '',
    }),
    col({
      key: 'description',
      header: '*Description',
      label: 'Description',
      required: true,
      type: 'text',
      maxLength: 500,
      synonyms: ['description', 'line description', 'details'],
      note: 'Blank allowed when ItemCode is set.',
      example: 'Consulting, June',
    }),
    col({
      key: 'quantity',
      header: 'Quantity',
      label: 'Quantity',
      required: false,
      type: 'quantity',
      maxLength: null,
      synonyms: ['quantity', 'qty'],
      note: 'Blank: 1.',
      example: '10',
    }),
    col({
      key: 'unitAmount',
      header: 'UnitAmount',
      label: 'Unit price',
      required: false,
      type: 'money',
      maxLength: null,
      synonyms: ['unit amount', 'unit price', 'price', 'rate'],
      note: `Excluding tax. Blank: the product's ${sales ? 'sale' : 'purchase'} price.`,
      example: '150.00',
    }),
    col({
      key: 'accountCode',
      header: 'AccountCode',
      label: 'Account',
      required: false,
      type: 'text',
      maxLength: 20,
      synonyms: sales
        ? ['account code', 'account', 'revenue account', 'sales account']
        : ['account code', 'account', 'expense account', 'purchases account'],
      note: `${sales ? 'A Revenue account.' : 'An Expense or Asset account.'} Blank: the product's account. Not needed in conversion mode.`,
      example: sales ? '4100' : '6100',
    }),
    col({
      key: 'taxRate',
      header: 'TaxRate',
      label: 'Tax %',
      required: false,
      type: 'percent',
      maxLength: null,
      synonyms: ['tax rate', 'tax', 'tax type', 'gst', 'vat'],
      note: "A percentage. Blank: the product's rate, else 0. Must be 0 or blank in conversion mode.",
      example: '10',
    }),
    col({
      key: 'location',
      header: 'Location',
      label: 'Stock location',
      required: false,
      type: 'text',
      maxLength: 100,
      synonyms: ['location', 'warehouse', 'stock location'],
      note: 'For inventory products only. Blank: your default location.',
      example: '',
    }),
  ];
}

export const INVOICE_COLUMNS: readonly ImportColumnDef[] = buildColumns('SALES');
export const BILL_COLUMNS: readonly ImportColumnDef[] = buildColumns('PURCHASES');

function buildEditFields(columns: readonly ImportColumnDef[], notNullable: readonly string[]): readonly ImportEditFieldDef[] {
  return columns.map((c) => ({
    key: c.key,
    label: c.label,
    input: 'text',
    maxLength: c.maxLength,
    nullable: !notNullable.includes(c.key),
    options: null,
  }));
}

export const INVOICE_EDIT_FIELDS: readonly ImportEditFieldDef[] = buildEditFields(INVOICE_COLUMNS, [
  'contactName',
  'invoiceDate',
  'description',
]);
export const BILL_EDIT_FIELDS: readonly ImportEditFieldDef[] = buildEditFields(BILL_COLUMNS, [
  'contactName',
  'invoiceNumber',
  'invoiceDate',
  'description',
]);

function str(v: string | number | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 'N:' + upper(invoiceNumber) when set; otherwise null — each row is its own invoice. */
export function invoiceGroupKey(
  values: Readonly<Record<string, string | number | null>>,
  raw: Readonly<Record<string, string>>,
): string | null {
  const number = str(values['invoiceNumber']) || (raw['invoiceNumber'] ?? '').trim();
  if (number === '') return null;
  return `N:${number.toUpperCase()}`.slice(0, 220);
}

/** 'B:' + lower(contactName) + '|' + upper(invoiceNumber), truncated to 220; null only when both are blank. */
export function billGroupKey(
  values: Readonly<Record<string, string | number | null>>,
  raw: Readonly<Record<string, string>>,
): string | null {
  const contact = (str(values['contactName']) || (raw['contactName'] ?? '').trim()).toLowerCase();
  const number = (str(values['invoiceNumber']) || (raw['invoiceNumber'] ?? '').trim()).toUpperCase();
  if (contact === '' && number === '') return null;
  return `B:${contact}|${number}`.slice(0, 220);
}

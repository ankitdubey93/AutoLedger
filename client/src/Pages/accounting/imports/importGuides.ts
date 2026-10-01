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
    key: 'products',
    label: 'Products & services',
    hint: 'What you sell and buy, before documents that name them.',
    to: '/migration-imports/new?kind=ITEMS',
    kind: 'ITEMS',
  },
  {
    key: 'opening',
    label: 'Opening balances',
    hint: 'Your trial balance on the conversion date, without receivables, payables or inventory.',
    to: '/migration-imports/new?kind=OPENING_BALANCES',
    kind: 'OPENING_BALANCES',
  },
  {
    key: 'invoices',
    label: 'Open invoices',
    hint: 'Unpaid customer invoices at your conversion date — use conversion mode.',
    to: '/migration-imports/new?kind=INVOICES',
    kind: 'INVOICES',
  },
  {
    key: 'bills',
    label: 'Open expenses (bills)',
    hint: 'Unpaid vendor bills at your conversion date — use conversion mode.',
    to: '/migration-imports/new?kind=BILLS',
    kind: 'BILLS',
  },
  {
    key: 'stock',
    label: 'Inventory items & opening stock',
    hint: 'Tracked stock and the quantity on hand at your conversion date.',
    to: '/migration-imports/new?kind=INVENTORY_ITEMS',
    kind: 'INVENTORY_ITEMS',
  },
  {
    key: 'journals',
    label: 'Other journals (optional)',
    hint: 'Adjustments not covered by the steps above, such as accruals or year-to-date summaries.',
    to: '/migration-imports/new?kind=JOURNALS',
    kind: 'JOURNALS',
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
  ITEMS: {
    intro: 'Bring in the products and services you sell or buy.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'A code that already exists only has its blank fields filled — names, types and tax rates are never overwritten.',
      'Type is Service or Non-inventory. Leave it blank and a product with a purchase price or purchases account becomes Non-inventory, anything else a Service.',
      'Accounts are account codes: a Revenue account for sales, an Expense account for purchases.',
      'Tax rates are percentages, such as 10 or 12.5%. Xero-style names like "GST on Income (15%)" work too.',
      'Tracked stock goes through Inventory → Import instead, so its opening quantity and cost are recorded.',
    ],
  },
  INVENTORY_ITEMS: {
    intro: 'Create tracked stock items — each with its product and, optionally, the stock you already hold.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'Each row creates a tracked item and its product. Existing codes are refused — to track an existing product, open it and tick Track inventory.',
      'OpeningQuantity with OpeningUnitCost (or the purchase price) posts opening stock on OpeningDate — your conversion date when blank — debiting your inventory account.',
      "Don't also include inventory in opening balances; the opening-balance import refuses inventory accounts for this reason.",
      "Category, Unit and OpeningLocation accept a code or a name; leave them blank to use your defaults. Inventory is set up automatically if it isn't yet.",
      'Lot- and serial-tracked stock is received under Stock movements → Receive, not here.',
    ],
  },  JOURNALS: {
    intro: 'Post several journal entries at once — accruals, adjustments or year-to-date summaries.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'Rows with the same JournalNumber form one entry. Without a JournalNumber, rows with the same Date and Narration are grouped — the same way Xero does it.',
      'Each entry needs at least two lines and must balance: total debits equal total credits.',
      'Use Debit and Credit columns, or one signed Amount column (positive is a debit, negative a credit).',
      'Receivable, payable and inventory control accounts are refused — use invoices, bills and Inventory for those so every balance stays traceable.',
      'Every date must fall in an open period. Imported entries are marked "Imported" and are corrected by reversing them, like any posted entry.',
    ],
  },
  INVOICES: {
    intro: "Bring in invoices — open ones you're still owed when you switch, or history you want to see here.",
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      'Rows with the same InvoiceNumber form one invoice and it keeps that number. Leave the number blank and each row becomes its own invoice, numbered from your sequence.',
      'Customers must exist first (Customers → Import). If two customers share a name, add EmailAddress.',
      'ItemCode is optional — it fills a blank description, price, account and tax rate from the product.',
      'Choose at commit: import as drafts to review them, or import and post to issue them straight away.',
      "Switching mid-year? Turn on conversion mode for invoices still unpaid at your conversion date and import only the amount outstanding — they post to Opening Balance Equity so your opening balances aren't counted twice.",
    ],
  },
  BILLS: {
    intro: 'Bring in expenses (bills) — ones you still owe when you switch, or history you want to see here.',
    steps: [
      'Download the template — keep the column headings exactly as they are. Headings starting with * are required.',
      'Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.',
      'Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.',
      'Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.',
      'Commit. An owner or admin commits; the import is then final.',
    ],
    rules: [
      "Rows with the same vendor and InvoiceNumber (the vendor's own invoice number) form one expense.",
      'Vendors must exist first (Vendors → Import). If two vendors share a name, add EmailAddress.',
      'Lines can use Expense or Asset accounts. An inventory product line receives stock when posted.',
      'Choose at commit: import as drafts to review them, or import and post to approve them straight away.',
      'Switching mid-year? Turn on conversion mode for bills still unpaid at your conversion date and import only the amount outstanding.',
    ],
  },
};

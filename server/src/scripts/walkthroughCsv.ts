import { WALKTHROUGH_DATASET, allVendors, documentLines, resolveTokens } from './walkthroughDataset.js';
import { resolveDate, type AnchorMonth, type WalkthroughMonth } from './walkthroughDates.js';
import { csvField, plainMoney } from './walkthroughStatements.js';
import { parseMoneyText } from '../utils/money.js';

/**
 * The CSV files the walkthrough imports through the migration importer
 * (Phase 36), generated from the dataset so the bytes the replay uploads are
 * the bytes `generateWalkthrough.ts` writes into `walkthrough/`. Same
 * "generate once, import for real" pattern as `walkthroughParties.ts` and
 * `walkthroughStatements.ts`. Header rows match `importKinds.ts` and the
 * `importItemColumns.ts` / `importInventoryItemColumns.ts` /
 * `importDocumentColumns.ts` / `importJournalColumns.ts` templates exactly.
 */

function joinCsv(header: string[], rows: string[][]): string {
  return [header.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
}

function requireVendorName(key: string): string {
  const vendor = allVendors().find((v) => v.key === key);
  if (vendor === undefined) throw new Error(`walkthroughCsv: unknown vendor key ${key}`);
  return vendor.name;
}

function requireCustomerName(key: string): string {
  const customer = WALKTHROUGH_DATASET.customers.find((c) => c.key === key);
  if (customer === undefined) throw new Error(`walkthroughCsv: unknown customer key ${key}`);
  return customer.name;
}

/** Descriptions the dataset does not carry (`extraAccounts` holds only code, name, type, parent). */
const ACCOUNT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '4300': 'Interest earned on the operating account',
};

export function accountsCsv(): string {
  const rows = WALKTHROUGH_DATASET.extraAccounts.map((a) => {
    const description = ACCOUNT_DESCRIPTIONS[a.code];
    if (description === undefined) throw new Error(`walkthroughCsv: no description for account ${a.code}`);
    return [a.code, a.name, a.type, a.parent, description];
  });
  return joinCsv(['*Code', '*Name', '*Type', 'Parent', 'Description'], rows);
}

export function productsCsv(): string {
  const rows = WALKTHROUGH_DATASET.products.map((p) => [
    p.code,
    p.name,
    'Service',
    p.description,
    plainMoney(parseMoneyText(p.salePrice)),
    p.accountCode,
    '0',
    '',
    '',
    '',
  ]);
  return joinCsv(
    [
      '*ItemCode', '*ItemName', 'Type', 'Description', 'SalesUnitPrice', 'SalesAccount', 'SalesTaxRate',
      'PurchasesUnitPrice', 'PurchasesAccount', 'PurchasesTaxRate',
    ],
    rows,
  );
}

export function stockItemsCsv(): string {
  const rows = WALKTHROUGH_DATASET.stockItems.map((s) => [
    s.code,
    s.name,
    s.description,
    s.category,
    '',
    '',
    String(s.reorderPoint),
    plainMoney(parseMoneyText(s.salePrice)),
    s.revenueAccount,
    '0',
    plainMoney(parseMoneyText(s.purchasePrice)),
    '0',
    s.assetAccount,
    s.cogsAccount,
    '',
    '',
    '',
    '',
  ]);
  return joinCsv(
    [
      'ItemCode', '*ItemName', 'Description', 'Category', 'Unit', 'Barcode', 'ReorderPoint', 'SalesUnitPrice',
      'SalesAccount', 'SalesTaxRate', 'PurchasesUnitPrice', 'PurchasesTaxRate', 'InventoryAssetAccount',
      'CostOfGoodsSoldAccount', 'OpeningQuantity', 'OpeningUnitCost', 'OpeningLocation', 'OpeningDate',
    ],
    rows,
  );
}

/** Sales invoices with `entry: 'IMPORT'` dated in `month`, one row per line; price and account come from the catalogue. */
export function invoicesCsv(anchor: AnchorMonth, month: WalkthroughMonth): string {
  const rows: string[][] = [];
  for (const doc of WALKTHROUGH_DATASET.invoices) {
    if (doc.entry !== 'IMPORT' || doc.month !== month) continue;
    const docDate = resolveDate(anchor, doc.month, doc.day);
    const dueDate = doc.dueDate === undefined ? docDate : resolveDate(anchor, doc.dueDate.month, doc.dueDate.day);
    for (const line of documentLines(doc)) {
      rows.push([
        requireCustomerName(doc.counterpartyKey),
        docDate,
        dueDate,
        line.itemCode ?? '',
        resolveTokens(anchor, line.description),
        line.quantity,
        '',
        '',
      ]);
    }
  }
  return joinCsv(
    ['*ContactName', '*InvoiceDate', 'DueDate', 'ItemCode', '*Description', 'Quantity', 'UnitAmount', 'AccountCode'],
    rows,
  );
}

/** Purchase bills with `entry: 'IMPORT'` dated in `month`, one row per line. */
export function billsCsv(anchor: AnchorMonth, month: WalkthroughMonth): string {
  const rows: string[][] = [];
  for (const doc of WALKTHROUGH_DATASET.bills) {
    if (doc.entry !== 'IMPORT' || doc.month !== month) continue;
    const docDate = resolveDate(anchor, doc.month, doc.day);
    const dueDate = doc.dueDate === undefined ? docDate : resolveDate(anchor, doc.dueDate.month, doc.dueDate.day);
    const invoiceNumber = doc.vendorReference === null ? '' : resolveTokens(anchor, doc.vendorReference);
    for (const line of documentLines(doc)) {
      rows.push([
        requireVendorName(doc.counterpartyKey),
        invoiceNumber,
        docDate,
        dueDate,
        resolveTokens(anchor, line.description),
        line.quantity,
        plainMoney(parseMoneyText(line.unitPrice)),
        line.accountCode,
      ]);
    }
  }
  return joinCsv(
    ['*ContactName', '*InvoiceNumber', '*InvoiceDate', 'DueDate', '*Description', 'Quantity', 'UnitAmount', 'AccountCode'],
    rows,
  );
}

/** Journals with `entry: 'IMPORT'`, one row per line; a side with no amount is left blank. */
export function payrollJournalCsv(anchor: AnchorMonth): string {
  const rows: string[][] = [];
  for (const journal of WALKTHROUGH_DATASET.journals) {
    if (journal.entry !== 'IMPORT') continue;
    const date = resolveDate(anchor, journal.month, journal.day);
    const narration = resolveTokens(anchor, journal.narration);
    for (const line of journal.lines) {
      const debit = parseMoneyText(line.debit);
      const credit = parseMoneyText(line.credit);
      rows.push([
        journal.ref,
        date,
        narration,
        line.accountCode,
        debit > 0 ? plainMoney(debit) : '',
        credit > 0 ? plainMoney(credit) : '',
      ]);
    }
  }
  return joinCsv(['JournalNumber', '*Date', '*Narration', '*AccountCode', 'Debit', 'Credit'], rows);
}

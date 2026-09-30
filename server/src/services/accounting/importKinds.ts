import type { PoolClient } from 'pg';
import type { DateFormat } from '../../utils/dateParse.js';
import {
  MIGRATION_IMPORT_KINDS,
  type ImportCommitContext,
  type ImportKindMeta,
  type MigrationCommitPreview,
  type MigrationCommitResult,
  type MigrationImportKind,
  type MigrationImportRow,
} from '../../types/accounting.js';
import {
  parseChartRow,
  parseDataRow,
  parseOpeningRow,
  parsePartyRow,
  type ResolvedImportColumns,
  type StagedRowInput,
} from './importRowParsers.js';
import * as chartImportService from './chartImportService.js';
import * as openingBalanceImportService from './openingBalanceImportService.js';
import * as partyImportService from './partyImportService.js';
import * as itemImportService from './itemImportService.js';
import * as inventoryItemImportService from './inventoryItemImportService.js';
import { IMPORT_ITEM_COLUMNS, IMPORT_ITEM_EDIT_FIELDS } from './importItemColumns.js';
import { IMPORT_INVENTORY_ITEM_COLUMNS, IMPORT_INVENTORY_ITEM_EDIT_FIELDS } from './importInventoryItemColumns.js';

/**
 * The staged importer's kind registry (Phase 36). One entry per kind carries
 * its template/column metadata (served to the client by GET /kinds) and the
 * strategy functions the generic importer dispatches to. Adding a kind means
 * adding an entry here; `satisfies` makes a missing one a compile error.
 */
export interface ImportKindDef extends ImportKindMeta {
  parseRow(
    cells: readonly string[],
    columns: ResolvedImportColumns,
    rowNumber: number,
    ctx: { dateFormat: DateFormat },
  ): StagedRowInput;
  validateRows(
    client: PoolClient,
    orgId: string,
    rows: readonly MigrationImportRow[],
  ): Promise<{ rowId: string; errors: string[] }[]>;
  preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview>;
  /** Optional; runs BEFORE BEGIN. Default: { inventoryProfile: null }. */
  prepareCommit?: (orgId: string) => Promise<ImportCommitContext>;
  commitOnClient(
    client: PoolClient,
    orgId: string,
    importId: string,
    createdBy: string,
    context: ImportCommitContext,
  ): Promise<MigrationCommitResult>;
}

const AMOUNT_MISSING = 'Could not find an amount column, or a debit/credit pair, in the file';

function partyDef(kind: 'CUSTOMERS' | 'VENDORS'): Pick<ImportKindDef, 'parseRow' | 'validateRows' | 'preview' | 'commitOnClient'> {
  return {
    parseRow: parsePartyRow,
    validateRows: (client, orgId, rows) => partyImportService.validateRows(client, orgId, kind, rows),
    preview: async (client, orgId, importId) => ({
      ...(await partyImportService.preview(client, orgId, importId)),
      summary: [],
      warnings: [],
    }),
    commitOnClient: async (client, orgId, importId) => {
      const { created, merged } = await partyImportService.commitOnClient(client, orgId, importId);
      return { kind, createdCount: created, mergedCount: merged };
    },
  };
}

const PARTY_EDIT_FIELDS = [
      { key: 'partyName', label: 'Name', input: 'text', maxLength: 200, nullable: false, options: null },
      { key: 'partyEmail', label: 'Email', input: 'text', maxLength: 254, nullable: true, options: null },
      { key: 'partyPhone', label: 'Phone', input: 'text', maxLength: 40, nullable: true, options: null },
      { key: 'partyTaxNumber', label: 'Tax number', input: 'text', maxLength: 64, nullable: true, options: null },
] as const;

export const IMPORT_KINDS = {
  CHART_OF_ACCOUNTS: {
    kind: 'CHART_OF_ACCOUNTS',
    label: 'Chart of accounts',
    noun: 'accounts',
    storage: 'typed',
    columns: [
      {
        key: 'code',
        header: '*Code',
        label: 'Account code',
        required: true,
        synonyms: ['code', 'account code', 'account', 'account number', 'gl code'],
        note: 'Up to 20 characters. A code that already exists is merged (name and description updated), never duplicated.',
        example: '4100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'name',
        header: '*Name',
        label: 'Account name',
        required: true,
        synonyms: ['name', 'account name', 'description', 'title'],
        note: 'Up to 120 characters.',
        example: 'Product Revenue',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'type',
        header: '*Type',
        label: 'Account type',
        required: true,
        synonyms: ['type', 'account type', 'category'],
        note: 'Asset, Liability, Equity, Revenue or Expense. Xero and QuickBooks type names such as Bank, Current Asset, Direct Costs or Other Income are converted automatically.',
        example: 'Revenue',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'parent',
        header: 'Parent',
        label: 'Parent account code',
        required: false,
        synonyms: ['parent', 'parent code', 'parent account'],
        note: "The parent account's code. It must exist (or be in this file) and have the same type.",
        example: '4000',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'description',
        header: 'Description',
        label: 'Description',
        required: false,
        synonyms: ['notes', 'memo', 'long description'],
        note: 'Up to 500 characters.',
        example: 'Sales of physical goods',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ],
    requiredOneOf: [],
    missingMessages: {
      code: 'Could not find an account code column in the file',
      name: 'Could not find an account name column in the file',
      type: 'Could not find an account type column in the file',
    },
    editFields: [
      { key: 'accountCode', label: 'Code', input: 'text', maxLength: 20, nullable: false, options: null },
      { key: 'accountName', label: 'Name', input: 'text', maxLength: 120, nullable: false, options: null },
      { key: 'accountType', label: 'Type', input: 'accountType', maxLength: null, nullable: false, options: null },
      { key: 'parentCode', label: 'Parent', input: 'text', maxLength: 20, nullable: true, options: null },
    ],
    parseRow: parseChartRow,
    validateRows: (client, orgId, rows) => chartImportService.validateRows(client, orgId, rows),
    preview: async (client, orgId, importId) => ({
      ...(await chartImportService.preview(client, orgId, importId)),
      summary: [],
      warnings: [],
    }),
    commitOnClient: async (client, orgId, importId) => {
      const { created, merged } = await chartImportService.commitOnClient(client, orgId, importId);
      return { kind: 'CHART_OF_ACCOUNTS', createdCount: created, mergedCount: merged };
    },
  },
  OPENING_BALANCES: {
    kind: 'OPENING_BALANCES',
    label: 'Opening balances',
    noun: 'balances',
    storage: 'typed',
    columns: [
      {
        key: 'code',
        header: '*Code',
        label: 'Account code',
        required: true,
        synonyms: ['code', 'account code', 'account', 'account number', 'gl code'],
        note: 'An existing account you can post to. Retained earnings, Accounts Receivable, Accounts Payable and inventory accounts are refused — bring those in as open invoices, bills and opening stock.',
        example: '1110',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'name',
        header: 'Name',
        label: 'Account name',
        required: false,
        synonyms: ['name', 'account name', 'description', 'title'],
        note: 'For your reference only; the account is matched by code.',
        example: 'Operating bank account',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'debit',
        header: 'Debit',
        label: 'Debit',
        required: false,
        synonyms: ['debit', 'dr', 'debit amount'],
        note: 'Use Debit and Credit, or a single signed Amount column.',
        example: '50000.00',
        inTemplate: true,
        type: 'text',
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
        note: 'Leave blank when the row is a debit.',
        example: '',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'amount',
        header: 'Amount',
        label: 'Signed amount',
        required: false,
        synonyms: ['amount', 'balance', 'opening balance'],
        note: 'Instead of Debit and Credit: positive is a debit, negative a credit.',
        example: '50000.00',
        inTemplate: false,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ],
    requiredOneOf: [['debit', 'credit'], ['amount']],
    missingMessages: {
      code: 'Could not find an account code column in the file',
      debit: AMOUNT_MISSING,
      credit: AMOUNT_MISSING,
      amount: AMOUNT_MISSING,
    },
    editFields: [
      { key: 'accountCode', label: 'Code', input: 'text', maxLength: 20, nullable: false, options: null },
      { key: 'debitCents', label: 'Debit', input: 'money', maxLength: null, nullable: false, options: null },
      { key: 'creditCents', label: 'Credit', input: 'money', maxLength: null, nullable: false, options: null },
    ],
    parseRow: parseOpeningRow,
    validateRows: (client, orgId, rows) => openingBalanceImportService.validateRows(client, orgId, rows),
    preview: async (client, orgId, importId) => ({
      ...(await openingBalanceImportService.preview(client, orgId, importId)),
      summary: [],
      warnings: [],
    }),
    commitOnClient: async (client, orgId, importId, createdBy) => {
      const { journalEntryId, plugCents } = await openingBalanceImportService.commitOnClient(
        client,
        orgId,
        importId,
        createdBy,
      );
      return { kind: 'OPENING_BALANCES', journalEntryId, plugCents };
    },
  },
  CUSTOMERS: {
    kind: 'CUSTOMERS',
    label: 'Customers',
    noun: 'customers',
    storage: 'typed',
    columns: [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name', 'customer', 'vendor', 'supplier', 'company', 'display name', 'customer name', 'vendor name', 'company name', 'contact name', 'contact'],
        note: "Up to 200 characters. Matched to an existing customer by email, then by name; a match only fills that customer's blank fields.",
        example: 'Northwind Traders',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'EmailAddress',
        label: 'Email',
        required: false,
        synonyms: ['email', 'e mail', 'email address', 'contact email'],
        note: 'Up to 254 characters.',
        example: 'ap@northwind.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyPhone',
        header: 'Phone',
        label: 'Phone',
        required: false,
        synonyms: ['phone', 'telephone', 'phone number', 'contact phone', 'mobile'],
        note: 'Up to 40 characters.',
        example: '555-0100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyAddress',
        header: 'BillingAddress',
        label: 'Billing address',
        required: false,
        synonyms: ['address', 'billing address', 'street', 'postal address', 'po address line 1', 'sa address line 1'],
        note: 'Up to 500 characters.',
        example: '1 Main St',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyTaxNumber',
        header: 'TaxNumber',
        label: 'Tax number',
        required: false,
        synonyms: ['tax number', 'tax id', 'vat', 'vat number', 'gst', 'gstin', 'abn', 'ein'],
        note: 'Up to 64 characters.',
        example: 'TAX-1',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyPaymentTerms',
        header: 'PaymentTerms',
        label: 'Payment terms',
        required: false,
        synonyms: ['terms', 'payment terms', 'payment term'],
        note: "Customers have no payment-terms field — the text is added to the customer's notes on its own line.",
        example: 'Net 30',
        inTemplate: false,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyNotes',
        header: 'Notes',
        label: 'Notes',
        required: false,
        synonyms: ['notes', 'memo', 'comment', 'comments'],
        note: 'Up to 1000 characters.',
        example: 'Migrated from prior system',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ],
    requiredOneOf: [],
    missingMessages: { partyName: 'Could not find a name column in the file' },
    editFields: PARTY_EDIT_FIELDS,
    ...partyDef('CUSTOMERS'),
  },
  VENDORS: {
    kind: 'VENDORS',
    label: 'Vendors',
    noun: 'vendors',
    storage: 'typed',
    columns: [
      {
        key: 'partyName',
        header: '*ContactName',
        label: 'Name',
        required: true,
        synonyms: ['name', 'customer', 'vendor', 'supplier', 'company', 'display name', 'customer name', 'vendor name', 'company name', 'contact name', 'contact'],
        note: "Up to 200 characters. Matched to an existing vendor by email, then by name; a match only fills that vendor's blank fields.",
        example: 'Acme Supplies',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyEmail',
        header: 'EmailAddress',
        label: 'Email',
        required: false,
        synonyms: ['email', 'e mail', 'email address', 'contact email'],
        note: 'Up to 254 characters.',
        example: 'ap@northwind.test',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyPhone',
        header: 'Phone',
        label: 'Phone',
        required: false,
        synonyms: ['phone', 'telephone', 'phone number', 'contact phone', 'mobile'],
        note: 'Up to 40 characters.',
        example: '555-0100',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyAddress',
        header: 'BillingAddress',
        label: 'Billing address',
        required: false,
        synonyms: ['address', 'billing address', 'street', 'postal address', 'po address line 1', 'sa address line 1'],
        note: 'Up to 500 characters.',
        example: '1 Main St',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyTaxNumber',
        header: 'TaxNumber',
        label: 'Tax number',
        required: false,
        synonyms: ['tax number', 'tax id', 'vat', 'vat number', 'gst', 'gstin', 'abn', 'ein'],
        note: 'Up to 64 characters.',
        example: 'TAX-1',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyPaymentTerms',
        header: 'PaymentTerms',
        label: 'Payment terms',
        required: false,
        synonyms: ['terms', 'payment terms', 'payment term'],
        note: 'Up to 500 characters.',
        example: 'Net 30',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
      {
        key: 'partyNotes',
        header: 'Notes',
        label: 'Notes',
        required: false,
        synonyms: ['notes', 'memo', 'comment', 'comments'],
        note: 'Up to 1000 characters.',
        example: 'Migrated from prior system',
        inTemplate: true,
        type: 'text',
        maxLength: null,
        enumAliases: null,
        enumLabels: null,
      },
    ],
    requiredOneOf: [],
    missingMessages: { partyName: 'Could not find a name column in the file' },
    editFields: PARTY_EDIT_FIELDS,
    ...partyDef('VENDORS'),
  },
  ITEMS: {
    kind: 'ITEMS',
    label: 'Products & services',
    noun: 'products',
    storage: 'data',
    columns: IMPORT_ITEM_COLUMNS,
    requiredOneOf: [],
    missingMessages: {
      itemCode: 'Could not find an item code column in the file',
      itemName: 'Could not find an item name column in the file',
    },
    editFields: IMPORT_ITEM_EDIT_FIELDS,
    parseRow: (cells, columns, rowNumber, ctx) =>
      parseDataRow(IMPORT_ITEM_COLUMNS, cells, columns, rowNumber, ctx.dateFormat),
    validateRows: (client, orgId, rows) => itemImportService.validateRows(client, orgId, rows),
    preview: (client, orgId, importId) => itemImportService.preview(client, orgId, importId),
    commitOnClient: (client, orgId, importId, createdBy) =>
      itemImportService.commitOnClient(client, orgId, importId, createdBy),
  },
  INVENTORY_ITEMS: {
    kind: 'INVENTORY_ITEMS',
    label: 'Inventory items',
    noun: 'items',
    storage: 'data',
    columns: IMPORT_INVENTORY_ITEM_COLUMNS,
    requiredOneOf: [],
    missingMessages: { itemName: 'Could not find an item name column in the file' },
    editFields: IMPORT_INVENTORY_ITEM_EDIT_FIELDS,
    parseRow: (cells, columns, rowNumber, ctx) =>
      parseDataRow(IMPORT_INVENTORY_ITEM_COLUMNS, cells, columns, rowNumber, ctx.dateFormat),
    validateRows: (client, orgId, rows) => inventoryItemImportService.validateRows(client, orgId, rows),
    preview: (client, orgId, importId) => inventoryItemImportService.preview(client, orgId, importId),
    prepareCommit: (orgId) => inventoryItemImportService.prepareCommit(orgId),
    commitOnClient: (client, orgId, importId, createdBy, context) =>
      inventoryItemImportService.commitOnClient(client, orgId, importId, createdBy, context),
  },
} satisfies Record<MigrationImportKind, ImportKindDef>;

export function getImportKind(kind: MigrationImportKind): ImportKindDef {
  return IMPORT_KINDS[kind];
}

/** Metadata only — every function-valued property stripped. Order = MIGRATION_IMPORT_KINDS. */
export function listImportKindMeta(): ImportKindMeta[] {
  return MIGRATION_IMPORT_KINDS.map((kind) => {
    const { kind: k, label, noun, storage, columns, requiredOneOf, missingMessages, editFields } = IMPORT_KINDS[kind];
    return { kind: k, label, noun, storage, columns, requiredOneOf, missingMessages, editFields };
  });
}

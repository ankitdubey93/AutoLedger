import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import { ITEM_CODE_REGEX } from '../../utils/stockCodePattern.js';
import { isValidGtin } from '../../utils/gtin.js';
import type {
  ImportCommitContext,
  MigrationCommitPreview,
  MigrationCommitResult,
  MigrationImportRow,
} from '../../types/accounting.js';
import * as documentStockService from '../inventory/documentStockService.js';
import { dataRowParseErrors } from './importRowParsers.js';
import {
  importDateFormatForRowOnClient,
  loadDataRowsOnClient,
  markCommittedOnClient,
  type DataRow,
} from './importRowStore.js';
import { accountCodeError, loadAccountsByCodeOnClient, type ImportAccount } from './importAccountLookup.js';
import { findItemsByCodesOnClient } from './itemService.js';
import { IMPORT_INVENTORY_ITEM_COLUMNS } from './importInventoryItemColumns.js';

/**
 * Inventory items import (Phase 36b) — the `INVENTORY_ITEMS` kind. Each row
 * creates a tracked stock item, its linked product and (optionally) opening
 * stock that posts to the GL through the inventory module's own OPENING
 * receipt. Create-only.
 *
 * Rule 16: `documentStockService` is the ONLY inventory module imported here;
 * reference data and creation cross the boundary through it. Every statement
 * of this file's own is org-scoped (rule 1) and runs on the caller's client
 * (rule 5). The pool read (`suggestedProfileForImport`) happens in
 * `prepareCommit`, before BEGIN.
 */

type Values = Readonly<Record<string, string | number | null>>;

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

function upperCode(values: Values): string | null {
  return text(values, 'itemCode')?.toUpperCase() ?? null;
}

const ACCOUNT_KEYS = ['salesAccount', 'inventoryAccount', 'cogsAccount'] as const;

interface Lookups {
  refs: documentStockService.ImportStockReferences;
  existingProducts: Awaited<ReturnType<typeof findItemsByCodesOnClient>>;
  accounts: Map<string, ImportAccount>;
  booksStartDate: string | null;
}

async function loadLookups(client: PoolClient, orgId: string, rows: readonly { values: Values }[]): Promise<Lookups> {
  const codes = uniq(rows.map((r) => upperCode(r.values)));
  const accountCodes = uniq(rows.flatMap((r) => ACCOUNT_KEYS.map((k) => text(r.values, k))));
  const refs = await documentStockService.loadImportReferencesOnClient(client, orgId, codes);
  const existingProducts = await findItemsByCodesOnClient(client, orgId, codes);
  const accounts = await loadAccountsByCodeOnClient(client, orgId, accountCodes);
  const { rows: settings } = await client.query<{ books_start_date: string | null }>(
    "SELECT to_char(books_start_date, 'YYYY-MM-DD') AS books_start_date FROM ledger_settings WHERE org_id = $1",
    [orgId],
  );
  return { refs, existingProducts, accounts, booksStartDate: settings[0]?.books_start_date ?? null };
}

function lookupByText<T>(map: ReadonlyMap<string, T>, raw: string): T | undefined {
  return map.get(raw.toUpperCase()) ?? map.get(raw.toLowerCase());
}

export async function prepareCommit(orgId: string): Promise<ImportCommitContext> {
  return { inventoryProfile: await documentStockService.suggestedProfileForImport(orgId), mode: null, postingDate: null };
}

export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const first = rows[0];
  const dateFormat = first === undefined ? 'ISO' : await importDateFormatForRowOnClient(client, orgId, first.id);
  const { refs, existingProducts, accounts, booksStartDate } = await loadLookups(client, orgId, rows);
  const today = new Date().toISOString().slice(0, 10);

  const rowNumbersByCode = new Map<string, number[]>();
  for (const row of rows) {
    const code = upperCode(row.values);
    if (code === null) continue;
    const list = rowNumbersByCode.get(code) ?? [];
    list.push(row.rowNumber);
    rowNumbersByCode.set(code, list);
  }

  return rows.map((row) => {
    const v = row.values;
    const errors: string[] = dataRowParseErrors(IMPORT_INVENTORY_ITEM_COLUMNS, row.raw, dateFormat);
    if (text(v, 'itemName') === null) errors.push('Name is required');

    const rawCode = text(v, 'itemCode');
    const code = upperCode(v);
    if (rawCode !== null && code !== null) {
      if (!ITEM_CODE_REGEX.test(code)) {
        errors.push(`Item code "${rawCode}" may use only A–Z, 0–9 and - _ / . (max 40)`);
      } else {
        const list = rowNumbersByCode.get(code) ?? [];
        if (list.length >= 2) errors.push(`Item code "${code}" appears more than once in this file (rows ${list.join(', ')})`);
        if (refs.existingCodes.has(code) || existingProducts.has(code)) {
          errors.push(
            `"${code}" already exists — to track stock for an existing product, open it in Products & Services and tick Track inventory`,
          );
        }
      }
    }

    const refChecks: [string, string, ReadonlyMap<string, { isActive: boolean }>][] = [
      ['category', 'Category', refs.categories],
      ['unit', 'Unit', refs.uoms],
      ['openingLocation', 'Opening location', refs.locations],
    ];
    for (const [key, label, map] of refChecks) {
      const t = text(v, key);
      if (t === null) continue;
      const found = lookupByText(map, t);
      if (found === undefined) {
        errors.push(
          `${label} "${t}" was not found. Leave it blank to use your default${refs.configured ? '' : ', or set up inventory first (Inventory → Setup)'}`,
        );
      } else if (!found.isActive) {
        errors.push(`${label} "${t}" is inactive`);
      }
    }

    const barcode = text(v, 'barcode');
    if (barcode !== null && (!/^[0-9]{8}$|^[0-9]{12,14}$/.test(barcode) || !isValidGtin(barcode))) {
      errors.push(`Barcode "${barcode}" is not a valid 8, 12, 13 or 14-digit barcode`);
    }

    const accountChecks: [string, string, 'Revenue' | 'Asset' | 'Expense'][] = [
      ['salesAccount', 'SalesAccount', 'Revenue'],
      ['inventoryAccount', 'InventoryAssetAccount', 'Asset'],
      ['cogsAccount', 'CostOfGoodsSoldAccount', 'Expense'],
    ];
    for (const [key, label, type] of accountChecks) {
      const c = text(v, key);
      if (c === null) continue;
      const err = accountCodeError(label, c, accounts.get(c), [type]);
      if (err !== null) errors.push(err);
    }

    const qty = num(v, 'openingQuantity');
    if (qty !== null) {
      if (qty === 0) errors.push('Opening quantity must be more than zero');
      if ((num(v, 'openingUnitCost') ?? num(v, 'purchasePrice')) === null) {
        errors.push('Enter an OpeningUnitCost or a PurchasesUnitPrice for the opening stock');
      }
      const date = text(v, 'openingDate') ?? booksStartDate;
      if (date === null) {
        errors.push('Enter an OpeningDate, or set your conversion date (Settings → Conversion balances)');
      } else if (date > today) {
        errors.push('Opening date cannot be in the future');
      }
      const categoryText = text(v, 'category');
      const category = categoryText === null ? undefined : lookupByText(refs.categories, categoryText);
      if (category !== undefined && category.defaultTracking !== 'QUANTITY') {
        errors.push('Opening stock for lot- or serial-tracked items goes in under Stock movements → Receive');
      }
    }
    return { rowId: row.id, errors };
  });
}

function openingCost(values: Values): number | null {
  return num(values, 'openingUnitCost') ?? num(values, 'purchasePrice');
}

export async function preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ status: string; error_count: number }>(
    'SELECT status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');

  const rows = await loadDataRowsOnClient(client, orgId, importId);
  const refs = await documentStockService.loadImportReferencesOnClient(client, orgId, []);
  let withOpening = 0;
  let openingValue = 0;
  for (const row of rows) {
    const qty = num(row.values, 'openingQuantity');
    if (qty === null) continue;
    withOpening += 1;
    const cost = openingCost(row.values);
    if (cost !== null) openingValue += Math.round((qty * cost) / 1000);
  }

  return {
    kind: 'INVENTORY_ITEMS',
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
      { label: 'Tracked items to create', value: rows.length, format: 'count' },
      { label: 'Items with opening stock', value: withOpening, format: 'count' },
      { label: 'Opening stock value', value: openingValue, format: 'money' },
    ],
    warnings: refs.configured
      ? []
      : [
          'Inventory is not set up yet — committing sets it up with the suggested industry profile, the same as creating your first tracked product.',
        ],
  };
}

function wrapRowError(err: unknown, row: DataRow, label: string): unknown {
  if (err instanceof ApiError) return new ApiError(err.status, `Row ${String(row.rowNumber)} (${label}): ${err.message}`);
  return err;
}

export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  createdBy: string,
  context: ImportCommitContext,
): Promise<Extract<MigrationCommitResult, { kind: 'INVENTORY_ITEMS' }>> {
  if (context.inventoryProfile === null || !documentStockService.isStockIndustryKey(context.inventoryProfile)) {
    throw new Error('prepareCommit did not run');
  }
  const profile = context.inventoryProfile;

  const rows = await loadDataRowsOnClient(client, orgId, importId);
  const { refs, accounts, booksStartDate } = await loadLookups(client, orgId, rows);

  let createdCount = 0;
  let openingStockCount = 0;
  for (const row of rows) {
    const v = row.values;
    const name = text(v, 'itemName');
    const code = upperCode(v);
    if (name === null) throw new ApiError(409, `Row ${String(row.rowNumber)}: name is required`);

    const accountId = (key: string): string | null => {
      const c = text(v, key);
      return c === null ? null : (accounts.get(c)?.id ?? null);
    };
    const refId = <T extends { id: string }>(map: ReadonlyMap<string, T>, key: string): string | null => {
      const t = text(v, key);
      return t === null ? null : (lookupByText(map, t)?.id ?? null);
    };

    const qty = num(v, 'openingQuantity');
    const input: documentStockService.CreateStockItemInput = {
      name,
      description: text(v, 'description'),
      categoryId: refId(refs.categories, 'category'),
      uomId: refId(refs.uoms, 'unit'),
      tracking: null,
      code,
      codeSchemeId: null,
      barcode: text(v, 'barcode'),
      attributes: {},
      reorderPointMilli: num(v, 'reorderPoint'),
      product: {
        salePriceCents: num(v, 'salePrice'),
        purchasePriceCents: num(v, 'purchasePrice'),
        revenueAccountId: accountId('salesAccount'),
        assetAccountId: accountId('inventoryAccount'),
        cogsAccountId: accountId('cogsAccount'),
        saleTaxRateBp: num(v, 'salesTaxRate') ?? 0,
        purchaseTaxRateBp: num(v, 'purchasesTaxRate') ?? 0,
      },
      opening:
        qty === null
          ? undefined
          : {
              quantityMilli: qty,
              unitCostCents: num(v, 'openingUnitCost'),
              occurredOn: text(v, 'openingDate') ?? booksStartDate ?? '',
              locationId: refId(refs.locations, 'openingLocation'),
            },
    };

    try {
      await documentStockService.createItemForImportOnClient(client, orgId, createdBy, input, profile);
    } catch (err) {
      throw wrapRowError(err, row, code ?? name);
    }
    createdCount += 1;
    if (qty !== null) openingStockCount += 1;
  }

  await markCommittedOnClient(client, orgId, importId);
  return { kind: 'INVENTORY_ITEMS', createdCount, openingStockCount };
}

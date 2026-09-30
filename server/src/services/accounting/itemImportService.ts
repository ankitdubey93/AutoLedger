import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import type {
  ItemType,
  MigrationCommitPreview,
  MigrationCommitResult,
  MigrationImportRow,
} from '../../types/accounting.js';
import { dataRowParseErrors } from './importRowParsers.js';
import { loadDataRowsOnClient, markCommittedOnClient, type DataRow } from './importRowStore.js';
import { accountCodeError, loadAccountsByCodeOnClient, type ImportAccount } from './importAccountLookup.js';
import { createItemOnClient, fillMissingItemFieldsOnClient, findItemsByCodesOnClient } from './itemService.js';
import { IMPORT_ITEM_COLUMNS } from './importItemColumns.js';

/**
 * Products & Services import (Phase 36b) — the validate, preview and commit
 * halves for the `ITEMS` kind. An unknown code is created through
 * `createItemOnClient`; a known code only has its blank fields filled
 * (`fillMissingItemFieldsOnClient`). Tracked stock (INVENTORY) is refused here
 * and imported under Inventory, so no `stock_*` table is touched (rule 16).
 * Every lookup is org-scoped (rule 1) and runs on the caller's client (rule 5).
 */

type ExistingItem = { id: string; itemType: ItemType; isActive: boolean };

function text(values: Readonly<Record<string, string | number | null>>, key: string): string | null {
  const v = values[key];
  return typeof v === 'string' ? v : null;
}

function num(values: Readonly<Record<string, string | number | null>>, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' ? v : null;
}

function uniq(list: (string | null)[]): string[] {
  return [...new Set(list.filter((v): v is string => v !== null))];
}

interface Lookups {
  items: Map<string, ExistingItem>;
  accounts: Map<string, ImportAccount>;
}

async function loadLookups(
  client: PoolClient,
  orgId: string,
  rows: readonly { values: Readonly<Record<string, string | number | null>> }[],
): Promise<Lookups> {
  const codes = uniq(rows.map((r) => text(r.values, 'itemCode')));
  const accountCodes = uniq(rows.flatMap((r) => [text(r.values, 'salesAccount'), text(r.values, 'purchasesAccount')]));
  return {
    items: await findItemsByCodesOnClient(client, orgId, codes),
    accounts: await loadAccountsByCodeOnClient(client, orgId, accountCodes),
  };
}

export async function validateRows(
  client: PoolClient,
  orgId: string,
  rows: readonly MigrationImportRow[],
): Promise<{ rowId: string; errors: string[] }[]> {
  const { items, accounts } = await loadLookups(client, orgId, rows);

  const rowNumbersByCode = new Map<string, number[]>();
  for (const row of rows) {
    const code = text(row.values, 'itemCode');
    if (code === null) continue;
    const list = rowNumbersByCode.get(code) ?? [];
    list.push(row.rowNumber);
    rowNumbersByCode.set(code, list);
  }

  return rows.map((row) => {
    const errors: string[] = dataRowParseErrors(IMPORT_ITEM_COLUMNS, row.raw, 'ISO');
    const code = text(row.values, 'itemCode');
    if (code === null) errors.push('Item code is required');
    if (text(row.values, 'itemName') === null) errors.push('Name is required');

    if (code !== null) {
      const list = rowNumbersByCode.get(code) ?? [];
      if (list.length >= 2) errors.push(`Item code "${code}" appears more than once in this file (rows ${list.join(', ')})`);

      const explicitType = text(row.values, 'itemType');
      const existing = items.get(code);
      if (explicitType === 'INVENTORY' || existing?.itemType === 'INVENTORY' || existing?.itemType === 'FIXED_ASSET') {
        errors.push(`"${code}" is a tracked inventory item — import it under Inventory → Import`);
      } else if (existing !== undefined && explicitType !== null && explicitType !== existing.itemType) {
        errors.push(
          `"${code}" already exists as ${existing.itemType === 'SERVICE' ? 'a Service' : 'Non-inventory'} — its type cannot change`,
        );
      }
    }

    const salesAccount = text(row.values, 'salesAccount');
    if (salesAccount !== null) {
      const err = accountCodeError('SalesAccount', salesAccount, accounts.get(salesAccount), ['Revenue']);
      if (err !== null) errors.push(err);
    }
    const purchasesAccount = text(row.values, 'purchasesAccount');
    if (purchasesAccount !== null) {
      const err = accountCodeError('PurchasesAccount', purchasesAccount, accounts.get(purchasesAccount), ['Expense']);
      if (err !== null) errors.push(err);
    }
    return { rowId: row.id, errors };
  });
}

export async function preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview> {
  const { rows: importRows } = await client.query<{ kind: string; status: string; error_count: number }>(
    'SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2',
    [importId, orgId],
  );
  const imp = importRows[0];
  if (imp === undefined) throw new ApiError(404, 'Migration import not found');

  const rows = await loadDataRowsOnClient(client, orgId, importId);
  const items = await findItemsByCodesOnClient(client, orgId, uniq(rows.map((r) => text(r.values, 'itemCode'))));
  let toCreate = 0;
  let toFill = 0;
  for (const row of rows) {
    const code = text(row.values, 'itemCode');
    if (code !== null && items.has(code)) toFill += 1;
    else toCreate += 1;
  }

  return {
    kind: 'ITEMS',
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
      { label: 'Products to create', value: toCreate, format: 'count' },
      { label: 'Existing products to fill in', value: toFill, format: 'count' },
    ],
    warnings: [],
  };
}

function pgCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function wrapRowError(err: unknown, row: DataRow, code: string): unknown {
  if (err instanceof ApiError) return new ApiError(err.status, `Row ${String(row.rowNumber)} (${code}): ${err.message}`);
  if (pgCode(err) === '23505') {
    return new ApiError(409, `Row ${String(row.rowNumber)} (${code}): Item code already exists`);
  }
  return err;
}

export async function commitOnClient(
  client: PoolClient,
  orgId: string,
  importId: string,
  createdBy: string,
): Promise<Extract<MigrationCommitResult, { kind: 'ITEMS' }>> {
  const rows = await loadDataRowsOnClient(client, orgId, importId);
  const { items, accounts } = await loadLookups(client, orgId, rows);

  let createdCount = 0;
  let mergedCount = 0;
  for (const row of rows) {
    const code = text(row.values, 'itemCode');
    const name = text(row.values, 'itemName');
    if (code === null || name === null) throw new ApiError(409, `Row ${String(row.rowNumber)}: code and name are required`);

    const salesCode = text(row.values, 'salesAccount');
    const purchasesCode = text(row.values, 'purchasesAccount');
    const revenueAccountId = salesCode === null ? null : (accounts.get(salesCode)?.id ?? null);
    const expenseAccountId = purchasesCode === null ? null : (accounts.get(purchasesCode)?.id ?? null);
    const salePriceCents = num(row.values, 'salePrice');
    const purchasePriceCents = num(row.values, 'purchasePrice');
    const description = text(row.values, 'description');

    try {
      const existing = items.get(code);
      if (existing !== undefined) {
        await fillMissingItemFieldsOnClient(client, orgId, existing.id, {
          description,
          salePriceCents,
          purchasePriceCents,
          revenueAccountId,
          expenseAccountId,
        });
        mergedCount += 1;
      } else {
        const explicit = text(row.values, 'itemType');
        const itemType: ItemType =
          explicit === 'SERVICE' || explicit === 'NON_INVENTORY'
            ? explicit
            : purchasePriceCents !== null || purchasesCode !== null
              ? 'NON_INVENTORY'
              : 'SERVICE';
        await createItemOnClient(client, orgId, createdBy, {
          code,
          name,
          description,
          itemType,
          salePriceCents,
          purchasePriceCents,
          revenueAccountId,
          expenseAccountId,
          saleTaxRateBp: num(row.values, 'salesTaxRate') ?? 0,
          purchaseTaxRateBp: num(row.values, 'purchasesTaxRate') ?? 0,
        });
        createdCount += 1;
      }
    } catch (err) {
      throw wrapRowError(err, row, code);
    }
  }

  await markCommittedOnClient(client, orgId, importId);
  return { kind: 'ITEMS', createdCount, mergedCount };
}

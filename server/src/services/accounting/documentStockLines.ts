import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import * as documentStockService from '../inventory/documentStockService.js';
import { resolveStockAccountsOnClient } from './itemService.js';
import type { StockItemAccounts } from './itemService.js';

/**
 * Phase 32 — how an invoice/bill decides which of its lines move stock.
 *
 * A line moves stock exactly when its `item_id` points at an INVENTORY
 * product. Everything else (free-typed lines, services, non-inventory items)
 * posts as it always has. Shared by `billService` and `invoiceService`, at
 * draft-save (early feedback) and again at posting (the definitive check — a
 * draft can sit for days while an item or location changes underneath it).
 *
 * Step 1 refuses FIXED_ASSET lines (capitalisation on a bill is the next step)
 * and, via documentStockService, lot/serial-tracked items.
 */

export interface DocumentLineCandidate {
  lineNumber: number;
  itemId: string | null;
  stockLocationId: string | null;
  quantityMilli: number;
}

export interface StockLine {
  lineNumber: number;
  itemId: string;
  stockLocationId: string | null;
  quantityMilli: number;
  accounts: StockItemAccounts;
}

/** Returns the INVENTORY lines, keyed by line number, with their resolved accounts. Throws 422 for unsupported combinations. */
export async function classifyStockLinesOnClient(
  client: PoolClient,
  orgId: string,
  lines: DocumentLineCandidate[],
): Promise<Map<number, StockLine>> {
  const stockLines = new Map<number, StockLine>();

  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => v !== null))];
  const types = new Map<string, { code: string; itemType: string }>();
  if (itemIds.length > 0) {
    const { rows } = await client.query<{ id: string; code: string; item_type: string }>(
      'SELECT id, code, item_type FROM items WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [orgId, itemIds],
    );
    for (const row of rows) types.set(row.id, { code: row.code, itemType: row.item_type });
  }

  const inventoryItemIds: string[] = [];
  for (const line of lines) {
    const type = line.itemId === null ? undefined : types.get(line.itemId);
    if (type?.itemType === 'FIXED_ASSET') {
      throw new ApiError(
        422,
        `Line ${String(line.lineNumber)}: item ${type.code} is a fixed asset — capitalising fixed assets on bills is not supported yet`,
      );
    }
    if (type?.itemType === 'INVENTORY' && line.itemId !== null) {
      inventoryItemIds.push(line.itemId);
      continue;
    }
    if (line.stockLocationId !== null) {
      throw new ApiError(422, `Line ${String(line.lineNumber)}: a stock location applies only to inventory items`);
    }
  }
  if (inventoryItemIds.length === 0) return stockLines;

  const accounts = await resolveStockAccountsOnClient(client, orgId, inventoryItemIds);
  for (const line of lines) {
    if (line.itemId === null) continue;
    const resolved = accounts.get(line.itemId);
    if (resolved === undefined) continue;
    stockLines.set(line.lineNumber, {
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantityMilli: line.quantityMilli,
      accounts: resolved,
    });
  }
  return stockLines;
}

/** Draft-save: classify, then apply Inventory's tracking/precision/location rules. */
export async function prepareStockLinesOnClient(
  client: PoolClient,
  orgId: string,
  lines: DocumentLineCandidate[],
): Promise<Map<number, StockLine>> {
  const stockLines = await classifyStockLinesOnClient(client, orgId, lines);
  await documentStockService.validateDocumentLinesOnClient(
    client,
    orgId,
    [...stockLines.values()].map((l) => ({
      lineNumber: l.lineNumber,
      ledgerItemId: l.itemId,
      locationId: l.stockLocationId,
      quantityMilli: l.quantityMilli,
    })),
  );
  return stockLines;
}

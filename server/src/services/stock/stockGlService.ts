import type { PoolClient } from 'pg';
import { ApiError } from '../../utils/apiError.js';
import * as ledgerItemService from '../ledger-core/itemService.js';
import * as journalService from '../ledger-core/journalService.js';
import type { JournalLineInput } from '../ledger-core/journalService.js';
import { resolveInventoryPostingAccountsOnClient } from '../ledger-core/settingsService.js';
import type { StockMovement } from '../../types/stock.js';

/**
 * StockLedger -> LedgerCore general-ledger bridge for MANUAL movements
 * (Phase 32). Document-driven movements (a bill's receipt, an invoice's issue)
 * do not come through here — LedgerCore builds those journals itself out of the
 * values `documentStockService` returns.
 *
 * Rule 16: this file reaches LedgerCore only through its public service
 * functions (`itemService`, `settingsService`, `journalService`) and reads only
 * StockLedger's own table (`stock_items`). Every function runs on the caller's
 * transaction client (rule 5): a period-closed refusal from the journal rolls
 * the stock movement back with it.
 *
 * An item is "linked" when `stock_items.ledger_item_id` is set. Linked items'
 * movements post; unlinked items (created before Phase 32 and not yet linked)
 * behave exactly as in Phase 28 — no GL effect.
 */

/** stock item id -> the inventory account its value posts to. Unlinked items are absent. */
export async function resolveGlAccountsOnClient(
  client: PoolClient,
  orgId: string,
  stockItemIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(stockItemIds)];
  if (unique.length === 0) return result;

  const { rows } = await client.query<{ id: string; ledger_item_id: string }>(
    `SELECT id, ledger_item_id FROM stock_items
      WHERE org_id = $1 AND id = ANY($2::uuid[]) AND ledger_item_id IS NOT NULL`,
    [orgId, unique],
  );
  if (rows.length === 0) return result;

  const accounts = await ledgerItemService.resolveStockAccountsOnClient(
    client,
    orgId,
    rows.map((r) => r.ledger_item_id),
  );
  for (const row of rows) {
    const resolved = accounts.get(row.ledger_item_id);
    if (resolved !== undefined) result.set(row.id, resolved.assetAccountId);
  }
  return result;
}

/**
 * Posts ONE journal entry for a manual movement group.
 *
 *   RECEIPT                 Dr Inventory   / Cr Opening-stock equity (3400)
 *   ISSUE, ADJUSTMENT_OUT   Dr Adjustments / Cr Inventory
 *   ADJUSTMENT_IN           Dr Inventory   / Cr Adjustments
 *   TRANSFER_*              nothing — the inventory account belongs to the item, not the location
 *
 * For a linked item a purchase should go through a bill; a manual receipt is
 * treated as opening stock. Returns the journal entry id, or null when nothing
 * needed posting (unlinked items, transfers, zero-value movements).
 */
export async function postManualMovementsOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  movementGroupId: string,
  movements: StockMovement[],
  occurredOn: string,
  description: string,
): Promise<string | null> {
  const posting = movements.filter(
    (m) =>
      m.glAccountId !== null &&
      m.valueCents !== 0 &&
      (m.movementType === 'RECEIPT' ||
        m.movementType === 'ISSUE' ||
        m.movementType === 'ADJUSTMENT_IN' ||
        m.movementType === 'ADJUSTMENT_OUT'),
  );
  if (posting.length === 0) return null;

  const defaults = await resolveInventoryPostingAccountsOnClient(client, orgId);

  // Net signed amount per account (debit positive). Every movement adds +v to
  // its inventory account and -v to its counter account, so the entry balances
  // by construction.
  const net = new Map<string, number>();
  const add = (accountId: string, amount: number): void => {
    net.set(accountId, (net.get(accountId) ?? 0) + amount);
  };
  for (const m of posting) {
    const inventoryAccountId = m.glAccountId;
    if (inventoryAccountId === null) continue;
    let counter: string | null;
    if (m.movementType === 'RECEIPT') {
      counter = defaults.openingAccountId;
      if (counter === null) throw new ApiError(422, 'No opening-stock equity account is configured. Set one in settings.');
    } else {
      counter = defaults.adjustmentAccountId;
      if (counter === null) throw new ApiError(422, 'No inventory-adjustment account is configured. Set one in settings.');
    }
    add(inventoryAccountId, m.valueCents);
    add(counter, -m.valueCents);
  }

  const lines: JournalLineInput[] = [];
  for (const [accountId, amount] of net) {
    if (amount > 0) lines.push({ accountId, debitCents: amount, creditCents: 0 });
    else if (amount < 0) lines.push({ accountId, debitCents: 0, creditCents: -amount });
  }
  if (lines.length === 0) return null;

  return journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: occurredOn,
    description,
    sourceType: 'stock',
    sourceId: movementGroupId,
    lines,
  });
}

/**
 * Linking an item that already holds stock: posts the opening entry
 * (Dr Inventory / Cr Opening-stock equity) for its current on-hand value so
 * the GL inventory account starts equal to StockLedger's valuation.
 */
export async function postLinkOpeningOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  stockItemId: string,
  inventoryAccountId: string,
  onHandValueCents: number,
  entryDate: string,
  itemCode: string,
): Promise<string | null> {
  if (onHandValueCents <= 0) return null;
  const defaults = await resolveInventoryPostingAccountsOnClient(client, orgId);
  if (defaults.openingAccountId === null) {
    throw new ApiError(422, 'No opening-stock equity account is configured. Set one in settings.');
  }
  return journalService.createEntryOnClient(client, orgId, userId, {
    entryDate,
    description: `Opening stock — ${itemCode}`,
    sourceType: 'stock',
    sourceId: stockItemId,
    lines: [
      { accountId: inventoryAccountId, debitCents: onHandValueCents, creditCents: 0 },
      { accountId: defaults.openingAccountId, debitCents: 0, creditCents: onHandValueCents },
    ],
  });
}

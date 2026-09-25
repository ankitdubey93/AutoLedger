import type { PoolClient } from 'pg';
import * as journalService from './journalService.js';
import type { JournalLineInput } from './journalService.js';
import * as ledgerItemService from './itemService.js';
import type { StockItemAccounts } from './itemService.js';
import * as documentStockService from '../inventory/documentStockService.js';
import type { DocumentReversalResult, ReclassPosting } from '../inventory/documentStockService.js';
import { MODULE_TAGS } from '../../config/modules.js';

/**
 * Phase 35a — the ONLY accounting file that orchestrates a stock reclass. It
 * calls Inventory's `documentStockService` (rule 16: never Inventory's
 * tables) to move stock value between GL accounts, and posts the resulting
 * journal itself.
 *
 * GLOBAL LOCK ORDER (Core model §4, extends Phase 32): document row FOR
 * UPDATE -> `items` rows (FOR SHARE when resolving, FOR UPDATE when changing
 * mapping; always ORDER BY id) -> `ledger_settings` row (FOR SHARE when
 * resolving, FOR UPDATE/UPDATE when changing) -> `stock_balances` (one sorted
 * `lockBalances` pass) -> invoice/bill number -> journal inserts. Every
 * caller into this file must resolve accounts BEFORE it locks balances —
 * every function here assumes the caller already holds whatever `items` /
 * `ledger_settings` locks the change needs.
 */

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Posts Dr to / Cr from for each posting, netted per account, source
 * (MODULE_TAGS.inventory, sourceId). No-op for an empty list.
 */
export async function postReclassJournalOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: { sourceId: string; entryDate: string; description: string; postings: ReclassPosting[] },
): Promise<string | null> {
  if (input.postings.length === 0) return null;

  const net = new Map<string, number>();
  const add = (accountId: string, amount: number): void => {
    net.set(accountId, (net.get(accountId) ?? 0) + amount);
  };
  for (const p of input.postings) {
    add(p.toAccountId, p.valueCents);
    add(p.fromAccountId, -p.valueCents);
  }

  const lines: JournalLineInput[] = [];
  for (const [accountId, amount] of net) {
    if (amount > 0) lines.push({ accountId, debitCents: amount, creditCents: 0 });
    else if (amount < 0) lines.push({ accountId, debitCents: 0, creditCents: -amount });
  }
  if (lines.length === 0) return null;

  return journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: input.entryDate,
    description: input.description,
    sourceType: MODULE_TAGS.inventory,
    sourceId: input.sourceId,
    lines,
  });
}

/**
 * Caller already holds the products' FOR UPDATE locks (or `ledger_settings`
 * for a default change). Resolves each product's current inventory account
 * and sweeps stock value into it. Returns the number of postings.
 */
export async function reclassToCurrentAccountsOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  ledgerItemIds: string[],
  description: string,
): Promise<number> {
  if (ledgerItemIds.length === 0) return 0;

  const accounts = await ledgerItemService.resolveStockAccountsOnClient(client, orgId, ledgerItemIds);
  const targets: { ledgerItemId: string; targetAccountId: string }[] = [];
  for (const id of ledgerItemIds) {
    const a = accounts.get(id);
    if (a !== undefined) targets.push({ ledgerItemId: id, targetAccountId: a.assetAccountId });
  }
  if (targets.length === 0) return 0;

  const entryDate = todayUtc();
  const outcome = await documentStockService.reclassItemsOnClient(client, orgId, userId, {
    targets,
    occurredOn: entryDate,
    reason: description,
  });
  await postReclassJournalOnClient(client, orgId, userId, {
    sourceId: outcome.sourceId,
    entryDate,
    description,
    postings: outcome.postings,
  });
  return outcome.postings.length;
}

/**
 * Void helper: after `reverseDocumentOnClient` + the reversing journal.
 * `targets` were resolved BEFORE the reversal (lock order).
 */
export async function sweepVoidOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  reversal: DocumentReversalResult,
  targets: Map<string, StockItemAccounts>,
  description: string,
): Promise<void> {
  const targetByLedgerItem = new Map<string, string>([...targets].map(([id, a]) => [id, a.assetAccountId]));
  const outcome = await documentStockService.sweepReversalOnClient(client, orgId, userId, {
    reversal,
    targetByLedgerItem,
    reason: description,
  });
  if (outcome.postings.length === 0) return;

  const entryDate = reversal.movements[0]?.occurredOn;
  if (entryDate === undefined) throw new Error('sweepVoidOnClient: postings exist but the reversal has no movements');
  await postReclassJournalOnClient(client, orgId, userId, {
    sourceId: outcome.sourceId,
    entryDate,
    description,
    postings: outcome.postings,
  });
}

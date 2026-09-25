import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { MODULE_TAGS } from '../../config/modules.js';
import * as ledgerItemService from '../accounting/itemService.js';
import { resolveInventoryPostingAccountsOnClient } from '../accounting/settingsService.js';
import { balancesForAccountsOnClient, listNonSubledgerLinesOnClient } from '../accounting/accountLedgerService.js';
import * as journalService from '../accounting/journalService.js';
import * as inventoryAccountingService from '../accounting/inventoryAccountingService.js';
import { listLinkedLedgerItemIdsWithValueOnClient } from './documentStockService.js';
import { linkAllProducts } from './itemService.js';
import type {
  InventoryMisplacedValue,
  InventoryTrueUp,
  InventoryValuation,
  InventoryValuationAccount,
  LinkAllResult,
} from '../../types/inventory.js';

/**
 * Phase 35a — inventory ties out to the general ledger. Rule 16: this file
 * reads only Inventory's own tables (`stock_items`, `stock_balances`,
 * `stock_movements`) directly; every GL number comes from Accounting's own
 * services (`accountLedgerService`, `itemService`, `settingsService`,
 * `journalService`), and `inventoryAccountingService` is the ONE accounting
 * entry point that orchestrates a reclass (Core model §4's lock order lives
 * there, not here).
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Accounts a reconciliation must cover: every control account plus every account any stock movement ever posted to. */
async function resolveValuationAccountIds(client: Queryable, orgId: string): Promise<Set<string>> {
  const controlIds = await ledgerItemService.resolveInventoryControlAccountIdsOnClient(client, orgId);
  const { rows } = await client.query<{ gl_account_id: string }>(
    'SELECT DISTINCT gl_account_id FROM stock_movements WHERE org_id = $1 AND gl_account_id IS NOT NULL',
    [orgId],
  );
  const ids = new Set(controlIds);
  for (const row of rows) ids.add(row.gl_account_id);
  return ids;
}

/** GET /inventory/valuation. Read-only, on the pool — no lock is held across these queries. */
export async function getValuation(orgId: string, asOf: string | null): Promise<InventoryValuation> {
  const client = await pool.connect();
  try {
    const accountIds = [...(await resolveValuationAccountIds(client, orgId))];

    const { rows: subledgerRows } = await client.query<{ gl_account_id: string; v: string }>(
      `SELECT gl_account_id, SUM(value_cents)::text AS v FROM stock_movements
        WHERE org_id = $1 AND gl_account_id = ANY($2::uuid[]) AND ($3::date IS NULL OR occurred_on <= $3::date)
        GROUP BY gl_account_id`,
      [orgId, accountIds, asOf],
    );
    const subledgerByAccount = new Map(subledgerRows.map((r) => [r.gl_account_id, parseCents(r.v)]));

    const glByAccount = await balancesForAccountsOnClient(client, orgId, accountIds, asOf);
    const unexplainedByAccount = await listNonSubledgerLinesOnClient(
      client,
      orgId,
      accountIds,
      asOf,
      [MODULE_TAGS.inventory, 'bill', 'invoice'],
      50,
    );

    const accounts: InventoryValuationAccount[] = accountIds
      .map((accountId) => {
        const gl = glByAccount.get(accountId);
        const subledgerCents = subledgerByAccount.get(accountId) ?? 0;
        const glCents = gl?.netDebitCents ?? 0;
        return {
          accountId,
          code: gl?.code ?? '',
          name: gl?.name ?? '',
          subledgerCents,
          glCents,
          differenceCents: glCents - subledgerCents,
          unexplainedLines: unexplainedByAccount.get(accountId) ?? [],
        };
      })
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const totalSubledgerCents = accounts.reduce((sum, a) => sum + a.subledgerCents, 0);
    const totalGlCents = accounts.reduce((sum, a) => sum + a.glCents, 0);
    const totalDifferenceCents = totalGlCents - totalSubledgerCents;

    // Misplaced value: a linked item whose stock ledger holds value on an
    // account that is no longer its CURRENT resolved account.
    const { rows: linkedRows } = await client.query<{
      item_id: string;
      code: string;
      name: string;
      ledger_item_id: string;
    }>(
      'SELECT id AS item_id, code, name, ledger_item_id FROM stock_items WHERE org_id = $1 AND ledger_item_id IS NOT NULL',
      [orgId],
    );

    const misplaced: InventoryMisplacedValue[] = [];
    if (linkedRows.length > 0) {
      const currentAccounts = await ledgerItemService.resolveStockAccountsOnClient(
        client,
        orgId,
        linkedRows.map((r) => r.ledger_item_id),
      );
      const { rows: sumRows } = await client.query<{ item_id: string; gl_account_id: string; v: string }>(
        `SELECT item_id, gl_account_id, SUM(value_cents)::text AS v FROM stock_movements
          WHERE org_id = $1 AND item_id = ANY($2::uuid[]) AND gl_account_id IS NOT NULL
          GROUP BY item_id, gl_account_id HAVING SUM(value_cents) <> 0`,
        [orgId, linkedRows.map((r) => r.item_id)],
      );
      const byId = new Map(linkedRows.map((r) => [r.item_id, r]));
      for (const row of sumRows) {
        const item = byId.get(row.item_id);
        if (item === undefined) continue;
        const current = currentAccounts.get(item.ledger_item_id)?.assetAccountId;
        if (current === undefined || current === row.gl_account_id) continue;
        misplaced.push({
          stockItemId: item.item_id,
          itemCode: item.code,
          itemName: item.name,
          accountId: row.gl_account_id,
          currentAccountId: current,
          valueCents: parseCents(row.v),
        });
      }
    }

    const { rows: unlinkedRows } = await client.query<{ unlinked_item_count: string; unlinked_value_cents: string }>(
      `SELECT count(DISTINCT i.id)::text AS unlinked_item_count,
              COALESCE(SUM(b.value_cents), 0)::text AS unlinked_value_cents
         FROM stock_items i
         JOIN stock_balances b ON b.item_id = i.id AND b.org_id = i.org_id
        WHERE i.org_id = $1 AND i.ledger_item_id IS NULL AND b.value_cents > 0`,
      [orgId],
    );
    const unlinkedRow = unlinkedRows[0];
    const unlinkedItemCount = Number(unlinkedRow?.unlinked_item_count ?? '0');
    const unlinkedValueCents = parseCents(unlinkedRow?.unlinked_value_cents ?? '0');

    return {
      asOf,
      accounts,
      totalSubledgerCents,
      totalGlCents,
      totalDifferenceCents,
      misplaced,
      unlinkedItemCount,
      unlinkedValueCents,
      tiesOut: accounts.every((a) => a.differenceCents === 0) && misplaced.length === 0,
    };
  } finally {
    client.release();
  }
}

/**
 * POST /inventory/reconcile/true-up. Serialized per org with an advisory
 * lock (not a row lock — there is no natural row to lock for "the whole
 * reconciliation") so two concurrent true-ups on the same account cannot both
 * read the same stale difference and both post.
 */
export async function trueUp(
  orgId: string,
  userId: string,
  input: { accountId: string; expectedDifferenceCents: number },
): Promise<InventoryTrueUp> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('stock_true_up:' || $1::text, 0))", [orgId]);

    const accountIds = await resolveValuationAccountIds(client, orgId);
    if (!accountIds.has(input.accountId)) {
      throw new ApiError(422, 'That account is not an inventory account');
    }

    const { rows: subledgerRows } = await client.query<{ v: string }>(
      'SELECT COALESCE(SUM(value_cents), 0)::text AS v FROM stock_movements WHERE org_id = $1 AND gl_account_id = $2',
      [orgId, input.accountId],
    );
    const subledgerCents = parseCents(subledgerRows[0]?.v ?? '0');

    const glByAccount = await balancesForAccountsOnClient(client, orgId, [input.accountId], null);
    const glCents = glByAccount.get(input.accountId)?.netDebitCents ?? 0;
    const differenceCents = glCents - subledgerCents;

    if (differenceCents === 0) throw new ApiError(409, 'This account already ties to inventory');
    if (differenceCents !== input.expectedDifferenceCents) {
      throw new ApiError(409, 'The difference has changed — refresh the valuation and try again');
    }

    const defaults = await resolveInventoryPostingAccountsOnClient(client, orgId);
    if (defaults.adjustmentAccountId === null) {
      throw new ApiError(422, 'No inventory-adjustment account is configured. Set one in settings.');
    }
    const adjustmentAccountId = defaults.adjustmentAccountId;

    const id = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const lines =
      differenceCents > 0
        ? [
            { accountId: adjustmentAccountId, debitCents: differenceCents, creditCents: 0 },
            { accountId: input.accountId, debitCents: 0, creditCents: differenceCents },
          ]
        : [
            { accountId: input.accountId, debitCents: -differenceCents, creditCents: 0 },
            { accountId: adjustmentAccountId, debitCents: 0, creditCents: -differenceCents },
          ];

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: today,
      description: 'Inventory true-up — general ledger adjusted to stock valuation',
      sourceType: MODULE_TAGS.inventory,
      sourceId: id,
      lines,
    });

    const { rows: inserted } = await client.query<{
      id: string;
      account_id: string;
      gl_before_cents: string;
      subledger_cents: string;
      difference_cents: string;
      journal_entry_id: string;
      occurred_on: string;
    }>(
      `INSERT INTO stock_gl_true_ups
         (id, org_id, account_id, gl_before_cents, subledger_cents, difference_cents, journal_entry_id, occurred_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, account_id, gl_before_cents, subledger_cents, difference_cents, journal_entry_id, occurred_on`,
      [id, orgId, input.accountId, glCents, subledgerCents, differenceCents, journalEntryId, today, userId],
    );
    const row = inserted[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');

    return {
      id: row.id,
      accountId: row.account_id,
      glBeforeCents: parseCents(row.gl_before_cents),
      subledgerCents: parseCents(row.subledger_cents),
      differenceCents: parseCents(row.difference_cents),
      journalEntryId: row.journal_entry_id,
      occurredOn: row.occurred_on,
    };
  });
}

/** POST /inventory/reconcile/reclass. Sweeps every linked item's stray GL value onto its current account. */
export async function reclassMisplaced(orgId: string, userId: string): Promise<{ postingCount: number }> {
  return withTransaction(async (client) => {
    const ledgerItemIds = await listLinkedLedgerItemIdsWithValueOnClient(client, orgId);
    await ledgerItemService.lockInventoryItemsOnClient(client, orgId, ledgerItemIds);
    const postingCount = await inventoryAccountingService.reclassToCurrentAccountsOnClient(
      client,
      orgId,
      userId,
      ledgerItemIds,
      'Inventory value moved to current accounts',
    );
    return { postingCount };
  });
}

/** POST /inventory/items/link-all. Delegates to Inventory's own itemService. */
export async function linkAll(orgId: string, userId: string): Promise<LinkAllResult> {
  return linkAllProducts(orgId, userId);
}

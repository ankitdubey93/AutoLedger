import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../utils/apiError.js';
import { MODULE_TAGS } from '../../config/modules.js';
import { getLocationOnClient } from './locationService.js';
import {
  issueOnClient,
  lockBalances,
  receiveOnClient,
  reclassOnClient,
  reverseMovementsOnClient,
} from './movementService.js';
import type { MovementOptions, OriginalMovement, ReclassMove } from './movementService.js';

/**
 * Inventory's document seam (Phase 32) — the ONE module Accounting's
 * invoice and bill services import from Inventory (guardrails rule 16).
 *
 * A bill line for an INVENTORY product receives stock; an invoice line issues
 * it. Accounting owns the documents and builds its own journal entry; this
 * file owns the stock: it moves quantity, values the movement, and hands the
 * values back so Accounting can put them in the entry it posts. Nothing here
 * writes a journal line.
 *
 * Every function takes the CALLER's transaction client and opens no
 * transaction of its own (rule 5) — the document, its stock movements and its
 * journal entry commit or roll back together. The caller must already hold the
 * document row's lock.
 *
 * LOCK ORDER (deadlock avoidance, extends movementService's header): document
 * row FOR UPDATE -> ALL of the document's stock balances in one sorted pass
 * (`lockBalances`) -> invoice-number counter -> journal inserts. A
 * multi-location document is therefore locked in the same (item, location, lot)
 * order as a manual multi-line movement, so no two paths can hold locks the
 * other needs.
 *
 * STEP 1 SCOPE: QUANTITY-tracked items only. Lot- and serial-tracked items on a
 * document line are refused with a 422 (lot/serial picking on document lines is
 * the next step) and are refused at draft-save time as well as at posting.
 */

export interface DocumentStockLine {
  lineNumber: number;
  /** The Accounting product (items.id) the line was picked from. */
  ledgerItemId: string;
  /** Null means "the default location" (stock_settings.default_location_id). */
  locationId: string | null;
  quantityMilli: number;
  /** The inventory account this line's value posts to (resolved by Accounting). */
  glAccountId: string;
  /** Receipts only: the line's total BASE-currency value, already split with allocateCents. */
  valueCents?: number | undefined;
}

export interface DocumentStockInput {
  sourceType: 'bill' | 'invoice';
  sourceId: string;
  occurredOn: string;
  reference: string | null;
  lines: DocumentStockLine[];
}

export interface DocumentStockLineResult {
  lineNumber: number;
  ledgerItemId: string;
  glAccountId: string;
  /** Positive base-currency cents moved (receipt: added, issue: removed at moving average). */
  valueCents: number;
  movementId: string;
}

export interface DocumentStockResult {
  movementGroupId: string;
  lines: DocumentStockLineResult[];
}

interface LinkedStockItem {
  id: string;
  code: string;
  tracking: string;
  decimalPlaces: number;
}

async function loadLinkedItems(
  client: PoolClient,
  orgId: string,
  ledgerItemIds: string[],
): Promise<Map<string, LinkedStockItem>> {
  const unique = [...new Set(ledgerItemIds)];
  const { rows } = await client.query<{
    id: string;
    code: string;
    tracking: string;
    decimal_places: number;
    ledger_item_id: string;
  }>(
    `SELECT i.id, i.code, i.tracking, u.decimal_places, i.ledger_item_id
       FROM stock_items i JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
      WHERE i.org_id = $1 AND i.ledger_item_id = ANY($2::uuid[])`,
    [orgId, unique],
  );
  const map = new Map<string, LinkedStockItem>();
  for (const row of rows) {
    map.set(row.ledger_item_id, {
      id: row.id,
      code: row.code,
      tracking: row.tracking,
      decimalPlaces: row.decimal_places,
    });
  }
  // A product typed INVENTORY without a stock item is a broken invariant (a
  // 500), not user input — Inventory creates both in one transaction.
  if (map.size !== unique.length) throw new Error('INVENTORY product has no linked stock item');
  return map;
}

async function resolveDefaultLocation(client: PoolClient, orgId: string): Promise<string | null> {
  const { rows } = await client.query<{ default_location_id: string | null }>(
    'SELECT default_location_id FROM stock_settings WHERE org_id = $1',
    [orgId],
  );
  return rows[0]?.default_location_id ?? null;
}

interface ResolvedLine extends DocumentStockLine {
  stockItem: LinkedStockItem;
  resolvedLocationId: string;
}

async function resolveLines(
  client: PoolClient,
  orgId: string,
  lines: Omit<DocumentStockLine, 'glAccountId' | 'valueCents'>[],
): Promise<(Omit<DocumentStockLine, 'glAccountId' | 'valueCents'> & { stockItem: LinkedStockItem; resolvedLocationId: string })[]> {
  const items = await loadLinkedItems(client, orgId, lines.map((l) => l.ledgerItemId));
  const defaultLocationId = await resolveDefaultLocation(client, orgId);

  const resolved = [];
  for (const line of lines) {
    const stockItem = items.get(line.ledgerItemId);
    if (stockItem === undefined) throw new Error('INVENTORY product has no linked stock item');

    if (stockItem.tracking !== 'QUANTITY') {
      throw new ApiError(
        422,
        `Line ${String(line.lineNumber)}: item ${stockItem.code} is ${stockItem.tracking.toLowerCase()}-tracked — lot/serial selection on invoice and bill lines is not supported yet; record it in Inventory`,
      );
    }
    const modulus = 10 ** (3 - stockItem.decimalPlaces);
    if (line.quantityMilli % modulus !== 0) {
      throw new ApiError(
        422,
        `Line ${String(line.lineNumber)}: quantity for item ${stockItem.code} allows at most ${String(stockItem.decimalPlaces)} decimal places`,
      );
    }

    const locationId = line.locationId ?? defaultLocationId;
    if (locationId === null) {
      throw new ApiError(422, `Choose a stock location for line ${String(line.lineNumber)}`);
    }
    // Existence + tenant check on the caller's client (getLocationOnClient scopes by org_id).
    await getLocationOnClient(client, orgId, locationId);
    resolved.push({ ...line, stockItem, resolvedLocationId: locationId });
  }
  return resolved;
}

/**
 * Early feedback at draft-save: the same tracking, precision and location
 * rules posting enforces. Posting re-checks — a draft can sit for days while
 * an item is edited or a location deactivated.
 */
export async function validateDocumentLinesOnClient(
  client: PoolClient,
  orgId: string,
  lines: Omit<DocumentStockLine, 'glAccountId' | 'valueCents'>[],
): Promise<void> {
  if (lines.length === 0) return;
  await resolveLines(client, orgId, lines);
}

async function lockAllBalances(client: PoolClient, orgId: string, lines: ResolvedLine[]): Promise<void> {
  await lockBalances(
    client,
    orgId,
    lines.map((l) => ({ itemId: l.stockItem.id, locationId: l.resolvedLocationId, lotId: null })),
  );
}

function optionsFor(input: DocumentStockInput, lines: ResolvedLine[]): MovementOptions {
  return {
    source: { type: input.sourceType, id: input.sourceId },
    glAccountByItem: new Map(lines.map((l) => [l.stockItem.id, l.glAccountId])),
    allowFuture: true,
  };
}

/** Groups lines by location (sorted, so processing order is deterministic), keeping each line's original index. */
function byLocation(lines: ResolvedLine[]): Map<string, { line: ResolvedLine; index: number }[]> {
  const groups = new Map<string, { line: ResolvedLine; index: number }[]>();
  lines.forEach((line, index) => {
    const group = groups.get(line.resolvedLocationId) ?? [];
    group.push({ line, index });
    groups.set(line.resolvedLocationId, group);
  });
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function resolveInputLines(
  client: PoolClient,
  orgId: string,
  input: DocumentStockInput,
): Promise<ResolvedLine[]> {
  const resolved = await resolveLines(client, orgId, input.lines);
  return resolved.map((r, i) => {
    const original = input.lines[i];
    if (original === undefined) throw new Error('line index out of range');
    return { ...original, stockItem: r.stockItem, resolvedLocationId: r.resolvedLocationId };
  });
}

/** A bill's stock lines RECEIVE stock at their allocated base-currency value. */
export async function receiveForDocumentOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: DocumentStockInput,
): Promise<DocumentStockResult> {
  const movementGroupId = randomUUID();
  const lines = await resolveInputLines(client, orgId, input);
  await lockAllBalances(client, orgId, lines);
  const opts = optionsFor(input, lines);

  const results: DocumentStockLineResult[] = new Array<DocumentStockLineResult>(lines.length);
  for (const [locationId, group] of byLocation(lines)) {
    const movements = await receiveOnClient(
      client,
      orgId,
      userId,
      movementGroupId,
      {
        occurredOn: input.occurredOn,
        reference: input.reference,
        locationId,
        lines: group.map(({ line }) => ({
          itemId: line.stockItem.id,
          quantityMilli: line.quantityMilli,
          unitCostCents: 0,
          totalValueCents: line.valueCents ?? 0,
          lot: null,
          serials: null,
        })),
      },
      opts,
    );
    group.forEach(({ line, index }, i) => {
      const movement = movements[i];
      if (movement === undefined) throw new Error('receipt produced no movement for a line');
      results[index] = {
        lineNumber: line.lineNumber,
        ledgerItemId: line.ledgerItemId,
        glAccountId: line.glAccountId,
        valueCents: movement.valueCents,
        movementId: movement.id,
      };
    });
  }
  return { movementGroupId, lines: results };
}

/** An invoice's stock lines ISSUE stock at the current moving average; 409 when short. */
export async function issueForDocumentOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: DocumentStockInput,
): Promise<DocumentStockResult> {
  const movementGroupId = randomUUID();
  const lines = await resolveInputLines(client, orgId, input);
  await lockAllBalances(client, orgId, lines);
  const opts = optionsFor(input, lines);

  const results: DocumentStockLineResult[] = new Array<DocumentStockLineResult>(lines.length);
  for (const [locationId, group] of byLocation(lines)) {
    const movements = await issueOnClient(
      client,
      orgId,
      userId,
      movementGroupId,
      {
        occurredOn: input.occurredOn,
        reference: input.reference,
        locationId,
        lines: group.map(({ line }) => ({
          itemId: line.stockItem.id,
          quantityMilli: line.quantityMilli,
          lotId: null,
          serialIds: null,
        })),
      },
      opts,
    );
    group.forEach(({ line, index }, i) => {
      const movement = movements[i];
      if (movement === undefined) throw new Error('issue produced no movement for a line');
      results[index] = {
        lineNumber: line.lineNumber,
        ledgerItemId: line.ledgerItemId,
        glAccountId: line.glAccountId,
        valueCents: -movement.valueCents,
        movementId: movement.id,
      };
    });
  }
  return { movementGroupId, lines: results };
}

export interface DocumentReversalResult {
  byAccount: { glAccountId: string; originalValueCents: number; reversedValueCents: number }[];
  /** Phase 35a — the individual reversal rows written, so a void can sweep them off a stale account. */
  movements: { ledgerItemId: string; stockItemId: string; locationId: string; glAccountId: string; valueCents: number; occurredOn: string }[];
}

/**
 * Voids a document's stock: appends reversal movements for every movement the
 * document made that has not already been reversed. A document that moved no
 * stock returns an empty result. See `reverseMovementsOnClient` for the value
 * rules (issue: exact; receipt: original, clamped to what the balance holds).
 */
export async function reverseDocumentOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: { sourceType: 'bill' | 'invoice'; sourceId: string; occurredOn: string | null },
): Promise<DocumentReversalResult> {
  const { rows } = await client.query<{
    id: string;
    movement_type: string;
    item_id: string;
    item_code: string;
    location_id: string;
    location_code: string;
    quantity_milli: string;
    value_cents: string;
    gl_account_id: string;
    occurred_on: string;
    ledger_item_id: string | null;
  }>(
    `SELECT m.id, m.movement_type, m.item_id, i.code AS item_code, m.location_id, l.code AS location_code,
            m.quantity_milli, m.value_cents, m.gl_account_id, m.occurred_on, i.ledger_item_id
       FROM stock_movements m
       JOIN stock_items i ON i.id = m.item_id AND i.org_id = m.org_id
       JOIN stock_locations l ON l.id = m.location_id AND l.org_id = m.org_id
      WHERE m.org_id = $1 AND m.source_type = $2 AND m.source_id = $3
        AND m.movement_type IN ('RECEIPT', 'ISSUE') AND m.gl_account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stock_movements r
                         WHERE r.org_id = m.org_id AND r.reverses_movement_id = m.id)
      ORDER BY m.created_at, m.id`,
    [orgId, input.sourceType, input.sourceId],
  );
  if (rows.length === 0) return { byAccount: [], movements: [] };

  const originals: OriginalMovement[] = rows.map((r) => ({
    id: r.id,
    movementType: r.movement_type === 'RECEIPT' ? 'RECEIPT' : 'ISSUE',
    itemId: r.item_id,
    itemCode: r.item_code,
    locationId: r.location_id,
    locationCode: r.location_code,
    quantityMilli: Number(r.quantity_milli),
    valueCents: Number(r.value_cents),
    glAccountId: r.gl_account_id,
    occurredOn: r.occurred_on,
  }));

  const outcome = await reverseMovementsOnClient(
    client,
    orgId,
    userId,
    randomUUID(),
    originals,
    input.occurredOn,
    { type: input.sourceType, id: input.sourceId },
  );

  const movements = outcome.movements.map((m, i) => {
    const row = rows[i];
    if (row === undefined) throw new Error('reversal movement produced without a matching original row');
    if (row.ledger_item_id === null) throw new Error('reversed movement has no linked ledger item');
    return {
      ledgerItemId: row.ledger_item_id,
      stockItemId: m.itemId,
      locationId: m.locationId,
      glAccountId: row.gl_account_id,
      valueCents: m.valueCents,
      occurredOn: m.occurredOn,
    };
  });

  return { byAccount: outcome.summaries, movements };
}

// ------------------------------------------------------------- reclass (Phase 35a)

export interface ReclassPosting {
  fromAccountId: string;
  toAccountId: string;
  /** > 0 */
  valueCents: number;
}

export interface ReclassOutcome {
  sourceId: string;
  postings: ReclassPosting[];
}

function mergePostings(raw: ReclassPosting[]): ReclassPosting[] {
  const merged = new Map<string, ReclassPosting>();
  for (const p of raw) {
    const key = `${p.fromAccountId}|${p.toAccountId}`;
    const existing = merged.get(key);
    if (existing !== undefined) existing.valueCents += p.valueCents;
    else merged.set(key, { ...p });
  }
  return [...merged.values()];
}

/**
 * Sweeps every non-target account's value of each linked item into its
 * target account. Caller holds the products' mapping locks. Empty `targets`
 * or nothing to move both return an empty `postings` list without writing.
 */
export async function reclassItemsOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: { targets: { ledgerItemId: string; targetAccountId: string }[]; occurredOn: string; reason: string },
): Promise<ReclassOutcome> {
  const sourceId = randomUUID();
  if (input.targets.length === 0) return { sourceId, postings: [] };

  const linked = await loadLinkedItems(client, orgId, input.targets.map((t) => t.ledgerItemId));
  const targetByStockItem = new Map<string, string>();
  for (const t of input.targets) {
    const stockItem = linked.get(t.ledgerItemId);
    if (stockItem === undefined) throw new Error('INVENTORY product has no linked stock item');
    targetByStockItem.set(stockItem.id, t.targetAccountId);
  }
  const stockItemIds = [...targetByStockItem.keys()];

  const { rows: sumRows } = await client.query<{ item_id: string; gl_account_id: string; v: string }>(
    `SELECT item_id, gl_account_id, SUM(value_cents)::text AS v FROM stock_movements
      WHERE org_id = $1 AND item_id = ANY($2::uuid[]) AND gl_account_id IS NOT NULL
      GROUP BY 1, 2 HAVING SUM(value_cents) <> 0`,
    [orgId, stockItemIds],
  );
  if (sumRows.length === 0) return { sourceId, postings: [] };

  const { rows: balanceRows } = await client.query<{ item_id: string; location_id: string; lot_id: string | null }>(
    'SELECT item_id, location_id, lot_id FROM stock_balances WHERE org_id = $1 AND item_id = ANY($2::uuid[])',
    [orgId, stockItemIds],
  );
  const balances = await lockBalances(
    client,
    orgId,
    balanceRows.map((r) => ({ itemId: r.item_id, locationId: r.location_id, lotId: r.lot_id })),
  );
  // lockBalances inserts into `balances` in its own deterministic sort order
  // (itemId, locationId, lotId ?? '') — the Map preserves that insertion
  // order, so the first key seen per item is the anchor (Core model §3).
  const anchorByItem = new Map<string, { locationId: string; lotId: string | null }>();
  for (const key of balances.keys()) {
    const parts = key.split('|');
    const itemId = parts[0];
    const locationId = parts[1];
    const lot = parts[2];
    if (itemId === undefined || locationId === undefined) continue;
    if (!anchorByItem.has(itemId)) anchorByItem.set(itemId, { locationId, lotId: lot === undefined || lot === '' ? null : lot });
  }

  const moves: ReclassMove[] = [];
  const rawPostings: ReclassPosting[] = [];
  for (const row of sumRows) {
    const target = targetByStockItem.get(row.item_id);
    if (target === undefined || target === row.gl_account_id) continue;
    const anchor = anchorByItem.get(row.item_id);
    if (anchor === undefined) throw new Error('item has GL value but no balance row');
    const w = Number(row.v);
    if (w > 0) {
      moves.push({ itemId: row.item_id, locationId: anchor.locationId, lotId: anchor.lotId, fromAccountId: row.gl_account_id, toAccountId: target, valueCents: w });
      rawPostings.push({ fromAccountId: row.gl_account_id, toAccountId: target, valueCents: w });
    } else {
      moves.push({ itemId: row.item_id, locationId: anchor.locationId, lotId: anchor.lotId, fromAccountId: target, toAccountId: row.gl_account_id, valueCents: -w });
      rawPostings.push({ fromAccountId: target, toAccountId: row.gl_account_id, valueCents: -w });
    }
  }
  if (moves.length === 0) return { sourceId, postings: [] };

  await reclassOnClient(
    client,
    orgId,
    userId,
    sourceId,
    moves,
    input.occurredOn,
    input.reason,
    { type: MODULE_TAGS.inventory, id: sourceId },
  );

  return { sourceId, postings: mergePostings(rawPostings) };
}

/**
 * After a document void: moves the reversal movements' value off accounts
 * that are no longer the item's current account. No-op (and writes nothing)
 * when every reversal already landed on its item's current account.
 */
export async function sweepReversalOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: { reversal: DocumentReversalResult; targetByLedgerItem: Map<string, string>; reason: string },
): Promise<ReclassOutcome> {
  const sourceId = randomUUID();
  if (input.reversal.movements.length === 0) return { sourceId, postings: [] };

  interface GroupKey {
    stockItemId: string;
    locationId: string;
    glAccountId: string;
    ledgerItemId: string;
  }
  const groups = new Map<string, { key: GroupKey; sum: number }>();
  for (const m of input.reversal.movements) {
    const key = `${m.stockItemId}|${m.locationId}|${m.glAccountId}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.sum += m.valueCents;
    } else {
      groups.set(key, {
        key: { stockItemId: m.stockItemId, locationId: m.locationId, glAccountId: m.glAccountId, ledgerItemId: m.ledgerItemId },
        sum: m.valueCents,
      });
    }
  }

  const moves: ReclassMove[] = [];
  const rawPostings: ReclassPosting[] = [];
  for (const { key, sum } of groups.values()) {
    if (sum === 0) continue;
    const target = input.targetByLedgerItem.get(key.ledgerItemId);
    if (target === undefined || target === key.glAccountId) continue;
    if (sum > 0) {
      moves.push({ itemId: key.stockItemId, locationId: key.locationId, lotId: null, fromAccountId: key.glAccountId, toAccountId: target, valueCents: sum });
      rawPostings.push({ fromAccountId: key.glAccountId, toAccountId: target, valueCents: sum });
    } else {
      moves.push({ itemId: key.stockItemId, locationId: key.locationId, lotId: null, fromAccountId: target, toAccountId: key.glAccountId, valueCents: -sum });
      rawPostings.push({ fromAccountId: target, toAccountId: key.glAccountId, valueCents: -sum });
    }
  }
  if (moves.length === 0) return { sourceId, postings: [] };

  const occurredOn = input.reversal.movements[0]?.occurredOn;
  if (occurredOn === undefined) throw new Error('reversal has movements but no occurredOn');

  await reclassOnClient(
    client,
    orgId,
    userId,
    sourceId,
    moves,
    occurredOn,
    input.reason,
    { type: MODULE_TAGS.inventory, id: sourceId },
  );

  return { sourceId, postings: mergePostings(rawPostings) };
}

/** The ledger item ids a document's stock movements used (no locks). */
export async function listDocumentLedgerItemIdsOnClient(
  client: PoolClient,
  orgId: string,
  sourceType: 'bill' | 'invoice',
  sourceId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ ledger_item_id: string }>(
    `SELECT DISTINCT i.ledger_item_id
       FROM stock_movements m
       JOIN stock_items i ON i.id = m.item_id AND i.org_id = m.org_id
      WHERE m.org_id = $1 AND m.source_type = $2 AND m.source_id = $3 AND i.ledger_item_id IS NOT NULL`,
    [orgId, sourceType, sourceId],
  );
  return rows.map((r) => r.ledger_item_id);
}

/** Ledger item ids of linked stock items holding any non-zero value on a non-null GL account. */
export async function listLinkedLedgerItemIdsWithValueOnClient(client: PoolClient, orgId: string): Promise<string[]> {
  const { rows } = await client.query<{ ledger_item_id: string }>(
    `SELECT DISTINCT i.ledger_item_id
       FROM stock_items i
      WHERE i.org_id = $1 AND i.ledger_item_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM stock_movements m
           WHERE m.org_id = i.org_id AND m.item_id = i.id AND m.gl_account_id IS NOT NULL
           GROUP BY m.gl_account_id
          HAVING SUM(m.value_cents) <> 0
        )`,
    [orgId],
  );
  return rows.map((r) => r.ledger_item_id);
}

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 32 (migration 072) — the database enforces what the services rely on:
 * a stock item's product link is one-to-one and frozen once set, a movement's
 * source is all-or-nothing, a reversal names exactly the movement it undoes and
 * can only be applied once, movements stay append-only, and the sixth integrity
 * check catches a stock movement whose GL entry is missing. Integration tier,
 * real PostgreSQL.
 */

const app = createApp();
const STOCK = '/api/v1/stock';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FEATURE_NOT_SUPPORTED = '0A000';

let user: SeededUser;
let orgId: string;
let itemId: string;
let ledgerItemId: string;
let locationId: string;

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgId = user.orgId;
  const agent = await loginAgent(app, user);
  await agent.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
  const { rows: cat } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [orgId]);
  const created = await agent.post(`${STOCK}/items`).send({ name: 'Widget', categoryId: cat[0]?.id, attributes: {} });
  itemId = created.body.item.id as string;
  ledgerItemId = created.body.item.ledgerItemId as string;
  const { rows: loc } = await pool.query<{ id: string }>("SELECT id FROM stock_locations WHERE org_id = $1 AND code = 'MAIN'", [orgId]);
  locationId = loc[0]?.id as string;
});

afterAll(closePool);

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  }
  return undefined;
}

async function insertMovement(cols: { type: string; qty: number; value: number; sourceType?: string | null; sourceId?: string | null; reverses?: string | null; glAccountId?: string | null }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO stock_movements
       (org_id, movement_group_id, movement_type, item_id, location_id, quantity_milli, value_cents, occurred_on,
        created_by, source_type, source_id, reverses_movement_id, gl_account_id)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, '2026-03-01', $7, $8, $9, $10, $11) RETURNING id`,
    [orgId, cols.type, itemId, locationId, cols.qty, cols.value, user.id, cols.sourceType ?? null, cols.sourceId ?? null, cols.reverses ?? null, cols.glAccountId ?? null],
  );
  return rows[0]?.id as string;
}

describe('stock_items.ledger_item_id', () => {
  it('a product link cannot change once set', async () => {
    const code = await pgCode(() => pool.query('UPDATE stock_items SET ledger_item_id = gen_random_uuid() WHERE id = $1', [itemId]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
    const cleared = await pgCode(() => pool.query('UPDATE stock_items SET ledger_item_id = NULL WHERE id = $1', [itemId]));
    expect(cleared).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('two stock items in one organization cannot share a product', async () => {
    const { rows: cat } = await pool.query<{ id: string }>("SELECT category_id AS id FROM stock_items WHERE id = $1", [itemId]);
    const { rows: uom } = await pool.query<{ id: string }>('SELECT uom_id AS id FROM stock_items WHERE id = $1', [itemId]);
    const code = await pgCode(() =>
      pool.query(
        `INSERT INTO stock_items (org_id, code, name, category_id, item_type, tracking, uom_id, created_by, ledger_item_id)
         VALUES ($1, 'DUP-1', 'Dup', $2, 'TRADING_GOOD', 'QUANTITY', $3, $4, $5)`,
        [orgId, cat[0]?.id, uom[0]?.id, user.id, ledgerItemId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe('stock_movements provenance and reversal constraints', () => {
  it('source_type and source_id are all-or-nothing', async () => {
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT', qty: 1000, value: 100, sourceType: 'bill' }))).toBe(CHECK_VIOLATION);
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT', qty: 1000, value: 100, sourceId: '00000000-0000-4000-8000-000000000001' }))).toBe(CHECK_VIOLATION);
  });

  it('a reversal type requires reverses_movement_id, and a plain type forbids it', async () => {
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT_REVERSAL', qty: -1000, value: -100 }))).toBe(CHECK_VIOLATION);
    const original = await insertMovement({ type: 'RECEIPT', qty: 1000, value: 100 });
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT', qty: 1000, value: 100, reverses: original }))).toBe(CHECK_VIOLATION);
  });

  it('reversal signs are enforced: RECEIPT_REVERSAL is outbound, ISSUE_REVERSAL is inbound', async () => {
    const original = await insertMovement({ type: 'RECEIPT', qty: 1000, value: 100 });
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT_REVERSAL', qty: 1000, value: 100, reverses: original }))).toBe(CHECK_VIOLATION);
    expect(await pgCode(() => insertMovement({ type: 'ISSUE_REVERSAL', qty: -1000, value: -100, reverses: original }))).toBe(CHECK_VIOLATION);
  });

  it('a movement can be reversed only once', async () => {
    const original = await insertMovement({ type: 'RECEIPT', qty: 1000, value: 100 });
    await insertMovement({ type: 'RECEIPT_REVERSAL', qty: -1000, value: -100, reverses: original });
    expect(await pgCode(() => insertMovement({ type: 'RECEIPT_REVERSAL', qty: -1000, value: -100, reverses: original }))).toBe(UNIQUE_VIOLATION);
  });

  it('a reversal cannot point at a movement of another organization', async () => {
    const other = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    const agentB = await loginAgent(app, other);
    await agentB.post(`${STOCK}/setup`).send({ industryProfile: 'GENERAL' });
    const { rows: catB } = await pool.query<{ id: string }>("SELECT id FROM stock_categories WHERE org_id = $1 AND code = 'GEN'", [other.orgId]);
    const createdB = await agentB.post(`${STOCK}/items`).send({ name: 'Foreign', categoryId: catB[0]?.id, attributes: {} });
    const { rows: locB } = await pool.query<{ id: string }>("SELECT id FROM stock_locations WHERE org_id = $1 AND code = 'MAIN'", [other.orgId]);
    const { rows: foreign } = await pool.query<{ id: string }>(
      `INSERT INTO stock_movements (org_id, movement_group_id, movement_type, item_id, location_id, quantity_milli, value_cents, occurred_on, created_by)
       VALUES ($1, gen_random_uuid(), 'RECEIPT', $2, $3, 1000, 100, '2026-03-01', $4) RETURNING id`,
      [other.orgId, createdB.body.item.id, locB[0]?.id, other.id],
    );
    const code = await pgCode(() => insertMovement({ type: 'RECEIPT_REVERSAL', qty: -1000, value: -100, reverses: foreign[0]?.id ?? null }));
    expect(code).toBe('23503');
  });

  it('movements stay append-only, including the new columns', async () => {
    const id = await insertMovement({ type: 'RECEIPT', qty: 1000, value: 100 });
    expect(await pgCode(() => pool.query("UPDATE stock_movements SET source_type = 'bill' WHERE id = $1", [id]))).toBe(FEATURE_NOT_SUPPORTED);
    expect(await pgCode(() => pool.query('DELETE FROM stock_movements WHERE id = $1', [id]))).toBe(FEATURE_NOT_SUPPORTED);
  });
});

describe('stock_movements_reconcile_with_gl integrity check', () => {
  it('catches a GL-linked movement whose journal entry is missing', async () => {
    const { rows: acc } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE org_id = $1 AND code = '1140'", [orgId]);
    await insertMovement({
      type: 'RECEIPT',
      qty: 1000,
      value: 5000,
      sourceType: 'bill',
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      glAccountId: acc[0]?.id ?? null,
    });

    const report = await runIntegrityChecks();
    const check = report.checks.find((c) => c.name === 'stock_movements_reconcile_with_gl');
    expect(check?.passed).toBe(false);
    expect(check?.offenders[0]?.orgId).toBe(orgId);
    expect(check?.offenders[0]?.detail).toContain('5000');
    expect(report.passed).toBe(false);
  });

  it('ignores movements that never touched the GL', async () => {
    await insertMovement({ type: 'RECEIPT', qty: 1000, value: 5000 });
    const check = (await runIntegrityChecks()).checks.find((c) => c.name === 'stock_movements_reconcile_with_gl');
    expect(check?.passed).toBe(true);
  });
});

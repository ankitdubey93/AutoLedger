import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { canTransitionOrder, ORDER_STATUSES, type OrderStatus } from '../../types/accounting.js';

/**
 * Phase 42 (Slice F) — what migration 092 enforces in the database itself,
 * written as raw SQL so no service check can mask a missing constraint: the
 * party XOR, the completeness CHECKs, the frozen confirmed order, the
 * deferred over-billing cap, tenant-local FKs, the direction of a quote
 * back-link — and that the trigger's transition list matches ORDER_TRANSITIONS
 * exactly (rule 10), pair by pair.
 */

let userA: SeededUser;
let userB: SeededUser;

async function customerIn(orgId: string, name = 'Acme'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO customers (org_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, name],
  );
  return rows[0]!.id;
}

async function vendorIn(orgId: string, name = 'Supplier'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO vendors (org_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, name],
  );
  return rows[0]!.id;
}

async function accountIn(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  return rows[0]!.id;
}

/**
 * Inserts an order directly in `status`, with every column any status's
 * completeness CHECK could need — INSERT is not guarded by the trigger, so
 * this is how a test starts from any state.
 */
async function rawOrder(
  orgId: string,
  createdBy: string,
  status: OrderStatus,
  party: { customerId?: string; vendorId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const customerId = party.customerId ?? (party.vendorId === undefined ? await customerIn(orgId) : null);
  const direction = customerId === null ? 'PURCHASE' : 'SALES';
  await pool.query(
    `INSERT INTO orders
       (id, org_id, direction, customer_id, vendor_id, status, order_number, order_date, currency_code,
        party_name_snapshot, subtotal_cents, tax_cents, total_cents,
        confirmed_at, confirmed_by, closed_at, cancelled_at, cancel_reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-01', 'INR', 'Acme', 100, 0, 100,
             now(), $8, now(), now(), 'reason', $8)`,
    [id, orgId, direction, customerId, party.vendorId ?? null, status, `SO-${id.slice(0, 8)}`, createdBy],
  );
  return id;
}

/** A DRAFT order with one line of `quantityMilli`, then confirmed (lines freeze). Returns the line id. */
async function confirmedOrderWithLine(
  orgId: string,
  createdBy: string,
  quantityMilli: number,
  party: { customerId?: string; vendorId?: string } = {},
): Promise<{ orderId: string; lineId: string }> {
  const orderId = await rawOrder(orgId, createdBy, 'DRAFT', party);
  const account = await accountIn(orgId, party.vendorId === undefined ? '4100' : '5100');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO order_lines (org_id, order_id, line_number, description, quantity_milli, unit_price_cents,
                              account_id, net_cents, tax_cents)
     VALUES ($1, $2, 1, 'Widget', $3, 100, $4, 100, 0) RETURNING id`,
    [orgId, orderId, quantityMilli, account],
  );
  await pool.query("UPDATE orders SET status = 'CONFIRMED' WHERE id = $1", [orderId]);
  return { orderId, lineId: rows[0]!.id };
}

async function insertInvoiceWithLine(
  orgId: string,
  createdBy: string,
  customerId: string,
  orderLineId: string | null,
  quantityMilli: number,
  client: { query: typeof pool.query } = pool,
): Promise<string> {
  const account = await accountIn(orgId, '4100');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO invoices (org_id, customer_id, issue_date, due_date, currency_code, customer_name_snapshot, created_by)
     VALUES ($1, $2, '2026-10-01', '2026-10-31', 'INR', 'Acme', $3) RETURNING id`,
    [orgId, customerId, createdBy],
  );
  const invoiceId = rows[0]!.id;
  await client.query(
    `INSERT INTO invoice_lines (org_id, invoice_id, line_number, description, quantity_milli, unit_price_cents,
                                revenue_account_id, net_cents, tax_cents, order_line_id)
     VALUES ($1, $2, 1, 'Widget', $3, 100, $4, 100, 0, $5)`,
    [orgId, invoiceId, quantityMilli, account, orderLineId],
  );
  return invoiceId;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('orders — schema constraints', () => {
  it('party XOR per direction', async () => {
    const customerId = await customerIn(userA.orgId);
    const vendorId = await vendorIn(userA.orgId);
    const insert = (direction: string, cust: string | null, vend: string | null) =>
      pool.query(
        `INSERT INTO orders (org_id, direction, customer_id, vendor_id, order_date, currency_code,
                             party_name_snapshot, created_by)
         VALUES ($1, $2, $3, $4, '2026-10-01', 'INR', 'x', $5)`,
        [userA.orgId, direction, cust, vend, userA.id],
      );
    await expect(insert('SALES', customerId, vendorId)).rejects.toMatchObject({ constraint: 'ck_orders_party' });
    await expect(insert('SALES', null, vendorId)).rejects.toMatchObject({ constraint: 'ck_orders_party' });
    await expect(insert('PURCHASE', customerId, null)).rejects.toMatchObject({ constraint: 'ck_orders_party' });
    await expect(insert('PURCHASE', null, null)).rejects.toMatchObject({ constraint: 'ck_orders_party' });
    await insert('SALES', customerId, null);
    await insert('PURCHASE', null, vendorId);
  });

  it("a confirmed order needs number, confirmed_at, confirmed_by", async () => {
    const customerId = await customerIn(userA.orgId);
    await expect(
      pool.query(
        `INSERT INTO orders (org_id, direction, customer_id, status, order_date, currency_code,
                             party_name_snapshot, created_by)
         VALUES ($1, 'SALES', $2, 'CONFIRMED', '2026-10-01', 'INR', 'x', $3)`,
        [userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_orders_confirmed_complete' });
    await expect(
      pool.query(
        `INSERT INTO orders (org_id, direction, customer_id, status, order_number, confirmed_at, order_date,
                             currency_code, party_name_snapshot, created_by)
         VALUES ($1, 'SALES', $2, 'CONFIRMED', 'SO-1', now(), '2026-10-01', 'INR', 'x', $3)`,
        [userA.orgId, customerId, userA.id],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_orders_confirmed_complete' });
  });

  it("a confirmed order's money and lines cannot change", async () => {
    const { orderId } = await confirmedOrderWithLine(userA.orgId, userA.id, 5000);
    for (const set of ['total_cents = 5, subtotal_cents = 5', "party_name_snapshot = 'Other'", "terms = 'new terms'"]) {
      await expect(pool.query(`UPDATE orders SET ${set} WHERE id = $1`, [orderId])).rejects.toMatchObject({
        code: '0A000',
      });
    }
    await expect(pool.query('DELETE FROM orders WHERE id = $1', [orderId])).rejects.toMatchObject({ code: '0A000' });
    const account = await accountIn(userA.orgId, '4100');
    await expect(
      pool.query(
        `INSERT INTO order_lines (org_id, order_id, line_number, description, quantity_milli, unit_price_cents,
                                  account_id, net_cents, tax_cents)
         VALUES ($1, $2, 2, 'x', 1000, 100, $3, 100, 0)`,
        [userA.orgId, orderId, account],
      ),
    ).rejects.toMatchObject({ code: '0A000' });
    await expect(pool.query('UPDATE order_lines SET quantity_milli = 1 WHERE order_id = $1', [orderId])).rejects.toMatchObject({
      code: '0A000',
    });
    await expect(pool.query('DELETE FROM order_lines WHERE order_id = $1', [orderId])).rejects.toMatchObject({
      code: '0A000',
    });
  });

  it('the trigger allows exactly ORDER_TRANSITIONS (4×4 parity walk)', async () => {
    const mismatches: string[] = [];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue;
        const id = await rawOrder(userA.orgId, userA.id, from);
        let allowed = true;
        try {
          await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, to]);
        } catch {
          allowed = false;
        }
        if (allowed !== canTransitionOrder(from, to)) mismatches.push(`${from}→${to} db=${String(allowed)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('order billing cap', () => {
  it('an invoice line linked beyond the ordered quantity fails at COMMIT (deferred) with P0001', async () => {
    const customerId = await customerIn(userA.orgId);
    const { lineId } = await confirmedOrderWithLine(userA.orgId, userA.id, 5000, { customerId });

    // Within the cap: 5 of 5.
    await insertInvoiceWithLine(userA.orgId, userA.id, customerId, lineId, 5000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The statement itself succeeds — the check is deferred …
      await insertInvoiceWithLine(userA.orgId, userA.id, customerId, lineId, 1000, client);
      // … and the transaction is refused when it commits.
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const { rows } = await pool.query(
      'SELECT COALESCE(SUM(quantity_milli), 0)::int AS q FROM invoice_lines WHERE order_line_id = $1',
      [lineId],
    );
    expect(rows[0]!.q).toBe(5000);
  });

  it("a VOID invoice's lines stop counting toward the cap", async () => {
    const customerId = await customerIn(userA.orgId);
    const { lineId } = await confirmedOrderWithLine(userA.orgId, userA.id, 5000, { customerId });
    const first = await insertInvoiceWithLine(userA.orgId, userA.id, customerId, lineId, 5000);
    // Full — a further 1 is refused.
    await expect(insertInvoiceWithLine(userA.orgId, userA.id, customerId, lineId, 1000)).rejects.toMatchObject({
      code: 'P0001',
    });
    await pool.query("UPDATE invoices SET status = 'VOID', voided_at = now() WHERE id = $1", [first]);
    // The voided quantity is released.
    await insertInvoiceWithLine(userA.orgId, userA.id, customerId, lineId, 5000);
  });

  it("a purchase order's line cannot be linked from an invoice of another org (composite FK)", async () => {
    const vendorId = await vendorIn(userA.orgId);
    const { lineId } = await confirmedOrderWithLine(userA.orgId, userA.id, 5000, { vendorId });
    const customerB = await customerIn(userB.orgId);
    await expect(insertInvoiceWithLine(userB.orgId, userB.id, customerB, lineId, 1000)).rejects.toMatchObject({
      constraint: 'fk_invoice_lines_order_line',
    });
  });
});

describe('orders — quote back-link', () => {
  it('a sales quote cannot be the source of a purchase order (direction FK)', async () => {
    const customerId = await customerIn(userA.orgId);
    const vendorId = await vendorIn(userA.orgId);
    const quoteId = randomUUID();
    await pool.query(
      `INSERT INTO quotes (id, org_id, direction, customer_id, root_quote_id, quote_date, valid_until,
                           currency_code, party_name_snapshot, created_by)
       VALUES ($1, $2, 'SALES', $3, $1, '2026-10-01', '2026-10-31', 'INR', 'x', $4)`,
      [quoteId, userA.orgId, customerId, userA.id],
    );
    const insert = (sourceDirection: string) =>
      pool.query(
        `INSERT INTO orders (org_id, direction, vendor_id, order_date, currency_code, party_name_snapshot,
                             created_by, source_quote_id, source_quote_direction)
         VALUES ($1, 'PURCHASE', $2, '2026-10-01', 'INR', 'x', $3, $4, $5)`,
        [userA.orgId, vendorId, userA.id, quoteId, sourceDirection],
      );
    // The CHECK pins the source direction to the order's own …
    await expect(insert('SALES')).rejects.toMatchObject({ constraint: 'ck_orders_source_quote' });
    // … and the composite FK refuses a PURCHASE claim about a SALES quote.
    await expect(insert('PURCHASE')).rejects.toMatchObject({ constraint: 'fk_orders_source_quote' });
  });
});

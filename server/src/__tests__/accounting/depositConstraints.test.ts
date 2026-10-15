import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import {
  applyDepositRequest,
  confirmedOrder,
  issuedDeposit,
  issuedFinalDocument,
  payDocument,
  requestDeposit,
} from '../helpers/depositFixtures.js';

/**
 * Phase 42 (Slice G) — what migration 093 enforces in the database itself,
 * written as raw SQL so no service check can mask a missing constraint.
 * Assertions name the constraint (or trigger message), never just "it threw".
 */

const app = createApp();

let user: SeededUser;
let agent: Agent;
let customerId: string;

async function insertApplication(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = {
    direction: 'SALES',
    deposit_invoice_id: randomUUID(),
    target_invoice_id: randomUUID(),
    deposit_bill_id: null,
    target_bill_id: null,
    amount_cents: 100,
    base_amount_cents: 100,
    ...overrides,
  };
  // CHECK constraints are evaluated before the (AFTER-trigger) foreign keys,
  // so random ids are enough to reach the CHECK under test.
  await pool.query(
    `INSERT INTO deposit_applications
       (org_id, direction, deposit_invoice_id, target_invoice_id, deposit_bill_id, target_bill_id,
        amount_cents, base_amount_cents, application_date, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-10-01', $9, $10)`,
    [
      user.orgId,
      row.direction,
      row.deposit_invoice_id,
      row.target_invoice_id,
      row.deposit_bill_id,
      row.target_bill_id,
      row.amount_cents,
      row.base_amount_cents,
      randomUUID(),
      user.id,
    ],
  );
}

/** A real POSTED application, built through the API. */
async function realApplication(): Promise<string> {
  const order = await confirmedOrder(agent, user.orgId, 'SALES', customerId);
  const deposit = await issuedDeposit(agent, 'SALES', order.id, { amountCents: 30_000 });
  await payDocument(agent, user.orgId, 'SALES', customerId, deposit, 30_000);
  const final = await issuedFinalDocument(agent, 'SALES', order.id);
  const applied = await applyDepositRequest(agent, 'SALES', final, deposit, 30_000);
  if (applied.status !== 201) throw new Error(`fixture: apply failed ${applied.status} ${applied.text}`);
  return applied.body.application.id as string;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  agent = await loginAgent(app, user);
  customerId = await createCustomer(agent, 'Acme Fitouts', 'buyer@acme.test');
});

afterAll(closePool);

describe('deposit_applications — constraints', () => {
  it('shape CHECK per direction', async () => {
    // SALES naming a bill instead of an invoice.
    await expect(
      insertApplication({ deposit_invoice_id: null, target_invoice_id: null, deposit_bill_id: randomUUID(), target_bill_id: randomUUID() }),
    ).rejects.toThrow(/ck_deposit_applications_shape/);
    // SALES carrying both an invoice pair and a bill pair.
    await expect(insertApplication({ deposit_bill_id: randomUUID(), target_bill_id: randomUUID() })).rejects.toThrow(
      /ck_deposit_applications_shape/,
    );
    // PURCHASE naming invoices.
    await expect(insertApplication({ direction: 'PURCHASE' })).rejects.toThrow(/ck_deposit_applications_shape/);
    // SALES missing its target.
    await expect(insertApplication({ target_invoice_id: null })).rejects.toThrow(/ck_deposit_applications_shape/);
  });

  it('base_amount_cents must equal amount_cents', async () => {
    // The table-level CHECK is unnamed in migration 093, so PostgreSQL names it
    // deposit_applications_check (the column CHECKs carry their column names).
    await expect(insertApplication({ amount_cents: 100, base_amount_cents: 101 })).rejects.toThrow(
      /violates check constraint "deposit_applications_check"/,
    );
  });

  it('a POSTED application cannot be edited or deleted; POSTED->VOID changes only the void columns', async () => {
    const id = await realApplication();

    await expect(pool.query('UPDATE deposit_applications SET amount_cents = 1 WHERE id = $1', [id])).rejects.toThrow(
      /is POSTED|immutable|may not change/,
    );
    await expect(pool.query('DELETE FROM deposit_applications WHERE id = $1', [id])).rejects.toThrow(/cannot be deleted/);

    // A void that also edits the amount is refused by the whole-row diff.
    const { rows } = await pool.query<{ journal_entry_id: string }>(
      'SELECT journal_entry_id FROM deposit_applications WHERE id = $1',
      [id],
    );
    await expect(
      pool.query(
        `UPDATE deposit_applications
            SET status = 'VOID', voided_at = now(), void_journal_entry_id = $2, amount_cents = 1, base_amount_cents = 1
          WHERE id = $1`,
        [id, rows[0]!.journal_entry_id],
      ),
    ).rejects.toThrow(/may not change any other field/);

    // The row is untouched.
    const after = await pool.query<{ status: string; amount_cents: string }>(
      'SELECT status, amount_cents::text FROM deposit_applications WHERE id = $1',
      [id],
    );
    expect(after.rows[0]).toEqual({ status: 'POSTED', amount_cents: '30000' });

    // A genuine void through the API is the one allowed transition, and VOID is terminal.
    const voided = await agent.post(`/api/v1/deposit-applications/sales/${id}/void`).send({});
    expect(voided.status).toBe(200);
    await expect(pool.query("UPDATE deposit_applications SET status = 'POSTED' WHERE id = $1", [id])).rejects.toThrow(
      /is immutable|ck_deposit_applications_void/,
    );
  });

  it('a DEPOSIT invoice needs deposit_for_order_id', async () => {
    const order = await confirmedOrder(agent, user.orgId, 'SALES', customerId);
    const created = await requestDeposit(agent, 'SALES', order.id, { percentBp: 3000 });
    expect(created.status).toBe(201);

    // The deposit invoice carries its order; a STANDARD draft cannot be turned into one without it.
    const standard = await agent.post('/api/v1/invoices').send({
      customerId,
      issueDate: '2026-10-01',
      dueDate: '2026-10-31',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'x',
          quantityMilli: 1000,
          unitPriceCents: 100,
          revenueAccountId: (
            await pool.query<{ id: string }>("SELECT id FROM accounts WHERE org_id = $1 AND code = '4100'", [user.orgId])
          ).rows[0]!.id,
          taxRateBp: 0,
        },
      ],
    });
    expect(standard.status).toBe(201);
    await expect(
      pool.query("UPDATE invoices SET kind = 'DEPOSIT' WHERE id = $1 AND org_id = $2", [
        standard.body.invoice.id,
        user.orgId,
      ]),
    ).rejects.toThrow(/ck_invoices_deposit_order/);
    // And an order id on a STANDARD invoice is refused by the same CHECK.
    await expect(
      pool.query('UPDATE invoices SET deposit_for_order_id = $3 WHERE id = $1 AND org_id = $2', [
        standard.body.invoice.id,
        user.orgId,
        order.id,
      ]),
    ).rejects.toThrow(/ck_invoices_deposit_order/);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — item catalogue references on invoice and bill lines
 * (Phase 24). Integration tier, real PostgreSQL. Includes this app's own
 * cross-tenant isolation case (rule 15).
 */

const app = createApp();
const ITEMS_BASE = '/api/v1/ledger-core/items';
const INVOICES_BASE = '/api/v1/ledger-core/invoices';
const BILLS_BASE = '/api/v1/ledger-core/bills';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function createCustomer(agent: import('supertest').Agent): Promise<string> {
  const res = await agent.post('/api/v1/ledger-core/customers').send({ name: 'Northwind Traders' });
  return res.body.customer.id as string;
}

async function createVendor(agent: import('supertest').Agent): Promise<string> {
  const res = await agent.post('/api/v1/ledger-core/vendors').send({ name: 'Acme Supplies' });
  return res.body.vendor.id as string;
}

describe('item references on invoice lines', () => {
  it('an invoice line records its itemId', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccount = await accountId(orgA, '4100');
    const item = await agent.post(ITEMS_BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      salePriceCents: 15000,
      revenueAccountId: revenueAccount,
    });
    const customerId = await createCustomer(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Consulting hour',
          quantityMilli: 1000,
          unitPriceCents: 15000,
          revenueAccountId: revenueAccount,
          itemId: item.body.item.id,
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.lines[0].itemId).toBe(item.body.item.id);
  });

  it('an invoice line with a null itemId is still legal', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccount = await accountId(orgA, '4100');
    const customerId = await createCustomer(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        { description: 'Ad-hoc work', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId: revenueAccount },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.lines[0].itemId).toBeNull();
  });

  it('a bill line records its itemId', async () => {
    const agent = await loginAgent(app, userA);
    const expenseAccount = await accountId(orgA, '6100');
    const item = await agent.post(ITEMS_BASE).send({
      code: 'SUPPLIES',
      name: 'Office supplies',
      kind: 'GOODS',
      purchasePriceCents: 2000,
      expenseAccountId: expenseAccount,
    });
    const vendorId = await createVendor(agent);

    const res = await agent.post(BILLS_BASE).send({
      vendorId,
      vendorReference: 'INV-001',
      billDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Office supplies',
          quantityMilli: 1000,
          unitPriceCents: 2000,
          expenseAccountId: expenseAccount,
          itemId: item.body.item.id,
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.bill.lines[0].itemId).toBe(item.body.item.id);
  });

  it('an item referenced by a line cannot be deleted', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccount = await accountId(orgA, '4100');
    const item = await agent.post(ITEMS_BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      revenueAccountId: revenueAccount,
    });
    const customerId = await createCustomer(agent);

    await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Consulting hour',
          quantityMilli: 1000,
          unitPriceCents: 15000,
          revenueAccountId: revenueAccount,
          itemId: item.body.item.id,
        },
      ],
    });

    await expect(
      pool.query('DELETE FROM items WHERE id = $1 AND org_id = $2', [item.body.item.id, orgA]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('cross-tenant isolation on line item references', () => {
  it('an invoice line cannot reference another organization item', async () => {
    const agentC = await loginAgent(app, userC);
    const orgBRevenueAccount = await accountId(orgB, '4100');
    const orgBItem = await agentC.post(ITEMS_BASE).send({
      code: 'FOREIGN',
      name: 'Foreign item',
      kind: 'SERVICE',
      revenueAccountId: orgBRevenueAccount,
    });

    const agentA = await loginAgent(app, userA);
    const orgARevenueAccount = await accountId(orgA, '4100');
    const customerId = await createCustomer(agentA);

    const res = await agentA.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Cross-org line',
          quantityMilli: 1000,
          unitPriceCents: 15000,
          revenueAccountId: orgARevenueAccount,
          itemId: orgBItem.body.item.id,
        },
      ],
    });

    expect(res.status).toBe(422);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM invoices WHERE org_id = $1', [orgA]);
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Server-side sorting of the invoice and bill lists (2026-09-30):
 * `?sort=<key>&dir=asc|desc`, whitelisted per list. Sorting has to happen on
 * the server for these two — they are paginated, and sorting one page in the
 * browser would sort the wrong rows.
 */

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>;

let user: SeededUser;
let agent: Agent;

async function accountId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [user.orgId, code]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`fixture: no account ${code}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'sorter' });
  agent = await loginAgent(app, user);
});

afterAll(closePool);

describe('GET /invoices sorting', () => {
  async function seedInvoices(): Promise<void> {
    const revenueAccountId = await accountId('4100');
    const rows = [
      { name: 'Beta Co', cents: 30000, issueDate: '2026-06-02' },
      { name: 'Alpha Co', cents: 10000, issueDate: '2026-06-03' },
      { name: 'Gamma Co', cents: 20000, issueDate: '2026-06-01' },
    ];
    for (const row of rows) {
      const customer = await agent.post('/api/v1/customers').send({ name: row.name });
      const created = await agent.post('/api/v1/invoices').send({
        customerId: customer.body.customer.id,
        issueDate: row.issueDate,
        dueDate: '2026-06-30',
        lines: [{ description: 'Work', quantityMilli: 1000, unitPriceCents: row.cents, revenueAccountId }],
      });
      expect(created.status).toBe(201);
    }
  }

  it('defaults to newest issue date first, unchanged from before', async () => {
    await seedInvoices();
    const res = await agent.get('/api/v1/invoices');
    expect(res.body.invoices.map((i: { issueDate: string }) => i.issueDate)).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });

  it('sorts by total and by customer, in either direction', async () => {
    await seedInvoices();
    const byTotal = await agent.get('/api/v1/invoices?sort=total&dir=asc');
    expect(byTotal.body.invoices.map((i: { totalCents: number }) => i.totalCents)).toEqual([10000, 20000, 30000]);

    const byCustomer = await agent.get('/api/v1/invoices?sort=customer&dir=desc');
    expect(byCustomer.body.invoices.map((i: { customerNameSnapshot: string }) => i.customerNameSnapshot)).toEqual([
      'Gamma Co',
      'Beta Co',
      'Alpha Co',
    ]);
  });

  it('sorts across pages, not within one', async () => {
    await seedInvoices();
    const page1 = await agent.get('/api/v1/invoices?sort=total&dir=desc&limit=2&page=1');
    const page2 = await agent.get('/api/v1/invoices?sort=total&dir=desc&limit=2&page=2');
    expect(page1.body.invoices.map((i: { totalCents: number }) => i.totalCents)).toEqual([30000, 20000]);
    expect(page2.body.invoices.map((i: { totalCents: number }) => i.totalCents)).toEqual([10000]);
  });

  it('refuses a sort key or direction outside the whitelist', async () => {
    const badKey = await agent.get('/api/v1/invoices?sort=total_cents;DROP TABLE invoices');
    expect(badKey.status).toBe(400);
    expect(badKey.body.error).toMatch(/sort must be one of/);
    const badDir = await agent.get('/api/v1/invoices?sort=total&dir=sideways');
    expect(badDir.status).toBe(400);
  });
});

describe('GET /bills sorting', () => {
  it('sorts by vendor reference and by total', async () => {
    const expenseAccountId = await accountId('6130');
    const vendor = await agent.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
    for (const [reference, cents] of [
      ['REF-B', 5000],
      ['REF-C', 1000],
      ['REF-A', 3000],
    ] as const) {
      const created = await agent.post('/api/v1/bills').send({
        vendorId: vendor.body.vendor.id,
        vendorReference: reference,
        billDate: '2026-06-01',
        dueDate: '2026-06-30',
        lines: [{ description: 'Supplies', quantityMilli: 1000, unitPriceCents: cents, expenseAccountId }],
      });
      expect(created.status).toBe(201);
    }

    const byRef = await agent.get('/api/v1/bills?sort=reference&dir=asc');
    expect(byRef.body.bills.map((b: { vendorReference: string }) => b.vendorReference)).toEqual(['REF-A', 'REF-B', 'REF-C']);
    const byTotal = await agent.get('/api/v1/bills?sort=total&dir=desc');
    expect(byTotal.body.bills.map((b: { totalCents: number }) => b.totalCents)).toEqual([5000, 3000, 1000]);

    expect((await agent.get('/api/v1/bills?sort=nope')).status).toBe(400);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — sales invoices (Phase 3.8). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors journals.test.ts's shape — userA (org A only), userC (org B only).
 */

const app = createApp();
const INVOICES = '/api/v1/ledger-core/invoices';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const JOURNALS = '/api/v1/ledger-core/journals';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function createCustomer(agent: Agent, name = 'Northwind Traders'): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  return res.body.customer.id as string;
}

/** One line: qty 2.5 @ 100.00 (10000 cents), tax 18% -> net 25000, tax 4500, total 29500. */
function invoicePayload(overrides: {
  customerId: string;
  revenueAccountId: string;
  issueDate?: string;
  dueDate?: string;
}) {
  return {
    customerId: overrides.customerId,
    issueDate: overrides.issueDate ?? '2026-06-01',
    dueDate: overrides.dueDate ?? '2026-06-30',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting hours',
        quantityMilli: 2500,
        unitPriceCents: 10000,
        revenueAccountId: overrides.revenueAccountId,
        taxRateBp: 1800,
      },
    ],
  };
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('POST /ledger-core/invoices', () => {
  it('creates a draft with computed totals', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('DRAFT');
    expect(res.body.invoice.invoiceNumber).toBeNull();
    expect(res.body.invoice.subtotalCents).toBe(25000);
    expect(res.body.invoice.taxCents).toBe(4500);
    expect(res.body.invoice.totalCents).toBe(29500);
  });

  it('rejects a header revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const headerAccountId = await accountId(orgA, '4000');

    const res = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId: headerAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account 4000 is a header account and cannot be posted to');
  });

  it('rejects a non-Revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const expenseAccountId = await accountId(orgA, '6120');

    const res = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId: expenseAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account 6120 is not a Revenue account');
  });

  it('rejects a due date before the issue date', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent.post(INVOICES).send(
      invoicePayload({
        customerId,
        revenueAccountId,
        issueDate: '2026-06-10',
        dueDate: '2026-06-01',
      }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Due date cannot be before the issue date');
  });

  it('rejects zero lines', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);

    const res = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
      notes: null,
      paymentTerms: null,
      lines: [],
    });

    expect(res.status).toBe(400);
  });

  it('rejects another org customerId with 422', async () => {
    const agentA = await loginAgent(app, userA);
    const agentC = await loginAgent(app, userC);
    const foreignCustomerId = await createCustomer(agentC);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agentA
      .post(INVOICES)
      .send(invoicePayload({ customerId: foreignCustomerId, revenueAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Customer not found');
  });

  it('rejects another org revenueAccountId with 422', async () => {
    const agentA = await loginAgent(app, userA);
    const customerId = await createCustomer(agentA);
    const foreignAccountId = await accountId(orgB, '4100');

    const res = await agentA
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId: foreignAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Revenue account not found');
  });

  it('is rejected for a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'eve', orgName: 'Org Eve' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agentOwner = await loginAgent(app, userA);
    const customerId = await createCustomer(agentOwner);
    const revenueAccountId = await accountId(orgA, '4100');

    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));

    expect(res.status).toBe(403);
  });
});

describe('PATCH and DELETE /ledger-core/invoices/:id — draft only', () => {
  it('PATCH replaces a draft lines', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const res = await agent.patch(`${INVOICES}/${invoiceId}`).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Retainer',
          quantityMilli: 1000,
          unitPriceCents: 5000,
          revenueAccountId,
          taxRateBp: 0,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.invoice.lines).toHaveLength(1);
    expect(res.body.invoice.lines[0].description).toBe('Retainer');
    expect(res.body.invoice.subtotalCents).toBe(5000);
  });

  it('DELETE removes a draft', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const deleteRes = await agent.delete(`${INVOICES}/${invoiceId}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await agent.get(`${INVOICES}/${invoiceId}`);
    expect(getRes.status).toBe(404);
  });

  it('PATCH on an issued invoice returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    const res = await agent.patch(`${INVOICES}/${invoiceId}`).send(
      invoicePayload({ customerId, revenueAccountId }),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only a draft invoice can be edited');
  });

  it('DELETE on an issued invoice returns 409', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    const res = await agent.delete(`${INVOICES}/${invoiceId}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only a draft invoice can be deleted');
  });
});

describe('POST /ledger-core/invoices/:id/issue', () => {
  it('allocates a number and posts a balanced entry', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const res = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    expect(res.status).toBe(200);
    expect(res.body.invoice.invoiceNumber).toBe('INV-000001');
    expect(res.body.invoice.status).toBe('ISSUED');
    expect(res.body.invoice.journalEntryId).not.toBeNull();

    const journalRes = await agent.get(`${JOURNALS}/${res.body.invoice.journalEntryId}`);
    expect(journalRes.body.entry.sourceType).toBe('invoice');
    expect(journalRes.body.entry.sourceId).toBe(invoiceId);
    expect(journalRes.body.entry.totalDebitCents).toBe(29500);
    expect(journalRes.body.entry.totalCreditCents).toBe(29500);
  });

  it("debits receivable and credits revenue and tax", async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const issueRes = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    const journalRes = await agent.get(`${JOURNALS}/${issueRes.body.invoice.journalEntryId}`);
    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
    }[];

    const receivable = lines.find((l) => l.accountCode === '1120');
    const revenue = lines.find((l) => l.accountCode === '4100');
    const tax = lines.find((l) => l.accountCode === '2140');

    expect(receivable?.debitCents).toBe(29500);
    expect(revenue?.creditCents).toBe(25000);
    expect(tax?.creditCents).toBe(4500);
  });

  it('allocates the next number on a second invoice', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const first = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    await agent.post(`${INVOICES}/${first.body.invoice.id}/issue`).send({});

    const second = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    const secondIssue = await agent.post(`${INVOICES}/${second.body.invoice.id}/issue`).send({});

    expect(secondIssue.body.invoice.invoiceNumber).toBe('INV-000002');
  });

  it('rejects issuing the same invoice twice', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    const res = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    expect(res.status).toBe(409);
  });

  it('another org invoice id returns 404 and leaves it DRAFT', async () => {
    const agentA = await loginAgent(app, userA);
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agentA
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const agentC = await loginAgent(app, userC);
    const res = await agentC.post(`${INVOICES}/${invoiceId}/issue`).send({});
    expect(res.status).toBe(404);

    const readBack = await agentA.get(`${INVOICES}/${invoiceId}`);
    expect(readBack.body.invoice.status).toBe('DRAFT');
  });
});

describe('POST /ledger-core/invoices/:id/void', () => {
  it('on an issued invoice posts a reversal', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;
    const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    const journalEntryId = issued.body.invoice.journalEntryId as string;

    const res = await agent.post(`${INVOICES}/${invoiceId}/void`).send({});

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOID');
    expect(res.body.invoice.voidJournalEntryId).not.toBeNull();

    const reversalRes = await agent.get(`${JOURNALS}/${res.body.invoice.voidJournalEntryId}`);
    expect(reversalRes.body.entry.reversesEntryId).toBe(journalEntryId);

    const trialBalanceRes = await agent.get('/api/v1/ledger-core/reports/trial-balance');
    expect(trialBalanceRes.body.isBalanced).toBe(true);
    const receivableRow = trialBalanceRes.body.rows.find(
      (r: { code: string }) => r.code === '1120',
    );
    expect(receivableRow?.netBalanceCents ?? 0).toBe(0);
  });

  it('on a draft posts no journal entry', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;

    const before = await agent.get(JOURNALS);
    const res = await agent.post(`${INVOICES}/${invoiceId}/void`).send({});
    const after = await agent.get(JOURNALS);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('VOID');
    expect(res.body.invoice.journalEntryId).toBeNull();
    expect(res.body.invoice.voidJournalEntryId).toBeNull();
    expect(after.body.totalCount).toBe(before.body.totalCount);
  });

  it('rejects voiding the same invoice twice', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/void`).send({});

    const res = await agent.post(`${INVOICES}/${invoiceId}/void`).send({});

    expect(res.status).toBe(409);
  });
});

describe('GET /ledger-core/invoices — filtering and isolation', () => {
  it('?status=ISSUED filters and totalCount matches', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const draft = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    const issued = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    await agent.post(`${INVOICES}/${issued.body.invoice.id}/issue`).send({});
    void draft;

    const res = await agent.get(`${INVOICES}?status=ISSUED`);

    expect(res.body.totalCount).toBe(1);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].status).toBe('ISSUED');
  });

  it('GET /:id with another org invoice id returns 404', async () => {
    const agentA = await loginAgent(app, userA);
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agentA
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId }));

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(`${INVOICES}/${created.body.invoice.id}`);

    expect(res.status).toBe(404);
  });

  it('never returns another org invoices', async () => {
    const agentA = await loginAgent(app, userA);
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agentA.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    await agentA.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(INVOICES);

    expect(res.body.invoices).toHaveLength(0);
    expect(orgB).not.toBe(orgA);
  });
});

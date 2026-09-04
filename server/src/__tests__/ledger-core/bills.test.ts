import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — bills (Phase 3.9). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors invoices.test.ts's shape — userA (org A only), userC (org B only).
 */

const app = createApp();
const BILLS = '/api/v1/ledger-core/bills';
const VENDORS = '/api/v1/ledger-core/vendors';
const JOURNALS = '/api/v1/ledger-core/journals';
const PAYMENTS = '/api/v1/ledger-core/payments';

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

async function createVendor(agent: Agent, name = 'Acme Supplies'): Promise<string> {
  const res = await agent.post(VENDORS).send({ name });
  return res.body.vendor.id as string;
}

/** One line: qty 2.5 @ 100.00 (10000 cents), tax 18% -> net 25000, tax 4500, total 29500. */
function billPayload(overrides: {
  vendorId: string;
  expenseAccountId: string;
  vendorReference?: string;
  billDate?: string;
  dueDate?: string;
}) {
  return {
    vendorId: overrides.vendorId,
    vendorReference: overrides.vendorReference ?? 'VEND-001',
    billDate: overrides.billDate ?? '2026-06-01',
    dueDate: overrides.dueDate ?? '2026-06-30',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Office supplies',
        quantityMilli: 2500,
        unitPriceCents: 10000,
        expenseAccountId: overrides.expenseAccountId,
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

describe('POST /ledger-core/bills', () => {
  it('creates a draft with computed totals', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');

    const res = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));

    expect(res.status).toBe(201);
    expect(res.body.bill.status).toBe('DRAFT');
    expect(res.body.bill.subtotalCents).toBe(25000);
    expect(res.body.bill.taxCents).toBe(4500);
    expect(res.body.bill.totalCents).toBe(29500);
  });

  it('sums per-line tax across two different rates, never tax on the subtotal', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');

    const res = await agent.post(BILLS).send({
      vendorId,
      vendorReference: 'VEND-002',
      billDate: '2026-06-01',
      dueDate: '2026-06-30',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Line at 10%',
          quantityMilli: 1000,
          unitPriceCents: 10000,
          expenseAccountId,
          taxRateBp: 1000,
        },
        {
          description: 'Line at 20%',
          quantityMilli: 1000,
          unitPriceCents: 10000,
          expenseAccountId,
          taxRateBp: 2000,
        },
      ],
    });

    expect(res.status).toBe(201);
    // net: 10000 + 10000 = 20000; tax: 1000 (10%) + 2000 (20%) = 3000
    expect(res.body.bill.subtotalCents).toBe(20000);
    expect(res.body.bill.taxCents).toBe(3000);
    expect(res.body.bill.totalCents).toBe(23000);
  });

  it('rejects a duplicate vendor reference for the same vendor', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');

    await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const res = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));

    expect(res.status).toBe(409);
  });

  it('rejects a Revenue expense account', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent
      .post(BILLS)
      .send(billPayload({ vendorId, expenseAccountId: revenueAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('must be an Expense or Asset account');
  });

  it('rejects a header account', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const headerAccountId = await accountId(orgA, '6000');

    const res = await agent
      .post(BILLS)
      .send(billPayload({ vendorId, expenseAccountId: headerAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('header account');
  });

  it('rejects a due date before the bill date', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');

    const res = await agent.post(BILLS).send(
      billPayload({ vendorId, expenseAccountId, billDate: '2026-06-10', dueDate: '2026-06-01' }),
    );

    expect(res.status).toBe(422);
  });

  it('rejects another org vendorId with 422', async () => {
    const agentA = await loginAgent(app, userA);
    const agentC = await loginAgent(app, userC);
    const foreignVendorId = await createVendor(agentC);
    const expenseAccountId = await accountId(orgA, '6130');

    const res = await agentA
      .post(BILLS)
      .send(billPayload({ vendorId: foreignVendorId, expenseAccountId }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Vendor not found');
  });

  it('rejects another org expenseAccountId with 422', async () => {
    const agentA = await loginAgent(app, userA);
    const vendorId = await createVendor(agentA);
    const foreignAccountId = await accountId(orgB, '6130');

    const res = await agentA.post(BILLS).send(billPayload({ vendorId, expenseAccountId: foreignAccountId }));

    expect(res.status).toBe(422);
  });
});

describe('POST /ledger-core/bills/:id/submit', () => {
  it('moves DRAFT to AWAITING_APPROVAL', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;

    const res = await agent.post(`${BILLS}/${billId}/submit`).send({});

    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('AWAITING_APPROVAL');
    expect(res.body.bill.submittedAt).not.toBeNull();
  });

  it('allows a PATCH while AWAITING_APPROVAL — the recall/correct path', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});

    const res = await agent.patch(`${BILLS}/${billId}`).send(
      billPayload({ vendorId, expenseAccountId, vendorReference: 'VEND-001' }),
    );

    expect(res.status).toBe(200);
  });
});

describe('POST /ledger-core/bills/:id/approve', () => {
  it('is rejected for an ACCOUNTANT', async () => {
    const accountant = await createUserWithOrg({ label: 'bob', orgName: 'Org Bob' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const ownerAgent = await loginAgent(app, userA);
    const vendorId = await createVendor(ownerAgent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await ownerAgent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await ownerAgent.post(`${BILLS}/${billId}/submit`).send({});

    const agent = await loginAgent(app, accountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(`${BILLS}/${billId}/approve`).send({});

    expect(res.status).toBe(403);
  });

  it('posts a balanced entry — debits expense and tax, credits payable', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});

    const res = await agent.post(`${BILLS}/${billId}/approve`).send({});

    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('POSTED');
    expect(res.body.bill.journalEntryId).not.toBeNull();
    expect(res.body.bill.approvedBy).toBe(userA.id);

    const journalRes = await agent.get(`${JOURNALS}/${res.body.bill.journalEntryId}`);
    expect(journalRes.body.entry.totalDebitCents).toBe(29500);
    expect(journalRes.body.entry.totalCreditCents).toBe(29500);

    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
    }[];
    const expense = lines.find((l) => l.accountCode === '6130');
    const taxInput = lines.find((l) => l.accountCode === '1180');
    const payable = lines.find((l) => l.accountCode === '2100');

    expect(expense?.debitCents).toBe(25000);
    expect(taxInput?.debitCents).toBe(4500);
    expect(payable?.creditCents).toBe(29500);
  });

  it('rejects a PATCH after approval', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    await agent.post(`${BILLS}/${billId}/approve`).send({});

    const res = await agent.patch(`${BILLS}/${billId}`).send(billPayload({ vendorId, expenseAccountId }));

    expect(res.status).toBe(409);
  });

  it('rejects a DELETE after approval', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    await agent.post(`${BILLS}/${billId}/approve`).send({});

    const res = await agent.delete(`${BILLS}/${billId}`);

    expect(res.status).toBe(409);
  });

  it('rejects approving twice', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    await agent.post(`${BILLS}/${billId}/approve`).send({});

    const res = await agent.post(`${BILLS}/${billId}/approve`).send({});

    expect(res.status).toBe(409);
  });
});

describe('POST /ledger-core/bills/:id/void', () => {
  it('on a posted bill posts a mirror reversal and rebalances the trial balance', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});

    const res = await agent.post(`${BILLS}/${billId}/void`).send({});

    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('VOID');
    expect(res.body.bill.voidJournalEntryId).not.toBeNull();

    const reversalRes = await agent.get(`${JOURNALS}/${res.body.bill.voidJournalEntryId}`);
    expect(reversalRes.body.entry.reversesEntryId).toBe(approved.body.bill.journalEntryId);

    const trialBalanceRes = await agent.get('/api/v1/ledger-core/reports/trial-balance');
    expect(trialBalanceRes.body.isBalanced).toBe(true);
    const payableRow = trialBalanceRes.body.rows.find((r: { code: string }) => r.code === '2100');
    expect(payableRow?.netBalanceCents ?? 0).toBe(0);
  });

  it('on a draft posts no journal entry', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;

    const res = await agent.post(`${BILLS}/${billId}/void`).send({});

    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('VOID');
    expect(res.body.bill.voidJournalEntryId).toBeNull();
  });
});

describe('GET /ledger-core/bills — filtering and isolation', () => {
  it('?status=AWAITING_APPROVAL filters and totalCount matches', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');

    const draft = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId, vendorReference: 'D1' }));
    const submitted = await agent
      .post(BILLS)
      .send(billPayload({ vendorId, expenseAccountId, vendorReference: 'S1' }));
    await agent.post(`${BILLS}/${submitted.body.bill.id}/submit`).send({});
    void draft;

    const res = await agent.get(`${BILLS}?status=AWAITING_APPROVAL`);

    expect(res.body.totalCount).toBe(1);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].status).toBe('AWAITING_APPROVAL');
  });

  it('?status=NOPE returns 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${BILLS}?status=NOPE`);
    expect(res.status).toBe(400);
  });

  it('GET /:id with another org bill id returns 404', async () => {
    const agentA = await loginAgent(app, userA);
    const vendorId = await createVendor(agentA);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agentA.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(`${BILLS}/${created.body.bill.id}`);

    expect(res.status).toBe(404);
  });

  it('approving another org bill id returns 404 and leaves it DRAFT', async () => {
    const agentA = await loginAgent(app, userA);
    const vendorId = await createVendor(agentA);
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agentA.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;

    const agentC = await loginAgent(app, userC);
    const res = await agentC.post(`${BILLS}/${billId}/approve`).send({});
    expect(res.status).toBe(404);

    const readBack = await agentA.get(`${BILLS}/${billId}`);
    expect(readBack.body.bill.status).toBe('DRAFT');
  });
});

describe('GET /ledger-core/bills — ?settlement= filter', () => {
  it('a fully paid bill moves from OUTSTANDING to PAID, and never 500s', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6130');
    const cashAccountId = await accountId(orgA, '1110');

    const created = await agent.post(BILLS).send(billPayload({ vendorId, expenseAccountId }));
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    await agent.post(`${BILLS}/${billId}/approve`).send({});

    const beforePayment = await agent.get(`${BILLS}?status=POSTED&settlement=OUTSTANDING`);
    expect(beforePayment.status).toBe(200);
    expect(beforePayment.body.bills.map((b: { id: string }) => b.id)).toContain(billId);

    await agent.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-06-15',
      amountCents: 29500,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId, amountCents: 29500 }],
    });

    const outstanding = await agent.get(`${BILLS}?status=POSTED&settlement=OUTSTANDING`);
    expect(outstanding.status).toBe(200);
    expect(outstanding.body.bills.map((b: { id: string }) => b.id)).not.toContain(billId);

    const overdue = await agent.get(`${BILLS}?status=POSTED&settlement=OVERDUE`);
    expect(overdue.status).toBe(200);
    expect(overdue.body.bills.map((b: { id: string }) => b.id)).not.toContain(billId);

    const paid = await agent.get(`${BILLS}?status=POSTED&settlement=PAID`);
    expect(paid.status).toBe(200);
    expect(paid.body.bills.map((b: { id: string }) => b.id)).toContain(billId);
    expect(paid.body.bills[0].settlementStatus).toBe('PAID');
  });
});

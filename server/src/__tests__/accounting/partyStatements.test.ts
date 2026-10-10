import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import {
  accountId,
  createCustomer,
  issueCreditNote,
  issueInvoice,
  receivePayment,
  type Agent,
} from '../helpers/accountingFixtures.js';

/**
 * Customer & vendor statements (Phase 39a). Integration tier, real
 * PostgreSQL. The central claim: an OUTSTANDING statement on a past date
 * reports the open items *as they stood on that date* — documents issued
 * later, payments and note allocations dated later, and voids dated later are
 * all ignored — and its total equals the party ledger's closing balance on
 * the same date.
 */

const app = createApp();
const STATEMENTS = '/api/v1/statements';
const SETTINGS = '/api/v1/settings/statements';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let customerId: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'stmt-a', orgName: 'Statement Org A' });
  userB = await createUserWithOrg({ label: 'stmt-b', orgName: 'Statement Org B' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  customerId = await createCustomer(agentA, 'Northwind Traders', 'ap@northwind.test');
});

afterAll(closePool);

/**
 * The scenario every as-at test reads:
 *   inv1 10000  issued 06-01 due 06-30; paid 4000 on 06-20 and 6000 on 07-20
 *   inv2  5000  issued 06-15 due 07-15; credit note 1000 on 06-25;
 *               paid 1000 on 06-28, that payment voided on 07-30
 *   inv3  3000  issued 08-10 due 09-10
 *   inv4  2000  issued 06-05 due 06-30; voided on 08-01
 */
async function seedScenario(): Promise<{ inv1: string; inv2: string; inv3: string; inv4: string }> {
  const inv1 = await issueInvoice(agentA, orgA, customerId, 10000, '2026-06-01', '2026-06-30');
  const inv2 = await issueInvoice(agentA, orgA, customerId, 5000, '2026-06-15', '2026-07-15');
  const inv3 = await issueInvoice(agentA, orgA, customerId, 3000, '2026-08-10', '2026-09-10');
  const inv4 = await issueInvoice(agentA, orgA, customerId, 2000, '2026-06-05', '2026-06-30');

  await receivePayment(agentA, orgA, customerId, '2026-06-20', [{ invoiceId: inv1.id, amountCents: 4000 }]);
  await receivePayment(agentA, orgA, customerId, '2026-07-20', [{ invoiceId: inv1.id, amountCents: 6000 }]);
  await issueCreditNote(agentA, orgA, inv2.id, 1000, '2026-06-25');
  const voidedPayment = await receivePayment(agentA, orgA, customerId, '2026-06-28', [
    { invoiceId: inv2.id, amountCents: 1000 },
  ]);
  const pv = await agentA.post(`/api/v1/payments/${voidedPayment}/void`).send({ entryDate: '2026-07-30' });
  expect(pv.status).toBe(200);
  const iv = await agentA.post(`/api/v1/invoices/${inv4.id}/void`).send({ entryDate: '2026-08-01' });
  expect(iv.status).toBe(200);

  return { inv1: inv1.id, inv2: inv2.id, inv3: inv3.id, inv4: inv4.id };
}

describe('GET /statements/customers/:id — OUTSTANDING (as-at)', () => {
  it('on 2026-07-10 ignores later documents, payments, voids; equals the ledger closing balance', async () => {
    const ids = await seedScenario();

    const res = await agentA.get(`${STATEMENTS}/customers/${customerId}?type=OUTSTANDING&asOf=2026-07-10`);
    expect(res.status).toBe(200);
    const statement = res.body.statement;

    const byId = new Map<string, number>(
      statement.openItems.map((i: { documentId: string; baseOutstandingCents: number }) => [
        i.documentId,
        i.baseOutstandingCents,
      ]),
    );
    expect(byId.get(ids.inv1)).toBe(6000); // the 07-20 payment had not happened
    expect(byId.get(ids.inv2)).toBe(3000); // 5000 − CN 1000 − payment 1000 (voided only on 07-30)
    expect(byId.get(ids.inv4)).toBe(2000); // voided only on 08-01
    expect(byId.has(ids.inv3)).toBe(false); // issued 08-10
    expect(statement.outstandingCents).toBe(11000);
    // inv1 (due 06-30) and inv4 (due 06-30) are overdue on 07-10; inv2 (due 07-15) is not.
    expect(statement.overdueCents).toBe(8000);
    expect(statement.aging.D1_30).toBe(8000);
    expect(statement.aging.CURRENT).toBe(3000);
    expect(statement.closingBalanceCents).toBe(11000);

    const ledger = await agentA.get(`/api/v1/customers/${customerId}/ledger?to=2026-07-10&limit=100`);
    expect(ledger.body.closingBalanceCents).toBe(statement.outstandingCents);
  });

  it('as of today reflects every later event', async () => {
    const ids = await seedScenario();
    const res = await agentA.get(`${STATEMENTS}/customers/${customerId}?type=OUTSTANDING&asOf=2026-09-01`);
    const items = res.body.statement.openItems as { documentId: string; baseOutstandingCents: number }[];
    expect(items.map((i) => [i.documentId, i.baseOutstandingCents]).sort()).toEqual(
      [
        [ids.inv2, 4000], // payment voided → only the credit note settles it
        [ids.inv3, 3000],
      ].sort(),
    );
    expect(res.body.statement.outstandingCents).toBe(7000);
  });

  it('as-at totals equal the ledger closing balance on every date in the scenario', async () => {
    await seedScenario();
    for (const day of ['2026-05-31', '2026-06-01', '2026-06-25', '2026-07-19', '2026-07-30', '2026-08-01', '2026-08-10']) {
      const stmt = await agentA.get(`${STATEMENTS}/customers/${customerId}?type=OUTSTANDING&asOf=${day}`);
      const ledger = await agentA.get(`/api/v1/customers/${customerId}/ledger?to=${day}&limit=1`);
      expect({ day, total: stmt.body.statement.outstandingCents }).toEqual({
        day,
        total: ledger.body.closingBalanceCents,
      });
    }
  });

  it('defaults to OUTSTANDING as of today', async () => {
    const res = await agentA.get(`${STATEMENTS}/customers/${customerId}`);
    expect(res.status).toBe(200);
    expect(res.body.statement.type).toBe('OUTSTANDING');
    expect(res.body.statement.statementDate).toBe(new Date().toISOString().slice(0, 10));
    expect(res.body.statement.party).toMatchObject({ name: 'Northwind Traders', email: 'ap@northwind.test' });
  });
});

describe('GET /statements/customers/:id — ACTIVITY', () => {
  it('opening + period movement = closing = as-at outstanding at the range end', async () => {
    await seedScenario();
    const res = await agentA.get(
      `${STATEMENTS}/customers/${customerId}?type=ACTIVITY&from=2026-06-10&to=2026-07-10`,
    );
    expect(res.status).toBe(200);
    const s = res.body.statement;
    expect(s.type).toBe('ACTIVITY');
    expect(s.from).toBe('2026-06-10');
    expect(s.statementDate).toBe('2026-07-10');
    expect(s.openingBalanceCents).toBe(12000); // inv1 + inv4
    expect(s.rows.map((r: { kind: string }) => r.kind)).toEqual([
      'INVOICE',
      'PAYMENT',
      'CREDIT_NOTE',
      'PAYMENT',
    ]);
    expect(s.closingBalanceCents).toBe(s.openingBalanceCents + s.periodDebitCents - s.periodCreditCents);
    expect(s.closingBalanceCents).toBe(11000);
    expect(s.closingBalanceCents).toBe(s.outstandingCents);
    expect(s.rows.at(-1).runningBalanceCents).toBe(11000);
  });

  it('is not paginated: 105 invoices give 105 rows', async () => {
    for (let i = 0; i < 105; i += 1) {
      await issueInvoice(agentA, orgA, customerId, 100, '2026-06-01', '2026-06-30');
    }
    const res = await agentA.get(
      `${STATEMENTS}/customers/${customerId}?type=ACTIVITY&from=2026-06-01&to=2026-06-30`,
    );
    expect(res.body.statement.rows).toHaveLength(105);
    expect(res.body.statement.closingBalanceCents).toBe(10500);
  }, 60_000);

  it('needs a from date; from after to → 400; unknown type → 400', async () => {
    expect((await agentA.get(`${STATEMENTS}/customers/${customerId}?type=ACTIVITY`)).status).toBe(400);
    expect(
      (await agentA.get(`${STATEMENTS}/customers/${customerId}?type=ACTIVITY&from=2026-07-01&to=2026-06-01`))
        .status,
    ).toBe(400);
    expect((await agentA.get(`${STATEMENTS}/customers/${customerId}?type=WEEKLY`)).status).toBe(400);
  });
});

describe('GET /statements/customers — the list', () => {
  it('lists outstanding and overdue per customer; zero balances only on request; credits are kept', async () => {
    await seedScenario();
    const zero = await createCustomer(agentA, 'Zero Balance Co');
    const credit = await createCustomer(agentA, 'Credit Holder Ltd');
    const paid = await issueInvoice(agentA, orgA, credit, 1000, '2026-06-01', '2026-06-30');
    await receivePayment(agentA, orgA, credit, '2026-06-02', [{ invoiceId: paid.id, amountCents: 1000 }]);
    await issueCreditNote(agentA, orgA, paid.id, 300, '2026-06-03');

    const res = await agentA.get(`${STATEMENTS}/customers?asOf=2026-07-10`);
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe('2026-07-10');
    const rows = res.body.parties as { partyId: string; outstandingCents: number; overdueCents: number }[];
    const byId = new Map(rows.map((r) => [r.partyId, r]));
    expect(byId.get(customerId)).toMatchObject({ outstandingCents: 11000, overdueCents: 8000, lastSentAt: null });
    expect(byId.get(credit)?.outstandingCents).toBe(-300);
    expect(byId.has(zero)).toBe(false);

    const withZero = await agentA.get(`${STATEMENTS}/customers?asOf=2026-07-10&includeZero=true`);
    expect(withZero.body.parties.some((r: { partyId: string }) => r.partyId === zero)).toBe(true);

    const searched = await agentA.get(`${STATEMENTS}/customers?asOf=2026-07-10&q=north`);
    expect(searched.body.parties.map((r: { name: string }) => r.name)).toEqual(['Northwind Traders']);
  });

  it('vendor statements list approved bills', async () => {
    const vendor = await agentA.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
    const vendorId = vendor.body.vendor.id as string;
    const created = await agentA.post('/api/v1/bills').send({
      vendorId,
      vendorReference: 'ACME-1',
      billDate: '2026-06-01',
      dueDate: '2026-06-30',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'x',
          quantityMilli: 1000,
          unitPriceCents: 7000,
          expenseAccountId: await accountId(orgA, '6130'),
          taxRateBp: 0,
        },
      ],
    });
    const billId = created.body.bill.id as string;
    await agentA.post(`/api/v1/bills/${billId}/submit`).send({});
    await agentA.post(`/api/v1/bills/${billId}/approve`).send({});

    const list = await agentA.get(`${STATEMENTS}/vendors?asOf=2026-07-10`);
    expect(list.body.parties).toEqual([
      expect.objectContaining({ partyId: vendorId, outstandingCents: 7000, overdueCents: 7000 }),
    ]);
    const one = await agentA.get(`${STATEMENTS}/vendors/${vendorId}?type=ACTIVITY&from=2026-06-01&to=2026-06-30`);
    expect(one.body.statement.closingBalanceCents).toBe(7000);
    expect(one.body.statement.rows[0].documentNumber).toBe('ACME-1');
  });
});

describe('/settings/statements', () => {
  it('returns defaults until saved, then the saved values', async () => {
    const first = await agentA.get(SETTINGS);
    expect(first.body.statementSettings).toMatchObject({
      templateId: 'classic',
      documentTitle: 'STATEMENT',
      defaultType: 'OUTSTANDING',
      configured: false,
    });
    const saved = await agentA
      .patch(SETTINGS)
      .send({ templateId: 'modern', documentTitle: 'Account statement', showAgingSummary: false });
    expect(saved.status).toBe(200);
    expect(saved.body.statementSettings).toMatchObject({
      templateId: 'modern',
      documentTitle: 'Account statement',
      showAgingSummary: false,
      configured: true,
    });
  });

  it('rejects an unknown template (400) and a VIEWER write (403)', async () => {
    expect((await agentA.patch(SETTINGS).send({ templateId: 'fancy' })).status).toBe(400);

    const viewer = await createUserWithOrg({ label: 'stmt-viewer', orgName: 'Viewer Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect((await agent.get(SETTINGS)).status).toBe(200);
    expect((await agent.patch(SETTINGS).send({ documentTitle: 'X' })).status).toBe(403);
    expect((await agent.get(`${STATEMENTS}/customers/${customerId}`)).status).toBe(200);
  });
});

describe('cross-tenant isolation', () => {
  it("org B's customer is 404 under org A; org A's list never shows org B; settings are per org", async () => {
    const agentB = await loginAgent(app, userB);
    const customerB = await createCustomer(agentB, 'Bravo Customer');
    await issueInvoice(agentB, userB.orgId, customerB, 4200, '2026-06-01', '2026-06-30');
    await agentB.patch(SETTINGS).send({ documentTitle: 'BRAVO' });

    const res = await agentA.get(`${STATEMENTS}/customers/${customerB}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');

    const list = await agentA.get(`${STATEMENTS}/customers?includeZero=true`);
    expect(list.body.parties.map((r: { partyId: string }) => r.partyId)).not.toContain(customerB);
    expect((await agentA.get(SETTINGS)).body.statementSettings.documentTitle).toBe('STATEMENT');

    const stillB = await agentB.get(`${STATEMENTS}/customers/${customerB}`);
    expect(stillB.body.statement.outstandingCents).toBe(4200);
  });
});

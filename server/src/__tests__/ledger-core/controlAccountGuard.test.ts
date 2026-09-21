import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as journalService from '../../services/ledger-core/journalService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the AR/AP control accounts refuse manual and bank-line
 * journals (Phase 25). Integration tier, real PostgreSQL. A control account's
 * balance is its subledger's total; a journal line names no customer or
 * vendor, so it could only ever break that tie. Documents (invoices, bills,
 * payments) still post to the control accounts unchanged.
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const ACCOUNTS = '/api/v1/ledger-core/accounts';
const INVOICE_SETTINGS = '/api/v1/ledger-core/settings/invoicing';
const INVOICES = '/api/v1/ledger-core/invoices';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';

const RECEIVABLE_MESSAGE =
  'Account 1120 is the receivable control account — post to it through an invoice or a payment, not a journal entry';
const PAYABLE_MESSAGE =
  'Account 2100 is the payable control account — post to it through a bill or a payment, not a journal entry';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function entryCount(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM journal_entries WHERE org_id = $1',
    [orgId],
  );
  return Number(rows[0]?.n ?? '0');
}

async function journal(orgId: string, debitCode: string, creditCode: string, amountCents: number) {
  return {
    entryDate: '2026-06-01',
    description: 'guard fixture',
    lines: [
      { accountId: await accountId(orgId, debitCode), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, creditCode), debitCents: 0, creditCents: amountCents },
    ],
  };
}

/** Creates a postable Asset account under 1100 and makes it the receivable control account. */
async function configureCustomReceivable(agent: Agent, orgId: string): Promise<string> {
  const created = await agent.post(ACCOUNTS).send({
    code: '1125',
    name: 'Trade Receivables',
    type: 'Asset',
    parentId: await accountId(orgId, '1100'),
  });
  if (created.status !== 201) throw new Error(`fixture: account create failed ${created.status}`);
  const id = created.body.account.id as string;
  const patched = await agent.patch(INVOICE_SETTINGS).send({ receivableAccountId: id });
  if (patched.status !== 200) throw new Error(`fixture: settings patch failed ${patched.status} ${JSON.stringify(patched.body)}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'guard-a', orgName: 'Guard Org A' });
  userB = await createUserWithOrg({ label: 'guard-b', orgName: 'Guard Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

describe('POST /journals — control accounts are refused', () => {
  it('a line on 1120 → 422 naming the receivable control account, and nothing is written', async () => {
    const before = await entryCount(orgA);

    const res = await agentA.post(JOURNALS).send(await journal(orgA, '1120', '4100', 5000));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(RECEIVABLE_MESSAGE);
    expect(await entryCount(orgA)).toBe(before);
  });

  it('a line on 2100 → 422 naming the payable control account', async () => {
    const res = await agentA.post(JOURNALS).send(await journal(orgA, '6120', '2100', 5000));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(PAYABLE_MESSAGE);
  });

  it('a configured receivable account is refused, and 1120 is then accepted', async () => {
    await configureCustomReceivable(agentA, orgA);

    const refused = await agentA.post(JOURNALS).send(await journal(orgA, '1125', '4100', 5000));
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe(
      'Account 1125 is the receivable control account — post to it through an invoice or a payment, not a journal entry',
    );

    const accepted = await agentA.post(JOURNALS).send(await journal(orgA, '1120', '4100', 5000));
    expect(accepted.status).toBe(201);
  });

  it('non-control accounts 1130/2120 → 201', async () => {
    const res = await agentA.post(JOURNALS).send(await journal(orgA, '1130', '2120', 5000));
    expect(res.status).toBe(201);
  });
});

describe('POST /bank-transactions/:id/post-journal — control accounts are refused', () => {
  it('accountId = 1120 → 422 and the bank line stays UNMATCHED', async () => {
    const cashAccountId = await accountId(orgA, '1110');
    const imported = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'single.csv',
      content: 'Date,Description,Amount\n2026-06-01,CUSTOMER DEPOSIT,50.00',
      dateFormat: 'ISO',
    });
    expect(imported.status).toBe(201);
    const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
    const txnId = (listRes.body.transactions as Array<{ id: string }>)[0]?.id;
    if (txnId === undefined) throw new Error('fixture: imported transaction not found');

    const res = await agentA
      .post(`${BANK_TRANSACTIONS}/${txnId}/post-journal`)
      .send({ accountId: await accountId(orgA, '1120'), description: null });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(RECEIVABLE_MESSAGE);
    const after = await agentA.get(`${BANK_TRANSACTIONS}/${txnId}`);
    expect(after.body.transaction.status).toBe('UNMATCHED');
  });
});

describe('documents and reversals are unaffected', () => {
  it('issuing an invoice still posts to 1120', async () => {
    const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const created = await agentA.post(INVOICES).send({
      customerId: customerRes.body.customer.id as string,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'x',
          quantityMilli: 1000,
          unitPriceCents: 10000,
          revenueAccountId: await accountId(orgA, '4100'),
          taxRateBp: 0,
        },
      ],
    });
    const res = await agentA.post(`${INVOICES}/${created.body.invoice.id as string}/issue`).send({});

    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ledger_lines WHERE org_id = $1 AND account_id = $2',
      [orgA, await accountId(orgA, '1120')],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('reversing a legacy manual entry on 2100 is allowed', async () => {
    const client = await pool.connect();
    let legacyId: string;
    try {
      await client.query('BEGIN');
      legacyId = await journalService.createEntryOnClient(
        client,
        orgA,
        userA.id,
        await journal(orgA, '6120', '2100', 7000),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const res = await agentA.post(`${JOURNALS}/${legacyId}/reverse`).send({});
    expect(res.status).toBe(201);
  });
});

describe('cross-tenant isolation', () => {
  it("each org's guard resolves that org's own control accounts only", async () => {
    const agentB = await loginAgent(app, userB);
    await configureCustomReceivable(agentB, orgB);

    const inA = await agentA.post(JOURNALS).send(await journal(orgA, '1120', '4100', 5000));
    expect(inA.status).toBe(422);
    expect(inA.body.error).toBe(RECEIVABLE_MESSAGE);

    const inB = await agentB.post(JOURNALS).send(await journal(orgB, '1120', '4100', 5000));
    expect(inB.status).toBe(201);
  });
});

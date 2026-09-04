import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as journalService from '../../services/ledger-core/journalService.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 5 — the actor and IP land on the audit row.
 *
 * These tests drive the app through HTTP (not the service layer directly),
 * because `attachRequestContext` and `authenticate` — the middleware that
 * fills the request context — only run on a real request. Case 5 is the one
 * deliberate exception: it calls the service directly to prove a write with
 * no request context still succeeds, with a null actor.
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

interface AuditRow {
  operation: string;
  table_name: string;
  actor_user_id: string | null;
  client_ip: string | null;
  txid: string;
}

async function auditRows(orgId: string, tableName: string, operation = 'INSERT'): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT operation, table_name, actor_user_id, client_ip, txid
       FROM audit_logs
      WHERE org_id = $1 AND table_name = $2 AND operation = $3
      ORDER BY id ASC`,
    [orgId, tableName, operation],
  );
  return rows;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
});

afterAll(closePool);

describe('Phase 5 — audit actor and client IP', () => {
  it('stamps the posting user on a journal entry audit row', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(JOURNALS).send({
      entryDate: '2026-08-15',
      description: 'AWS August',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 45000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 45000 },
      ],
    });
    expect(res.status).toBe(201);

    const rows = await auditRows(orgA, 'journal_entries');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(userA.id);
  });

  it('stamps the client ip', async () => {
    const agent = await loginAgent(app, userA);

    await agent.post(JOURNALS).send({
      entryDate: '2026-08-15',
      description: 'AWS August',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 45000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 45000 },
      ],
    });

    const rows = await auditRows(orgA, 'journal_entries');
    expect(rows[0]?.client_ip).not.toBeNull();
    expect(rows[0]?.client_ip).not.toBe('');
  });

  it('stamps the actor on a single-statement write', async () => {
    const agent = await loginAgent(app, userA);

    const res = await agent.post(CUSTOMERS).send({
      name: 'Acme Co',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      notes: null,
    });
    expect(res.status).toBe(201);

    const rows = await auditRows(orgA, 'customers');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(userA.id);
  });

  it('stamps the actor on every row of a multi-table transaction, all sharing one txid', async () => {
    const agent = await loginAgent(app, userA);

    const customerRes = await agent.post(CUSTOMERS).send({
      name: 'Acme Co',
      email: null,
      phone: null,
      billingAddress: null,
      taxNumber: null,
      notes: null,
    });
    const customerId = customerRes.body.customer.id as string;

    const invoiceRes = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Consulting',
          quantityMilli: 1000,
          unitPriceCents: 100000,
          revenueAccountId: await accountId(orgA, '4100'),
          taxRateBp: 0,
        },
      ],
    });
    const invoiceId = invoiceRes.body.invoice.id as string;

    const issueRes = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    expect(issueRes.status).toBe(200);

    const invoiceUpdateRows = await auditRows(orgA, 'invoices', 'UPDATE');
    const journalEntryRows = await auditRows(orgA, 'journal_entries');
    const ledgerLineRows = await auditRows(orgA, 'ledger_lines');

    expect(invoiceUpdateRows).toHaveLength(1);
    expect(journalEntryRows).toHaveLength(1);
    expect(ledgerLineRows.length).toBeGreaterThanOrEqual(2);

    const allActors = [
      invoiceUpdateRows[0]?.actor_user_id,
      journalEntryRows[0]?.actor_user_id,
      ...ledgerLineRows.map((r) => r.actor_user_id),
    ];
    expect(allActors.every((actor) => actor === userA.id)).toBe(true);

    const allTxids = [
      invoiceUpdateRows[0]?.txid,
      journalEntryRows[0]?.txid,
      ...ledgerLineRows.map((r) => r.txid),
    ];
    expect(new Set(allTxids).size).toBe(1);
  });

  it('leaves the actor null for a write with no request context', async () => {
    const debitAccount = await accountId(orgA, '6120');
    const creditAccount = await accountId(orgA, '2100');

    await journalService.createEntry(orgA, userA.id, {
      entryDate: '2026-08-15',
      description: 'Posted with no HTTP request',
      lines: [
        { accountId: debitAccount, debitCents: 1000, creditCents: 0 },
        { accountId: creditAccount, debitCents: 0, creditCents: 1000 },
      ],
    });

    const rows = await auditRows(orgA, 'journal_entries');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.client_ip).toBeNull();
  });

  it('does not leak an actor between pooled requests', async () => {
    await addMember(orgA, userB.id, 'ACCOUNTANT');

    const agentA = await loginAgent(app, userA);
    const agentB = await loginAgent(app, userB);
    // userB's own registration created a second organization; switch-org puts
    // their active token on orgA so both agents post into the same tenant and
    // this test isolates the actor leak this case exists to catch.
    const switchRes = await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    expect(switchRes.status).toBe(200);

    await agentA.post(JOURNALS).send({
      entryDate: '2026-08-15',
      description: 'Posted by A',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 1000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 1000 },
      ],
    });

    await agentB.post(JOURNALS).send({
      entryDate: '2026-08-16',
      description: 'Posted by B',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 2000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 2000 },
      ],
    });

    const rows = await auditRows(orgA, 'journal_entries');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actor_user_id).toBe(userA.id);
    expect(rows[1]?.actor_user_id).toBe(userB.id);
  });
});

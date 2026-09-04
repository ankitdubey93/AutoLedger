import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 5 — the audit trail captures INSERT/UPDATE/DELETE, scopes every row
 * by org_id, refuses its own mutation, and never records `users` or
 * `refresh_tokens`. Actor/IP attribution is asserted separately, in
 * auditActor.test.ts, once the request-context plumbing is in scope.
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const INVOICES = '/api/v1/ledger-core/invoices';

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

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

describe('Phase 5 — audit trail capture', () => {
  it('records an INSERT with new_row populated and old_row null', async () => {
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
    const entryId = res.body.entry.id as string;

    const { rows } = await pool.query(
      `SELECT operation, old_row, new_row, app_slug FROM audit_logs
        WHERE org_id = $1 AND table_name = 'journal_entries'`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('INSERT');
    expect(rows[0].old_row).toBeNull();
    expect(rows[0].new_row.id).toBe(entryId);
    expect(rows[0].app_slug).toBe('ledger-core');
  });

  it('records one audit row per ledger line', async () => {
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

    const { rows } = await pool.query(
      `SELECT id FROM audit_logs WHERE org_id = $1 AND table_name = 'ledger_lines'`,
      [orgA],
    );
    expect(rows).toHaveLength(2);
  });

  it('records an UPDATE with changed_keys naming only what moved', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const customerId = created.body.customer.id as string;

    const updated = await agent.patch(`${CUSTOMERS}/${customerId}`).send({ name: 'Northwind Inc' });
    expect(updated.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT operation, changed_keys FROM audit_logs
        WHERE org_id = $1 AND table_name = 'customers' AND operation = 'UPDATE'`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_keys).toContain('name');
    expect(rows[0].changed_keys).toContain('updated_at');
    expect(rows[0].changed_keys).not.toContain('email');
  });

  it('records a DELETE with old_row populated and new_row null', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(INVOICES).send({
      customerId: (await agent.post(CUSTOMERS).send({ name: 'Acme Co' })).body.customer.id,
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
    const invoiceId = created.body.invoice.id as string;

    const deleted = await agent.delete(`${INVOICES}/${invoiceId}`);
    expect(deleted.status).toBe(204);

    const { rows } = await pool.query(
      `SELECT operation, old_row, new_row FROM audit_logs
        WHERE org_id = $1 AND table_name = 'invoices' AND operation = 'DELETE'`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].new_row).toBeNull();
    expect(rows[0].old_row.id).toBe(invoiceId);
  });

  it("stamps org_id from the audited row's own org_id column", async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });

    const { rows } = await pool.query(
      `SELECT org_id FROM audit_logs WHERE table_name = 'customers'`,
    );
    expect(rows.every((r: { org_id: string }) => r.org_id === orgA)).toBe(true);
  });

  it('stamps org_id from id on the organizations table', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch('/api/v1/organizations').send({ name: 'Org Alpha Renamed' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT org_id, app_slug FROM audit_logs
        WHERE table_name = 'organizations' AND operation = 'UPDATE'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).toBe(orgA);
    expect(rows[0].app_slug).toBe('platform');
  });

  it('does not audit users or refresh_tokens', async () => {
    await loginAgent(app, userA);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM audit_logs WHERE table_name IN ('users', 'refresh_tokens')`,
    );
    expect(rows[0].count).toBe(0);
  });

  it('refuses UPDATE on audit_logs', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });

    await expect(pool.query(`UPDATE audit_logs SET client_ip = 'x'`)).rejects.toMatchObject({
      code: '0A000',
    });
  });

  it('refuses DELETE on audit_logs', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });

    await expect(pool.query('DELETE FROM audit_logs')).rejects.toMatchObject({
      code: '0A000',
    });
  });

  it('an org A write never produces an audit row scoped to org B', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(JOURNALS).send({
      entryDate: '2026-08-15',
      description: 'AWS August',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 45000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 45000 },
      ],
    });

    // Org B has its own audit rows from registering (the default chart seed) —
    // the leak this guards against is org A's *journal posting* showing up
    // under org B, not the total row count across both tenants.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE org_id = $1 AND table_name IN ('journal_entries', 'ledger_lines')`,
      [orgB],
    );
    expect(rows[0].count).toBe(0);
  });
});

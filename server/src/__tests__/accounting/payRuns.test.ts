import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId } from '../helpers/accountingFixtures.js';
import { createVendor } from '../helpers/depositFixtures.js';

/**
 * ABA pay runs (Phase 49g). Integration tier.
 *
 * The central claims: a batch records one payment per vendor, all or nothing;
 * the file matches the ledger and drops a voided payment; account numbers are
 * encrypted and never returned; a change of supplier bank details leaves a
 * trail; and nothing crosses a tenant.
 */

const app = createApp();
const RUNS = '/api/v1/pay-runs';
const ACTIVATE = { gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' }, timezone: 'Australia/Sydney' };
const BANK = { bsb: '062000', accountNumber: '12345678', accountName: 'Harbour Bakery', financialInstitution: 'cba', apcaUserId: '123456' };

type Agent = Awaited<ReturnType<typeof loginAgent>>;
let user: SeededUser;
let agent: Agent;
let bank: string;
const originalKey = env.INTEGRATION_ENCRYPTION_KEY;

async function bill(vendorId: string, cents: number, reference: string): Promise<string> {
  const created = await agent.post('/api/v1/bills').send({
    vendorId,
    vendorReference: reference,
    billDate: '2026-08-01',
    dueDate: '2026-08-31',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: cents, expenseAccountId: await accountId(user.orgId, '6130'), taxCode: 'P_FREE' }],
  });
  if (created.status !== 201) throw new Error(`fixture: ${created.text}`);
  const id = created.body.bill.id as string;
  await agent.post(`/api/v1/bills/${id}/submit`).send({});
  const approved = await agent.post(`/api/v1/bills/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: ${approved.text}`);
  return id;
}

async function vendorWithDetails(name: string, account: string): Promise<string> {
  const id = await createVendor(agent, name);
  const res = await agent.put(`${RUNS}/vendor-details/${id}`).send({ bsb: '083-004', accountNumber: account, accountName: name });
  if (res.status !== 200) throw new Error(`fixture: ${res.text}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  Object.assign(env, { INTEGRATION_ENCRYPTION_KEY: 'a'.repeat(64) });
  user = await createUserWithOrg({ label: 'a' });
  agent = await loginAgent(app, user);
  expect((await agent.post('/api/v1/settings/region/australia').send(ACTIVATE)).status).toBe(200);
  bank = await accountId(user.orgId, '1110');
  expect((await agent.put(`${RUNS}/bank-accounts/${bank}`).send(BANK)).status).toBe(200);
});

afterAll(async () => {
  Object.assign(env, { INTEGRATION_ENCRYPTION_KEY: originalKey });
  await closePool();
});

describe('bank details', () => {
  it('encrypts the account number and only ever returns the last three digits', async () => {
    const vendor = await createVendor(agent, 'Coastal');
    const res = await agent.put(`${RUNS}/vendor-details/${vendor}`).send({ bsb: '083004', accountNumber: '987654321', accountName: 'Coastal' });
    expect(res.status).toBe(200);
    expect(res.body.details).toMatchObject({ bsb: '083-004', accountNumberLast3: '321' });
    expect(JSON.stringify(res.body)).not.toContain('987654321');
    expect(JSON.stringify((await agent.get(`${RUNS}/vendor-details`)).body)).not.toContain('987654321');

    const { rows } = await pool.query<{ account_number_enc: string }>('SELECT account_number_enc FROM vendor_bank_details WHERE vendor_id = $1', [vendor]);
    expect(rows[0]?.account_number_enc.startsWith('v1.')).toBe(true);
    expect(rows[0]?.account_number_enc).not.toContain('987654321');

    const { rows: audit } = await pool.query<{ row_data: string }>(
      `SELECT to_jsonb(a)::text AS row_data FROM audit_logs a WHERE a.org_id = $1 AND a.table_name = 'vendor_bank_details'`,
      [user.orgId],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.map((a) => a.row_data).join()).not.toContain('987654321');
  });

  it('leaves a trail when a supplier’s account changes', async () => {
    const vendor = await vendorWithDetails('Coastal', '111222333');
    await agent.put(`${RUNS}/vendor-details/${vendor}`).send({ bsb: '083-004', accountNumber: '444555666', accountName: 'Coastal' });
    const { rows } = await pool.query<{ summary: string }>(
      `SELECT summary FROM document_history WHERE org_id = $1 AND entity_type = 'VENDOR' AND entity_id = $2 AND summary LIKE 'Bank details%' ORDER BY created_at`,
      [user.orgId, vendor],
    );
    expect(rows.map((r) => r.summary)).toEqual([
      'Bank details changed to BSB 083-004, account ending 333',
      'Bank details changed to BSB 083-004, account ending 666',
    ]);
  });

  it('refuses a bad BSB, a bad account, and a non-bank account', async () => {
    const vendor = await createVendor(agent, 'Coastal');
    expect((await agent.put(`${RUNS}/vendor-details/${vendor}`).send({ bsb: '12345x', accountNumber: '1', accountName: 'x' })).status).toBe(422);
    expect((await agent.put(`${RUNS}/vendor-details/${vendor}`).send({ bsb: '083004', accountNumber: '1234567890', accountName: 'x' })).status).toBe(422);
    const expense = await accountId(user.orgId, '6130');
    expect((await agent.put(`${RUNS}/bank-accounts/${expense}`).send(BANK)).status).toBe(404);
  });

  it('says so when no encryption key is configured, storing nothing', async () => {
    Object.assign(env, { INTEGRATION_ENCRYPTION_KEY: '' });
    const vendor = await createVendor(agent, 'Coastal');
    expect((await agent.put(`${RUNS}/vendor-details/${vendor}`).send({ bsb: '083004', accountNumber: '1', accountName: 'x' })).status).toBe(503);
  });
});

describe('a pay run', () => {
  it('records one payment per vendor and writes a file that matches the ledger', async () => {
    const a = await vendorWithDetails('Coastal Supplies', '111222333');
    const b = await vendorWithDetails('Bay Freight', '444555666');
    const a1 = await bill(a, 10_000, 'A-1');
    const a2 = await bill(a, 5_000, 'A-2');
    const b1 = await bill(b, 7_500, 'B-1');

    const run = await agent.post(RUNS).send({
      bankAccountId: bank,
      paymentDate: '2026-08-10',
      description: 'August',
      items: [
        { billId: a1, amountCents: 10_000 },
        { billId: a2, amountCents: 5_000 },
        { billId: b1, amountCents: 7_500 },
      ],
    });
    expect(run.status).toBe(201);
    expect(run.body.batch).toMatchObject({ totalCents: 22_500, paymentCount: 2 });

    const { rows } = await pool.query<{ amount_cents: string }>(`SELECT amount_cents::text FROM payments WHERE org_id = $1 ORDER BY amount_cents`, [user.orgId]);
    expect(rows.map((r) => r.amount_cents)).toEqual(['15000', '7500']);
    expect((await agent.get(`/api/v1/bills/${a1}`)).body.bill.amountDueCents).toBe(0);

    const file = await agent.get(`${RUNS}/${run.body.batch.id as string}/aba`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('pay-run-2026-08-10.aba');
    expect(file.headers['cache-control']).toBe('no-store');
    const lines = file.text.split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toHaveLength(120);
    expect(lines[0]?.slice(20, 23)).toBe('CBA');
    expect(lines[0]?.slice(74, 80)).toBe('100826');
    expect(file.text).toContain('111222333');
    expect(file.text).toContain('444555666');
    expect(lines[1]?.slice(87, 96)).toBe(' 12345678');
    expect(lines[3]?.slice(30, 40)).toBe('0000022500');
  });

  it('is all or nothing', async () => {
    const a = await vendorWithDetails('Coastal', '111222333');
    const ok = await bill(a, 10_000, 'A-1');
    const over = await bill(a, 1_000, 'A-2');
    const res = await agent.post(RUNS).send({
      bankAccountId: bank,
      paymentDate: '2026-08-10',
      description: 'August',
      items: [
        { billId: ok, amountCents: 10_000 },
        { billId: over, amountCents: 9_999 },
      ],
    });
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT 1 FROM payments WHERE org_id = $1', [user.orgId]);
    expect(rows).toHaveLength(0);
    expect((await agent.get(RUNS)).body.batches).toHaveLength(0);
  });

  it('names a vendor with no bank details, and refuses a bill twice', async () => {
    const vendor = await createVendor(agent, 'No Details Ltd');
    const b = await bill(vendor, 100, 'X-1');
    const missing = await agent.post(RUNS).send({ bankAccountId: bank, paymentDate: '2026-08-10', description: 'x', items: [{ billId: b, amountCents: 100 }] });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toContain('No Details Ltd');
    const twice = await agent.post(RUNS).send({ bankAccountId: bank, paymentDate: '2026-08-10', description: 'x', items: [{ billId: b, amountCents: 50 }, { billId: b, amountCents: 50 }] });
    expect(twice.status).toBe(422);
  });

  it('drops a voided payment from a re-download', async () => {
    const a = await vendorWithDetails('Coastal', '111222333');
    const b = await vendorWithDetails('Bay', '444555666');
    const run = await agent.post(RUNS).send({
      bankAccountId: bank,
      paymentDate: '2026-08-10',
      description: 'x',
      items: [{ billId: await bill(a, 100, 'A'), amountCents: 100 }, { billId: await bill(b, 200, 'B'), amountCents: 200 }],
    });
    const id = run.body.batch.id as string;
    const { rows } = await pool.query<{ id: string }>(
      `SELECT p.id FROM payments p WHERE p.org_id = $1 AND p.amount_cents = 100`,
      [user.orgId],
    );
    expect((await agent.post(`/api/v1/payments/${rows[0]?.id ?? ''}/void`).send({})).status).toBe(200);
    const file = await agent.get(`${RUNS}/${id}/aba`);
    expect(file.text).not.toContain('111222333');
    expect(file.text).toContain('444555666');
  });
});

describe('access', () => {
  it('is refused to a generic organization, a junior member, and another tenant', async () => {
    const a = await vendorWithDetails('Coastal', '111222333');
    const run = await agent.post(RUNS).send({ bankAccountId: bank, paymentDate: '2026-08-10', description: 'x', items: [{ billId: await bill(a, 100, 'A'), amountCents: 100 }] });
    const id = run.body.batch.id as string;

    const generic = await createUserWithOrg({ label: 'g' });
    const genericAgent = await loginAgent(app, generic);
    expect((await genericAgent.get(RUNS)).status).toBe(403);

    const other = await createUserWithOrg({ label: 'o' });
    const otherAgent = await loginAgent(app, other);
    await otherAgent.post('/api/v1/settings/region/australia').send(ACTIVATE);
    expect((await otherAgent.get(`${RUNS}/${id}/aba`)).status).toBe(404);
    expect((await otherAgent.get(RUNS)).body.batches).toEqual([]);
    expect((await otherAgent.get(`${RUNS}/vendor-details`)).body.details).toEqual([]);
    expect((await otherAgent.put(`${RUNS}/vendor-details/${a}`).send({ bsb: '083004', accountNumber: '1', accountName: 'x' })).status).toBe(404);
    expect((await otherAgent.put(`${RUNS}/bank-accounts/${bank}`).send(BANK)).status).toBe(404);

    const accountant = await createUserWithOrg({ label: 'acc' });
    await addMember(user.orgId, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await accountantAgent.post('/api/v1/auth/switch-org').send({ orgId: user.orgId });
    expect((await accountantAgent.get(`${RUNS}/${id}/aba`)).status).toBe(403);
    expect((await accountantAgent.put(`${RUNS}/vendor-details/${a}`).send({ bsb: '083004', accountNumber: '1', accountName: 'x' })).status).toBe(403);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — invoice settings (Phase 3.8). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors settings.test.ts's shape.
 */

const app = createApp();
const INVOICE_SETTINGS = '/api/v1/ledger-core/settings/invoicing';

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

describe('GET /ledger-core/settings/invoicing', () => {
  it('on a fresh org returns defaults, not 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(INVOICE_SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.invoiceSettings.numberPrefix).toBe('INV-');
    expect(res.body.invoiceSettings.configured).toBe(false);
  });
});

describe('PATCH /ledger-core/settings/invoicing', () => {
  it('creates the row and returns configured: true', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(INVOICE_SETTINGS).send({ numberPrefix: 'ACME-' });

    expect(res.status).toBe(200);
    expect(res.body.invoiceSettings.numberPrefix).toBe('ACME-');
    expect(res.body.invoiceSettings.configured).toBe(true);
  });

  it('rejects an invalid accentColor', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(INVOICE_SETTINGS).send({ accentColor: 'blue' });

    expect(res.status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(INVOICE_SETTINGS).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No fields to update');
  });

  it("rejects another org's account id with 422", async () => {
    const agent = await loginAgent(app, userA);
    const foreignAccountId = await accountId(orgB, '1120');

    const res = await agent.patch(INVOICE_SETTINGS).send({ receivableAccountId: foreignAccountId });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Account does not exist in this organization');
  });

  it('rejects the request from an ACCOUNTANT', async () => {
    const accountant = await createUserWithOrg({ label: 'dana', orgName: 'Org Dana' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.patch(INVOICE_SETTINGS).send({ numberPrefix: 'ACME-' });

    expect(res.status).toBe(403);
  });

  it("org B never sees org A's invoice settings", async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.patch(INVOICE_SETTINGS).send({ numberPrefix: 'ACME-' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(INVOICE_SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.invoiceSettings.numberPrefix).toBe('INV-');
    expect(res.body.invoiceSettings.configured).toBe(false);
  });
});

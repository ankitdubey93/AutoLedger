import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — customers (Phase 3.8). Integration tier, real PostgreSQL.
 *
 * Includes this app's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors accounts.test.ts's shape — userA (org A only), userC (org B only) —
 * plus a spanning ACCOUNTANT to exercise the role gate.
 */

const app = createApp();
const BASE = '/api/v1/ledger-core/customers';

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

describe('POST /ledger-core/customers', () => {
  it('creates one', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).send({ name: 'Northwind Traders' });

    expect(res.status).toBe(201);
    expect(res.body.customer.name).toBe('Northwind Traders');
    expect(res.body.customer.isActive).toBe(true);
  });

  it('lowercases the email', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(BASE)
      .send({ name: 'Northwind Traders', email: 'AP@Northwind.test' });

    expect(res.status).toBe(201);
    expect(res.body.customer.email).toBe('ap@northwind.test');
  });

  it('rejects a blank name', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).send({ name: '   ' });

    expect(res.status).toBe(400);
  });

  it('is rejected for a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'eve', orgName: 'Org Eve' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(BASE).send({ name: 'Northwind Traders' });

    expect(res.status).toBe(403);
  });
});

describe('GET /ledger-core/customers', () => {
  it('hides inactive customers by default', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).send({ name: 'Northwind Traders' });
    await agent.patch(`${BASE}/${created.body.customer.id}`).send({ isActive: false });

    const defaultList = await agent.get(BASE);
    expect(defaultList.body.customers).toHaveLength(0);

    const withInactive = await agent.get(`${BASE}?includeInactive=true`);
    expect(withInactive.body.customers).toHaveLength(1);
  });

  it('?q= filters by name', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).send({ name: 'Northwind Traders' });
    await agent.post(BASE).send({ name: 'Contoso Ltd' });

    const res = await agent.get(`${BASE}?q=north`);

    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].name).toBe('Northwind Traders');
  });

  it('never returns another org customers', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(BASE).send({ name: 'Northwind Traders' });
    await agentA.post(BASE).send({ name: 'Contoso Ltd' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(BASE);

    expect(res.body.customers).toHaveLength(0);
    expect(orgB).not.toBe(orgA);
  });
});

describe('cross-tenant isolation on a single customer', () => {
  it('GET /:id with another org id returns 404', async () => {
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(BASE).send({ name: 'Northwind Traders' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(`${BASE}/${created.body.customer.id}`);

    expect(res.status).toBe(404);
  });

  it('PATCH /:id with another org id returns 404 and leaves the row unchanged', async () => {
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(BASE).send({ name: 'Northwind Traders' });
    const customerId = created.body.customer.id as string;

    const agentC = await loginAgent(app, userC);
    const patchRes = await agentC.patch(`${BASE}/${customerId}`).send({ name: 'Hijacked' });
    expect(patchRes.status).toBe(404);

    const readBack = await agentA.get(`${BASE}/${customerId}`);
    expect(readBack.body.customer.name).toBe('Northwind Traders');
  });
});

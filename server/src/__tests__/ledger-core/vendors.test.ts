import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — vendors (Phase 3.9). Integration tier, real PostgreSQL.
 *
 * Includes this app's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors customers.test.ts's shape — userA (org A only), userC (org B only) —
 * plus a spanning ACCOUNTANT/VIEWER to exercise the role gate.
 */

const app = createApp();
const BASE = '/api/v1/ledger-core/vendors';

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

describe('POST /ledger-core/vendors', () => {
  it('creates one', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).send({ name: 'Acme Supplies' });

    expect(res.status).toBe(201);
    expect(res.body.vendor.name).toBe('Acme Supplies');
    expect(res.body.vendor.isActive).toBe(true);
  });

  it('lowercases the email', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).send({ name: 'Acme Supplies', email: 'AP@Acme.test' });

    expect(res.status).toBe(201);
    expect(res.body.vendor.email).toBe('ap@acme.test');
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

    const res = await agent.post(BASE).send({ name: 'Acme Supplies' });

    expect(res.status).toBe(403);
  });
});

describe('GET /ledger-core/vendors', () => {
  it('hides inactive vendors by default', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).send({ name: 'Acme Supplies' });
    await agent.patch(`${BASE}/${created.body.vendor.id}`).send({ isActive: false });

    const defaultList = await agent.get(BASE);
    expect(defaultList.body.vendors).toHaveLength(0);

    const withInactive = await agent.get(`${BASE}?includeInactive=true`);
    expect(withInactive.body.vendors).toHaveLength(1);
  });

  it('?q= filters by name', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).send({ name: 'Acme Supplies' });
    await agent.post(BASE).send({ name: 'Contoso Ltd' });

    const res = await agent.get(`${BASE}?q=acme`);

    expect(res.body.vendors).toHaveLength(1);
    expect(res.body.vendors[0].name).toBe('Acme Supplies');
  });

  it('never returns another org vendors', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(BASE).send({ name: 'Acme Supplies' });
    await agentA.post(BASE).send({ name: 'Contoso Ltd' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(BASE);

    expect(res.body.vendors).toHaveLength(0);
    expect(orgB).not.toBe(orgA);
  });

  it('requires authentication', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation on a single vendor', () => {
  it('GET /:id with another org id returns 404 and leaks no data', async () => {
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(BASE).send({ name: 'Acme Supplies' });

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(`${BASE}/${created.body.vendor.id}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Acme Supplies');
  });

  it('PATCH /:id with another org id returns 404 and leaves the row unchanged', async () => {
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(BASE).send({ name: 'Acme Supplies' });
    const vendorId = created.body.vendor.id as string;

    const agentC = await loginAgent(app, userC);
    const patchRes = await agentC.patch(`${BASE}/${vendorId}`).send({ name: 'Hijacked' });
    expect(patchRes.status).toBe(404);

    const readBack = await agentA.get(`${BASE}/${vendorId}`);
    expect(readBack.body.vendor.name).toBe('Acme Supplies');
  });
});

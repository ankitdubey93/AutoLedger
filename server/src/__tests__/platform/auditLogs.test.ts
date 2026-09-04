import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * GET /api/v1/audit-logs and /:id — Phase 5's read API. OWNER/ADMIN only,
 * org-scoped. Includes this module's own cross-tenant isolation suite (rule
 * 15) as case 9.
 */

const app = createApp();
const BASE = '/api/v1/audit-logs';
const CUSTOMERS = '/api/v1/ledger-core/customers';

let userA: SeededUser;
let userAccountant: SeededUser;
let userViewer: SeededUser;
let userC: SeededUser;
let orgA: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;

  userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
  await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

  userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
  await addMember(orgA, userViewer.id, 'VIEWER');
});

afterAll(closePool);

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('GET /api/v1/audit-logs', () => {
  it('lists the org’s audit trail newest first', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'First Co' });
    await agent.post(CUSTOMERS).send({ name: 'Second Co' });

    const res = await agent.get(`${BASE}?tableName=customers`);
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThanOrEqual(2);
    const dates = res.body.logs.map((l: { createdAt: string }) => l.createdAt);
    expect(new Date(dates[0]).getTime()).toBeGreaterThanOrEqual(new Date(dates[1]).getTime());
  });

  it('omits row images from the list response', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'Acme Co' });

    const res = await agent.get(`${BASE}?tableName=customers`);
    expect(res.status).toBe(200);
    expect(res.body.logs[0]).not.toHaveProperty('oldRow');
    expect(res.body.logs[0]).not.toHaveProperty('newRow');
  });

  it('filters by tableName', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CUSTOMERS).send({ name: 'Acme Co' });

    const res = await agent.get(`${BASE}?tableName=customers`);
    expect(res.status).toBe(200);
    for (const log of res.body.logs) {
      expect(log.tableName).toBe('customers');
    }
  });

  it('filters by operation', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(CUSTOMERS).send({ name: 'Acme Co' });
    await agent.patch(`${CUSTOMERS}/${created.body.customer.id}`).send({ name: 'Acme Inc' });

    const res = await agent.get(`${BASE}?operation=INSERT`);
    expect(res.status).toBe(200);
    for (const log of res.body.logs) {
      expect(log.operation).toBe('INSERT');
    }
  });

  it('rejects an unknown operation', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${BASE}?operation=UPSERT`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('operation must be one of INSERT, UPDATE, DELETE');
  });

  it('returns row images on the detail route', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(CUSTOMERS).send({ name: 'Acme Co' });
    await agent.patch(`${CUSTOMERS}/${created.body.customer.id}`).send({ name: 'Acme Inc' });

    const list = await agent.get(`${BASE}?tableName=customers&operation=UPDATE`);
    const logId = list.body.logs[0].id as string;

    const res = await agent.get(`${BASE}/${logId}`);
    expect(res.status).toBe(200);
    expect(res.body.log.oldRow).not.toBeNull();
    expect(res.body.log.newRow).not.toBeNull();
    expect(Array.isArray(res.body.log.changedKeys)).toBe(true);
  });

  it('404s a non-numeric id', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${BASE}/not-a-number`);
    expect(res.status).toBe(404);
  });

  it('forbids ACCOUNTANT and VIEWER', async () => {
    const accountantAgent = await switchTo(await loginAgent(app, userAccountant), orgA);
    const accountantRes = await accountantAgent.get(BASE);
    expect(accountantRes.status).toBe(403);

    const viewerAgent = await switchTo(await loginAgent(app, userViewer), orgA);
    const viewerRes = await viewerAgent.get(BASE);
    expect(viewerRes.status).toBe(403);
  });

  it('does not return another org’s audit rows', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(CUSTOMERS).send({ name: 'Acme Co' });

    const listInA = await agentA.get(`${BASE}?tableName=customers`);
    const logIdInA = listInA.body.logs[0].id as string;

    const agentC = await loginAgent(app, userC);
    const listAsC = await agentC.get(`${BASE}?tableName=customers`);
    expect(listAsC.status).toBe(200);
    expect(listAsC.body.totalCount).toBe(0);

    const getAsC = await agentC.get(`${BASE}/${logIdInA}`);
    expect(getAsC.status).toBe(404);
  });
});

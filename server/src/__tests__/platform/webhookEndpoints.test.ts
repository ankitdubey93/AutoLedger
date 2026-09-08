import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { assertDeliverableUrl } from '../../utils/webhookUrl.js';
import {
  generateWebhookSecret,
  signWebhookBody,
  verifyWebhookSignature,
} from '../../utils/webhookSignature.js';
import { ApiError } from '../../utils/apiError.js';

const app = createApp();
const BASE = '/api/v1/webhooks';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

function expectApiError(fn: () => unknown, status: number, message: string): void {
  try {
    fn();
    throw new Error('expected assertDeliverableUrl to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).message).toBe(message);
  }
}

describe('assertDeliverableUrl', () => {
  it('accepts a normal https URL', () => {
    expect(assertDeliverableUrl('https://hooks.example.com/x')).toBe('https://hooks.example.com/x');
  });

  it('rejects a non-http(s) protocol', () => {
    expectApiError(() => assertDeliverableUrl('ftp://example.com'), 400, 'Webhook URL must use https');
  });

  it('rejects localhost', () => {
    expectApiError(
      () => assertDeliverableUrl('http://localhost:5432/'),
      400,
      'Webhook URL must not target a private host',
    );
  });

  it('rejects the cloud metadata endpoint', () => {
    expectApiError(
      () => assertDeliverableUrl('http://169.254.169.254/latest/meta-data/'),
      400,
      'Webhook URL must not target a private host',
    );
  });

  it.each(['http://10.0.0.5/hook', 'http://192.168.1.1/hook', 'http://172.16.0.1/hook', 'http://127.0.0.1/hook'])(
    'rejects private IPv4 literal %s',
    (url) => {
      expectApiError(() => assertDeliverableUrl(url), 400, 'Webhook URL must not target a private host');
    },
  );

  it('rejects credentials embedded in the URL', () => {
    expectApiError(
      () => assertDeliverableUrl('https://user:pass@example.com/h'),
      400,
      'Webhook URL must not contain credentials',
    );
  });

  it('accepts a public IPv4 literal', () => {
    expect(assertDeliverableUrl('http://8.8.8.8/hook')).toBe('http://8.8.8.8/hook');
  });
});

describe('webhook signing', () => {
  it('produces a sha256= header of the expected shape', () => {
    const header = signWebhookBody('a-secret', 1700000000, '{"a":1}');
    expect(header.startsWith('sha256=')).toBe(true);
    expect(header.length).toBe(7 + 64);
  });

  it('verifies a matching signature and rejects a mismatched timestamp', () => {
    const secret = 'a-secret';
    const header = signWebhookBody(secret, 1700000000, '{"a":1}');
    expect(verifyWebhookSignature(secret, 1700000000, '{"a":1}', header)).toBe(true);
    expect(verifyWebhookSignature(secret, 1700000001, '{"a":1}', header)).toBe(false);
  });

  it('rejects a truncated header without throwing', () => {
    const secret = 'a-secret';
    const header = signWebhookBody(secret, 1700000000, '{"a":1}');
    expect(verifyWebhookSignature(secret, 1700000000, '{"a":1}', header.slice(0, 20))).toBe(false);
  });

  it('generates distinct 64-char hex secrets', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('webhook endpoints API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let userC: SeededUser;
  let userAccountant: SeededUser;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
    orgA = userA.orgId;
    orgB = userC.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
    await addMember(orgA, userB.id, 'ADMIN');
    await addMember(orgB, userB.id, 'ADMIN');

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');
  });

  afterAll(closePool);

  it('creates an endpoint with a 201 and a 64-hex secret', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/a', label: 'Slack', eventTypes: ['invoice.issued'] });

    expect(res.status).toBe(201);
    expect(res.body.endpoint.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.endpoint.eventTypes).toEqual(['invoice.issued']);
  });

  it('never leaks a secret through the list or detail routes', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/b', label: 'Ops', eventTypes: ['bill.approved'] });
    const secret = created.body.endpoint.secret as string;

    const list = await agent.get(BASE);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(secret);

    const detail = await agent.get(`${BASE}/${created.body.endpoint.id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain(secret);
  });

  it('rejects a duplicate URL in the same org with 409', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).send({ url: 'https://hooks.example.com/dup', label: 'One', eventTypes: ['invoice.issued'] });
    const res = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/dup', label: 'Two', eventTypes: ['invoice.issued'] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A webhook endpoint with this URL already exists');
  });

  it('rejects an empty eventTypes array', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(BASE).send({ url: 'https://hooks.example.com/c', label: 'X', eventTypes: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown event type', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/d', label: 'X', eventTypes: ['not.an.event'] });
    expect(res.status).toBe(400);
  });

  it('PATCH toggles isActive as ADMIN', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await ownerAgent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/e', label: 'X', eventTypes: ['invoice.issued'] });

    const adminAgent = await switchTo(await loginAgent(app, userB), orgA);
    const res = await adminAgent.patch(`${BASE}/${created.body.endpoint.id}`).send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.endpoint.isActive).toBe(false);
  });

  it('PATCH with no fields is a 400', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/f', label: 'X', eventTypes: ['invoice.issued'] });
    const res = await agent.patch(`${BASE}/${created.body.endpoint.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('DELETE is forbidden for ADMIN', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await ownerAgent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/g', label: 'X', eventTypes: ['invoice.issued'] });

    const adminAgent = await switchTo(await loginAgent(app, userB), orgA);
    const res = await adminAgent.delete(`${BASE}/${created.body.endpoint.id}`);
    expect(res.status).toBe(403);
  });

  it('DELETE succeeds for OWNER with a 204 and empty body', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/h', label: 'X', eventTypes: ['invoice.issued'] });

    const res = await agent.delete(`${BASE}/${created.body.endpoint.id}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('rotate-secret as OWNER returns a different secret', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/i', label: 'X', eventTypes: ['invoice.issued'] });
    const original = created.body.endpoint.secret as string;

    const res = await agent.post(`${BASE}/${created.body.endpoint.id}/rotate-secret`);
    expect(res.status).toBe(200);
    expect(res.body.endpoint.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.endpoint.secret).not.toBe(original);
  });

  it('rotate-secret is forbidden for ACCOUNTANT', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await ownerAgent
      .post(BASE)
      .send({ url: 'https://hooks.example.com/j', label: 'X', eventTypes: ['invoice.issued'] });

    const accountantAgent = await switchTo(await loginAgent(app, userAccountant), orgA);
    const res = await accountantAgent.post(`${BASE}/${created.body.endpoint.id}/rotate-secret`);
    expect(res.status).toBe(403);
  });

  it('every route 401s with no session', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  describe('cross-tenant isolation', () => {
    it('org A never sees org B endpoints in the raw response text', async () => {
      const agentA = await loginAgent(app, userA);
      await agentA.post(BASE).send({ url: 'https://hooks.example.com/orgA', label: 'A label', eventTypes: ['invoice.issued'] });

      const agentC = await loginAgent(app, userC);
      const createdB = await agentC
        .post(BASE)
        .send({ url: 'https://hooks.example.com/orgB', label: 'B label', eventTypes: ['invoice.issued'] });

      const listAsA = await agentA.get(BASE);
      expect(listAsA.status).toBe(200);
      expect(listAsA.text).not.toContain(createdB.body.endpoint.id);
      expect(listAsA.text).not.toContain('B label');
      expect(listAsA.text).not.toContain('orgB');
    });

    it('GET/:id with org B id under org A token is 404', async () => {
      const agentC = await loginAgent(app, userC);
      const createdB = await agentC
        .post(BASE)
        .send({ url: 'https://hooks.example.com/orgB2', label: 'B2', eventTypes: ['invoice.issued'] });

      const agentA = await loginAgent(app, userA);
      const res = await agentA.get(`${BASE}/${createdB.body.endpoint.id}`);
      expect(res.status).toBe(404);
    });

    it('PATCH and DELETE with a foreign id are 404 and leave the row unchanged', async () => {
      const agentC = await loginAgent(app, userC);
      const createdB = await agentC
        .post(BASE)
        .send({ url: 'https://hooks.example.com/orgB3', label: 'B3', eventTypes: ['invoice.issued'] });

      const agentA = await loginAgent(app, userA);
      const patchRes = await agentA.patch(`${BASE}/${createdB.body.endpoint.id}`).send({ isActive: false });
      expect(patchRes.status).toBe(404);

      const deleteRes = await agentA.delete(`${BASE}/${createdB.body.endpoint.id}`);
      expect(deleteRes.status).toBe(404);

      const stillThere = await agentC.get(`${BASE}/${createdB.body.endpoint.id}`);
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.endpoint.isActive).toBe(true);
    });

    it('a forged orgId in query, header and body is ignored — byte-identical response', async () => {
      const agentA = await loginAgent(app, userA);
      await agentA.post(BASE).send({ url: 'https://hooks.example.com/forge', label: 'Forge', eventTypes: ['invoice.issued'] });

      const honest = await agentA.get(BASE);
      const forged = await agentA.get(BASE).query({ orgId: orgB }).set('X-Org-Id', orgB).send({ orgId: orgB });

      expect(forged.status).toBe(200);
      expect(forged.body).toEqual(honest.body);
    });

    it('userB, after switching to org B, does see org B endpoints', async () => {
      const agentC = await loginAgent(app, userC);
      const createdB = await agentC
        .post(BASE)
        .send({ url: 'https://hooks.example.com/orgB4', label: 'B4', eventTypes: ['invoice.issued'] });

      const bobAgent = await switchTo(await loginAgent(app, userB), orgB);
      const res = await bobAgent.get(BASE);
      expect(res.status).toBe(200);
      expect(res.body.endpoints.map((e: { id: string }) => e.id)).toContain(createdB.body.endpoint.id);
    });
  });
});

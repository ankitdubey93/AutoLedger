import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { closePool, pool } from '../../db/connect.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { QUEUE_NAMES } from '../../types/jobs.js';
import { createUserWithOrg, loginAgent, resetTables, clearStorage, buildTestPdf } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { handleInboundMailProcess } from '../../queue/handlers/inboundMailProcessHandler.js';

/**
 * Phase 43d — email-in for the bill inbox. Brevo is faked: the webhook is
 * POSTed with supertest and the attachment download is a stubbed global fetch
 * that never reaches the network. The queue job is run inline by taking its
 * payload off the real queue and handing it to the real handler.
 */

const app = createApp();
const BASE = '/api/v1/integrations/inbound-mail';
const DOMAIN = 'in.example.test';
const SECRET = 's'.repeat(40);
const HOOK = `/api/v1/public/inbound-mail/brevo/${SECRET}`;

// env is parsed once at import; the feature switch is process-wide, so this
// file flips the runtime object for its own duration and restores it.
type MutableEnv = { -readonly [K in keyof typeof env]: (typeof env)[K] };
const mutableEnv = env as MutableEnv;
const original = {
  INBOUND_MAIL: env.INBOUND_MAIL,
  INBOUND_MAIL_DOMAIN: env.INBOUND_MAIL_DOMAIN,
  INBOUND_MAIL_WEBHOOK_SECRET: env.INBOUND_MAIL_WEBHOOK_SECRET,
  BREVO_API_KEY: env.BREVO_API_KEY,
};

const PDF = buildTestPdf(['Invoice 100', 'Total 12.00']);

function email(messageId: string, recipients: string[], attachments: { name: string; type: string; token: string }[]) {
  return {
    items: [
      {
        MessageId: messageId,
        From: { Address: 'Vendor@Example.com' },
        Recipients: recipients,
        Subject: 'Your invoice',
        Attachments: attachments.map((a) => ({
          Name: a.name,
          ContentType: a.type,
          ContentLength: PDF.length,
          DownloadToken: a.token,
        })),
      },
    ],
  };
}

async function countCaptureDocs(orgId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM ap_flow_documents WHERE org_id = $1', [orgId]);
  return Number(rows[0]?.n ?? '0');
}

async function runQueuedJobs(): Promise<number> {
  const jobs = await queues['inbound-mail-process'].getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  for (const job of jobs) {
    await handleInboundMailProcess(job.data);
    await job.remove();
  }
  return jobs.length;
}

async function messageRows(orgId: string) {
  const { rows } = await pool.query<{ status: string; attachment_count: number; imported_count: number; error: string | null }>(
    'SELECT status, attachment_count, imported_count, error FROM inbound_messages WHERE org_id = $1 ORDER BY created_at',
    [orgId],
  );
  return rows;
}

describe('email-in (Phase 43d)', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    mutableEnv.INBOUND_MAIL = 'brevo';
    mutableEnv.INBOUND_MAIL_DOMAIN = DOMAIN;
    mutableEnv.INBOUND_MAIL_WEBHOOK_SECRET = SECRET;
    mutableEnv.BREVO_API_KEY = 'test-key';
  });

  afterAll(async () => {
    Object.assign(mutableEnv, original);
    await Promise.all(QUEUE_NAMES.map((name) => queues[name].obliterate({ force: true })).map((p) => p.catch(() => undefined)));
    await closeQueues();
    await closePool();
  });

  beforeEach(async () => {
    await resetTables();
    await clearStorage();
    await Promise.all(QUEUE_NAMES.map((name) => queues[name].obliterate({ force: true })).map((p) => p.catch(() => undefined)));
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    fetchMock = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://api.brevo.com/v3/inbound/attachments/')) {
        return Promise.resolve(new Response(new Uint8Array(PDF), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mutableEnv.INBOUND_MAIL = 'brevo';
  });

  async function addressOf(user: SeededUser): Promise<{ address: string; token: string }> {
    const agent = await loginAgent(app, user);
    const res = await agent.get(BASE);
    expect(res.status).toBe(200);
    const address = res.body.address as string;
    return { address, token: address.split('@')[0] ?? '' };
  }

  it('creates and returns an address ending @<domain>, stable across reads', async () => {
    const first = await addressOf(userA);
    expect(first.address).toMatch(new RegExp(`^[a-z2-7]{16}@${DOMAIN.replace(/\./g, '\\.')}$`));
    const second = await addressOf(userA);
    expect(second.address).toBe(first.address);
  });

  it('rotating issues a new token and the old one no longer routes', async () => {
    const agent = await loginAgent(app, userA);
    const old = await addressOf(userA);
    const rotated = await agent.post(`${BASE}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.address).not.toBe(old.address);
    expect(rotated.body.rotatedAt).not.toBeNull();

    const res = await agent.post(HOOK).send(email('m-old', [old.address], [{ name: 'a.pdf', type: 'application/pdf', token: 't1' }]));
    // Anonymous requests are fine here: the hook needs no session. (agent keeps cookies; harmless.)
    expect(res.status).toBe(200);
    expect(await messageRows(userA.orgId)).toEqual([]);

    const fresh = await agent.post(HOOK).send(email('m-new', [rotated.body.address], [{ name: 'a.pdf', type: 'application/pdf', token: 't1' }]));
    expect(fresh.status).toBe(200);
    expect(await messageRows(userA.orgId)).toHaveLength(1);
  });

  it('a wrong secret is a 404 and stores nothing', async () => {
    const a = await addressOf(userA);
    const body = email('m1', [a.address], [{ name: 'a.pdf', type: 'application/pdf', token: 't1' }]);
    const wrongSameLength = await loginAgent(app, userA).then((g) => g.post(`/api/v1/public/inbound-mail/brevo/${'x'.repeat(40)}`).send(body));
    expect(wrongSameLength.status).toBe(404);
    const wrongLength = await loginAgent(app, userA).then((g) => g.post('/api/v1/public/inbound-mail/brevo/short').send(body));
    expect(wrongLength.status).toBe(404);
    expect(await messageRows(userA.orgId)).toEqual([]);
    expect(await queues['inbound-mail-process'].getJobs(['waiting', 'delayed', 'active'])).toHaveLength(0);
  });

  it('a PDF attachment lands in the bill inbox for the right organization and the message is IMPORTED', async () => {
    const a = await addressOf(userA);
    const agent = await loginAgent(app, userA);
    const res = await agent.post(HOOK).send(email('m1', [a.address.toUpperCase()], [{ name: 'inv.pdf', type: 'application/pdf', token: 'tok/1' }]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    expect(await runQueuedJobs()).toBe(1);
    expect(await countCaptureDocs(userA.orgId)).toBe(1);
    expect(await countCaptureDocs(userB.orgId)).toBe(0);
    const [message] = await messageRows(userA.orgId);
    expect(message).toMatchObject({ status: 'IMPORTED', attachment_count: 1, imported_count: 1, error: null });
    // The download token is URL-encoded and sent with the api key.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v3/inbound/attachments/'));
    expect(String(call?.[0])).toBe('https://api.brevo.com/v3/inbound/attachments/tok%2F1');
    expect((call?.[1] as RequestInit).headers).toEqual({ 'api-key': 'test-key' });
  });

  it('the same MessageId again creates no second message and no second capture document', async () => {
    const a = await addressOf(userA);
    const agent = await loginAgent(app, userA);
    const payload = email('m1', [a.address], [{ name: 'inv.pdf', type: 'application/pdf', token: 't1' }]);
    await agent.post(HOOK).send(payload);
    await runQueuedJobs();
    const again = await agent.post(HOOK).send(payload);
    expect(again.status).toBe(200);
    expect(await runQueuedJobs()).toBe(0);
    expect(await messageRows(userA.orgId)).toHaveLength(1);
    expect(await countCaptureDocs(userA.orgId)).toBe(1);
  });

  it('a message with only a .docx is REJECTED and nothing is downloaded', async () => {
    const a = await addressOf(userA);
    const agent = await loginAgent(app, userA);
    await agent.post(HOOK).send(
      email('m1', [a.address], [
        { name: 'terms.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', token: 't1' },
      ]),
    );
    await runQueuedJobs();
    const [message] = await messageRows(userA.orgId);
    expect(message).toMatchObject({ status: 'REJECTED', imported_count: 0, error: 'No PDF, PNG or JPEG attachment' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v3/inbound/attachments/'))).toBe(false);
    expect(await countCaptureDocs(userA.orgId)).toBe(0);
  });

  it("cross-tenant: org B's address creates nothing in org A, and each organization lists only its own messages", async () => {
    await addressOf(userA);
    const b = await addressOf(userB);
    const agentA = await loginAgent(app, userA);
    const agentB = await loginAgent(app, userB);

    await agentA.post(HOOK).send(email('m-b', [b.address, `unknown0000000000@${DOMAIN}`, 'someone@other.test'], [{ name: 'inv.pdf', type: 'application/pdf', token: 't1' }]));
    await runQueuedJobs();

    expect(await messageRows(userA.orgId)).toEqual([]);
    expect(await countCaptureDocs(userA.orgId)).toBe(0);
    expect(await countCaptureDocs(userB.orgId)).toBe(1);

    const listA = await agentA.get(`${BASE}/messages`);
    expect(listA.status).toBe(200);
    expect(listA.body.messages).toEqual([]);
    expect(listA.body.totalCount).toBe(0);
    const listB = await agentB.get(`${BASE}/messages`);
    expect(listB.body.messages).toHaveLength(1);
    expect(listB.body).toMatchObject({ totalCount: 1, currentPage: 1, totalPages: 1 });
    expect(listB.body.messages[0]).toMatchObject({ fromAddress: 'vendor@example.com', status: 'IMPORTED', importedCount: 1 });
  });

  it('INBOUND_MAIL=off makes the webhook and the authenticated routes 404', async () => {
    const a = await addressOf(userA);
    const agent = await loginAgent(app, userA);
    mutableEnv.INBOUND_MAIL = 'off';
    const hook = await agent.post(HOOK).send(email('m1', [a.address], [{ name: 'inv.pdf', type: 'application/pdf', token: 't1' }]));
    expect(hook.status).toBe(404);
    expect((await agent.get(BASE)).status).toBe(404);
    expect((await agent.get(`${BASE}/messages`)).status).toBe(404);
    expect(await messageRows(userA.orgId)).toEqual([]);
  });
});

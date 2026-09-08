import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { pool, closePool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { emitEvent } from '../../services/outboxService.js';
import { handleOutboxDrain } from '../../queue/handlers/outboxDrainHandler.js';
import { handleWebhookDeliver } from '../../queue/handlers/webhookDeliverHandler.js';
import { verifyWebhookSignature } from '../../utils/webhookSignature.js';
import { closeQueues, queues } from '../../queue/queues.js';
import { startWorkers, stopWorkers } from '../../queue/worker.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const BASE = '/api/v1/webhook-deliveries';
const SECRET = 'b'.repeat(64);

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('webhook delivery', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeQueues();
    await closePool();
  });

  async function createEndpoint(orgId: string, createdBy: string, url: string) {
    const { rows } = await withTransaction((client) =>
      client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, url, label, secret, event_types, created_by)
         VALUES ($1, $2, 'Test', $3, $4, $5)
         RETURNING id`,
        [orgId, url, SECRET, ['invoice.issued'], createdBy],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixture insert failed');
    return row.id;
  }

  async function createDelivery(orgId: string, createdBy: string, url: string) {
    await createEndpoint(orgId, createdBy, url);
    await withTransaction((client) => emitEvent(client, orgId, 'ledger-core', 'invoice.issued', { total: 100 }));
    await handleOutboxDrain();

    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM webhook_deliveries WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixture drain produced no delivery');
    return row.id;
  }

  it('a 200 response marks the delivery DELIVERED', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/ok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await handleWebhookDeliver({ deliveryId });

    const { rows } = await pool.query<{ status: string; attempt_count: number; last_status_code: number; delivered_at: Date | null }>(
      'SELECT status, attempt_count, last_status_code, delivered_at FROM webhook_deliveries WHERE id = $1',
      [deliveryId],
    );
    const row = rows[0]!;
    expect(row.status).toBe('DELIVERED');
    expect(row.attempt_count).toBe(1);
    expect(row.last_status_code).toBe(200);
    expect(row.delivered_at).not.toBeNull();
  });

  it('the request carries a valid signature', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/sig');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await handleWebhookDeliver({ deliveryId });

    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    const timestamp = Number(headers['X-AutoLedger-Timestamp']);
    expect(verifyWebhookSignature(SECRET, timestamp, body, headers['X-AutoLedger-Signature']!)).toBe(true);
  });

  it('the request body carries deliveryId, eventId, eventType, orgId and data', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/body');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await handleWebhookDeliver({ deliveryId });

    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const parsed = JSON.parse(init.body as string);
    expect(parsed.deliveryId).toBe(deliveryId);
    expect(typeof parsed.eventId).toBe('string');
    expect(parsed.eventType).toBe('invoice.issued');
    expect(parsed.orgId).toBe(orgA);
    expect(parsed.data).toEqual({ total: 100 });
  });

  it('a 500 response throws and records the attempt', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/500');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('server error', { status: 500 }));

    await expect(handleWebhookDeliver({ deliveryId })).rejects.toThrow();

    const { rows } = await pool.query<{ status: string; attempt_count: number; last_status_code: number }>(
      'SELECT status, attempt_count, last_status_code FROM webhook_deliveries WHERE id = $1',
      [deliveryId],
    );
    const row = rows[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempt_count).toBe(1);
    expect(row.last_status_code).toBe(500);
  });

  it('a network error throws and records a null status code', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/neterr');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(handleWebhookDeliver({ deliveryId })).rejects.toThrow();

    const { rows } = await pool.query<{ status: string; attempt_count: number; last_status_code: number | null; last_error: string | null }>(
      'SELECT status, attempt_count, last_status_code, last_error FROM webhook_deliveries WHERE id = $1',
      [deliveryId],
    );
    const row = rows[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempt_count).toBe(1);
    expect(row.last_status_code).toBeNull();
    expect(row.last_error).not.toBeNull();
  });

  it('a delivery already DELIVERED is not re-sent', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/nodup');
    await pool.query(
      "UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = now(), last_status_code = 200 WHERE id = $1",
      [deliveryId],
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await handleWebhookDeliver({ deliveryId });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no secret appears in the fetch body', async () => {
    const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/nosecret');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await handleWebhookDeliver({ deliveryId });

    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.body as string).not.toContain(SECRET);
  });

  describe('GET/retry API', () => {
    it('GET rejects an unknown status filter with 400', async () => {
      const agent = await loginAgent(app, userA);
      const res = await agent.get(`${BASE}?status=NOPE`);
      expect(res.status).toBe(400);
    });

    it('retry on a FAILED delivery returns 202 and moves it back to PENDING', async () => {
      const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/retry-failed');
      await pool.query("UPDATE webhook_deliveries SET status = 'FAILED', last_error = 'boom' WHERE id = $1", [deliveryId]);

      const agent = await loginAgent(app, userA);
      const res = await agent.post(`${BASE}/${deliveryId}/retry`);
      expect(res.status).toBe(202);

      const { rows } = await pool.query<{ status: string }>('SELECT status FROM webhook_deliveries WHERE id = $1', [deliveryId]);
      expect(rows[0]!.status).toBe('PENDING');
    });

    it('retry on a DELIVERED delivery is 409', async () => {
      const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/retry-delivered');
      await pool.query("UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = now(), last_status_code = 200 WHERE id = $1", [deliveryId]);

      const agent = await loginAgent(app, userA);
      const res = await agent.post(`${BASE}/${deliveryId}/retry`);
      expect(res.status).toBe(409);
    });

    it('retry on a PENDING delivery is 409', async () => {
      const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/retry-pending');

      const agent = await loginAgent(app, userA);
      const res = await agent.post(`${BASE}/${deliveryId}/retry`);
      expect(res.status).toBe(409);
    });

    it('retry is forbidden for ACCOUNTANT', async () => {
      const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/retry-403');
      await pool.query("UPDATE webhook_deliveries SET status = 'FAILED', last_error = 'boom' WHERE id = $1", [deliveryId]);

      const agent = await switchTo(await loginAgent(app, userAccountant), orgA);
      const res = await agent.post(`${BASE}/${deliveryId}/retry`);
      expect(res.status).toBe(403);
    });

    describe('cross-tenant isolation', () => {
      it('org A never sees org B deliveries in the raw response text', async () => {
        await createDelivery(orgA, userA.id, 'https://hooks.example.com/isoA');
        const deliveryIdB = await createDelivery(orgB, userC.id, 'https://hooks.example.com/isoB');

        const agentA = await loginAgent(app, userA);
        const res = await agentA.get(BASE);
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(deliveryIdB);
      });

      it('GET/:id and retry with a foreign id are 404', async () => {
        const deliveryIdB = await createDelivery(orgB, userC.id, 'https://hooks.example.com/isoB2');
        await pool.query("UPDATE webhook_deliveries SET status = 'FAILED', last_error = 'x' WHERE id = $1", [deliveryIdB]);

        const agentA = await loginAgent(app, userA);
        const getRes = await agentA.get(`${BASE}/${deliveryIdB}`);
        expect(getRes.status).toBe(404);

        const retryRes = await agentA.post(`${BASE}/${deliveryIdB}/retry`);
        expect(retryRes.status).toBe(404);
      });

      it('userB, after switching to org B, does see org B deliveries', async () => {
        const deliveryIdB = await createDelivery(orgB, userC.id, 'https://hooks.example.com/isoB3');

        const bobAgent = await switchTo(await loginAgent(app, userB), orgB);
        const res = await bobAgent.get(BASE);
        expect(res.status).toBe(200);
        expect(res.body.deliveries.map((d: { id: string }) => d.id)).toContain(deliveryIdB);
      });

      it('no response body ever contains an endpoint secret', async () => {
        const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/nosecret2');

        const agent = await loginAgent(app, userA);
        const list = await agent.get(BASE);
        expect(list.text).not.toContain(SECRET);

        const detail = await agent.get(`${BASE}/${deliveryId}`);
        expect(detail.text).not.toContain(SECRET);
      });
    });
  });

  describe('the real worker wiring', () => {
    it('exhausting retries on webhook-deliver marks the delivery FAILED and dead-letters the job', async () => {
      const deliveryId = await createDelivery(orgA, userA.id, 'https://hooks.example.com/exhaust');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));

      await startWorkers();
      try {
        await queues['dead-letter'].obliterate({ force: true });
        await queues['webhook-deliver'].add('webhook-deliver', { deliveryId }, { jobId: `delivery-${deliveryId}` });

        const deadline = Date.now() + 10_000;
        let status = 'PENDING';
        while (Date.now() < deadline) {
          const { rows } = await pool.query<{ status: string }>(
            'SELECT status FROM webhook_deliveries WHERE id = $1',
            [deliveryId],
          );
          status = rows[0]!.status;
          if (status === 'FAILED') break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(status).toBe('FAILED');
        const dlqCount = await queues['dead-letter'].getWaitingCount();
        expect(dlqCount).toBeGreaterThanOrEqual(1);
      } finally {
        await stopWorkers();
      }
    }, 15_000);
  });
});

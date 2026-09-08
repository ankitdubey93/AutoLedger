import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, closePool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { emitEvent } from '../../services/outboxService.js';
import { handleOutboxDrain } from '../../queue/handlers/outboxDrainHandler.js';
import { queues, closeQueues } from '../../queue/queues.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Integration tier — requires real PostgreSQL and Redis. Proves the
 * transactional outbox's core guarantee (rollback leaves no event) and the
 * drain's fan-out, idempotency, and per-org scoping.
 */
describe('outbox drain', () => {
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
    await queues['webhook-deliver'].obliterate({ force: true });
  });

  afterAll(async () => {
    await closeQueues();
    await closePool();
  });

  async function createEndpoint(orgId: string, createdBy: string, url: string, eventTypes: string[], isActive = true) {
    const { rows } = await withTransaction((client) =>
      client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, url, label, secret, event_types, is_active, created_by)
         VALUES ($1, $2, 'Test', $3, $4, $5, $6)
         RETURNING id`,
        [orgId, url, 'a'.repeat(64), eventTypes, isActive, createdBy],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('fixture insert failed');
    return row.id;
  }

  it('emitEvent inside a transaction that rolls back leaves no row', async () => {
    const client = await pool.connect();
    try {
      await beginTransaction(client);
      await emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox_events');
    expect(rows[0]!.n).toBe(0);
  });

  it('emitEvent inside a committed transaction leaves exactly one unpublished row', async () => {
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    const { rows } = await pool.query<{ n: number; published_at: Date | null }>(
      'SELECT count(*)::int AS n, max(published_at) AS published_at FROM outbox_events',
    );
    expect(rows[0]!.n).toBe(1);
    expect(rows[0]!.published_at).toBeNull();
  });

  it('fans one event out to two subscribed endpoints', async () => {
    await createEndpoint(orgA, userA.id, 'https://hooks.example.com/1', ['invoice.issued']);
    await createEndpoint(orgA, userA.id, 'https://hooks.example.com/2', ['invoice.issued']);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    await handleOutboxDrain();

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'PENDING' AND event_type = 'invoice.issued'",
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('an inactive endpoint receives nothing', async () => {
    await createEndpoint(orgA, userA.id, 'https://hooks.example.com/inactive', ['invoice.issued'], false);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    await handleOutboxDrain();

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(rows[0]!.n).toBe(0);
  });

  it('an endpoint not subscribed to the event type receives nothing', async () => {
    await createEndpoint(orgA, userA.id, 'https://hooks.example.com/other', ['bill.approved']);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    await handleOutboxDrain();

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(rows[0]!.n).toBe(0);
  });

  it('an endpoint in another org receives nothing', async () => {
    await createEndpoint(orgB, userC.id, 'https://hooks.example.com/orgb', ['invoice.issued']);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    await handleOutboxDrain();

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(rows[0]!.n).toBe(0);
  });

  it('a second drain pass creates no duplicate deliveries', async () => {
    await createEndpoint(orgA, userA.id, 'https://hooks.example.com/dup', ['invoice.issued']);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));

    await handleOutboxDrain();
    await handleOutboxDrain();

    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_deliveries');
    expect(rows[0]!.n).toBe(1);

    const { rows: publishedRows } = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_events',
    );
    expect(publishedRows[0]!.published_at).not.toBeNull();
  });

  it('the stale sweep re-enqueues a PENDING delivery older than the threshold', async () => {
    const endpointId = await createEndpoint(orgA, userA.id, 'https://hooks.example.com/stale', ['invoice.issued']);
    await withTransaction((client) => emitEvent(client, orgA, 'ledger-core', 'invoice.issued', { x: 1 }));
    await handleOutboxDrain();

    // Simulate a genuinely lost enqueue: the job never made it into Redis
    // (the deterministic jobId means a job still sitting there would just
    // dedupe on re-add, which is a different, already-covered case).
    const { rows: deliveryRows } = await pool.query<{ id: string }>(
      'SELECT id FROM webhook_deliveries WHERE endpoint_id = $1',
      [endpointId],
    );
    const deliveryId = deliveryRows[0]!.id;
    const job = await queues['webhook-deliver'].getJob(`delivery-${deliveryId}`);
    await job?.remove();

    // Back-date the delivery so it looks like its enqueue was lost.
    // trg_webhook_deliveries_updated_at otherwise forces updated_at back to
    // now() on every UPDATE, so the trigger must be disabled for this one
    // statement — same pattern integrity.test.ts uses to prove a guarantee
    // by bypassing the mechanism that would normally hold it.
    await pool.query('ALTER TABLE webhook_deliveries DISABLE TRIGGER USER');
    try {
      await pool.query(
        `UPDATE webhook_deliveries SET updated_at = now() - INTERVAL '10 minutes' WHERE endpoint_id = $1`,
        [endpointId],
      );
    } finally {
      await pool.query('ALTER TABLE webhook_deliveries ENABLE TRIGGER USER');
    }

    const before = await queues['webhook-deliver'].getWaitingCount();
    await handleOutboxDrain();
    const after = await queues['webhook-deliver'].getWaitingCount();

    expect(after).toBeGreaterThan(before);
  });
});

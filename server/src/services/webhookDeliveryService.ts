import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { canTransitionDelivery } from '../types/webhooks.js';
import type {
  ClaimedOutboxEvent,
  ListDeliveriesOptions,
  OutboxEventType,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus,
} from '../types/webhooks.js';

/**
 * Webhook delivery attempts — one row per (event, subscribed endpoint),
 * created by the drain and updated by the send handler. Every
 * request-serving function here carries `org_id` (guardrails rule 1); the
 * two worker-side functions are documented exceptions, same reasoning as
 * outboxService.claimUnpublishedEvents.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  endpoint_label: string;
  endpoint_url: string;
  event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DeliveryDetailRow extends DeliveryRow {
  payload: Record<string, unknown>;
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    endpointLabel: row.endpoint_label,
    endpointUrl: row.endpoint_url,
    eventId: row.event_id,
    eventType: row.event_type as OutboxEventType,
    status: row.status as WebhookDeliveryStatus,
    attemptCount: row.attempt_count,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    deliveredAt: row.delivered_at === null ? null : row.delivered_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDetail(row: DeliveryDetailRow): WebhookDeliveryDetail {
  return { ...toDelivery(row), payload: row.payload };
}

const DELIVERY_JOIN = `
    FROM webhook_deliveries d
    INNER JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id`;

const DELIVERY_SELECT = `SELECT d.id, d.endpoint_id, e.label AS endpoint_label, e.url AS endpoint_url,
                                 d.event_id, d.event_type, d.status, d.attempt_count,
                                 d.last_status_code, d.last_error, d.delivered_at,
                                 d.created_at, d.updated_at${DELIVERY_JOIN}`;

function buildFilters(orgId: string, options: ListDeliveriesOptions): { where: string; values: unknown[] } {
  const values: unknown[] = [
    orgId,
    options.endpointId,
    options.status,
    options.eventType,
    options.from,
    options.to,
  ];

  const where = `d.org_id = $1
      AND ($2::uuid IS NULL OR d.endpoint_id = $2)
      AND ($3::text IS NULL OR d.status = $3)
      AND ($4::text IS NULL OR d.event_type = $4)
      AND ($5::date IS NULL OR d.created_at >= $5::date)
      AND ($6::date IS NULL OR d.created_at < ($6::date + 1))`;

  return { where, values };
}

export async function listDeliveries(
  orgId: string,
  options: ListDeliveriesOptions,
): Promise<{ deliveries: WebhookDelivery[]; totalCount: number }> {
  const { where, values } = buildFilters(orgId, options);
  const offset = (options.page - 1) * options.limit;

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total${DELIVERY_JOIN} WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const { rows } = await pool.query<DeliveryRow>(
    `${DELIVERY_SELECT}
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { deliveries: rows.map(toDelivery), totalCount };
}

export async function getDeliveryById(orgId: string, id: string): Promise<WebhookDeliveryDetail> {
  try {
    const { rows } = await pool.query<DeliveryDetailRow>(
      `SELECT d.id, d.endpoint_id, e.label AS endpoint_label, e.url AS endpoint_url,
              d.event_id, d.event_type, d.payload, d.status, d.attempt_count,
              d.last_status_code, d.last_error, d.delivered_at,
              d.created_at, d.updated_at${DELIVERY_JOIN}
        WHERE d.org_id = $1 AND d.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Webhook delivery not found');
    return toDetail(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Webhook delivery not found');
    }
    throw err;
  }
}

interface DeliveryForSend {
  id: string;
  orgId: string;
  endpointId: string;
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  createdAt: string;
}

/**
 * Worker-side read. A worker holds no access token, so there is no verified
 * org to scope by (guardrails rule 1 governs request handling; this serves
 * no request). The safety property is that the job payload carries an
 * opaque id and NOTHING ELSE — org_id, url and secret are all read back
 * from the row, so a tampered payload can only name a different delivery,
 * never widen one delivery's scope. Every org_id used downstream comes from
 * this row.
 */
export async function getDeliveryForSend(deliveryId: string): Promise<DeliveryForSend | null> {
  const { rows } = await pool.query<{
    id: string;
    org_id: string;
    endpoint_id: string;
    url: string;
    secret: string;
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    status: string;
    attempt_count: number;
    created_at: Date;
  }>(
    `SELECT d.id, d.org_id, d.endpoint_id, e.url, e.secret, d.event_id, d.event_type,
            d.payload, d.status, d.attempt_count, d.created_at
       FROM webhook_deliveries d
       INNER JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id
      WHERE d.id = $1`,
    [deliveryId],
  );

  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    orgId: row.org_id,
    endpointId: row.endpoint_id,
    url: row.url,
    secret: row.secret,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status as WebhookDeliveryStatus,
    attemptCount: row.attempt_count,
    createdAt: row.created_at.toISOString(),
  };
}

/** Drain-side fan-out. Returns the ids of the deliveries actually created. */
export async function createDeliveriesForEvent(
  client: PoolClient,
  event: ClaimedOutboxEvent,
  endpointIds: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const endpointId of endpointIds) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
       VALUES ($1, $2, $3::bigint, $4, $5::jsonb)
       ON CONFLICT (event_id, endpoint_id) DO NOTHING
       RETURNING id`,
      [event.orgId, endpointId, event.id, event.eventType, JSON.stringify(event.payload)],
    );
    const row = rows[0];
    if (row !== undefined) ids.push(row.id);
  }
  return ids;
}

// recordAttempt/markDelivered/markFailed are worker-side, like
// getDeliveryForSend above: no verified org exists in this context. Each
// takes only a deliveryId — an unguessable UUID that only ever reaches a job
// payload after passing through an org-scoped read (getDeliveryForSend or
// requeueDelivery), never from request input directly — so adding an org_id
// parameter here would re-scope a value that was already scoped one step
// earlier, with no additional safety property.
export async function recordAttempt(
  deliveryId: string,
  statusCode: number | null,
  error: string | null,
): Promise<void> {
  await withTransaction((client) =>
    client.query(
      `UPDATE webhook_deliveries
          SET attempt_count = attempt_count + 1,
              last_status_code = $2,
              last_error = $3
        WHERE id = $1`,
      [deliveryId, statusCode, error],
    ),
  );
}

export async function markDelivered(deliveryId: string, statusCode: number): Promise<void> {
  await withTransaction((client) =>
    client.query(
      `UPDATE webhook_deliveries
          SET status = 'DELIVERED', delivered_at = now(), last_status_code = $2, last_error = NULL
        WHERE id = $1 AND status = 'PENDING'`,
      [deliveryId, statusCode],
    ),
  );
}

export async function markFailed(deliveryId: string, error: string): Promise<void> {
  await withTransaction((client) =>
    client.query(
      `UPDATE webhook_deliveries
          SET status = 'FAILED', last_error = $2
        WHERE id = $1 AND status = 'PENDING'`,
      [deliveryId, error],
    ),
  );
}

// Same documented unscoped-by-design exemption as getDeliveryForSend: this
// serves no request, and every downstream use re-scopes by the row's own
// org_id.
/** Drain-side sweep: PENDING deliveries whose enqueue was lost. */
export async function claimStaleDeliveries(
  client: PoolClient,
  olderThanMs: number,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries
      WHERE status = 'PENDING'
        AND updated_at < now() - ($1::int * INTERVAL '1 millisecond')
      ORDER BY updated_at
      FOR UPDATE SKIP LOCKED
      LIMIT $2`,
    [olderThanMs, limit],
  );
  return rows.map((r) => r.id);
}

/** Operator replay. FAILED -> PENDING only. */
export async function requeueDelivery(orgId: string, id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM webhook_deliveries WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Webhook delivery not found');

  const currentStatus = row.status as WebhookDeliveryStatus;
  if (!canTransitionDelivery(currentStatus, 'PENDING')) {
    throw new ApiError(409, `A delivery in status ${currentStatus} cannot be retried`);
  }

  await withTransaction((client) =>
    client.query(
      `UPDATE webhook_deliveries SET status = 'PENDING', last_error = NULL
        WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    ),
  );

  return id;
}

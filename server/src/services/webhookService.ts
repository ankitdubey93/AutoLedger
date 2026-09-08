import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { assertDeliverableUrl } from '../utils/webhookUrl.js';
import { generateWebhookSecret } from '../utils/webhookSignature.js';
import type {
  CreateEndpointInput,
  OutboxEventType,
  UpdateEndpointInput,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from '../types/webhooks.js';

/**
 * Webhook endpoint configuration — the receivers a tenant registers for
 * outbound financial-event delivery (Phase 7).
 *
 * Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1).
 *
 * SELECT * is banned here — one careless star ships every tenant's HMAC key
 * to the browser. ENDPOINT_SELECT lists columns explicitly and never
 * includes `secret`. Only createEndpoint and rotateSecret ever return a
 * secret, and they return the value they just generated in JavaScript,
 * never a value read back from the table.
 */

const PG_UNIQUE_VIOLATION = '23505';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface EndpointRow {
  id: string;
  url: string;
  label: string;
  event_types: string[];
  is_active: boolean;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const ENDPOINT_SELECT = `SELECT e.id, e.url, e.label, e.event_types, e.is_active,
                                 e.created_by, u.name AS created_by_name,
                                 e.created_at, e.updated_at
                            FROM webhook_endpoints e
                            LEFT JOIN users u ON u.id = e.created_by`;

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    eventTypes: row.event_types as OutboxEventType[],
    isActive: row.is_active,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapUniqueViolation(err: unknown): never {
  if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
    throw new ApiError(409, 'A webhook endpoint with this URL already exists');
  }
  throw err;
}

export async function listEndpoints(orgId: string): Promise<WebhookEndpoint[]> {
  const { rows } = await pool.query<EndpointRow>(
    `${ENDPOINT_SELECT} WHERE e.org_id = $1 ORDER BY e.created_at DESC`,
    [orgId],
  );
  return rows.map(toEndpoint);
}

export async function getEndpointById(orgId: string, id: string): Promise<WebhookEndpoint> {
  try {
    const { rows } = await pool.query<EndpointRow>(
      `${ENDPOINT_SELECT} WHERE e.org_id = $1 AND e.id = $2`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Webhook endpoint not found');
    return toEndpoint(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Webhook endpoint not found');
    }
    throw err;
  }
}

export async function createEndpoint(
  orgId: string,
  createdBy: string,
  input: CreateEndpointInput,
): Promise<WebhookEndpointWithSecret> {
  const url = assertDeliverableUrl(input.url);
  const secret = generateWebhookSecret();

  try {
    const { rows } = await withTransaction((client) =>
      client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (org_id, url, label, secret, event_types, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [orgId, url, input.label, secret, input.eventTypes, createdBy],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    const endpoint = await getEndpointById(orgId, row.id);
    return { ...endpoint, secret };
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function updateEndpoint(
  orgId: string,
  id: string,
  input: UpdateEndpointInput,
): Promise<WebhookEndpoint> {
  if (input.url !== undefined) {
    input = { ...input, url: assertDeliverableUrl(input.url) };
  }

  const COLUMNS = {
    url: 'url',
    label: 'label',
    eventTypes: 'event_types',
    isActive: 'is_active',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [id, orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  try {
    const { rows } = await withTransaction((client) =>
      client.query<{ id: string }>(
        `UPDATE webhook_endpoints SET ${assignments.join(', ')}
          WHERE id = $1 AND org_id = $2
          RETURNING id`,
        values,
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Webhook endpoint not found');
    return await getEndpointById(orgId, row.id);
  } catch (err) {
    mapUniqueViolation(err);
  }
}

export async function deleteEndpoint(orgId: string, id: string): Promise<void> {
  // The composite FK's ON DELETE CASCADE removes this endpoint's delivery
  // history with it — a real data-loss consequence the operator is
  // choosing, which is why the route requires OWNER.
  const { rowCount } = await withTransaction((client) =>
    client.query('DELETE FROM webhook_endpoints WHERE org_id = $1 AND id = $2', [orgId, id]),
  );
  if (rowCount === 0) throw new ApiError(404, 'Webhook endpoint not found');
}

export async function rotateSecret(orgId: string, id: string): Promise<WebhookEndpointWithSecret> {
  const secret = generateWebhookSecret();
  const { rowCount } = await withTransaction((client) =>
    client.query('UPDATE webhook_endpoints SET secret = $3 WHERE org_id = $1 AND id = $2', [
      orgId,
      id,
      secret,
    ]),
  );
  if (rowCount === 0) throw new ApiError(404, 'Webhook endpoint not found');
  const endpoint = await getEndpointById(orgId, id);
  return { ...endpoint, secret };
}

/** Used by the drain handler only: active endpoints in one org subscribed to one event type. */
export async function listSubscribedEndpointsOnClient(
  client: PoolClient,
  orgId: string,
  eventType: string,
): Promise<{ id: string }[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints
      WHERE org_id = $1 AND is_active = TRUE AND $2 = ANY (event_types)
      ORDER BY created_at`,
    [orgId, eventType],
  );
  return rows;
}

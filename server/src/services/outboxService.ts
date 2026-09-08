import type { PoolClient } from 'pg';
import type { AppSlug } from '../config/apps.js';
import type { ClaimedOutboxEvent, OutboxEventType } from '../types/webhooks.js';

/**
 * Writes one event row INSIDE the caller's transaction. This is the whole
 * point of Phase 7's outbox: guardrails rule 5 forbids post-COMMIT
 * follow-up work, so an event must be committed atomically with the
 * financial fact it describes. If the invoice rolls back, the event rolls
 * back with it; if the invoice commits, the event is durably queued even if
 * Redis is down, because Redis is not involved yet.
 *
 * Takes the caller's `client`, never `pool` — a stray pool.query here would
 * commit an event for a document that never existed.
 */
export async function emitEvent(
  client: PoolClient,
  orgId: string,
  appSlug: AppSlug,
  eventType: OutboxEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (org_id, app_slug, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [orgId, appSlug, eventType, JSON.stringify(payload)],
  );
}

interface OutboxEventRow {
  id: string;
  org_id: string;
  app_slug: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

// The ONE query in src/services/ without an org_id predicate. It serves no
// request and no user: the drain is a system pass across every tenant's
// events, and it re-attaches each row's own org_id to everything it
// produces downstream (webhookDeliveryService scopes every later query by
// that value). db/integrity.ts is the codebase's other documented
// exemption. Do not copy this shape into a request-serving function.
/**
 * Claims up to `limit` unpublished events for this drain pass, marking them
 * published in the same statement. FOR UPDATE SKIP LOCKED is what makes two
 * concurrent workers safe: the second pass steps over rows the first has
 * locked instead of blocking on them or double-claiming them.
 */
export async function claimUnpublishedEvents(
  client: PoolClient,
  limit: number,
): Promise<ClaimedOutboxEvent[]> {
  const { rows } = await client.query<OutboxEventRow>(
    `UPDATE outbox_events
        SET published_at = now()
      WHERE id IN (
              SELECT id FROM outbox_events
               WHERE published_at IS NULL
               ORDER BY id
               FOR UPDATE SKIP LOCKED
               LIMIT $1
            )
     RETURNING id::text, org_id, app_slug, event_type, payload, created_at`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    appSlug: row.app_slug,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }));
}

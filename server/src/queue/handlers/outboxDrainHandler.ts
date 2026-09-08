import { withTransaction } from '../../db/transaction.js';
import { claimUnpublishedEvents } from '../../services/outboxService.js';
import { createDeliveriesForEvent, claimStaleDeliveries } from '../../services/webhookDeliveryService.js';
import { listSubscribedEndpointsOnClient } from '../../services/webhookService.js';
import { enqueue } from '../queues.js';
import { DELIVERY_REENQUEUE_AFTER_MS, OUTBOX_DRAIN_BATCH } from '../../config/constants.js';

/**
 * Runs every OUTBOX_DRAIN_INTERVAL_MS. Two passes, one transaction each:
 *
 *  1. Claim unpublished outbox events, fan each out to that org's active
 *     subscribed endpoints as PENDING webhook_deliveries rows.
 *  2. Sweep PENDING deliveries older than DELIVERY_REENQUEUE_AFTER_MS —
 *     the ones whose enqueue was lost because the process died between
 *     COMMIT and the Redis round trip.
 *
 * Pass 2 is what makes delivery AT-LEAST-ONCE. Enqueuing to Redis after the
 * transaction commits is not a rule-5 violation being smuggled back in: the
 * durable record is the committed PENDING row, and a lost enqueue costs a
 * delay, never an event. Receivers must dedupe on `deliveryId`.
 */
export async function handleOutboxDrain(): Promise<void> {
  const created = await withTransaction(async (client) => {
    const events = await claimUnpublishedEvents(client, OUTBOX_DRAIN_BATCH);
    const ids: string[] = [];
    for (const event of events) {
      const endpoints = await listSubscribedEndpointsOnClient(client, event.orgId, event.eventType);
      ids.push(...(await createDeliveriesForEvent(client, event, endpoints.map((e) => e.id))));
    }
    return ids;
  });

  const stale = await withTransaction((client) =>
    claimStaleDeliveries(client, DELIVERY_REENQUEUE_AFTER_MS, OUTBOX_DRAIN_BATCH),
  );

  // Sequential, not Promise.all: a burst of parallel `add`s on one
  // connection buys nothing here and makes a partial failure harder to
  // reason about.
  for (const deliveryId of [...created, ...stale]) {
    // BullMQ rejects ':' in a custom jobId (it is a reserved separator in
    // its own Redis key naming) — '-' is the safe delimiter.
    await enqueue('webhook-deliver', { deliveryId }, { jobId: `delivery-${deliveryId}` });
  }
}

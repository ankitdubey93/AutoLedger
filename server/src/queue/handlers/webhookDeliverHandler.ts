import { getDeliveryForSend, markDelivered, recordAttempt } from '../../services/webhookDeliveryService.js';
import { signWebhookBody } from '../../utils/webhookSignature.js';
import { WEBHOOK_ERROR_SNIPPET_CHARS, WEBHOOK_TIMEOUT_MS } from '../../config/constants.js';
import type { JobPayloads } from '../../types/jobs.js';

/**
 * Sends one webhook delivery attempt. Marking FAILED (the terminal state)
 * is NOT this handler's job — it happens once, in the worker's `failed`
 * listener, after every retry BullMQ granted has been spent.
 */
export async function handleWebhookDeliver(payload: JobPayloads['webhook-deliver']): Promise<void> {
  const delivery = await getDeliveryForSend(payload.deliveryId);

  if (delivery === null) {
    // The endpoint was deleted and its deliveries cascaded away; retrying
    // is pointless.
    console.warn(`[worker] webhook-deliver: delivery ${payload.deliveryId} no longer exists`);
    return;
  }

  if (delivery.status !== 'PENDING') {
    // A completed delivery must not be re-sent by a duplicate job.
    return;
  }

  const rawBody = JSON.stringify({
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    orgId: delivery.orgId,
    occurredAt: delivery.createdAt,
    data: delivery.payload,
  });

  const timestamp = Math.floor(Date.now() / 1000);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'AutoLedger-Webhooks/1',
    'X-AutoLedger-Delivery': delivery.id,
    'X-AutoLedger-Event': delivery.eventType,
    'X-AutoLedger-Timestamp': String(timestamp),
    'X-AutoLedger-Signature': signWebhookBody(delivery.secret, timestamp, rawBody),
  };

  let response: Response;
  try {
    response = await fetch(delivery.url, {
      method: 'POST',
      headers,
      body: rawBody,
      // A security control, not a preference — following a 302 would defeat
      // the write-time URL guard by letting the receiver point us at a
      // private address after validation.
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    await recordAttempt(delivery.id, null, message.slice(0, WEBHOOK_ERROR_SNIPPET_CHARS));
    throw err instanceof Error ? err : new Error(message);
  }

  if (response.status >= 200 && response.status < 300) {
    await recordAttempt(delivery.id, response.status, null);
    await markDelivered(delivery.id, response.status);
    return;
  }

  const snippet = (await response.text().catch(() => '')).slice(0, WEBHOOK_ERROR_SNIPPET_CHARS);
  await recordAttempt(delivery.id, response.status, snippet);
  throw new Error(`Webhook endpoint returned ${String(response.status)}`);
}

import type { Request, RequestHandler } from 'express';
import * as webhookDeliveryService from '../services/webhookDeliveryService.js';
import { enqueue } from '../queue/queues.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { optionalIsoDate, optionalText, optionalUuid, readPagination } from '../utils/queryParam.js';
import { ApiError } from '../utils/apiError.js';
import { WEBHOOK_DELIVERY_STATUSES, type WebhookDeliveryStatus } from '../types/webhooks.js';

/** Thin adapters over webhookDeliveryService. Zero SQL (guardrails rule 2). */

function isDeliveryStatus(value: string): value is WebhookDeliveryStatus {
  return (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(value);
}

function optionalStatus(req: Request): WebhookDeliveryStatus | null {
  const raw = optionalText(req, 'status', 10);
  if (raw === null) return null;
  if (!isDeliveryStatus(raw)) {
    throw new ApiError(400, `status must be one of ${WEBHOOK_DELIVERY_STATUSES.join(', ')}`);
  }
  return raw;
}

/** GET /webhook-deliveries */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const { deliveries, totalCount } = await webhookDeliveryService.listDeliveries(user.orgId, {
    page,
    limit,
    endpointId: optionalUuid(req, 'endpointId'),
    status: optionalStatus(req),
    eventType: optionalText(req, 'eventType', 60),
    from: optionalIsoDate(req, 'from'),
    to: optionalIsoDate(req, 'to'),
  });

  res.json({
    success: true,
    count: deliveries.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    deliveries,
  });
};

/** GET /webhook-deliveries/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const delivery = await webhookDeliveryService.getDeliveryById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, delivery });
};

/**
 * POST /webhook-deliveries/:id/retry
 *
 * This is the one controller in the codebase that enqueues. That is
 * deliberate and allowed: `enqueue` is not SQL, so guardrails rule 2 is
 * intact, and putting it in the service would give a service a Redis
 * dependency it otherwise has none of.
 */
export const retry: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const deliveryId = await webhookDeliveryService.requeueDelivery(user.orgId, requireParam(req, 'id'));
  // BullMQ rejects ':' in a custom jobId — '-' is the safe delimiter.
  await enqueue(
    'webhook-deliver',
    { deliveryId },
    { jobId: `delivery-${deliveryId}-retry-${String(Date.now())}` },
  );
  res.status(202).json({ success: true, delivery: { id: deliveryId, status: 'PENDING' } });
};

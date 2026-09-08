/**
 * Phase 7's outbound financial-event webhook types. Platform-scoped, like
 * `audit.ts` and `jobs.ts` — any app may emit into the outbox.
 */

export const OUTBOX_EVENT_TYPES = [
  'invoice.issued',
  'bill.approved',
  'payment.recorded',
  'fiscal_period.closed',
  'bank.large_unmatched',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export function isOutboxEventType(value: string): value is OutboxEventType {
  return (OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'FAILED'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * DELIVERED is terminal — a webhook that has been received cannot be
 * un-received, and there is no edge out of it (guardrails rule 6 applied to
 * an outbound record of fact). FAILED -> PENDING is the ONLY reverse edge:
 * an operator replaying a dead endpoint after fixing it.
 */
export const WEBHOOK_DELIVERY_TRANSITIONS = {
  PENDING: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: ['PENDING'],
} as const satisfies Record<WebhookDeliveryStatus, readonly WebhookDeliveryStatus[]>;

export function canTransitionDelivery(
  from: WebhookDeliveryStatus,
  to: WebhookDeliveryStatus,
): boolean {
  return (WEBHOOK_DELIVERY_TRANSITIONS[from] as readonly WebhookDeliveryStatus[]).includes(to);
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  label: string;
  eventTypes: OutboxEventType[];
  isActive: boolean;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned exactly once, by create and rotate-secret. Never by a read. */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  endpointLabel: string;
  endpointUrl: string;
  eventId: string;
  eventType: OutboxEventType;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: Record<string, unknown>;
}

export interface CreateEndpointInput {
  url: string;
  label: string;
  eventTypes: OutboxEventType[];
}

export interface UpdateEndpointInput {
  url?: string | undefined;
  label?: string | undefined;
  eventTypes?: OutboxEventType[] | undefined;
  isActive?: boolean | undefined;
}

export interface ListDeliveriesOptions {
  page: number;
  limit: number;
  endpointId: string | null;
  status: WebhookDeliveryStatus | null;
  eventType: string | null;
  from: string | null;
  to: string | null;
}

/** One event drained from the outbox, ready to fan out. */
export interface ClaimedOutboxEvent {
  id: string;
  orgId: string;
  appSlug: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

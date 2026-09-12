/**
 * Phase 7's background-job types. Platform-scoped, like `audit.ts` — the
 * queue is shared infrastructure, not owned by any one app.
 */

export const QUEUE_NAMES = [
  'outbox-drain',
  'webhook-deliver',
  'integrity-check',
  'ap-flow-extract',
  'boarddeck-generate',
  'dead-letter',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * One payload type per queue. A job payload carries IDENTIFIERS ONLY,
 * never a snapshot of the row: the worker re-reads the row from Postgres,
 * so it can never act on data the payload's producer had but that has since
 * been voided, and so a payload sitting in Redis is not a copy of tenant
 * data outside the database.
 */
export interface JobPayloads {
  'outbox-drain': Record<string, never>;
  'webhook-deliver': { deliveryId: string };
  'integrity-check': Record<string, never>;
  'ap-flow-extract': { orgId: string; apFlowDocumentId: string };
  'boarddeck-generate': { orgId: string; deckId: string };
  'dead-letter': {
    queue: QueueName;
    jobId: string;
    failedReason: string;
    payload: unknown;
  };
}

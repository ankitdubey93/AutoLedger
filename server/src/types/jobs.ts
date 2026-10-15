/**
 * Phase 7's background-job types. Platform-scoped, like `audit.ts` — the
 * queue is shared infrastructure, not owned by any one app.
 */

export const QUEUE_NAMES = [
  'outbox-drain',
  'webhook-deliver',
  'integrity-check',
  'capture-extract',
  'integration-drive-sweep',
  'integration-drive-sync',
  'recurring-sweep',
  'recurring-generate',
  'email-drain',
  'quote-expiry-sweep',
  'inbound-mail-process',
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
  'capture-extract': { orgId: string; captureDocumentId: string };
  'integration-drive-sweep': Record<string, never>;
  'integration-drive-sync': { orgId: string; folderId: string };
  'recurring-sweep': Record<string, never>;
  'recurring-generate': { orgId: string; scheduleId: string };
  'email-drain': Record<string, never>;
  'quote-expiry-sweep': Record<string, never>;
  /**
   * Phase 43d. Unlike the other payloads this carries the attachments'
   * provider download tokens (not mail content): they exist nowhere else, and
   * they are short-lived provider handles, never logged.
   */
  'inbound-mail-process': {
    orgId: string;
    messageId: string;
    attachments: { downloadToken: string; name: string; contentType: string; contentLength: number }[];
  };
  'dead-letter': {
    queue: QueueName;
    jobId: string;
    failedReason: string;
    payload: unknown;
  };
}

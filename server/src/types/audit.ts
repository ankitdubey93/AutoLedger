/**
 * Phase 5's audit trail types. Platform-scoped, like `auth.ts` — the trail
 * spans every app, not just LedgerCore (guardrails rule 16).
 */

export const AUDIT_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

/** Narrows a string (a query parameter) to a known operation. */
export function isAuditOperation(value: string): value is AuditOperation {
  return (AUDIT_OPERATIONS as readonly string[]).includes(value);
}

/**
 * One row of the audit trail, without its before/after images — what the
 * list endpoint returns. Two JSONB row images per record is a large payload
 * for a list view; `AuditLogDetail` (below) is where they are read.
 */
export interface AuditLogEntry {
  /** `audit_logs.id` is a BIGINT identity — kept a string, exactly as `pg` hands it back. */
  id: string;
  txid: string;
  appSlug: string;
  tableName: string;
  rowId: string | null;
  operation: AuditOperation;
  /** `null` for INSERT/DELETE, where "everything" and "nothing" are the only possible answers. */
  changedKeys: string[] | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  clientIp: string | null;
  createdAt: string;
}

/** One entry, plus the full before/after row images. */
export interface AuditLogDetail extends AuditLogEntry {
  oldRow: Record<string, unknown> | null;
  newRow: Record<string, unknown> | null;
}

export interface ListAuditLogsOptions {
  page: number;
  limit: number;
  appSlug: string | null;
  tableName: string | null;
  rowId: string | null;
  operation: AuditOperation | null;
  actorUserId: string | null;
  from: string | null;
  to: string | null;
}

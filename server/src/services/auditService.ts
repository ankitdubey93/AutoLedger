import { pool } from '../db/connect.js';
import { ApiError } from '../utils/apiError.js';
import type { AuditLogDetail, AuditLogEntry, AuditOperation, ListAuditLogsOptions } from '../types/audit.js';

/**
 * Phase 5's audit trail, read-only. Every row is written by the triggers in
 * migrations 017/018, never by this file or any caller of it (guardrails
 * rule 6 extended to the trail itself — there is no write path here).
 *
 * Every query carries `org_id = $1` (guardrails rule 1). `id` is an integer
 * identity, not a UUID, so it is validated with a plain digit regex before
 * ever reaching SQL, matching the discipline every other `optionalUuid`-style
 * check in this codebase already follows.
 */

const BIGINT_ID = /^\d+$/;

interface LogRow {
  id: string;
  txid: string;
  app_slug: string;
  table_name: string;
  row_id: string | null;
  operation: string;
  changed_keys: string[] | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  client_ip: string | null;
  created_at: Date;
}

interface LogDetailRow extends LogRow {
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
}

function toEntry(row: LogRow): AuditLogEntry {
  return {
    id: row.id,
    txid: row.txid,
    appSlug: row.app_slug,
    tableName: row.table_name,
    rowId: row.row_id,
    operation: row.operation as AuditOperation,
    changedKeys: row.changed_keys,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    clientIp: row.client_ip,
    createdAt: row.created_at.toISOString(),
  };
}

function toDetail(row: LogDetailRow): AuditLogDetail {
  return {
    ...toEntry(row),
    oldRow: row.old_row,
    newRow: row.new_row,
  };
}

/**
 * `u` is a `LEFT JOIN`: a user who has since been removed must not drop
 * their own audit rows. `users` is a platform table, not another app's — the
 * join does not violate guardrails rule 16.
 */
const LOG_JOIN = `
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id`;

const LOG_SELECT = `SELECT a.id, a.txid, a.app_slug, a.table_name, a.row_id, a.operation,
                           a.changed_keys, a.actor_user_id, a.client_ip, a.created_at,
                           u.name  AS actor_name,
                           u.email AS actor_email${LOG_JOIN}`;

/**
 * Shared by the count and the page query — one predicate, so the two can
 * never silently drift apart. `to` is exclusive of the *next* day, so an
 * inclusive `to=2026-09-04` still catches a row written at 23:59 that day.
 */
function buildFilters(orgId: string, options: ListAuditLogsOptions): { where: string; values: unknown[] } {
  const values: unknown[] = [
    orgId,
    options.appSlug,
    options.tableName,
    options.rowId,
    options.operation,
    options.actorUserId,
    options.from,
    options.to,
  ];

  const where = `a.org_id = $1
      AND ($2::text IS NULL OR a.app_slug = $2)
      AND ($3::text IS NULL OR a.table_name = $3)
      AND ($4::uuid IS NULL OR a.row_id = $4)
      AND ($5::text IS NULL OR a.operation = $5)
      AND ($6::uuid IS NULL OR a.actor_user_id = $6)
      AND ($7::date IS NULL OR a.created_at >= $7::date)
      AND ($8::date IS NULL OR a.created_at < ($8::date + 1))`;

  return { where, values };
}

export async function listAuditLogs(
  orgId: string,
  options: ListAuditLogsOptions,
): Promise<{ logs: AuditLogEntry[]; totalCount: number }> {
  const { where, values } = buildFilters(orgId, options);
  const offset = (options.page - 1) * options.limit;

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total${LOG_JOIN} WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const { rows } = await pool.query<LogRow>(
    `${LOG_SELECT}
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { logs: rows.map(toEntry), totalCount };
}

export async function getAuditLogById(orgId: string, id: string): Promise<AuditLogDetail> {
  // Reject a non-numeric id before it reaches SQL. Never a 400 for a
  // wrong-org id below — a 404 does not confirm the row exists elsewhere
  // (guardrails rule 1).
  if (!BIGINT_ID.test(id)) throw new ApiError(404, 'Audit log entry not found');

  const { rows } = await pool.query<LogDetailRow>(
    `SELECT a.id, a.txid, a.app_slug, a.table_name, a.row_id, a.operation,
            a.old_row, a.new_row, a.changed_keys, a.actor_user_id, a.client_ip, a.created_at,
            u.name  AS actor_name,
            u.email AS actor_email
       ${LOG_JOIN}
      WHERE a.id = $2::bigint AND a.org_id = $1`,
    [orgId, id],
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Audit log entry not found');
  return toDetail(row);
}

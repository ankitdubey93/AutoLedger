import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { cents, formatCents } from '../utils/money.js';
import { getRequestContext } from '../utils/requestContext.js';
import {
  HISTORY_ACTIONS,
  type HistoryAction,
  type HistoryEntityType,
  type HistoryEntry,
  type RecordHistoryInput,
} from '../types/history.js';

/**
 * Phase 46c — the "History & notes" timeline. Events are written by each
 * document's own service on its own transaction client (never derived from
 * audit_logs); notes are written by users. The table is insert-only
 * (migration 101). `entity_id` is polymorphic with no FK, so every read and
 * every note first proves the entity exists in the caller's org
 * (assertEntityExistsOnClient) — rule 1.
 */

type Queryable = Pick<PoolClient, 'query'>;

const MAX_SUMMARY = 1000;
const MAX_LIST = 500;

function cleanSummary(summary: string): string {
  return summary.trim().slice(0, MAX_SUMMARY);
}

/** The acting user, from the request context only; a background sweep writes null. */
function currentActor(): string | null {
  return getRequestContext()?.userId ?? null;
}

/** `${currencyCode} ${formatCents(cents(amountCents))}`, e.g. "USD 1200.00". */
export function formatMoney(amountCents: number, currencyCode: string): string {
  return `${currencyCode} ${formatCents(cents(amountCents))}`;
}

/** Writes one EVENT on the caller's transaction. */
export async function recordEventOnClient(
  q: Queryable,
  orgId: string,
  input: RecordHistoryInput,
): Promise<void> {
  await q.query(
    `INSERT INTO document_history
       (org_id, entity_type, entity_id, kind, action, summary, details, actor_user_id)
     VALUES ($1, $2, $3, 'EVENT', $4, $5, $6::jsonb, $7)`,
    [
      orgId,
      input.entityType,
      input.entityId,
      input.action,
      cleanSummary(input.summary),
      input.details === undefined ? null : JSON.stringify(input.details),
      currentActor(),
    ],
  );
}

/** One INSERT … SELECT FROM unnest for several events. No-op on []. */
export async function recordEventsOnClient(
  q: Queryable,
  orgId: string,
  inputs: readonly RecordHistoryInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  await q.query(
    `INSERT INTO document_history
       (org_id, entity_type, entity_id, kind, action, summary, details, actor_user_id)
     SELECT $1, t.entity_type, t.entity_id, 'EVENT', t.action, t.summary, t.details::jsonb, $7
       FROM unnest($2::text[], $3::uuid[], $4::text[], $5::text[], $6::text[])
            AS t(entity_type, entity_id, action, summary, details)`,
    [
      orgId,
      inputs.map((i) => i.entityType),
      inputs.map((i) => i.entityId),
      inputs.map((i) => i.action),
      inputs.map((i) => cleanSummary(i.summary)),
      inputs.map((i) => (i.details === undefined ? null : JSON.stringify(i.details))),
      currentActor(),
    ],
  );
}

/** 404 with the entity's message when the id is not in the org. One literal SQL string per case (rule 4). */
export async function assertEntityExistsOnClient(
  q: Queryable,
  orgId: string,
  entityType: HistoryEntityType,
  entityId: string,
): Promise<void> {
  const params = [entityId, orgId];
  let sql: string;
  let message: string;
  switch (entityType) {
    case 'INVOICE':
      sql = 'SELECT 1 FROM invoices WHERE id = $1 AND org_id = $2';
      message = 'Invoice not found';
      break;
    case 'BILL':
      sql = 'SELECT 1 FROM bills WHERE id = $1 AND org_id = $2';
      message = 'Bill not found';
      break;
    case 'CREDIT_NOTE':
      sql = 'SELECT 1 FROM credit_notes WHERE id = $1 AND org_id = $2';
      message = 'Credit note not found';
      break;
    case 'DEBIT_NOTE':
      sql = 'SELECT 1 FROM debit_notes WHERE id = $1 AND org_id = $2';
      message = 'Debit note not found';
      break;
    case 'QUOTE':
      sql = "SELECT 1 FROM quotes WHERE id = $1 AND org_id = $2 AND direction = 'SALES'";
      message = 'Quote not found';
      break;
    case 'PURCHASE_QUOTE':
      sql = "SELECT 1 FROM quotes WHERE id = $1 AND org_id = $2 AND direction = 'PURCHASE'";
      message = 'Quote not found';
      break;
    case 'SALES_ORDER':
      sql = "SELECT 1 FROM orders WHERE id = $1 AND org_id = $2 AND direction = 'SALES'";
      message = 'Order not found';
      break;
    case 'PURCHASE_ORDER':
      sql = "SELECT 1 FROM orders WHERE id = $1 AND org_id = $2 AND direction = 'PURCHASE'";
      message = 'Order not found';
      break;
    case 'PAYMENT':
      sql = 'SELECT 1 FROM payments WHERE id = $1 AND org_id = $2';
      message = 'Payment not found';
      break;
    case 'MANUAL_JOURNAL':
      sql = 'SELECT 1 FROM manual_journals WHERE id = $1 AND org_id = $2';
      message = 'Manual journal not found';
      break;
    case 'CUSTOMER':
      sql = 'SELECT 1 FROM customers WHERE id = $1 AND org_id = $2';
      message = 'Customer not found';
      break;
    case 'VENDOR':
      sql = 'SELECT 1 FROM vendors WHERE id = $1 AND org_id = $2';
      message = 'Vendor not found';
      break;
    case 'BANK_TRANSACTION':
      sql = 'SELECT 1 FROM bank_transactions WHERE id = $1 AND org_id = $2';
      message = 'Bank transaction not found';
      break;
    default: {
      const _exhaustive: never = entityType;
      throw new Error(`Unknown history entity type: ${String(_exhaustive)}`);
    }
  }
  const { rowCount } = await q.query(sql, params);
  if (!rowCount) throw new ApiError(404, message);
}

interface HistoryRow {
  id: string;
  kind: 'EVENT' | 'NOTE';
  action: string;
  summary: string;
  details: Record<string, unknown> | null;
  actor_user_id: string | null;
  actor_name: string | null;
  created_at: Date;
}

function toHistoryEntry(row: HistoryRow): HistoryEntry {
  if (!(HISTORY_ACTIONS as readonly string[]).includes(row.action)) {
    throw new Error(`Unknown history action in database: ${row.action}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    action: row.action as HistoryAction,
    summary: row.summary,
    details: row.details,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listHistory(
  orgId: string,
  entityType: HistoryEntityType,
  entityId: string,
): Promise<HistoryEntry[]> {
  await assertEntityExistsOnClient(pool, orgId, entityType, entityId);
  const { rows } = await pool.query<HistoryRow>(
    `SELECT h.id, h.kind, h.action, h.summary, h.details, h.actor_user_id,
            COALESCE(u.name, u.email) AS actor_name, h.created_at
       FROM document_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.org_id = $1 AND h.entity_type = $2 AND h.entity_id = $3
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT $4`,
    [orgId, entityType, entityId, MAX_LIST],
  );
  return rows.map(toHistoryEntry);
}

export async function addNote(
  orgId: string,
  userId: string,
  entityType: HistoryEntityType,
  entityId: string,
  text: string,
): Promise<HistoryEntry> {
  return withTransaction(async (client) => {
    await assertEntityExistsOnClient(client, orgId, entityType, entityId);
    const { rows } = await client.query<Omit<HistoryRow, 'actor_name'>>(
      `INSERT INTO document_history
         (org_id, entity_type, entity_id, kind, action, summary, actor_user_id)
       VALUES ($1, $2, $3, 'NOTE', 'NOTE', $4, $5)
       RETURNING id, kind, action, summary, details, actor_user_id, created_at`,
      [orgId, entityType, entityId, cleanSummary(text), userId],
    );
    const row = rows[0];
    if (!row) throw new Error('Note insert returned no row');
    const { rows: users } = await client.query<{ name: string | null }>(
      'SELECT COALESCE(name, email) AS name FROM users WHERE id = $1',
      [userId],
    );
    return toHistoryEntry({ ...row, actor_name: users[0]?.name ?? null });
  });
}

import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { INVOICE_LINK_TTL_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { randomUrlToken, sha256Hex } from '../../utils/pkce.js';
import { enqueueEmailOnClient } from '../mail/emailOutboxService.js';
import * as historyService from '../historyService.js';
import { onlineCardAvailableOnClient } from './onlinePaymentService.js';
import { getInvoiceById } from './invoiceService.js';
import { allocatedCentsSubquery, depositAppliedCentsSubquery, noteAppliedCentsSubquery } from './settlementSql.js';
import { formatMoney } from './statementEmailService.js';
import type { InvoiceSend, InvoiceSendKind } from '../../types/accounting.js';

/**
 * Phase 48 — emailing an issued invoice. One transaction writes the send row
 * (token stored only as a SHA-256 hash), the outbox row (which references the
 * PDF, rendered at drain time) and a history event. Nothing here writes to
 * `invoices`: an issued invoice is immutable (rule 6), so "sent" is derived
 * from `invoice_sends`.
 */

export interface SendInvoiceOnClientInput {
  invoiceId: string;
  sendKind: InvoiceSendKind;
  toEmail: string | null;
  message: string | null;
  /** invoice_reminder only; selects the wording of the subject. */
  overdue?: boolean;
}

interface SendSourceRow {
  invoice_number: string | null;
  status: string;
  due_date: string;
  currency_code: string;
  total_cents: string;
  customer_name: string;
  customer_email: string | null;
  allocated_cents: string;
  credited_cents: string;
  deposit_applied_cents: string;
}

function linkFor(token: string): string {
  return `${new URL(env.FRONTEND_URL).origin}/invoice/${encodeURIComponent(token)}`;
}

/**
 * Sends one invoice on the caller's transaction client. Returns null only when
 * no address exists (neither supplied nor on the customer), so recurring and
 * reminder callers can tolerate it; the manual route turns that into a 422.
 */
export async function sendInvoiceOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: SendInvoiceOnClientInput,
): Promise<InvoiceSend | null> {
  const { rows } = await client.query<SendSourceRow>(
    `SELECT i.invoice_number, i.status, i.due_date::text AS due_date, i.currency_code, i.total_cents::text AS total_cents,
            c.name AS customer_name, c.email AS customer_email,
            ${allocatedCentsSubquery('i', 'invoice_id')} AS allocated_cents,
            ${noteAppliedCentsSubquery('i', 'invoice_id')} AS credited_cents,
            ${depositAppliedCentsSubquery('i', 'invoice_id')} AS deposit_applied_cents
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
      WHERE i.org_id = $1 AND i.id = $2`,
    [orgId, input.invoiceId],
  );
  const source = rows[0];
  if (source === undefined) throw new ApiError(404, 'Invoice not found');
  if (source.status !== 'ISSUED') throw new ApiError(422, 'Only an issued invoice can be sent');

  const toEmail = (input.toEmail ?? source.customer_email)?.trim().toLowerCase() ?? '';
  if (toEmail === '') return null;

  const total = parseCents(source.total_cents);
  const amountDue =
    total -
    parseCents(source.allocated_cents) -
    parseCents(source.credited_cents) -
    parseCents(source.deposit_applied_cents);
  const currency = source.currency_code.trim();

  const org = await client.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const organizationName = org.rows[0]?.name;
  if (organizationName === undefined) throw new ApiError(404, 'Organization not found');

  const token = randomUrlToken();
  const expiresAt = new Date(Date.now() + INVOICE_LINK_TTL_MS);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO invoice_sends (org_id, invoice_id, send_kind, to_email, sent_by, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [orgId, input.invoiceId, input.sendKind, toEmail, userId, sha256Hex(token), expiresAt],
  );
  const sendId = inserted.rows[0]?.id;
  if (sendId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  const canPayOnline = amountDue > 0 && (await onlineCardAvailableOnClient(client, orgId));
  const reminder = input.sendKind === 'REMINDER';
  const emailId = await enqueueEmailOnClient(client, {
    orgId,
    to: toEmail,
    toName: source.customer_name,
    template: reminder ? 'invoice_reminder' : 'invoice_sent',
    data: {
      organizationName,
      customerName: source.customer_name,
      invoiceNumber: source.invoice_number ?? '',
      total: formatMoney(total, currency),
      amountDue: formatMoney(amountDue, currency),
      dueDate: source.due_date,
      message: input.message ?? '',
      canPayOnline,
      ...(reminder ? { overdue: input.overdue === true } : {}),
    },
    link: linkFor(token),
    attachment: { kind: 'INVOICE_PDF', refId: input.invoiceId },
  });

  await client.query('UPDATE invoice_sends SET email_id = $1 WHERE org_id = $2 AND id = $3', [emailId, orgId, sendId]);

  await historyService.recordEventOnClient(client, orgId, {
    entityType: 'INVOICE',
    entityId: input.invoiceId,
    // The history action set is closed (types/history.ts, DB pattern A-Z_); a
    // reminder is a SENT whose summary says so.
    action: 'SENT',
    summary: reminder ? `Reminder emailed to ${toEmail}` : `Emailed to ${toEmail}`,
  });

  const send = await readSend(client, orgId, input.invoiceId, sendId);
  if (send === null) throw new Error('invoice_sends row vanished inside its own transaction');
  return send;
}

/** POST /invoices/:id/send */
export async function sendInvoice(
  orgId: string,
  userId: string,
  invoiceId: string,
  input: { toEmail: string | null; message: string | null },
): Promise<InvoiceSend> {
  const send = await withTransaction((client) =>
    sendInvoiceOnClient(client, orgId, userId, {
      invoiceId,
      sendKind: 'MANUAL',
      toEmail: input.toEmail,
      message: input.message,
    }),
  );
  if (send === null) {
    throw new ApiError(422, 'This customer has no email address. Enter one to send the invoice');
  }
  return send;
}

// ---------------------------------------------------------------------- reads

interface SendRow {
  id: string;
  invoice_id: string;
  send_kind: InvoiceSendKind;
  to_email: string;
  sent_by_name: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_viewed_at: Date | null;
  delivery_status: InvoiceSend['deliveryStatus'];
}

function toSend(row: SendRow): InvoiceSend {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    sendKind: row.send_kind,
    toEmail: row.to_email,
    sentByName: row.sent_by_name,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
    deliveryStatus: row.delivery_status,
  };
}

const SEND_SELECT = `
  SELECT s.id, s.invoice_id, s.send_kind, s.to_email, u.name AS sent_by_name,
         s.created_at, s.expires_at, s.revoked_at, s.last_viewed_at, e.status AS delivery_status
    FROM invoice_sends s
    LEFT JOIN email_outbox e ON e.id = s.email_id
    LEFT JOIN users u ON u.id = s.sent_by`;

async function readSend(
  q: Pick<PoolClient, 'query'>,
  orgId: string,
  invoiceId: string,
  sendId: string,
): Promise<InvoiceSend | null> {
  const { rows } = await q.query<SendRow>(
    `${SEND_SELECT} WHERE s.org_id = $1 AND s.invoice_id = $2 AND s.id = $3`,
    [orgId, invoiceId, sendId],
  );
  const row = rows[0];
  return row === undefined ? null : toSend(row);
}

/** GET /invoices/:id/sends — newest first. */
export async function listInvoiceSends(orgId: string, invoiceId: string): Promise<InvoiceSend[]> {
  // 404 for an invoice outside the org, through the invoice's own read.
  await getInvoiceById(orgId, invoiceId);
  const { rows } = await pool.query<SendRow>(
    `${SEND_SELECT}
      WHERE s.org_id = $1 AND s.invoice_id = $2
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 50`,
    [orgId, invoiceId],
  );
  return rows.map(toSend);
}

/** POST /invoices/:id/sends/:sendId/revoke — the link stops working; idempotent. */
export async function revokeInvoiceSend(orgId: string, invoiceId: string, sendId: string): Promise<InvoiceSend> {
  const { rowCount } = await pool.query(
    `UPDATE invoice_sends SET revoked_at = COALESCE(revoked_at, now())
      WHERE org_id = $1 AND invoice_id = $2 AND id = $3`,
    [orgId, invoiceId, sendId],
  );
  if (rowCount === 0) throw new ApiError(404, 'Invoice link not found');
  const send = await readSend(pool, orgId, invoiceId, sendId);
  if (send === null) throw new ApiError(404, 'Invoice link not found');
  return send;
}
